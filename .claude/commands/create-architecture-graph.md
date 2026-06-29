# Reverse Engineer the Entire Codebase

You are not documenting this project for humans.

You are building an **Architecture Knowledge Base** whose primary consumer is future Claude sessions.

Future Claude sessions should be able to understand 95% of the project architecture without reading the entire repository again.

Your objective is to reverse engineer every important aspect of this codebase and store that knowledge inside:

```
docs/architecture-graph/
```

---

# IMPORTANT

Do NOT summarize.

Do NOT guess.

Do NOT skip files because they "look unimportant".

Read the code.

Every line.

Every module.

Every dependency.

Every execution path.

---

# Goal

Create documentation that allows future Claude sessions to:

- understand the architecture
- locate functionality quickly
- understand execution flow
- understand dependencies
- understand business logic
- understand data flow
- understand folder responsibilities
- understand ownership of every module

without having to scan the entire repository.

---

# Reading Strategy

Traverse the repository completely.

For every file:

- read the entire file
- understand its purpose
- identify relationships
- identify callers
- identify callees
- identify exports
- identify imports
- identify side effects
- identify runtime behavior

Never assume.

Never infer without evidence.

Everything must be derived from actual code.

---

# Ignore

Ignore only:

- node_modules
- build artifacts
- dist
- coverage
- generated files
- cache directories
- temporary files

Everything else must be inspected.

---

# While Reading

Continuously build a mental graph containing:

- folders
- modules
- services
- APIs
- classes
- interfaces
- functions
- utilities
- configuration
- environment variables
- scheduled jobs
- queues
- event handlers
- middleware
- repositories
- models
- DTOs
- controllers
- routes
- background workers
- database interactions
- external systems

Keep updating this graph as new information is discovered.

---

# Trace Execution

For every feature determine:

Entry Point

↓

Who calls it

↓

What it calls

↓

Business Logic

↓

External Services

↓

Persistence

↓

Response

Future Claude sessions should be able to reconstruct execution flow without reopening dozens of files.

---

# Cross References

Record relationships like:

Authentication

↓

Middleware

↓

Controller

↓

Service

↓

Repository

↓

Database

or

Scheduler

↓

Queue

↓

Worker

↓

API

↓

Storage

---

# Capture Hidden Knowledge

Document things that are usually difficult to discover:

- implicit dependencies
- singleton initialization
- startup sequence
- application bootstrap
- global state
- feature flags
- configuration hierarchy
- dependency injection
- caching
- retry logic
- concurrency
- transactions
- async pipelines
- event chains
- recursive flows
- circular dependencies
- runtime generated objects

---

# Business Logic

Document business rules discovered in code.

Examples:

- validation rules
- archival rules
- backup strategy
- scheduling logic
- filtering logic
- retry policy
- permissions
- ownership rules
- feature restrictions

Do not only describe *what* happens.

Describe *why* it happens if the code makes it evident.

---

# Required Output

Create a complete knowledge base under

```
docs/architecture-graph/
```

Suggested structure:

```
architecture-graph/

README.md
SYSTEM_OVERVIEW.md
BOOTSTRAP.md
STARTUP_SEQUENCE.md
REQUEST_FLOW.md
DATA_FLOW.md
MODULE_INDEX.md
DEPENDENCY_GRAPH.md
FOLDER_STRUCTURE.md
CONFIGURATION.md
ENVIRONMENT.md
DATABASE.md
API_MAP.md
SERVICES.md
UTILITIES.md
BACKGROUND_JOBS.md
SCHEDULERS.md
QUEUES.md
EVENT_FLOW.md
EXTERNAL_INTEGRATIONS.md
SECURITY.md
ERROR_HANDLING.md
BUSINESS_RULES.md
EXECUTION_PATHS.md
COMMON_PATTERNS.md
GLOSSARY.md

modules/
    module-a.md
    module-b.md
    module-c.md

execution/
    feature-a.md
    feature-b.md
    feature-c.md

graphs/
    module-dependencies.md
    execution-flow.md
    request-flow.md
    data-flow.md
```

---

# Graphs

Where helpful, use Mermaid diagrams.

Examples:

- dependency graph
- request flow
- startup flow
- scheduler flow
- service interaction
- module hierarchy
- sequence diagrams

Focus on clarity rather than aesthetics.

---

# Important Principle

Optimize documentation for Claude, not humans.

Future Claude sessions should answer questions like:

- "Where does this feature start?"
- "Which service owns this logic?"
- "Which files should I inspect?"
- "What happens after this API is called?"
- "Which scheduler creates this job?"
- "What external systems are involved?"
- "Where is this object mutated?"
- "Which modules depend on this one?"

without reading the repository again.

---

# Validation

Before finishing, verify that:

✓ Every significant source file has been inspected.

✓ Every major module has documentation.

✓ Every execution path is documented.

✓ Every API is mapped.

✓ Every scheduler/background process is documented.

✓ Every external integration is documented.

✓ Every major business rule is captured.

✓ Every important dependency is recorded.

✓ Documentation is internally cross-linked.

✓ Future Claude sessions can navigate the project using only `docs/architecture-graph/`.

Only after all validations pass should the task be considered complete.