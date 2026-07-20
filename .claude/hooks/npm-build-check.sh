#!/usr/bin/env bash
# Stop hook — runs `npm run build` for each service that has pending changes and,
# on failure, feeds the errors back to Claude (exit 2) so they get fixed before
# the turn ends. Services with no working-tree changes are skipped so unrelated
# turns don't pay for a build.
#
# A `stop_hook_active` guard caps this at one re-engagement, so a build that is
# already red (pre-existing, unrelated errors) can't trap the session in a loop.
#
# No jq dependency (not installed here): stdin is matched with grep, feedback is
# sent via stderr + exit 2 rather than JSON.
set -uo pipefail

input=$(cat 2>/dev/null || true)
active=false
if printf '%s' "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  active=true
fi

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
cd "$root" 2>/dev/null || exit 0

report=""
for svc in client-service backup-service; do
  [ -d "$svc" ] || continue
  # Skip services with no pending changes (unstaged, staged, or untracked).
  if git diff --quiet -- "$svc" \
     && git diff --cached --quiet -- "$svc" \
     && [ -z "$(git ls-files --others --exclude-standard -- "$svc")" ]; then
    continue
  fi
  if ! out=$(cd "$svc" && npm run build 2>&1); then
    report="${report}=== ${svc}: 'npm run build' FAILED ===
${out}

"
  fi
done

[ -z "$report" ] && exit 0

if [ "$active" = "true" ]; then
  # Already re-engaged once this stop — surface but don't loop.
  printf 'npm run build still failing (not re-blocking to avoid a loop):\n%s\n' "$report" >&2
  exit 0
fi

printf 'npm run build failed for changed service(s). Fix the errors before finishing:\n\n%s\n' "$report" >&2
exit 2
