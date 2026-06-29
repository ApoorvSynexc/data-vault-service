# Operating Mode

Before performing any analysis, determine whether the architecture knowledge base already exists.

---

## Bootstrap Mode

If the following directory does **not** exist, or is empty:

```text
docs/architecture-graph/
```

Do **not** generate the documentation yourself.

Instead, immediately invoke the dedicated Claude Skill:

```
/create-architecture-graph
```

Allow that skill to completely reverse engineer the repository and generate the initial architecture knowledge base.

Once the skill has successfully completed, continue in **Incremental Mode** using the newly generated documentation.

Do not duplicate the responsibilities of the `/create-architecture-graph` skill.

---

## Incremental Mode

If:

```text
docs/architecture-graph/
```

already exists:

Treat it as the project's current architecture knowledge base.

### Step 1

Read the entire `docs/architecture-graph/` directory before reading implementation code.

Use it to build a complete understanding of the project's architecture.

### Step 2

Determine what has changed since the architecture documentation was last updated.

Use Git history, changed files, timestamps, or repository state to identify modified areas of the codebase.

### Step 3

Inspect every changed file and recursively inspect any dependent files whose architecture may be impacted.

Do not limit yourself only to directly modified files if execution flow or dependencies have changed.

### Step 4

Update only the affected documentation.

Preserve every document, section, and diagram that is still accurate.

Do not regenerate the entire architecture graph.

### Step 5

Update every impacted artifact, including (when applicable):

- Module documentation
- Execution flows
- Request flows
- Data flows
- Dependency graphs
- API maps
- Business rules
- Startup sequence
- Configuration
- Environment documentation
- External integrations
- Mermaid diagrams
- Cross references

Only modify documentation that is affected by the code changes.

---

# Incremental Update Rules

When updating an existing architecture graph:

- Never regenerate everything.
- Preserve formatting.
- Preserve document structure.
- Preserve cross references.
- Preserve Mermaid diagrams where possible.
- Minimize documentation churn.
- Make the smallest set of changes necessary to accurately reflect the current codebase.

The architecture graph should evolve alongside the codebase rather than being recreated from scratch after every change.