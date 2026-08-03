#!/usr/bin/env node
/**
 * The TS 119 612 acceptance run, driven through the real HTTP server.
 *
 * It creates one EAA-only and one QEAA-only Trusted List, publishes a provider
 * into each, ends each service, and then checks every artifact the way a
 * consumer would: over HTTP, from the published bytes, with no access to the
 * publisher's internals.
 *
 * The Trust Inspector step needs the network. Everything else is local, so the
 * script reports the Inspector as unavailable rather than failing when it
 * cannot be reached.
 *
 * Artifact locations come from the environment, as `directives/BARIO.md`
 * requires; the default is a temporary directory that is removed at the end.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.env.TLP_ACCEPTANCE_DIR
  ? (mkdirSync(process.env.TLP_ACCEPTANCE_DIR, { recursive: true }),
    process.env.TLP_ACCEPTANCE_DIR)
  : mkdtempSync(join(tmpdir(), "tsl612-acceptance-"));
const KEEP = Boolean(process.env.TLP_ACCEPTANCE_DIR);
const HOST = process.env.TLP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TLP_PORT ?? 8099);
const TOKEN = process.env.TLP_ADMIN_TOKEN ?? "acceptance-token";
const INSPECTOR =
  process.env.TLP_INSPECTOR_URL ?? "https://trust-inspector.credimi.io";

let failures = 0;
let checks = 0;
function check(condition, label, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function generate(name, organisation, territory, eku = false) {
  const dir = join(ROOT, "material");
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, `${name}.key`);
  const certPath = join(dir, `${name}.crt`);
  const cnfPath = join(dir, `${name}.cnf`);
  writeFileSync(
    cnfPath,
    `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nC=${territory}\nO=${organisation}\nCN=${name}\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\n${eku ? "extendedKeyUsage=critical,0.4.0.2231.3.0\n" : ""}`,
  );
  execFileSync("openssl", [
    "genpkey", "-out", keyPath, "-algorithm", "EC",
    "-pkeyopt", "ec_paramgen_curve:P-256",
  ]);
  execFileSync("openssl", [
    "req", "-new", "-x509", "-key", keyPath, "-out", certPath,
    "-days", "365", "-config", cnfPath, "-extensions", "ext",
  ]);
  const pem = readFileSync(certPath, "utf-8");
  return {
    keyFile: keyPath,
    certFile: certPath,
    pem,
    der: Buffer.from(
      pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
      "base64",
    ).toString("base64"),
  };
}

const base = `http://${HOST}:${PORT}`;
const headers = { Cookie: `tlp_admin_token=${TOKEN}` };

async function get(path) {
  return fetch(`${base}${path}`, { headers, redirect: "manual" });
}
async function post(path, fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const v of value) body.append(key, v);
    else body.append(key, value);
  }
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });
}

async function main() {
  const { createWebServer } = await import("../dist/src/web/server.js");
  const { verifyTrustedList } = await import("../dist/src/core/tsl612/sign.js");
  const { readTrustedList } = await import("../dist/src/core/tsl612/read.js");

  writeFileSync(join(ROOT, "signing-config.json"), JSON.stringify({ lists: [] }));
  const server = createWebServer({
    publicationDir: join(ROOT, "publications"),
    authoringDir: join(ROOT, "authoring"),
    signingConfigPath: join(ROOT, "signing-config.json"),
    dataCollectionGui: true,
    adminToken: TOKEN,
  });
  await new Promise((done) => server.listen(PORT, HOST, done));
  console.log(`\nServer listening on ${base}\n`);

  try {
    const eaaSigner = generate("eaa-signer", "Acceptance EAA Operator", "IT", true);
    const qeaaSigner = generate("qeaa-signer", "Acceptance QEAA Operator", "IT", true);
    const provider = generate("provider", "Acceptance Provider SpA", "IT");

    async function createList(operator, profiles, signer) {
      const response = await post("/admin/trusted-lists/create", {
        schemeOperatorName: operator,
        schemeTerritory: "IT",
        schemeName: `IT:${operator}`,
        schemeOperatorStreet: "Via Roma 1",
        schemeOperatorLocality: "Roma",
        schemeOperatorPostalCode: "00100",
        schemeOperatorCountry: "IT",
        schemeOperatorEmail: "op@example.it",
        schemeOperatorWebsite: "https://example.it",
        schemeInformationUri: "https://example.it/scheme",
        nationalSchemeRulesUri: "https://example.it/rules",
        policyUri: "https://example.it/policy",
        distributionPointUri: "https://example.it/trusted-list.xml",
        /* The pointer operator must match the pointer certificate subject. */
        lotlSchemeOperatorNames: operator,
        lotlCertificatesBase64Der: signer.der,
        keyFile: signer.keyFile,
        certFile: signer.certFile,
        allowedServiceProfiles: profiles,
      });
      if (response.status !== 303)
        throw new Error(`list creation failed: ${await response.text()}`);
      return (response.headers.get("location") ?? "").replace("/lists/", "");
    }

    console.log("1. Create one EAA-only and one QEAA-only XML Trusted List");
    const eaaList = await createList("Acceptance EAA Operator", ["eaa-providers"], eaaSigner);
    const qeaaList = await createList("Acceptance QEAA Operator", ["qeaa-providers"], qeaaSigner);
    check(Boolean(eaaList), `EAA list created: ${eaaList}`);
    check(Boolean(qeaaList), `QEAA list created: ${qeaaList}`);

    console.log("\n2. Submit, approve and publish one provider into each");
    async function publishInto(route, listKey, serviceName) {
      const submitted = await post(route, {
        listKey,
        tspName: "Acceptance Provider SpA",
        registrationIdentifier: "12345678901",
        registrationIdentifierKind: "vat",
        streetAddress: "Via Milano 2",
        locality: "Milano",
        postalCode: "20121",
        countryName: "IT",
        email: "info@example.it",
        website: "https://provider.example.it",
        tspInformationUri: "https://provider.example.it/practices",
        serviceName,
        certificatePem: provider.pem,
        evidence: "ACCEPTANCE-EVIDENCE-MUST-NOT-BE-PUBLISHED",
      });
      if (submitted.status !== 200)
        throw new Error(`submission failed: ${await submitted.text()}`);
      const html = await (await get("/admin/xml-applications")).text();
      const ids = [...html.matchAll(/\/admin\/xml-applications\/([0-9a-f-]{36})/g)].map(
        (m) => m[1],
      );
      const id = ids[0];
      await post(`/admin/xml-applications/${id}/approve`, {});
      const published = await post(`/admin/xml-applications/${id}/publish`, {});
      if (published.status !== 200)
        throw new Error(`publication failed: ${await published.text()}`);
      return id;
    }
    const eaaId = await publishInto("/onboarding/eaa-provider", eaaList, "Acceptance EAA Issuance");
    const qeaaId = await publishInto("/onboarding/qeaa-provider", qeaaList, "Acceptance QEAA Issuance");
    check(Boolean(eaaId), "EAA provider published");
    check(Boolean(qeaaId), "QEAA provider published");

    console.log("\n3. Deprecate the EAA service and withdraw the QEAA service");
    check(
      (await post(`/admin/xml-applications/${eaaId}/supersede`, {})).status === 200,
      "EAA national recognition deprecated",
    );
    check(
      (await post(`/admin/xml-applications/${qeaaId}/supersede`, {})).status === 200,
      "QEAA qualified status withdrawn",
    );

    console.log("\n4. Every version: schema, signature, digest, immutability");
    const expected = {
      [eaaList]: {
        type: "http://uri.etsi.org/TrstSvc/Svctype/EAA",
        initial: "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/recognisedatnationallevel",
        end: "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/deprecatedatnationallevel",
      },
      [qeaaList]: {
        type: "http://uri.etsi.org/TrstSvc/Svctype/EAA/Q",
        initial: "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted",
        end: "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/withdrawn",
      },
    };
    const xmlByVersion = {};
    for (const listKey of [eaaList, qeaaList]) {
      for (const sequence of [1, 2, 3]) {
        const response = await get(
          `/api/v1/lists/${listKey}/versions/${sequence}/trusted-list.xml`,
        );
        check(response.status === 200, `${listKey} v${sequence} XML is served`);
        check(
          response.headers.get("content-type") === "application/vnd.etsi.tsl+xml",
          `${listKey} v${sequence} served as application/vnd.etsi.tsl+xml`,
        );
        const xml = await response.text();
        xmlByVersion[`${listKey}/${sequence}`] = xml;

        const verification = verifyTrustedList(xml);
        check(
          verification.schema.valid,
          `${listKey} v${sequence} validates against the pinned schemas`,
          verification.schema.findings.map((f) => f.message).join("; "),
        );
        check(
          verification.signature.valid,
          `${listKey} v${sequence} XAdES signature verifies locally`,
          verification.signature.findings.join("; "),
        );

        const sha2 = await (
          await get(`/api/v1/lists/${listKey}/versions/${sequence}/trusted-list.sha2`)
        ).text();
        check(
          sha2 === createHash("sha256").update(Buffer.from(xml, "utf-8")).digest("hex"),
          `${listKey} v${sequence} .sha2 matches the exact XML bytes`,
        );

        check(
          !xml.includes("ACCEPTANCE-EVIDENCE-MUST-NOT-BE-PUBLISHED"),
          `${listKey} v${sequence} does not publish the review evidence`,
        );
      }

      /* Statuses and history. */
      const v1 = readTrustedList(xmlByVersion[`${listKey}/1`]);
      check(!v1.providers, `${listKey} v1 is empty: no TrustServiceProviderList`);

      const v2 = readTrustedList(xmlByVersion[`${listKey}/2`]).providers[0].services[0];
      check(
        v2.serviceTypeIdentifier === expected[listKey].type,
        `${listKey} v2 publishes the family service type`,
      );
      check(
        v2.serviceStatus === expected[listKey].initial,
        `${listKey} v2 publishes the family initial status`,
      );

      const v3 = readTrustedList(xmlByVersion[`${listKey}/3`]).providers[0].services[0];
      check(
        v3.serviceStatus === expected[listKey].end,
        `${listKey} v3 publishes the family end status`,
      );
      check(
        v3.serviceHistory?.length === 1 &&
          v3.serviceHistory[0].serviceStatus === expected[listKey].initial,
        `${listKey} v3 moved the previous state into ServiceHistory`,
      );
      check(
        Boolean(v3.serviceHistory?.[0]?.digitalIdentity?.x509SkiBase64) &&
          !v3.serviceHistory[0].digitalIdentity.x509CertificateBase64Der,
        `${listKey} v3 history carries X509SKI and no X509Certificate`,
      );

      /* Immutability: v2 still says what it said. */
      const v2again = readTrustedList(
        await (await get(`/api/v1/lists/${listKey}/versions/2/trusted-list.xml`)).text(),
      ).providers[0].services[0];
      check(
        v2again.serviceStatus === expected[listKey].initial,
        `${listKey} v2 is unchanged after v3 was published`,
      );

      /* Stable latest URLs point at the newest version. */
      const latestXml = await (await get(`/lists/${listKey}/latest/trusted-list.xml`)).text();
      check(
        latestXml === xmlByVersion[`${listKey}/3`],
        `${listKey} latest/trusted-list.xml serves version 3`,
      );
      const latestSha2 = await (await get(`/lists/${listKey}/latest/trusted-list.sha2`)).text();
      check(
        latestSha2 ===
          createHash("sha256").update(Buffer.from(latestXml, "utf-8")).digest("hex"),
        `${listKey} latest/trusted-list.sha2 matches latest/trusted-list.xml`,
      );
    }

    console.log("\n5. Routes: pages, downloads and API");
    for (const [label, path, expect] of [
      ["Catalogue", "/", 200],
      ["Onboarding catalogue", "/onboarding", 200],
      ["EAA onboarding form", "/onboarding/eaa-provider", 200],
      ["QEAA onboarding form", "/onboarding/qeaa-provider", 200],
      ["Administration", "/admin", 200],
      ["XML applications", "/admin/xml-applications", 200],
      ["Create XML Trusted List", "/admin/trusted-lists/create", 200],
      ["EAA list page", `/lists/${eaaList}`, 200],
      ["EAA version page", `/lists/${eaaList}/versions/3`, 200],
      ["EAA list API", `/api/v1/lists/${eaaList}`, 200],
      ["EAA version API", `/api/v1/lists/${eaaList}/versions/3`, 200],
      ["EAA manifest", `/api/v1/lists/${eaaList}/versions/3/manifest`, 200],
      ["Health", "/healthz", 200],
      ["An XML list has no lote artifact", `/api/v1/lists/${eaaList}/versions/3/lote`, 404],
      ["An XML list has no detached signature", `/api/v1/lists/${eaaList}/versions/3/signature`, 404],
    ]) {
      const response = await get(path);
      check(response.status === expect, `${label} → HTTP ${expect}`, `got ${response.status}`);
    }

    console.log("\n6. No enabled onboarding card leads to a 404");
    const onboardingHtml = await (await get("/onboarding")).text();
    const routes = [...new Set(
      [...onboardingHtml.matchAll(/href="(\/onboarding\/[a-z-]+)"/g)].map((m) => m[1]),
    )];
    check(routes.length >= 7, `onboarding offers ${routes.length} routes`);
    for (const route of routes) {
      check((await get(route)).status === 200, `${route} → HTTP 200`);
    }

    console.log("\n7. Catalogue and version copy");
    check(onboardingHtml.includes("EAA Providers"), "onboarding names EAA Providers");
    check(onboardingHtml.includes("QEAA Providers"), "onboarding names QEAA Providers");
    const versionHtml = await (await get(`/lists/${eaaList}/versions/3`)).text();
    check(versionHtml.includes("ETSI TS 119 612"), "version page states the standard");
    check(versionHtml.includes("XML / XAdES-B-B"), "version page states the format");
    check(
      !versionHtml.includes("Compact JAdES"),
      "version page never promises Compact JAdES",
    );

    console.log("\n8. Trust Inspector (live)");
    let inspectorReported = false;
    for (const [listKey, sequence] of [[eaaList, 3], [qeaaList, 3]]) {
      const xml = xmlByVersion[`${listKey}/${sequence}`];
      let body = null;
      try {
        const response = await fetch(`${INSPECTOR}/api/audit/artifact`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: xml,
            source: `${base}/lists/${listKey}/versions/${sequence}`,
            contentType: "application/vnd.etsi.tsl+xml",
            options: { timeoutMs: 30000 },
          }),
          signal: AbortSignal.timeout(45000),
        });
        if (response.ok) body = await response.json();
      } catch (error) {
        console.log(`  note  Inspector unreachable: ${error.message}`);
      }
      if (!body?.result) {
        console.log(`  note  ${listKey}: Inspector unavailable — not a conformance claim`);
        continue;
      }
      inspectorReported = true;
      const result = body.result;
      const section = result.ts119612 ?? {};
      const fails = (section.checks ?? []).filter(
        (c) => c.status === "fail" && c.category !== "fetch",
      );
      check(
        result.detected?.artifactKind === "ts119612_xml_tsl",
        `${listKey}: Inspector detects ts119612_xml_tsl`,
        String(result.detected?.artifactKind),
      );
      check(
        result.standardApplicability?.ts119612 === "applicable",
        `${listKey}: Inspector applies TS 119 612`,
      );
      const serviceChecks = (section.checks ?? []).filter((c) =>
        c.id.startsWith("ts119612.service."),
      );
      check(serviceChecks.length > 0, `${listKey}: Inspector evaluated the service`);
      check(
        fails.length === 0,
        `${listKey}: zero locally decidable failures`,
        fails.map((f) => `${f.id}: ${f.message}`).join(" | "),
      );
      const counts = (section.checks ?? []).reduce((acc, c) => {
        acc[c.status] = (acc[c.status] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`  info  ${listKey} checks: ${JSON.stringify(counts)}`);
    }
    if (!inspectorReported)
      console.log("  note  Inspector was not reachable; local checks above still stand.");

    console.log(`\n${checks - failures}/${checks} checks passed.`);
    console.log(`LAN URLs while this server runs: ${base}/ and ${base}/lists/${eaaList}`);
  } finally {
    await new Promise((done) => server.close(done));
    if (!KEEP) rmSync(ROOT, { recursive: true, force: true });
    else console.log(`Artifacts kept in ${ROOT}`);
  }

  process.exit(failures === 0 ? 0 : 1);
}

await main();
