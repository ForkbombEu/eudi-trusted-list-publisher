import { CERTIFICATE_INPUT_MESSAGES } from "../../core/authoring/certificate-input.js";

/** Title of the page and of the footer Resources entry that links to it. */
export const CERTIFICATE_GUIDE_TITLE = "Certificate creation";

/** Route of this page. Linked from the footer and from both onboarding forms. */
export const CERTIFICATE_GUIDE_PATH = "/docs/certificate-creation";

/** Label of the onboarding field this page explains. */
export const CERTIFICATE_FIELD_LABEL =
  "Service Digital Identity Certificate (PEM)";

/*
  The OpenSSL workflow is the substance of this page, so the commands are the
  only content that is laid out verbatim. Everything around them explains just
  enough to pick the right object and to keep the private key at the provider.
*/

const SELF_SIGNED_WORKFLOW = `ORGANISATION_NAME="Example Wallet Provider"
SERVICE_NAME="Example Wallet Service"
COUNTRY_CODE="DK"

# 1. Generate the private key. Keep this secret and never upload it.
openssl genpkey \\
  -algorithm EC \\
  -pkeyopt ec_paramgen_curve:P-256 \\
  -out service-private-key.pem

# 2. Export the public key for inspection or use by the service.
# This file is not uploaded to Credimi.
openssl pkey \\
  -in service-private-key.pem \\
  -pubout \\
  -out service-public-key.pem

# 3. Create a self-signed X.509 certificate for testing.
openssl req \\
  -new \\
  -x509 \\
  -key service-private-key.pem \\
  -sha256 \\
  -days 365 \\
  -out service-certificate.pem \\
  -subj "/C=\${COUNTRY_CODE}/O=\${ORGANISATION_NAME}/CN=\${SERVICE_NAME}" \\
  -addext "basicConstraints=critical,CA:FALSE" \\
  -addext "keyUsage=critical,digitalSignature" \\
  -addext "subjectKeyIdentifier=hash"

# 4. Inspect the certificate.
openssl x509 \\
  -in service-certificate.pem \\
  -noout \\
  -subject \\
  -issuer \\
  -dates \\
  -fingerprint \\
  -sha256`;

const KEY_MATCH_CHECK = `openssl pkey \\
  -in service-private-key.pem \\
  -pubout \\
  -outform DER |
openssl sha256

openssl x509 \\
  -in service-certificate.pem \\
  -pubkey \\
  -noout |
openssl pkey \\
  -pubin \\
  -outform DER |
openssl sha256`;

const CSR_WORKFLOW = `openssl req \\
  -new \\
  -key service-private-key.pem \\
  -out service-certificate.csr \\
  -subj "/C=\${COUNTRY_CODE}/O=\${ORGANISATION_NAME}/CN=\${SERVICE_NAME}"`;

const DER_TO_PEM = `openssl x509 \\
  -inform DER \\
  -in service-certificate.der \\
  -out service-certificate.pem`;

const PKCS12_EXTRACTION = `openssl pkcs12 \\
  -in service-identity.p12 \\
  -clcerts \\
  -nokeys \\
  -out extracted-certificate.pem

openssl x509 \\
  -in extracted-certificate.pem \\
  -out service-certificate.pem`;

function block(commands: string): string {
  return `<pre><code>${escape(commands)}</code></pre>`;
}

/** What the applicant supplied, in the order the parser reports it. */
const REJECTED_INPUTS: ReadonlyArray<
  readonly [keyof typeof CERTIFICATE_INPUT_MESSAGES, string]
> = [
  ["private-key", "A private key"],
  ["public-key", "A public key"],
  ["certificate-request", "A signing request"],
  ["pkcs12", "A PKCS#12/PFX bundle"],
  ["unparseable-certificate", "A damaged certificate block"],
];

/**
 * Rendered from the parser's own message table, so the page cannot drift from
 * what the form actually says.
 */
function rejectionRows(): string {
  return REJECTED_INPUTS.map(
    ([kind, what]) =>
      `      <tr><th>${escape(what)}</th><td>${escape(
        CERTIFICATE_INPUT_MESSAGES[kind],
      )}</td></tr>`,
  ).join("\n");
}

export function certificateGuideHtml(): string {
  return `
<h1>${escape(CERTIFICATE_GUIDE_TITLE)}</h1>
<p class="lead">Every service you register in a List of Trusted Entities is
identified by one X.509 certificate. This page explains which object the
onboarding form expects, and how to create it with OpenSSL. The field is labelled
<strong>${escape(CERTIFICATE_FIELD_LABEL)}</strong> on the Wallet Provider and PID
Provider forms.</p>

<div class="notice notice-warning">
  The private key stays with the provider and is never uploaded. Upload
  <code>service-certificate.pem</code> only.
</div>

<div class="card">
  <h2>What the certificate is for</h2>
  <p><code>ServiceDigitalIdentity</code> is the component of a TS 119 602 List of
  Trusted Entities that says <em>which key material a relying party may trust for
  this service</em>. For a Wallet Solution Issuance or Revocation service, and for
  a PID Issuance or Revocation service, it carries the X.509 certificate of that
  service. Relying parties read the published list, take that certificate, and use
  it to recognise the service. That is why the list needs the certificate: without
  it an entry names a provider but gives nothing to verify against.</p>
  <p>This publisher populates <code>ServiceDigitalIdentity</code> with
  <code>X509Certificates</code> only, and it never builds or verifies a
  certification path. A <strong>self-signed</strong> certificate is therefore
  accepted and is the simplest option for testing. A <strong>CA-issued</strong>
  certificate is equally accepted; in production the certificate is normally
  issued by the CA your scheme requires.</p>
  <p>The certificate subject must identify the provider. Set the organisation
  (<code>O</code>) to <strong>exactly</strong> the Trusted Entity Name you enter
  during onboarding — the <em>Entity Name</em> field — or the submission is
  rejected.</p>
</div>

<div class="card">
  <h2>Which object do you have?</h2>
  <p>These names are often used as if they were interchangeable. They are not.</p>
  <table class="kv-table">
    <tbody>
      <tr>
        <th>PEM</th>
        <td>An <em>encoding</em>, not a type of certificate: base64 text between
        <code>-----BEGIN …-----</code> and <code>-----END …-----</code> lines. A
        private key, a public key, a request and a certificate can all be PEM.
        Read the label on the first line to know what you have.</td>
      </tr>
      <tr>
        <th>X.509 certificate</th>
        <td>What the form needs, in PEM form. Its first line is
        <code>-----BEGIN CERTIFICATE-----</code>.</td>
      </tr>
      <tr>
        <th>PKCS#8</th>
        <td>Normally contains a <em>private key</em>
        (<code>-----BEGIN PRIVATE KEY-----</code>). Never upload it.</td>
      </tr>
      <tr>
        <th>PKCS#10</th>
        <td>A certificate-signing request
        (<code>-----BEGIN CERTIFICATE REQUEST-----</code>). It is what you send to
        a CA, not what you publish.</td>
      </tr>
      <tr>
        <th>PKCS#12 / PFX</th>
        <td>A binary bundle of a certificate <em>and</em> its private key, usually
        <code>.p12</code> or <code>.pfx</code>. Extract the certificate to PEM
        first — see below.</td>
      </tr>
      <tr>
        <th>DER</th>
        <td>The binary encoding of the same certificate. Convert it to PEM before
        uploading.</td>
      </tr>
    </tbody>
  </table>
</div>

<div class="card">
  <h2>Complete self-signed test workflow</h2>
  ${block(SELF_SIGNED_WORKFLOW)}
  <p><strong>Upload <code>service-certificate.pem</code>. Do not upload
  <code>service-private-key.pem</code> or
  <code>service-public-key.pem</code>.</strong></p>
</div>

<div class="card">
  <h2>Confirm that the certificate matches the private key</h2>
  <p>These two commands must produce the same SHA-256 value. If they differ, the
  certificate does not belong to that key and the service will not be able to use
  it.</p>
  ${block(KEY_MATCH_CHECK)}
</div>

<div class="card">
  <h2>CA-issued certificate workflow</h2>
  <p>Reuse the private key from step 1 and create a certificate-signing request
  instead of a self-signed certificate:</p>
  ${block(CSR_WORKFLOW)}
  <p>Send <code>service-certificate.csr</code> to the CA your scheme selects. The
  CA returns the service certificate; upload that, converting it to PEM first if
  it arrives in another encoding. The private key never leaves your side during
  this exchange.</p>
  <h3>DER to PEM</h3>
  ${block(DER_TO_PEM)}
  <h3>PKCS#12 / PFX certificate extraction</h3>
  ${block(PKCS12_EXTRACTION)}
</div>

<div class="card">
  <h2>What the form rejects</h2>
  <p>A parseable self-signed or CA-issued X.509 PEM certificate is accepted.
  Anything else is reported against the certificate field:</p>
  <table class="kv-table">
    <tbody>
${rejectionRows()}
      <tr><th>A provider-name mismatch</th><td>The certificate subject and the
      expected Trusted Entity Name are both named in the message, so you can see
      which one to correct.</td></tr>
    </tbody>
  </table>
  <p class="field-help">A file that contains the private key <em>and</em> the
  certificate is rejected as a private key. Split it and upload the certificate
  alone.</p>
</div>
`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
