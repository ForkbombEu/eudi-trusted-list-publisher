# BARIO.md

This file defines how work is done in this repository. As per BARIO wishes.

It is the canonical source of truth for agents, assistants, humans, automation, and future maintainers.

If another instruction conflicts with this file:

→ STOP  
→ surface the conflict

---

## Enforcement Model

All rules in this document are mandatory unless explicitly stated otherwise.

If a rule is violated:

→ the task is considered incomplete  
→ the agent MUST correct it before finishing

Agents MUST NOT:

- ignore rules because they were not explicitly mentioned in the prompt
- assume rules are optional

---

## Prime Directive

Do not behave like a generic coding agent.

This repository expects opinionated, deterministic, reproducible engineering.

Prefer:

- clarity over cleverness
- explicitness over magic
- small steps over huge rewrites
- working code over speculative architecture
- tests over promises
- boring, maintainable solutions over fashionable abstractions

---

## Agent Boot Sequence

Before modifying anything:

1. Read `BARIO.md`
2. Inspect repository structure
3. Do NOT infer or adopt undocumented conventions
4. If a convention is observed but not defined in BARIO.md:
   → record it in `./directives/HITL.md`
5. Proceed using ONLY known rules from BARIO.md
6. Make the smallest safe change
7. Validate the change

Skipping any step is a failure.

---

## Default Expectations

Unless explicitly forbidden, if Taskfile.yaml is present, every task MUST:

- produce a complete, runnable project
- include tests for core behavior
- if present, include `mise.toml` with pinned Go version
- if present, include `task = "latest"` in `mise.toml`
- if present, include `Taskfile.yml`
- initialize git when creating projects
- create at least one valid commit
- leave the repository in a clean state

These requirements apply even if not mentioned in the prompt.

---

## Git Behavior

Agents MUST NOT push.

```sh
git push
```

is forbidden unless explicitly requested.

Before every commit, agents MUST run formatting and linting.

Required pre-commit validation:

```sh
task lint
```

Formatting MUST also be run through the repository-defined formatter before committing.

If the repository has no formatting task or formatter defined:

→ STOP

→ append the missing formatting rule to `./directives/HITL.md`

→ do NOT commit

If formatting or linting fails:

→ STOP

→ fix the issue

→ rerun formatting and linting

→ do NOT commit until both pass

A commit made without successful formatting and linting:

→ FAILURE

---

## Secrets And Ignore Files

Agents MUST NEVER commit secrets or sensitive data.

Sensitive data includes, but is not limited to:

- `.env`
- `.env.*`
- API keys
- access tokens
- private keys
- certificates
- credentials
- database dumps
- production configuration
- local machine paths containing secrets

Every new project MUST include a secure-by-default `.gitignore` before the first commit.

The `.gitignore` MUST ignore:

- environment files
- secret files
- private keys and certificates
- dependency directories
- build outputs
- logs
- caches
- editor and operating-system files
- local database files
- generated coverage artifacts

Before every commit, agents MUST inspect staged files for secrets and sensitive data.

If a secret or sensitive file is found staged:

→ STOP

→ unstage it

→ add or fix `.gitignore`

→ report the issue

→ do NOT commit until corrected

---

### Required Git State

A valid project MUST have:

- `.git` initialized
- files staged
- at least one commit

If missing:

→ FAILURE

---

### Commit Requirement

All commits MUST follow:

- Conventional Commits
- include `reason` and `prompt`

A repository without commits when expected:

→ FAILURE

---

## Commit Style

### Format

```text
<type>(<scope>): <subject>

reason:
<why>

prompt:
<short intent>
```

---

### Rules

- subject MUST be imperative, concise, lowercase
- MUST include `reason` and `prompt`
- MUST NOT describe the diff
- MUST explain intent

---

### Constraints

- reason: max 3 lines
- prompt: max 2 lines

---

### Failure Conditions

A commit is invalid if:

- missing `reason` or `prompt`
- describes only changes
- lacks intent

---

## Mandatory Project Skeleton (Go)

If the project is in Go, every Go project MUST include:

```text
go.mod
mise.toml
Taskfile.yml
main.go
main_test.go
```

Absence of any:

→ FAILURE

---

## Go Toolchain

If the project is in Go, `mise.toml` MUST define Go version and Task:

```toml
[tools]
go = "1.26.2"
task = "latest"
```

If `task lint:design` cannot run because `task` is not installed:

→ mise is not being used yet

→ `mise.toml` MUST include `task = "latest"`

→ the task remains incomplete until corrected

---

## Taskfile

`Taskfile.yml` MUST include:

```yaml
version: "3"

tasks:
  test:
    cmds:
      - go test ./...

  lint:
    cmds:
      - task lint:design

  run:
    cmds:
      - go run .

  build:
    cmds:
      - go build -o bin/starter .
```

---

## Design Source



If `DESIGN.md` is present:

→ it is the source of truth for design

→ agents MUST follow it

→  if present `mise.toml` MUST include `node = "latest"`

→ agents MUST validate it through `task lint`

→  if Taskfile.yml is present, `task lint` MUST run `task lint:design`

→ if Taskfile.yml is present, `task lint:design` MUST run `npx --yes @google/design.md lint DESIGN.md`


---

## Testing Requirement

All executable code MUST have tests.

A task is incomplete if:

- no tests exist
- tests do not cover core behavior

---

## Repository Cleanliness

Forbidden:

- binaries in repo root
- logs
- temp folders
- test artifacts

Before completion:

```sh
git status --short
```

must be clean or explained.

---

## Artifact Location And Repository Hygiene

Artifacts MUST NOT live in the repository root.

An artifact is any file the software reads or writes at runtime, or that a
generator, script, or task produces. This includes, but is not limited to:

- signing keys, certificates and signing configuration
- Trusted List publications and their sidecar evidence
- generated reports, exports and run summaries
- authoring stores and mutable application records
- caches, indexes and local databases

### Rules

Artifacts MUST be separated from code. Code lives in the source tree; artifacts
live in artifact directories.

Signing material and Trusted List artifacts MUST default to:

```text
./.local-signing/
```

Every other class of artifact MUST have its own dedicated directory. Different
kinds of artifact MUST NOT share one directory.

Every artifact location MUST be defined in `.env`, with the variable documented
in `.env.example`.

Artifact locations MUST NOT be hardcoded. A path written literally in source, in
a script, or in a test fixture is a violation, even when it happens to be
correct.

A default value in code is permitted ONLY as the fallback for an environment
variable that is absent. The environment variable MUST always take precedence:

```text
ARTIFACT_DIR from .env  →  documented default  →  never a literal in the code path
```

Artifact directories MUST be listed in the root `.gitignore`.

### Applies To Scripts

Scripts under `./scripts/` are held to the same rule as application code. A
one-off generator is still software, and its output is still an artifact.

### Verification

Before completing a task:

```sh
git status --short
```

Untracked artifacts in the repository root:

→ FAILURE

An artifact location found hardcoded anywhere in the source tree:

→ FAILURE

→ move the location to `.env`, document it in `.env.example`, and read it from
  the environment before finishing

---

## Rolling Task Handoffs

Every coding task MUST maintain a repository-local rolling handoff.

Handoffs exist so another agent can continue safely from a fresh session
without access to chat history, terminal scrollback, or the previous agent's
context.

### Location And Git Hygiene

Handoffs MUST be written under:

```text
./handoffs/
```

The root `.gitignore` MUST contain:

```gitignore
/handoffs/
```

Handoffs are local operational records. They MUST NOT be staged, committed, or
included in release artifacts.

If `./handoffs/` is not ignored:

→ add `/handoffs/` to the root `.gitignore` before creating a handoff

→ verify with `git check-ignore handoffs/<handoff-file>.md`

### Lifecycle

Near the start of a task, after reading required governance and inspecting the
repository state, the agent MUST:

1. read the newest relevant handoff, if one exists
2. create or update the current task's handoff
3. set its status to `in_progress`
4. record the prompt that initiated the task

Do NOT postpone the first handoff write until the task is complete.

Use one file per task and update it in place. Name new files:

```text
YYYYMMDDTHHMMSSZ_<short-task-slug>.md
```

Use a UTC timestamp. Keep the same file when continuing the same objective.
Create a new file when starting a materially different objective.

The handoff MUST be refreshed:

- after each coherent implementation phase
- after an important decision or discovery
- after a failure that changes the working hypothesis
- before a long-running command or background wait
- before an expected context compaction or session handover
- before committing
- immediately before the final response

The handoff MUST describe the repository state that actually exists when it is
written. Plans and intended changes MUST NOT be reported as completed work.

### Required Contents

Every handoff MUST contain:

1. task title and current status: `in_progress`, `blocked`,
   `needs_human_review`, or `complete`
2. the initiating prompt verbatim, plus material follow-up instructions
3. objective, scope, and explicit non-goals
4. completed work
5. decisions made and their rationale
6. changed-file inventory, grouped by purpose
7. decisive commands and results, including exact test counts where available
8. failures, rejected hypotheses, blockers, and unresolved issues
9. current branch and `HEAD`
10. current `git diff --stat` and `git status --short`
11. commit hashes created during the task, if any
12. the exact safest next action or command

If the task produces many generated artifacts, list each output directory once
and summarize its contents. Do NOT enumerate hundreds of files.

The handoff MUST contain enough concrete paths, commands, decisions, and current
state for a new agent to continue without replaying the transcript.

### Authority And Completion

A handoff records state and continuity. It does NOT override:

- the current user prompt
- `BARIO.md`
- `STANDARDS.md`
- `SPECS.md`
- `DESIGN.md`
- human-approved decisions

If a handoff conflicts with current repository state, record the discrepancy
and trust the verified repository state.

Before finishing, the agent MUST:

1. update the handoff with final status and verification results
2. confirm the file exists under `./handoffs/`
3. confirm Git ignores it
4. print the handoff path in the final response
5. stop without starting a new task or proposed next phase

Printing a handoff only to the terminal or final response:

→ FAILURE

Starting a new phase without an explicit user request:

→ FAILURE

---

## Engineering Style

Prefer:

- standard library
- small interfaces
- explicit errors
- deterministic behavior

Avoid:

- unnecessary dependencies
- magic
- over-engineering

---

## Planning Policy

Large tasks MUST be broken down.

Agents MUST:

- stop on oversized tasks
- propose phases
- agree before changing direction

---

## CLI Identity / ASCII Art

CLI tools MUST include ASCII art header.

Missing ASCII art:

→ FAILURE

---

## Web Identity / Console Signature

Web apps MUST include styled console signature.

Missing console identity:

→ FAILURE

## Required Developer Tools

If a repository requires a command to operate, that command MUST be declared in `mise.toml`.

A tool is required if it is used by:

- `Taskfile.yml`
- tests
- build commands
- lint commands
- release commands
- validation instructions

Missing required tools in `mise.toml`:

→ FAILURE

---

## Standard Go mise.toml

Every Go project using `Taskfile.yml` MUST declare both Go and Task:

```toml
[tools]
go = "1.26.2"
task = "latest"
```

Agents MUST NOT create Taskfile.yml without also declaring task in mise.toml.

Then your `mise install` should actually install Task, and:

```sh
mise exec -- task -a
```

should work even if your shell PATH is not reloaded.

## README.md updates 

After each development task and before each commit, the README.md should be updated. If the README.md is obsolete or empty, re-write it from scratch. README.md should contain the sections: 
- Intro: explains what the app does. It will a one-liner and a short description first of the main problems the app try to solve (but only if those are known and clear) and then the main functionalities. 
- Technical specs: list the programming languages and frameworks used and describe the main software components and libraries used in the project, but only include specific, noteworthy and non-obvious libraries, e.g. Credo.TS. Do not include any commonly used or basic libraries. 
- HOW to run: basic info about how build and run the app locally
- Quick GUI guide (if applicable): Organize this in subchapters. Describe what the GUI offers, what can be see on the homepage, how to perform actions that are related to the main functionalities of the app
- CLI Examples (if applicable): a Table listing all the CLI functions, with one example per functionalities
- API Examples (if applicable): a Table listing all the API functions, with one curl example per API
