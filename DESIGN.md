# Credimi Design and Branding

The following human-supplied files are canonical and must not be modified,
regenerated, optimized, or converted:

| Canonical asset | SHA-256 |
| --- | --- |
| `HITL/style.css` | `ff452337f866cae1060057a8c417752b5a9767f59b748c9c7cde509c638387c7` |
| `HITL/credimi_logo.svg` | `031885760a9165e9d8d49eab45baca30ba5ed8dd1fbf0b4699fba2de5dc4feac` |
| `HITL/credimi_logo_negative.svg` | `32df33f9f5ffa696d452e1f65f5d6738b920415c5114db4b010af1f997a8cb3a` |

Each derived web application must install unchanged runtime copies of all three
assets. It must load its application CSS after `style.css`, use
`credimi_logo.svg` on light backgrounds and
`credimi_logo_negative.svg` on dark backgrounds, and use
`credimi_logo.svg` directly as the favicon.

Apply this branding to every HTML page, including API documentation. Add tests
that prove each runtime copy is byte-for-byte equal to its canonical HITL
original. Do not generate PNG or ICO logo variants.

The chosen stack determines the runtime asset locations. Record those locations
in the derived project's `SPECS.md`; this template intentionally does not
prescribe paths.

## Project asset locations

Runtime copies installed under `src/web/assets/`:

| Asset | Runtime path | Canonical source |
|-------|-------------|------------------|
| `style.css` | `src/web/assets/style.css` | `HITL/style.css` |
| `credimi_logo.svg` | `src/web/assets/credimi_logo.svg` | `HITL/credimi_logo.svg` |
| `credimi_logo_negative.svg` | `src/web/assets/credimi_logo_negative.svg` | `HITL/credimi_logo_negative.svg` |

All three files are byte-for-byte identical to their HITL sources (verified by test).
Application CSS (`src/web/assets/app.css`) loads after `style.css` and provides
page-specific layout only; it does not redefine shared design foundation.

## Phase 3 GUI design

The data-collection and administration GUI follows the same Credimi visual style.
All onboarding and admin pages use the `htmlPage()` layout with the Credimi
topbar, main content area, and dark footer. GUI-specific pages add navigation
links ("Onboarding", "Admin") to the topbar.

The mutable authoring store is separate from the immutable publication store.
Core services (compile, validate, sign, verify, publish, store) are reused
directly — the GUI does not duplicate or reimplement Phase 1/2 logic.

Testing-tool notices ("This is a test/debug fixture publisher") are displayed
on all onboarding and administration pages.
