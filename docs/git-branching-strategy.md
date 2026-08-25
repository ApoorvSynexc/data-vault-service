# Git Branching Strategy

This repo hosts both `client-service` and `backup-service` in one tree, so branching is shared across both. Remote: `origin` → `git@github.com:prateeknarayan/DataVault-Backend-NodeJS.git` is canonical — it's the only remote that carries the three branches below. A second remote, `personal-origin` (`ApoorvSynexc/data-vault-service`), only holds feature branches (`feat/*`) and is a personal fork used for pushing work-in-progress, not a deployment target.

---

## The three environment branches

| Branch | Environment | Purpose |
|---|---|---|
| `DEV` | Development | Integration branch. Feature branches merge here first; this is what the dev-deployed instance runs. |
| `qa` | QA | Staging/test branch. Promoted from `DEV` once a set of changes is ready for QA sign-off. |
| `master` | Production | What's actually live. Promoted from `qa` after sign-off. |

Note: the branch is `master`, not `main` — there is no `main` branch in this repo. There's also no branch literally named `develop` — that role is played by `DEV`.

### Promotion flow

```
feat/<name>  ──PR──▶  DEV  ──PR──▶  qa  ──PR──▶  master
   (topic)          (Development)   (QA)        (Production)
```

Each arrow is a pull request, not a direct push — merging `DEV → qa` and `qa → master` should go through review the same as a feature branch merging into `DEV`, since both are promotions to a shared environment other people depend on.

---

## Current state (as of 2026-08-25)

Worth knowing before you branch off any of these — the promotion flow above is the *intended* one, not necessarily what every branch reflects right now:

- **`master` has never received a real merge.** It's still sitting at the initial commit (2026-04-13) — `git diff --stat master qa` shows 267 files / ~47.6k lines of difference. Production hasn't been cut from this repo yet; treat `master` as "not yet initialized" rather than "behind."
- **`qa` is currently ahead of `DEV`**, not behind it. `qa`'s tip matches `feat/restore`'s tip (both at commit `49c26d9`, 2026-08-25), while `DEV`'s last commit is from 2026-08-10. That means `feat/restore` was merged into `qa` without first landing on `DEV` — the strict `DEV → qa` order in the diagram above wasn't followed for that branch. Reconcile this (merge `qa` back into `DEV`, or vice versa) before relying on `DEV` being a strict subset of `qa`.
- **Stale, already-merged feature branches**: `feat/backup` and `feat/demo` are fully merged into both `DEV` and `qa` (`git branch --merged`). Safe to delete (locally and on `origin`) — keeping merged branches around just adds noise to `git branch -a`.

---

## Topic branch naming

Branches observed on `origin` today, for reference:

```
feat/backup
feat/restore
```

Most follow a `feat/<name>` or `fix/<name>` convention. A handful (the four `PascalCase-With-Dashes` names, plus `bug/temp` and `archival/dry-run`) don't — they read as ad hoc names picked per-task rather than following a fixed pattern.

**Going forward, prefer:**

- `feat/<short-description>` — new functionality (e.g. `feat/archival-v2`, not `feat/archival_v2` — hyphens, not underscores, for consistency with the rest)
- `fix/<short-description>` — bug fixes (e.g. `fix/restore-conflict-mapping`, not `fix/bugs` — name the actual bug, not the category)
- `chore/<short-description>` — non-functional work (deps, config, docs)

Avoid free-form `Title-Case-Branch-Names` — they don't sort or filter alongside everything else in `git branch -a`, and the name alone doesn't say whether it's a feature, fix, or experiment.

---

## Working with this setup

- **Branch off `DEV`** for new work, not `qa` or `master` — `DEV` is the integration point, and branching off `qa`/`master` risks missing work that's already landed on `DEV`.
- **PR into `DEV`** when a feature is ready for the shared dev environment.
- **Promote `DEV → qa`** as a PR (not a direct merge/push) once a batch of `DEV` changes is ready for QA — this keeps a reviewable record of exactly what moved to QA and when.
- **Promote `qa → master`** as a PR once QA has signed off — this is the production release point.
- **Delete branches after merge.** A merged `feat/*`/`fix/*` branch that stays around (like `feat/backup`/`feat/demo` today) is just noise — delete both the local and `origin` copy once its PR lands.
