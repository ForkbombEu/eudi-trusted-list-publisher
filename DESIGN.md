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
topbar, main content area, and dark footer. The topbar adds an "Onboarding" link
when the GUI is enabled; administration is reached from the footer.

The mutable authoring store is separate from the immutable publication store.
Core services (compile, validate, sign, verify, publish, store) are reused
directly — the GUI does not duplicate or reimplement Phase 1/2 logic.

## Phase 4 cumulative preview

The authenticated application-detail page presents cumulative publication
metadata in a dedicated key/value card:

- Existing Entities
- Resulting Entities
- Current Sequence
- Proposed Sequence

These values come from the same preparation operation used by publication. The
preview card must remain visible for approved Wallet Provider applications and
must report conversion or authentication failures instead of showing a
plausible fallback sequence.

## Phase 5 profile-aware administration

PID Provider onboarding uses the existing application shell, form, preview, and
administration patterns. The catalogue shows Wallet and PID Providers as
available, while the five remaining families remain visibly disabled. No new
visual system or canonical HITL asset is introduced.

## Phase 6 presentation

The product is named **Credimi EUDI Trusted Lists** in the topbar lockup, the
footer, the browser console signature and the OpenAPI document title.

Logo boxes reproduce the Credimi Capture Wallet shell
(`HITL/credimi-capture-wallet-master/src/ui.ts`): a square, padded, contained
box — 42x42 px with 4 px padding on the light topbar using `credimi_logo.svg`,
56x56 px with 6 px padding on the dark footer using `credimi_logo_negative.svg`.

The topbar navigation reads as three groups separated by a hairline rule:
Catalogue and Onboarding, API Docs and Open API, Repository. The footer carries
three columns: Explore, Resources and Settings, the last holding the Admin link.

Trusted List Families and individual Trusted Lists are colour-coded. Each of the
seven families has one predefined colour and each list key is mapped
deterministically to one of eight list swatches, so the same family or list is
always the same colour wherever it appears: catalogue, list and version pages,
onboarding, administration and settings. `src/web/views/colors.ts` decides the
class, `app.css` defines the colour, and a test proves the two stay in step.

Testing-tool warning notices are not used. The catalogue states plainly that the
lists are published for testing and debugging purposes only.
