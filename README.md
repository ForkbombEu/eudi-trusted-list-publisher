# EUDI Trusted List Publisher

A TS 119 602 JSON List of Trusted Entities (LoTE) publisher for the Wallet
Provider profile (Annex E). Signing keys are supplied through local files or
CI secrets and are never uploaded through a public web interface.

This first vertical slice implements compilation, schema validation,
JAdES Compact Baseline B signing, and verification for single LoTE
artifacts. It does not yet implement TS 119 612 Trusted Lists, LoTL
aggregation, XML/XAdES, or the EC TS02 notification API.

## Technical specs

- **Runtime**: Node.js 24 LTS
- **Language**: TypeScript 5.8
- **Module system**: ESM (`"type": "module"`)
- **Libraries**:
  - `jose` (JOSE/JWS)
  - `ajv` + `ajv-formats` (JSON Schema validation)
  - `commander` (CLI argument parsing)

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
| `sign` | `trusted-list-publisher sign -i lote.json -k key.pem -c cert.pem -o signed.txt` |
| `verify` | `trusted-list-publisher verify -i signed.txt -c cert.pem` |

**Exit codes**:
- 0: success
- 1: general error (invalid JSON, file not found)
- 2: authoring schema validation failure
- 3: ETSI schema validation failure
- 4: missing key or certificate
- 5: signature verification failure
