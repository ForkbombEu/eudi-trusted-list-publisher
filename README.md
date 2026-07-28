# Credimi Extras mini-app Template

This GitHub template starts a new Credimi Extras mini-app with its governance,
standards-neutral documentation, and authoritative Credimi design assets.

It deliberately contains no application implementation. A derived project may
use exactly one backend stack: Go or Node.js with TypeScript. Stack selection
happens in the derived project, based on its actual requirements; this template
does not select, scaffold, or implement either stack.

Complete [SPECS.md](SPECS.md) before implementation. It records the selected
backend, architecture, dependencies, commands, and runtime asset locations.
Populate [STANDARDS.md](STANDARDS.md) only with standards, versions, and
profiles confirmed to apply to the derived project.

The authoritative design assets are in [HITL/](HITL/):

- `HITL/style.css`
- `HITL/credimi_logo.svg`
- `HITL/credimi_logo_negative.svg`

Follow [docs/CREATE_PROJECT.md](docs/CREATE_PROJECT.md) when creating a
project from this template. Design and branding rules are in
[DESIGN.md](DESIGN.md); governance instructions are in [AGENTS.md](AGENTS.md)
and [directives/](directives/).
