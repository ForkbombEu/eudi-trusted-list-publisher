// @ts-nocheck
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, unlinkSync, lstatSync, realpathSync, } from "node:fs";
import { resolve, sep } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { X509Certificate } from "node:crypto";
import { APPLICATION_SCHEMA_VERSION } from "./application-model.js";
import { getProfile } from "../profiles/registry.js";
const SAFE_ID_RE = /^[a-f0-9-]{32,128}$/;
export class AuthoringStore {
    authoringDir;
    canonicalRoot;
    constructor(config) {
        const raw = resolve(config.authoringDir);
        if (!existsSync(raw)) {
            mkdirSync(raw, { recursive: true });
        }
        if (lstatSync(raw).isSymbolicLink()) {
            throw new Error("Authoring root is a symlink — rejected for security");
        }
        const real = realpathSync(raw);
        if (real !== resolve(raw) && !isSubpath(resolve(raw), real)) {
            throw new Error("Authoring root canonical path mismatch");
        }
        this.authoringDir = raw;
        this.canonicalRoot = real;
    }
    appPath(id) {
        if (!SAFE_ID_RE.test(id)) {
            throw new Error(`Unsafe application ID: "${id}"`);
        }
        return resolve(this.canonicalRoot, `${id}.json`);
    }
    assertCanonicalRoot() {
        if (existsSync(this.canonicalRoot)) {
            const real = realpathSync(this.canonicalRoot);
            if (real !== this.canonicalRoot) {
                throw new Error("Authoring root was redirected — canonical root changed");
            }
        }
    }
    save(app) {
        this.assertCanonicalRoot();
        const ver = validateApplication(app, app.id);
        if (!ver.valid) {
            throw new Error(`Cannot save invalid application: ${ver.reason}`);
        }
        const path = this.appPath(app.id);
        const tmpPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
        try {
            writeFileSync(tmpPath, JSON.stringify(app, null, 2), {
                encoding: "utf-8",
                flag: "wx",
            });
            renameSync(tmpPath, path);
        }
        catch (e) {
            try {
                unlinkSync(tmpPath);
            }
            catch {
                /* ignore */
            }
            throw e;
        }
    }
    load(id) {
        this.assertCanonicalRoot();
        const path = this.appPath(id);
        if (!existsSync(path))
            return null;
        if (lstatSync(path).isSymbolicLink())
            return null;
        try {
            const raw = readFileSync(path, "utf-8");
            const parsed = JSON.parse(raw);
            const ver = validateApplication(parsed, id);
            if (!ver.valid)
                return null;
            return parsed;
        }
        catch {
            return null;
        }
    }
    delete(id) {
        this.assertCanonicalRoot();
        const app = this.load(id);
        if (!app)
            return false;
        const path = this.appPath(id);
        unlinkSync(path);
        return true;
    }
    list() {
        this.assertCanonicalRoot();
        if (!existsSync(this.canonicalRoot))
            return [];
        const entries = readdirSync(this.canonicalRoot, {
            withFileTypes: true,
        });
        const apps = [];
        for (const e of entries) {
            if (!e.isFile())
                continue;
            if (!e.name.endsWith(".json"))
                continue;
            const id = e.name.slice(0, -5);
            if (!SAFE_ID_RE.test(id))
                continue;
            const app = this.load(id);
            if (app)
                apps.push(app);
        }
        apps.sort((a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime());
        return apps;
    }
    createId() {
        return randomUUID();
    }
}
const SAFE_KEY_RE_STRICT = /^[a-z0-9][a-z0-9_]{0,99}$/;
function validateApplication(obj, expectedId) {
    if (typeof obj !== "object" || obj === null) {
        return { valid: false, reason: "not an object" };
    }
    const app = obj;
    if (typeof app.id !== "string" || app.id !== expectedId) {
        return { valid: false, reason: "id mismatch or missing" };
    }
    if (!SAFE_ID_RE.test(app.id)) {
        return { valid: false, reason: "unsafe id" };
    }
    if (app.schemaVersion !== APPLICATION_SCHEMA_VERSION) {
        return { valid: false, reason: "unsupported schemaVersion" };
    }
    try { getProfile(app.family); } catch { return { valid: false, reason: "unsupported family" }; }
    if (typeof app.targetListKey !== "string" ||
        !SAFE_KEY_RE_STRICT.test(app.targetListKey)) {
        return { valid: false, reason: "unsafe or missing targetListKey" };
    }
    const state = app.state;
    const allowedStates = ["submitted", "approved", "rejected", "published"];
    if (typeof state !== "string" || !allowedStates.includes(state)) {
        return { valid: false, reason: `invalid state: ${String(state)}` };
    }
    if (typeof app.submittedAt !== "string" || !isIsoString(app.submittedAt)) {
        return { valid: false, reason: "invalid submittedAt" };
    }
    if (!isValidApplicantData(app.applicantData, app.family))
        return { valid: false, reason: "invalid applicantData" };
    // Lifecycle consistency checks
    if (state === "submitted") {
        if (app.approvedAt !== undefined)
            return { valid: false, reason: "submitted with approvedAt" };
        if (app.rejectedAt !== undefined)
            return { valid: false, reason: "submitted with rejectedAt" };
        if (app.adminNote !== undefined)
            return { valid: false, reason: "submitted with adminNote" };
        if (app.publication !== undefined)
            return { valid: false, reason: "submitted with publication" };
    }
    if (state === "approved") {
        if (!isIsoString(app.approvedAt))
            return { valid: false, reason: "approved without valid approvedAt" };
        if (app.rejectedAt !== undefined)
            return { valid: false, reason: "approved with rejectedAt" };
        if (app.adminNote !== undefined)
            return { valid: false, reason: "approved with adminNote" };
        if (app.publication !== undefined)
            return { valid: false, reason: "approved with publication" };
    }
    if (state === "rejected") {
        if (!isIsoString(app.rejectedAt))
            return { valid: false, reason: "rejected without valid rejectedAt" };
        if (typeof app.adminNote !== "string" || !app.adminNote.trim())
            return { valid: false, reason: "rejected without non-empty adminNote" };
        if (app.approvedAt !== undefined)
            return { valid: false, reason: "rejected with approvedAt" };
        if (app.publication !== undefined)
            return { valid: false, reason: "rejected with publication" };
    }
    if (state === "published") {
        if (!isIsoString(app.approvedAt))
            return { valid: false, reason: "published without valid approvedAt" };
        if (app.rejectedAt !== undefined)
            return { valid: false, reason: "published with rejectedAt" };
        if (app.adminNote !== undefined)
            return { valid: false, reason: "published with adminNote" };
        if (!isValidPublication(app))
            return {
                valid: false,
                reason: "published without complete publication metadata or listKey mismatch",
            };
    }
    return { valid: true };
}
function isIsoString(s) {
    if (typeof s !== "string")
        return false;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/);
    if (!m)
        return false;
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    const hour = parseInt(m[4], 10);
    const min = parseInt(m[5], 10);
    const sec = parseInt(m[6], 10);
    if (month < 1 || month > 12)
        return false;
    if (hour > 23 || min > 59 || sec > 59)
        return false;
    const daysInMonth = [
        31,
        isLeapYear(year) ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if (day < 1 || day > daysInMonth[month - 1])
        return false;
    return true;
}
function isLeapYear(y) {
    if (y % 400 === 0)
        return true;
    if (y % 100 === 0)
        return false;
    return y % 4 === 0;
}
function isValidUri(s) {
    try {
        const u = new URL(s);
        return u.protocol === "http:" || u.protocol === "https:";
    }
    catch {
        return false;
    }
}
function isValidPublication(app) {
    const pub = app.publication;
    if (typeof pub !== "object" || pub === null)
        return false;
    const p = pub;
    if (typeof p.listKey !== "string" || !p.listKey.trim())
        return false;
    if (p.listKey !== app.targetListKey)
        return false;
    if (typeof p.sequenceNumber !== "number" ||
        p.sequenceNumber < 1 ||
        !Number.isInteger(p.sequenceNumber))
        return false;
    const shaRe = /^[0-9a-f]{64}$/;
    if (typeof p.manifestSha256 !== "string" || !shaRe.test(p.manifestSha256))
        return false;
    if (typeof p.compactJadesSha256 !== "string" ||
        !shaRe.test(p.compactJadesSha256))
        return false;
    if (typeof p.publicationTimestamp !== "string" ||
        !isIsoString(p.publicationTimestamp))
        return false;
    return true;
}
function isValidApplicantData(data, family) {
    if (typeof data !== "object" || data === null)
        return false;
    const d = data;
    if (typeof d.entityName !== "string" || !d.entityName.trim())
        return false;
    if (typeof d.entityStreetAddress !== "string" ||
        !d.entityStreetAddress.trim())
        return false;
    if (typeof d.entityCountry !== "string" ||
        !/^[A-Z]{2}$/.test(d.entityCountry))
        return false;
    if (typeof d.entityInformationURI !== "string" ||
        !isValidUri(d.entityInformationURI))
        return false;
    if (family === "pid-providers" && (typeof d.responsibleMemberState !== "string" || !/^[A-Z]{2}$/.test(d.responsibleMemberState))) return false;
    if (d.entityTradeName !== undefined) {
        if (typeof d.entityTradeName !== "string")
            return false;
    }
    if (d.entityLocality !== undefined) {
        if (typeof d.entityLocality !== "string")
            return false;
    }
    if (d.entityPostalCode !== undefined) {
        if (typeof d.entityPostalCode !== "string")
            return false;
    }
    if (!Array.isArray(d.services) || d.services.length === 0)
        return false;
    for (const svc of d.services) {
        if (!isValidService(svc))
            return false;
    }
    return true;
}
function isValidService(svc) {
    if (typeof svc !== "object" || svc === null)
        return false;
    const s = svc;
    if (!["issuance", "revocation"].includes(s.serviceType))
        return false;
    if (typeof s.serviceName !== "string" || !s.serviceName.trim())
        return false;
    if (typeof s.certificatePem !== "string" || !s.certificatePem.trim())
        return false;
    try {
        new X509Certificate(s.certificatePem);
    }
    catch {
        return false;
    }
    if (typeof s.serviceUniqueIdentifier !== "string" ||
        !isValidUri(s.serviceUniqueIdentifier))
        return false;
    if (s.serviceSupplyPoints !== undefined) {
        if (!Array.isArray(s.serviceSupplyPoints))
            return false;
    }
    return true;
}
function isSubpath(parent, child) {
    const rel = child.slice(parent.length);
    return rel.startsWith(sep) || rel === "";
}
//# sourceMappingURL=authoring-store.js.map
