# EAA and QEAA example

A worked TS 119 612 example: one national Trusted List accepting both service
profiles, and one EAA provider listed in it.

Nothing here is a fixture the tests read. It shows the two shapes an operator
actually supplies — the list configuration and the onboarding submission — so
the field names in `signing-config.json` and in the POST body are visible in one
place.

## Files

| File | What it is |
|------|-----------|
| `signing-config-entry.json` | One `lists:` entry declaring an XML Trusted List |
| `eaa-submission.txt` | The form fields a `POST /onboarding/eaa-provider` sends |
| `qeaa-submission.txt` | The same for `POST /onboarding/qeaa-provider` |

## Creating the list

The entry below goes in the `lists:` array of the file `TLP_SIGNING_CONFIG`
points at, beside any TS 119 602 entries. It is discriminated by `standard`; an
entry without that field is read as TS 119 602, which is why existing
configurations keep loading unchanged.

In practice the administration form writes this for you, and publishes the
list's empty first version at the same time. Writing it by hand declares a list
whose version 1 does not exist yet.

## Verifying what was published

```sh
LIST=it_example_scheme_operator
curl -so trusted-list.xml http://localhost:8080/lists/$LIST/latest/trusted-list.xml
curl -s http://localhost:8080/lists/$LIST/latest/trusted-list.sha2 > expected.sha2
test "$(sha256sum trusted-list.xml | cut -d' ' -f1)" = "$(cat expected.sha2)" \
  && echo "digest matches the published bytes"
```

The XAdES-B-B signature is inside `trusted-list.xml`; there is no detached
signature file. `verifyTrustedList()` from `src/core/index.ts` checks the
document against the pinned TS 119 612 schemas and re-verifies the signature
from the bytes alone.
