# Create a Credimi Extra Project

1. Create a repository with GitHub's **Use this template** action.
2. Choose Go or Node.js with TypeScript.
3. Complete `SPECS.md`.
4. Review and populate `STANDARDS.md` with only confirmed applicable standards.
5. Copy the HITL assets to stack-appropriate runtime locations.
6. Add byte-equality tests for those copies.
7. Implement only the CLI, web, and API interfaces the application needs.
8. Add stack-native build, format, lint, test, Docker, and CI configuration.

Choose Go when direct Go import, a self-contained binary, or low runtime
overhead materially matters. Choose Node.js with TypeScript when the existing
or consuming system is TypeScript or the Node ecosystem provides a concrete
advantage.

Use one backend stack. Do not silently select or migrate it, and keep an
existing application's current stack unless migration is a separately approved
task.
