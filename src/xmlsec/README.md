# xmlsec

An enveloped **XAdES-B-B** signer and verifier for XML documents, written for
this repository but deliberately self-contained.

Nothing in this directory imports from `src/core`, knows what a Trusted List
is, or reads an environment variable. Its only dependencies are `node:crypto`
and `libxml2-wasm`, so it can be lifted out into a package of its own without
untangling it from the publisher first.

## What it implements

- Enveloped XML signature over the whole document, per W3C XMLDSig
- Enveloped-signature transform followed by Exclusive XML Canonicalisation
- Exclusive canonicalisation for `SignedInfo`
- XAdES `SignedProperties` covered by its own `ds:Reference`
- `SigningTime` and `SigningCertificateV2`, per ETSI EN 319 132-1
- `ds:KeyInfo/X509Data` carrying exactly one certificate
- ECDSA-SHA256 and RSA-SHA256, with SHA-256 digests throughout
- Local verification: re-canonicalises and re-checks every digest and the
  signature itself, from the serialized document rather than from any state
  the signer kept

## What it does not do

- No certification path building, no revocation checking, no trust decision.
  Verification answers "was this document signed by the key in this
  certificate", never "should you trust it".
- No `-T`, `-LT` or `-LTA` levels. B-B only.
- No detached or enveloping signatures.
- No key generation and no key storage.

## Usage

```ts
import { signEnveloped, verifyEnveloped } from "./index.js";

const signed = signEnveloped(xml, {
  privateKeyPem,
  certificatePem,
  signingTime: new Date(),
});

const result = verifyEnveloped(signed);
// result.valid, result.findings, result.signingTime, result.certificatePem
```

## Why the signature is assembled as text

The signature is built by serializing, re-parsing and canonicalising the real
document at each stage, rather than by mutating a DOM the signer holds. Every
digest is therefore computed from bytes a verifier could produce on its own. A
signer that digests its private in-memory tree can produce a signature that
only it can check.
