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
administration patterns. No new visual system or canonical HITL asset is
introduced.

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
six families has one predefined colour and each list key is mapped
deterministically to one of eight list swatches, so the same family or list is
always the same colour wherever it appears: catalogue, list and version pages,
onboarding, administration and settings. `src/web/views/colors.ts` decides the
class, `app.css` defines the colour, and a test proves the two stay in step.

Testing-tool warning notices are not used. The catalogue states plainly that the
lists are published for testing and debugging purposes only.

## Phase 7 Trust Inspector and Trusted List creation

Every version page carries a **Trust Inspector** card and a **Downloads** card.
The Inspector verdict is a badge — Pass (assurance), Fail (destructive),
Unavailable (neutral) — because it is the first thing a reader looks for; the
detected profile, conformance level, check counts, evaluation timestamp and
Inspector origin follow as key/value rows. Unavailable never renders as
conformance: the level reads "not evaluated" and the card says why.

Downloads are three primary buttons in one row — JSON, Compact JAdES, Inspector
report — plus the publication manifest as a plain link. The wording states which
artifact is which, and that XML is not published yet.

The Create Trusted List form reuses the onboarding form shell. The broken-list
options are shown but disabled, under a legend carrying the same
"Not implemented yet" neutral badge the disabled Trusted List Families use, so an
unavailable capability looks the same everywhere in the product.

## Phase 8 WRPAC and WRPRC

The catalogue lists the six TS 119 602 families in annex order — PID, Wallet,
WRPAC, WRPRC, Pub-EAA, Registrars and Registers — with the first four available
and the last two carrying the same neutral "Not implemented yet" badge. Nothing
distinguishes a WRPAC or WRPRC page from a Wallet or PID page except its words:
the same shell, cards, chips, preview, Inspector card and Downloads row.

The WRPAC and WRPRC onboarding forms differ from the Annex D/E forms in three
visible ways, each because the profile differs and not for variety's sake:

- the entity's public URI is labelled **Policies and Terms URL**, because that is
  what Annex F/G collect in that position;
- **Official Registration Identifier** and **Additional Information URL** are
  optional fields, and say so;
- there is no Service Unique Identifier field, because the profile has no such
  extension. An absent field is better than a disabled one here: the applicant
  has nothing to decide.

A **Mandate** card closes both forms, and the same sentence appears above the
administration Actions card: being listed states that the provider is currently
mandated by the Responsible Member State, and losing the mandate removes the
entity from the next version rather than marking it withdrawn. The profiles
publish no service status, so the meaning of approval has to be stated in words.

## Certificate input and guidance

The onboarding certificate field is labelled **Service Digital Identity
Certificate (PEM)** on every onboarding form. Its help text opens with what the
certificate is for in that profile — wallet unit authentication for Wallet
Providers, PID signature or seal verification for PID Providers, access
certificate signatures for WRPAC Providers, registration certificate signatures
for WRPRC Providers — then says what to upload, links the Certificate creation
guide and states that the private key is never uploaded.

The onboarding introduction is short and uses the full content width
(`.lead-wide`). A service block is removed with a labelled **Remove service**
button rather than a bare multiplication sign.

The guide is a page of its own in the footer **Resources** column, above
Repository. It uses the existing shell, `card`, `kv-table`, `notice-warning` and
`pre` styles and introduces no new CSS: the OpenSSL commands are the substance of
the page, so they are shown verbatim in preformatted blocks and everything else
is prose around them. Its rejection table is rendered from the parser's own
message constants, so the page and the form always say the same thing.
