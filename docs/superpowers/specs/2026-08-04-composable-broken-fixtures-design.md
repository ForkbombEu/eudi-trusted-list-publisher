# Composable Broken Fixtures for Every Trusted List Family

## Status

Approved design. Implementation has not started.

## Problem

The administrator must be able to create an intentionally broken Trusted List
for every implemented family and select any non-empty subset of the defects
offered for that artifact format.

The current TS 119 602 path always seeds a broken list with a Pub-EAA issuance
service. Wallet, PID, WRPAC, and WRPRC compilers reject that service before any
selected defect can be applied. The current TS 119 612 path accepts multiple
defect identifiers, but a list accepting EAA and QEAA seeds only its first
profile. Its two signing-certificate defects also replace the signer
independently, so selecting both can leave only the later defect in the final
certificate.

Recording every selected identifier is insufficient. The final published
artifact must exhibit every selected defect.

## Scope

This change covers:

- all five enabled TS 119 602 JSON families: PID, Wallet, WRPAC, WRPRC, and
  Pub-EAA Providers;
- TS 119 612 XML lists accepting EAA, QEAA, or both;
- GUI and JSON API creation paths;
- any selection size from one defect through every defect offered for the
  selected artifact format; and
- fixture metadata that truthfully describes the final published artifact.

Healthy list semantics, the canonical defect catalogue, normative validation,
onboarding behavior, and unrelated publication behavior are non-goals.

## Selection Semantics

Defect selection is conjunctive. If an administrator selects defects A, B, and
C, the one created list must exhibit A and B and C.

Defects remain independently selectable. The software will not define special
bundles or treat any example combination as privileged. The same rules apply to
one selected defect, an arbitrary intermediate subset, and the complete set.

The selected identifiers in `fixture.json` are evidence claims. Creation must
not publish or register a list when any selected mutation is not applied to the
final artifact.

## Architecture

Keep `src/core/defects/registry.ts` as the only defect catalogue and retain the
existing JSON and XML mutation engines. Change fixture preparation and signing
planning at their existing boundaries.

### TS 119 602 family-aware seed

Build the deterministic seed from the selected profile in
`PROFILE_REGISTRY`, not from Pub-EAA constants:

- use the profile's first allowed service type and role URI prefix;
- include a service unique identifier exactly where the profile requires one;
- include service status and status starting time exactly where the profile
  uses them;
- include the Pub-EAA legal-basis trade name and electronic-address role URI
  only for Pub-EAA;
- place the role URI in the location declared by the profile; and
- provide a service certificate suitable for the healthy baseline: an
  ordinary end-entity certificate for PID, Wallet, and Pub-EAA, and a CA
  certificate with the required key usages for WRPAC and WRPRC.

The healthy seeded document must compile for its family before any mutation is
applied. This prevents unrelated family errors from contaminating a negative
fixture.

### TS 119 612 profile-complete seed

For a broken XML list, create one deterministic seeded provider for every
accepted service profile. EAA-only and QEAA-only lists therefore contain one
seed; a list accepting both contains one EAA seed and one QEAA seed. Provider
identities must remain deterministic and distinguishable.

Service-level mutations run over the entire provider list, so a dual-profile
fixture exercises both accepted profiles.

### Composed signing-certificate defects

Treat signer mutations as requirements on one substitute certificate rather
than sequential certificate replacements.

- `signer_organisation_mismatch` requires subject `O` and `C` to differ from
  the published scheme operator and territory.
- `incorrect_signing_certificate` requires the wrong certificate profile,
  including CA constraints and incompatible key usage.
- When both are selected, mint one certificate satisfying both sets of wrong
  properties.
- Signature-format defects such as a missing signing time and post-signature
  tampering remain independently composable with that certificate.

Each selected signing defect records its own applied mutation, even when the
same synthesized certificate realizes several defects.

## Data Flow

1. Validate the request and every defect identifier against the format-specific
   catalogue view.
2. Compile a healthy family-appropriate seeded artifact.
3. Apply every selected pre-sign mutation.
4. Accumulate signing requirements and sign once with the resulting plan.
5. Apply every selected post-sign mutation.
6. Apply publication-stage mutations, where the format defines them.
7. Check the mutation log against the selected defect set.
8. If any selected defect has no applied mutation, return an error naming those
   defects before immutable storage or signing-configuration update.
9. Otherwise publish the artifact and store fixture evidence.

Mutation order remains the canonical catalogue order so output stays
deterministic regardless of checkbox or API array order.

## Error Handling and Atomicity

Unknown defect identifiers remain request errors.

An applicable defect that cannot mutate the prepared artifact is a creation
error, not a successful fixture with `applied: false`. The error identifies all
unapplied selected defects and preserves their mutation details for diagnosis.

The unapplied-defect gate runs before immutable storage. The signing
configuration is updated only after successful publication, preserving the
existing commit boundary. Healthy list creation remains strict and unchanged.

## GUI and API

Both creation forms continue to render one checkbox per format-supported
defect. Repeated HTML fields and JSON arrays remain the transport representation
for multiple selections.

On a validation error, the forms retain every selected checkbox. Successful GUI
and API responses report the same selected defect set and the same mutation
evidence.

No compatibility matrix or disabled combination is introduced: every subset
offered for a format must compose.

## Testing Strategy

Use test-driven development. Each regression must fail for the intended reason
before production code changes.

### TS 119 602

- Compile the healthy seed for each of the five enabled families.
- Assert family-specific service types, role placement, unique identifiers,
  status fields, and certificate profiles.
- Create a broken list for each family through the core creation path.
- Verify each defect independently.
- Verify representative arbitrary multi-defect selections.
- Verify the complete TS 119 602 defect set in one creation.
- Confirm every selected identifier has an applied mutation and remains
  observable in the final Compact JAdES payload or protected header.

### TS 119 612

- Create EAA-only, QEAA-only, and EAA-plus-QEAA broken fixtures.
- Assert a dual-profile fixture contains and mutates both service profiles.
- Verify each XML defect independently.
- Verify representative arbitrary multi-defect selections.
- Verify the complete TS 119 612 defect set in one creation.
- Verify that combined signer-subject and certificate-profile defects produce
  one certificate with wrong `C`, wrong `O`, CA constraints, and incompatible
  key usage.

### Interfaces and failure behavior

- Verify GUI form parsing and API arrays preserve multiple selections.
- Verify failed form rendering retains all checked defects.
- Verify fixture metadata matches the selected set and applied mutations.
- Verify an intentionally forced unapplied mutation prevents publication and
  signing-configuration changes.
- Re-run healthy creation regressions to prove opt-in isolation.

Testing every mathematical subset is unnecessary: single-defect coverage proves
each independent mutation, representative combinations exercise interactions,
and the complete-set cases prove that all available mutations compose.

## Documentation

Update `README.md`, `SPECS.md`, and `DESIGN.md` with the conjunctive selection
invariant, family-aware seeding, dual-profile XML behavior, and fail-before-
publication rule. Remove wording that describes `applied: false` as an
acceptable published fixture outcome.
