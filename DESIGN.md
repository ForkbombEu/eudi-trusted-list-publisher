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

Downloads on a TS 119 602 version page are three primary buttons in one row —
JSON, Compact JAdES, Inspector report — plus the publication manifest as a plain
link. The wording states which artifact is which and which standard this list
belongs to, so a reader never expects XML from a JSON list; the TS 119 612
version pages offer XML, its SHA-256 digest and the Inspector report in the same
shape.

The Create Trusted List form reuses the onboarding form shell. The broken-list
options are live checkboxes: selecting one publishes an intentionally broken test
fixture, and the copy says that leaving them clear is the healthy path.

When server-side certificate generation is configured, the Signing Material
card carries one secondary **Generate key and certificate** button. It submits
the values already entered above, returns to the same form with the key and
certificate paths filled, and shows the result through the existing success
notice style. No private-key content is rendered in HTML.

## Phase 8 WRPAC and WRPRC

The catalogue lists the six TS 119 602 families in annex order — PID, Wallet,
WRPAC, WRPRC, Pub-EAA, Registrars and Registers — with Registrars and Registers
carrying the neutral "Not implemented yet" badge. Nothing
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

## Catalogue Open column

The Catalogue's last column is **Open** and holds one small button per artifact
the latest version actually has. A TS 119 602 row offers **JSON** always and
**XML** only when an `lote.xml` rendition sits beside that version, which this
publisher does not produce. A TS 119 612 row offers **XML**, which is its only
artifact. The buttons open the artifact in place rather than downloading it — a
reader scanning the Catalogue wants to look, and the version page is where
downloading belongs.

An absent button is the honest rendering: a disabled or dead link would promise
an artifact that does not exist.

For a TS 119 612 row, the **Trusted List Family** column renders one family chip
for every profile the XML list accepts. A list accepting both EAA and QEAA shows
both chips. Adjacent chips sit in a wrapping group with the smallest shared
spacing token between them, so they remain distinct without opening a large gap.
For older publications, the newest historical manifest that recorded
`allowedServiceProfiles` supplies the list-level labels; the singular manifest
family is the last compatibility fallback.

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

## Phase 9 Pub-EAA

The Pub-EAA card on the Catalogue and the Onboarding page reads Available like
the other four; nothing distinguishes a Pub-EAA page from a WRPAC page except its
words, its family colour and the two things Annex H actually adds.

The onboarding form differs from the Annex F/G form in three visible ways, each
because the profile differs:

- a **Legal Basis Reference** field, required, because Annex H asks which Union
  or national act the notification rests on. The citation starts with `EU` or
  the relevant EU Member State's ISO country code, followed by the law
  identifier. The help text says it is published as an `OJ:` URI in
  `TETradeName` and that the scheme prefix is added for the applicant;
- the certificate field is **not** marked required, because Annex H is the only
  implemented profile whose service digital identity is optional. It is the
  absence of the asterisk that says so, and the help text explains that more than
  one certificate may be supplied when they share a key and a subject;
- there is no Additional Information URL, because Annex H does not collect one.

The closing card is headed **Notification** rather than **Mandate**, and says
what the other profiles cannot: every service is published as notified with a
status starting time, and a withdrawal publishes a new version rather than
removing the entity.

On the administration detail page a published Pub-EAA application carries one
extra action, **Withdraw notification**, styled as a destructive button behind a
confirmation, because it publishes an immutable version that cannot be taken
back. A withdrawn application shows two records side by side — **Publication
Record** and **Withdrawal Record** — since both versions stay authentic and
downloadable, and that is exactly the point of a withdrawal that adds a version
instead of rewriting one. The state chip for `withdrawn` is neutral, not an
error: a withdrawn notification is a normal end state, not a failure.

## Phase 10 EAA and QEAA

The product now shows two standards. Every page that names a family also says
which standard and which artifact format it uses, through two neutral chips —
`ETSI TS 119 612` and `XML / XAdES-B-B` — rendered beside the existing family
chip. The catalogue module decides both; no page infers a format from a family
name, which is how a page ends up promising JSON for an XML list.

EAA and QEAA take two adjacent hues in the existing chip palette, 145 and 175,
the same sibling treatment WRPAC and WRPRC already have at 25 and 345: related
but distinguishable, because the two families are siblings that must never be
mistaken for each other.

### Onboarding

The EAA and QEAA forms use the same shell, cards and field styles as the
TS 119 602 forms and introduce no new CSS. They differ where the standard
differs:

- the **Scheme Territory is read-only**, taken from the selected Trusted List
  and shown once a list is chosen. Asking the applicant for a country would
  invite two values that disagree;
- a **registration identifier type** selector, because the published prefix is
  `VAT<CC>-` or `NTR<CC>-` and only the applicant knows which they hold. The
  help text says the prefix is added for them;
- a **TSP trade name** that is optional in general and required exactly when
  the certificate's subject organisation differs from the legal name — the
  form says so rather than failing later;
- an **evidence** field, worded for the family: national recognition for EAA,
  qualified status for QEAA. Its help text states that it is kept for review
  and never published, because an applicant pasting a decision needs to know
  where it will end up.

The closing card is **Status and lifecycle**, and it says what the artifact
cannot: which status approval publishes, and that ending it publishes a new
version rather than rewriting one.

### Administration

The dashboard is split into three cards — one per standard, then configuration
— so an administrator picks the standard before the action, rather than reading
two similarly named links side by side.

The review page carries the same cumulative-publication card as the TS 119 602
pages, plus a **Review evidence** card that repeats, in place, that the text is
never published. The lifecycle button takes its wording from the registry:
**Deprecate national recognition** for EAA, **Withdraw qualified status** for
QEAA. Both are destructive-styled and behind a confirmation, because they
publish an immutable version that cannot be taken back. A `superseded`
application shows both records side by side; its state chip is neutral, not an
error, because a deprecated recognition is a normal end state.

### Version pages

An XML version page carries four cards: the Trusted List's own values, an
Integrity card, the Trust Inspector verdict and Downloads. Downloads offers
**XML**, **SHA-256 digest** and **Inspector report** as primary buttons with the
manifest as a plain link — the same shape as the JSON pages, naming the
artifacts this list actually has. The copy never mentions JSON or Compact JAdES.

The Integrity card states `signer trust: not_evaluated` in words: this publisher
builds no certification path and makes no trust decision, and a page that showed
a green signature without saying so would imply one.

The latest version says it is also served at the stable
`/lists/<key>/latest/trusted-list.xml` and `.sha2` URLs, so a reader knows there
is an address that does not change.

The XML list page places its accepted EAA/QEAA family chips under **Allowed
service profiles** at the top. It does not repeat the list-key chip because the
key is already the page title. Its immutable versions are listed from sequence
1 upward, matching the JSON list page.

### Create XML Trusted List

The form reuses the onboarding shell and opens like the JSON form: a **List**
card contains the accepted service profiles, Trusted List Name and Scheme
Territory. The name is entered without a territory prefix; publication adds
`<SchemeTerritory>:` idempotently to form `SchemeName`. Scheme name and
territory do not appear again in the Scheme operator card.

Each accepted profile is a checkbox reusing the existing `settings-row` layout.
One list may accept EAA, QEAA or both, and only the profiles chosen appear on the
onboarding forms for that list.

Beyond the TS 119 602 fields the form collects the national scheme-rules URI,
an optional stable XML distribution URL, and the EU LOTL pointer material. A
blank distribution URL is derived from the deployed public origin, the list key
and `/latest/trusted-list.xml`; an explicit URL is preserved. The pointer card
states that the declared scheme operator and the pointer certificates must
describe the same list, because the Trust Inspector checks exactly that and the
failure is otherwise cryptic.

## Intentionally broken XML Trusted Lists

### The list says what is wrong with it

A broken list looks, at a glance, exactly like a healthy one that happens to be
failing: same catalogue row, same red Inspector verdict. Every place an XML list
can be chosen or inspected therefore carries an explicit marker, so nobody
onboards to a deliberately bad list by accident and nobody files its failing
verdict as a bug.

- The Catalogue row gains the warning badge, the `catalogue-row-broken` class and
  a Broken column listing each defect by label.
- The list page opens with the warning notice and a table of what is broken:
  what this list does, what a conformant list does instead, the clause, the
  stage the mutation was applied at, and the Inspector rules it is expected to
  trip.
- The version page carries the same badge and the Negative fixture card.

### The Negative fixture card

One layout for both standards. A reader comparing a JSON fixture with an XML one
should not have to learn two panels, and the evidence is format-independent by
design.

It states the fixture mode, the standard, the artifact format and the mutation
stages, then pairs expectation with reality on both axes: expected and actual
Inspector failures, matched, expected-but-not-reported, additional; then the
same for the local checks. **Additional failures are listed rather than hidden**,
because one mutation legitimately trips several rules and a catalogue that
quietly agreed with reality would be one nobody could check.

The Mutations table below it names every selected defect, its stage, whether it
applied, and the detail. A defect that did not apply is shown in bold as **not
applied**: a silently repaired defect is worse than a missing fixture.

### Creation

The Create XML Trusted List form gains an **Intentionally broken test fixture**
card, below the scheme material and above the signing material, reusing the same
`tl-broken-options` layout as the TS 119 602 form. Each checkbox states the
defect, what the mutation does to the XML, when it is applied and the clause it
violates. Leaving every box clear is the healthy path, and the copy says so
first.

A healthy creation redirects to the new list, as before. A broken creation stops
at a confirmation page that states what was asked for and what actually failed —
nobody should have to open the version page to discover that the fixture they
generated did not produce the defect they selected.

### Never a green light for an unassessed artifact

The Trust Inspector card shows `Unavailable` — a neutral badge, not a green one —
whenever no verdict was reached: the Inspector could not be reached, it did not
apply the submitted standard, or it ran no check. The reason is printed
underneath. The card also states the TS 119 612 applicability and the artifact
kind the Inspector detected, so a reader can see *why* there is no verdict.

A standard that was not applied cannot have been passed. This is a design rule,
not an implementation detail: the summary type has no fourth status, so there is
nowhere for "assessed nothing, looked fine" to be recorded.
