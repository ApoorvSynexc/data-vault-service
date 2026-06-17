## Default Command Behavior

If the user starts a message **without** any slash command (`/write-code`, `/code-review`, `/write-document`), automatically apply the `/write-code` standards by default.

This means every coding task in this project follows the full coding standards — readability, DRY, Single Responsibility, scalability, and language best practices — unless the user explicitly overrides with another command.

## Available Commands

| Command | When to Use |
|---|---|
| `/write-code` | Writing or modifying code (default) |
| `/code-review` | Reviewing existing code across 12 dimensions |
| `/write-document` | Producing User Flow, Technical Design, Architecture, or ADR documents before building |

## Override Rule

If the user explicitly starts their message with `/code-review` or `/write-document`, use that command's standards instead of the default `/write-code`.
