// @ts-nocheck
import { readFileSync, existsSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { getProfile } from "../profiles/registry.js";
export interface SigningConfigEntry { listKey: string; family: string; schemeOperatorName: string; schemeOperatorStreet: string; schemeOperatorCountry: string; schemeName: string; schemeTerritory: string; schemeOperatorContactUri: string; distributionPointUri: string; keyFile: string; certFile: string; }
export interface SigningConfig { lists: SigningConfigEntry[]; }
export interface SigningConfigEntryDisplay { listKey: string; family: string; configured: boolean; certificateSubject?: string; certificateFingerprint?: string; }
export function loadSigningConfig(path) {
    if (!existsSync(path))
        return { lists: [] };
    const content = readFileSync(path, "utf-8");
    const config = path.endsWith(".yaml") || path.endsWith(".yml")
        ? parseYaml(content)
        : JSON.parse(content);
    if (!config || !Array.isArray(config.lists)) throw new Error("Signing configuration must contain a lists array.");
    const keys = new Set();
    for (const entry of config.lists) {
        if (!entry.listKey || !entry.family || !entry.keyFile || !entry.certFile) throw new Error("Each signing configuration entry requires listKey, family, keyFile, and certFile.");
        if (keys.has(entry.listKey)) throw new Error(`Duplicate signing configuration list key: ${entry.listKey}`);
        keys.add(entry.listKey);
        getProfile(entry.family);
        for (const field of ["schemeOperatorName", "schemeOperatorStreet", "schemeOperatorCountry", "schemeName", "schemeTerritory", "schemeOperatorContactUri", "distributionPointUri"]) {
            if (!entry[field]) throw new Error(`Signing configuration '${entry.listKey}' is missing ${field}.`);
        }
    }
    return config;
}
export function findSigningConfig(config, listKey) {
    return config.lists.find((e) => e.listKey === listKey);
}
export function getWalletProviderConfigs(config) {
    return config.lists.filter((e) => e.family === "wallet-providers");
}
export function getFamilyConfigs(config, family) {
    getProfile(family);
    return config.lists.filter((entry) => entry.family === family);
}
export function signingConfigDisplay(config) {
    return config.lists.map((entry) => {
        let certificateSubject;
        let certificateFingerprint;
        if (existsSync(entry.certFile)) {
            try {
                const certPem = readFileSync(entry.certFile, "utf-8");
                const cert = new X509Certificate(certPem);
                certificateSubject = cert.subject.replace(/\n/g, ", ");
                certificateFingerprint = cert.fingerprint256
                    .replace(/:/g, "")
                    .toLowerCase();
            }
            catch {
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
export function loadSigningKey(certFile) {
    return readFileSync(certFile, "utf-8");
}
//# sourceMappingURL=signing-config.js.map
