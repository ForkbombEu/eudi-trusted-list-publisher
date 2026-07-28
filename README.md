# EUDI Trusted List Publisher

A TS 119 602 JSON List of Trusted Entities (LoTE) publisher for the Wallet
Provider profile (Annex E). Compiles, validates, signs (JAdES Compact Baseline B),
verifies, stores, and publishes LoTE artefacts. Signing keys are supplied through
local files or CI secrets and are never uploaded through a public web interface.

Includes an immutable filesystem publication store and a read-only Credimi-branded
web UI for browsing published LoTEs. Does not implement TS 119 612 Trusted Lists,
LoTL aggregation, XML/XAdES, or the EC TS02 notification API.

## Important: signature valid vs signer trusted

This tool **cryptographically verifies** signatures but does **not evaluate signer trust**.
The signature validity (`signatureValid`) is distinct from trust (`signerTrustStatus`),
which is always `"not_evaluated"`. No PKIX trust chain validation is performed.

## Technical specs

- **Runtime**: Node.js 24 LTS
- **Language**: TypeScript 5.8
- **Module system**: ESM (`"type": "module"`)
- **Web server**: `node:http` (no framework)
- **Libraries**: `jose` (JOSE/JWS), `ajv` + `ajv-formats` (JSON Schema), `commander` (CLI)

## How to run

```bash
npm install
npm run build
node dist/src/cli/main.js --help
```

Or during development:

```bash
npx tsx src/cli/main.ts --help
```

## CLI Examples

| Command | Example |
|---------|---------|
| `compile` | `trusted-list-publisher compile -i scheme.json -o lote.json` |
| `validate` | `trusted-list-publisher validate -i lote.json --etsi` |
| `sign` | `trusted-list-publisher sign -i lote.json -k key.pem -c cert.pem -o signed.jades` |
| `verify` | `trusted-list-publisher verify -i signed.jades -c cert.pem` |
| `publish` | `trusted-list-publisher publish -i signed.jades -c cert.pem --publication-dir ./publications` |
| `serve` | `trusted-list-publisher serve --publication-dir ./publications --port 8080` |

**Exit codes**:
- 0: success
- 1: general error (invalid JSON, file not found)
- 2: authoring schema validation failure
- 3: ETSI schema validation failure
- 4: missing key or certificate
- 5: signature verification failure

## Quick Web UI Guide

Start the server:

```bash
trusted-list-publisher publish -i signed.jades -c cert.pem
trusted-list-publisher serve
```

Open `http://localhost:8080`. The catalogue page lists all published Wallet
Provider LoTEs with their sequence numbers, issue dates, signature status,
and trust status. Click any list key to browse its version history. Click
any version to see full details including signer certificate metadata and
download links for the Compact JAdES artifact, decoded LoTE JSON, and
publication manifest.

**Every page displays**: "Signer trust: not evaluated."

## API Examples

| Endpoint | curl example |
|----------|-------------|
| List catalogue | `curl http://localhost:8080/api/v1/lists` |
| List index | `curl http://localhost:8080/api/v1/lists/eu_test_authority` |
| Version manifest | `curl http://localhost:8080/api/v1/lists/eu_test_authority/versions/1` |
| LoTE JSON download | `curl http://localhost:8080/api/v1/lists/eu_test_authority/versions/1/lote` |
| JAdES signature download | `curl http://localhost:8080/api/v1/lists/eu_test_authority/versions/1/signature` |
| Manifest download | `curl http://localhost:8080/api/v1/lists/eu_test_authority/versions/1/manifest` |
| OpenAPI spec | `curl http://localhost:8080/openapi.yaml` |
| Health check | `curl http://localhost:8080/healthz` |

API documentation available at `http://localhost:8080/docs` (Stoplight Elements).
