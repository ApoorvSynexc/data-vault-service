Reverse Engineer the Entire Codebase into an Obsidian Knowledge Graph
=====================================================================

You are **not documenting this project for humans.**

You are building a **permanent Architecture Knowledge Base** whose primary consumer is **future Claude sessions**.

Future Claude sessions should be able to understand **95%+ of the entire architecture without rereading the repository.**

Your objective is to reverse engineer every important aspect of this codebase and store that knowledge inside:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   docs/architecture-graph/   `

Primary Objective
=================

Produce a complete, interconnected Obsidian knowledge graph that allows future Claude sessions to answer questions like:

*   Where does this feature start?
    
*   Which module owns this logic?
    
*   Which files implement this feature?
    
*   What happens after this API is called?
    
*   Which scheduler triggers this job?
    
*   Which service writes this data?
    
*   Where is this object mutated?
    
*   Which modules depend on this one?
    
*   Which environment variables affect this behavior?
    
*   Which external systems are involved?
    

without rescanning the repository.

Critical Rules
==============

Do NOT summarize.

Do NOT guess.

Do NOT skip files because they "look unimportant."

Read the code.

Every file.

Every module.

Every execution path.

Every dependency.

Everything must be derived from actual code.

If something cannot be confirmed from code, explicitly mark it as:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   Unknown (Not found in repository)   `

Never invent architecture.

Repository Scope
================

Inspect every source file except:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   node_modules/  dist/  build/  coverage/  .cache/  .next/  target/  out/  bin/  generated/  tmp/  temp/   `

Everything else must be inspected.

Reading Strategy
================

Traverse the repository completely.

For every file:

*   Read the entire file.
    
*   Determine its responsibility.
    
*   Identify imports.
    
*   Identify exports.
    
*   Identify callers.
    
*   Identify callees.
    
*   Identify side effects.
    
*   Identify runtime behavior.
    
*   Identify ownership.
    
*   Identify business logic.
    
*   Record relationships with other files.
    

Never infer.

Always verify from code.

Build a Mental Architecture Graph
=================================

Continuously maintain a graph containing:

*   folders
    
*   packages
    
*   modules
    
*   services
    
*   controllers
    
*   repositories
    
*   models
    
*   DTOs
    
*   interfaces
    
*   utilities
    
*   middleware
    
*   routes
    
*   APIs
    
*   configuration
    
*   environment variables
    
*   feature flags
    
*   dependency injection
    
*   startup sequence
    
*   schedulers
    
*   queues
    
*   workers
    
*   events
    
*   database interactions
    
*   caching
    
*   retries
    
*   external systems
    
*   logging
    
*   authentication
    
*   authorization
    
*   validation
    
*   background processes
    

Keep updating this graph while reading additional files.

Trace Every Execution Path
==========================

For every feature identify:

Entry Point

↓

Caller

↓

Controller

↓

Middleware

↓

Service

↓

Business Logic

↓

Repository

↓

Database

↓

External Systems

↓

Response

Document the complete execution chain.

Cross Reference Every Layer
===========================

Document relationships such as:

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

Service

↓

Storage

Capture Hidden Knowledge
========================

Record everything that usually requires reading dozens of files:

*   startup sequence
    
*   singleton initialization
    
*   dependency injection
    
*   application bootstrap
    
*   global state
    
*   implicit dependencies
    
*   feature flags
    
*   runtime generated objects
    
*   caching
    
*   retry logic
    
*   async workflows
    
*   concurrency
    
*   transactions
    
*   recursive execution
    
*   circular dependencies
    
*   event chains
    
*   lifecycle hooks
    
*   middleware chains
    

Business Logic
==============

Capture business rules discovered in code.

Examples:

*   validation
    
*   backup strategy
    
*   archival strategy
    
*   restore strategy
    
*   scheduling
    
*   permissions
    
*   ownership
    
*   retry policy
    
*   filtering
    
*   feature restrictions
    
*   synchronization
    
*   versioning
    
*   conflict resolution
    

Do not merely describe _what_ happens.

Document _why_ it happens whenever the code makes it evident.

Reverse Engineer APIs
=====================

For every API record:

*   route
    
*   HTTP method
    
*   controller
    
*   middleware
    
*   service
    
*   repository
    
*   request DTO
    
*   response DTO
    
*   validation
    
*   authentication
    
*   authorization
    
*   downstream dependencies
    

Reverse Engineer Database
=========================

Document:

*   tables
    
*   collections
    
*   indexes
    
*   relationships
    
*   foreign keys
    
*   migrations
    
*   repositories
    
*   CRUD ownership
    
*   transaction boundaries
    

Identify:

*   where each table is written
    
*   where each table is read
    
*   where each table is updated
    
*   where each table is deleted
    

Reverse Engineer External Integrations
======================================

Document every interaction with:

*   AWS
    
*   Salesforce
    
*   REST APIs
    
*   GraphQL
    
*   Message Queues
    
*   Kafka
    
*   RabbitMQ
    
*   Redis
    
*   S3
    
*   Athena
    
*   Glue
    
*   Spark
    
*   Email
    
*   OAuth
    
*   Webhooks
    
*   Storage systems
    

Record:

*   authentication
    
*   request flow
    
*   retry policy
    
*   failure handling
    
*   configuration
    
*   modules using it
    

Reverse Engineer Configuration
==============================

Document:

*   environment variables
    
*   config hierarchy
    
*   feature flags
    
*   secrets
    
*   defaults
    
*   runtime overrides
    
*   initialization order
    

Reverse Engineer Dependencies
=============================

For every module identify:

Depends On

Used By

Calls

Called From

Exports

Imports

Initialization

Side Effects

Required Output Structure
=========================

Generate documentation under:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   docs/  └── architecture-graph/      │      ├── README.md      ├── SYSTEM_OVERVIEW.md      ├── BOOTSTRAP.md      ├── STARTUP_SEQUENCE.md      ├── REQUEST_FLOW.md      ├── DATA_FLOW.md      ├── MODULE_INDEX.md      ├── DEPENDENCY_GRAPH.md      ├── EXECUTION_PATHS.md      ├── API_MAP.md      ├── DATABASE.md      ├── SERVICES.md      ├── CONTROLLERS.md      ├── REPOSITORIES.md      ├── UTILITIES.md      ├── CONFIGURATION.md      ├── ENVIRONMENT.md      ├── SECURITY.md      ├── ERROR_HANDLING.md      ├── EXTERNAL_INTEGRATIONS.md      ├── BACKGROUND_JOBS.md      ├── SCHEDULERS.md      ├── QUEUES.md      ├── EVENT_FLOW.md      ├── BUSINESS_RULES.md      ├── COMMON_PATTERNS.md      ├── FOLDER_STRUCTURE.md      ├── GLOSSARY.md      │      ├── modules/      ├── execution/      ├── folders/      ├── apis/      ├── database/      ├── integrations/      ├── services/      ├── controllers/      ├── workers/      ├── schedulers/      └── graphs/   `

Obsidian Knowledge Graph Requirements
=====================================

This documentation is designed for **Obsidian**.

Never create isolated markdown files.

Every markdown document must become part of an interconnected knowledge graph.

Mandatory Wiki Links
====================

Always reference documents using Obsidian wiki links.

Example:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   Uses [[DATABASE]]  Configured By [[CONFIGURATION]]  Calls [[Backup Service]]  Execution [[execution/Create Backup]]  Related [[REQUEST_FLOW]]   `

Never use plain filenames.

Always use wiki links.

Bidirectional Linking
=====================

If document A references document B,

then document B must also reference document A whenever applicable.

Example:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   Backup Service  ↓  [[Athena]]   `

Then Athena must contain:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   Referenced By  [[Backup Service]]   `

No one-way relationships.

Every Document Must Contain
===========================

Every markdown file should include:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   # Purpose  # Responsibilities  # Depends On  # Used By  # Calls  # Called From  # Related APIs  # Related Database  # Related Services  # Related Modules  # Related Execution Paths  # Related Integrations  # See Also   `

Folder Documentation
====================

Every folder must contain its own README.

Example:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   controllers/  README.md  services/  README.md  repositories/  README.md  workers/  README.md   `

Each README links every file inside.

Hub Documents
=============

The following documents become navigation hubs:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   README  ↓  SYSTEM_OVERVIEW  ↓  MODULE_INDEX  ↓  REQUEST_FLOW  ↓  DATA_FLOW  ↓  EXECUTION_PATHS  ↓  API_MAP  ↓  DATABASE  ↓  SERVICES  ↓  EXTERNAL_INTEGRATIONS   `

Each hub links every relevant document.

Module Documentation
====================

Every module document should include:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   Purpose  Responsibilities  Entry Points  Exports  Imports  Dependencies  Dependents  Execution Flow  Configuration  Environment Variables  Business Rules  Related APIs  Related Database  Related Services  Related Execution  See Also   `

Execution Documentation
=======================

Every execution document should show complete flow.

Example:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   Create Backup  ↓  [[Backup Controller]]  ↓  [[Backup Service]]  ↓  [[S3 Service]]  ↓  [[Glue]]  ↓  [[Athena]]  ↓  [[Database]]   `

Mermaid Graphs
==============

Create Mermaid diagrams wherever useful.

Examples:

*   dependency graph
    
*   startup sequence
    
*   request flow
    
*   service interaction
    
*   scheduler flow
    
*   queue processing
    
*   event flow
    
*   database relationships
    
*   module hierarchy
    

Immediately below every Mermaid diagram include wiki links to every node.

Dependency Documentation
========================

Whenever dependencies are documented, always include both directions.

Example:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   Backup Service  Depends On  [[Athena]]  [[Glue]]  [[Database]]  [[Logger]]   `

Athena should contain:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   Referenced By  [[Backup Service]]   `

Module Ownership
================

Every module must explicitly define:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   Owns  Depends On  Used By  Calls  Called From   `

Tags
====

Every markdown file should begin with Obsidian tags.

Example:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   ---  tags:    - architecture    - service    - backup  ---   `

Use consistent tags throughout the knowledge base.

Cross-Link Everything
=====================

Every document should link to at least **5–10** related documents.

No orphan files.

No isolated modules.

No dead ends.

Every important concept should be reachable through multiple navigation paths.

Validation Checklist
====================

Before finishing verify:

*   ✓ Every significant source file was inspected.
    
*   ✓ Every module has documentation.
    
*   ✓ Every API is mapped.
    
*   ✓ Every controller links to its services.
    
*   ✓ Every service links to repositories.
    
*   ✓ Every repository links to database objects.
    
*   ✓ Every scheduler is documented.
    
*   ✓ Every queue is documented.
    
*   ✓ Every worker is documented.
    
*   ✓ Every external integration is documented.
    
*   ✓ Every environment variable is documented.
    
*   ✓ Every important dependency is recorded.
    
*   ✓ Every execution path is documented.
    
*   ✓ Every business rule is captured.
    
*   ✓ Every folder has a README.
    
*   ✓ Every markdown file links to multiple related documents.
    
*   ✓ Every dependency has backlinks.
    
*   ✓ No orphan markdown files exist.
    
*   ✓ Mermaid diagrams accurately represent the implementation.
    
*   ✓ The entire documentation forms a fully navigable Obsidian knowledge graph.
    

Final Objective
===============

Do not produce traditional documentation.

Produce a **living Architecture Knowledge Graph**.

A future Claude session should be able to start from **any single markdown document**, navigate through wiki links and backlinks, understand the complete architecture, trace execution paths, discover dependencies, and answer implementation questions **without rescanning the repository**.