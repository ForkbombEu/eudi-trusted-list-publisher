import { readFileSync, existsSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { parse as parseYaml } from "yaml";

export interface SigningConfigEntry {
  listKey: string;
  family: string;
  schemeOperatorName: string;
  schemeOperatorStreet: string;
  schemeOperatorCountry: string;
  schemeName: string;
  schemeTerritory: string;
  schemeOperatorContactUri: string;
  distributionPointUri: string;
  keyFile: string;
  certFile: string;
}

export interface SigningConfig {
  lists: SigningConfigEntry[];
}

export interface SigningConfigEntryDisplay {
  listKey: string;
  family: string;
  configured: boolean;
  certificateSubject?: string;
  certificateFingerprint?: string;
}

export function loadSigningConfig(path: string): SigningConfig {
  if (!existsSync(path)) return { lists: [] };
  const content = readFileSync(path, "utf-8");
  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    return parseYaml(content) as SigningConfig;
  }
  return JSON.parse(content) as SigningConfig;
}

export function findSigningConfig(
  config: SigningConfig,
  listKey: string,
): SigningConfigEntry | undefined {
  return config.lists.find((e) => e.listKey === listKey);
}

export function getWalletProviderConfigs(
  config: SigningConfig,
): SigningConfigEntry[] {
  return config.lists.filter((e) => e.family === "wallet-providers");
}

export function signingConfigDisplay(
  config: SigningConfig,
): SigningConfigEntryDisplay[] {
  return config.lists.map((entry) => {
    let certificateSubject: string | undefined;
    let certificateFingerprint: string | undefined;

    if (existsSync(entry.certFile)) {
      try {
        const certPem = readFileSync(entry.certFile, "utf-8");
        const cert = new X509Certificate(certPem);
        certificateSubject = cert.subject.replace(/\n/g, ", ");
        certificateFingerprint = cert.fingerprint256
          .replace(/:/g, "")
          .toLowerCase();
      } catch {
        /* leave undefined */
      }
    }

    return {
      listKey: entry.listKey,
      family: entry.family,
      configured: existsSync(entry.certFile) && existsSync(entry.keyFile),
      certificateSubject,
      certificateFingerprint,
    };
  });
}

export function loadSigningKey(certFile: string): string {
  return readFileSync(certFile, "utf-8");
}
