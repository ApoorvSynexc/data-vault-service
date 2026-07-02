# Architecture First

**Description:**\
Ensure every new Claude session understands the project architecture before reading the implementation.

---

## Purpose

This skill prevents unnecessary full-codebase scanning by making Claude understand the architecture graph first. The architecture graph contains the high-level design, module relationships, execution flow, and important entry points.

This should always be treated as the first source of truth.

---

## Instructions

Whenever a **new Claude session** starts:

### Step 1 — Read the Architecture Graph

Before opening or indexing any source code, navigate to:

```text
docs/architecture-graph/
```

Read every relevant document in this directory to understand:

- Overall system architecture
- Module relationships
- Request flow
- Data flow
- Package boundaries
- Service dependencies
- Important entry points
- Shared utilities
- Layer responsibilities
- Design decisions

Do **NOT** begin reading implementation files until this step is complete.

---

### Step 2 — Build a Mental Model

From the architecture documents, identify:

- Which module owns the requested feature
- Which services are involved
- Which APIs are called
- Expected execution flow
- Relevant folders to inspect
- Components that are likely unrelated

Use this understanding to limit code exploration.

---

### Step 3 — Read Only Relevant Code

Only after understanding the architecture should implementation files be opened.

Avoid scanning the entire repository.

Instead:

1. Locate the relevant module.
2. Read the entry points.
3. Follow only the execution path required for the current task.
4. Expand outward only when necessary.

---

## Rules

- Architecture documentation is always the first source of truth.
- Never start by reading the whole repository.
- Never recursively scan all files without first understanding the architecture graph.
- Prefer targeted code navigation over repository-wide exploration.
- Use the architecture graph to determine which files actually matter.

---

## Workflow

New Session ↓ Read `docs/architecture-graph/`↓ Understand architecture ↓ Identify relevant modules ↓ Read only required implementation files ↓ Perform requested task

---

## Goal

Reduce unnecessary context usage, improve reasoning accuracy, and make code navigation faster by using the architecture graph as the project's primary navigation guide.