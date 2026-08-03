import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LIST_FAMILIES,
  familiesForStandard,
  findFamily,
  getEnabledFamilies,
  isXmlFamily,
} from "../src/core/authoring/list-family-catalogue.js";
import { PROFILE_REGISTRY } from "../src/core/profiles/registry.js";
import {
  TSL_PROFILE_REGISTRY,
  getTslProfile,
  tslProfileForServiceType,
} from "../src/core/tsl612/registry.js";
import {
  SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL,
  SVCSTATUS_GRANTED,
  SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
  SVCSTATUS_WITHDRAWN,
  SVCTYPE_EAA,
  SVCTYPE_QEAA,
} from "../src/core/tsl612/constants.js";
import { familyColorClass } from "../src/web/views/colors.js";

describe("TS 119 612 profile registry", () => {
  it("gives EAA the non-qualified service type and national-recognition statuses", () => {
    const eaa = getTslProfile("eaa-providers");
    expect(eaa.serviceTypeIdentifier).toBe(SVCTYPE_EAA);
    expect(eaa.initialStatus).toBe(SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL);
    expect(eaa.endStatus).toBe(SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL);
    expect(eaa.qualified).toBe(false);
    expect(eaa.lifecycleActionLabel).toBe("Deprecate national recognition");
  });

  it("gives QEAA the qualified service type and granted/withdrawn statuses", () => {
    const qeaa = getTslProfile("qeaa-providers");
    expect(qeaa.serviceTypeIdentifier).toBe(SVCTYPE_QEAA);
    expect(qeaa.initialStatus).toBe(SVCSTATUS_GRANTED);
    expect(qeaa.endStatus).toBe(SVCSTATUS_WITHDRAWN);
    expect(qeaa.qualified).toBe(true);
    expect(qeaa.lifecycleActionLabel).toBe("Withdraw qualified status");
  });

  it("never reuses a status URI between the two families", () => {
    const eaa = new Set(TSL_PROFILE_REGISTRY["eaa-providers"].statuses);
    for (const status of TSL_PROFILE_REGISTRY["qeaa-providers"].statuses) {
      expect(eaa.has(status)).toBe(false);
    }
  });

  it("identifies a family from a published service type", () => {
    expect(tslProfileForServiceType(SVCTYPE_EAA)?.family).toBe("eaa-providers");
    expect(tslProfileForServiceType(SVCTYPE_QEAA)?.family).toBe(
      "qeaa-providers",
    );
    expect(
      tslProfileForServiceType("http://uri.etsi.org/TrstSvc/Svctype/CA/QC"),
    ).toBeUndefined();
  });

  it("refuses an unknown family rather than returning a default", () => {
    expect(() => getTslProfile("pub-eaa-providers")).toThrow(
      /Unknown TS 119 612 list family/,
    );
  });
});

describe("format-aware family catalogue", () => {
  it("keeps the TS 119 602 registry free of the XML families", () => {
    expect(Object.keys(PROFILE_REGISTRY)).not.toContain("eaa-providers");
    expect(Object.keys(PROFILE_REGISTRY)).not.toContain("qeaa-providers");
  });

  it("labels every family with its standard and artifact format", () => {
    for (const family of LIST_FAMILIES) {
      if (family.standard === "TS 119 612") {
        expect(family.artifactFormat).toBe("XML / XAdES-B-B");
      } else {
        expect(family.artifactFormat).toBe("JSON / Compact JAdES");
      }
    }
  });

  it("lists five TS 119 602 families beside the two TS 119 612 families", () => {
    expect(familiesForStandard("TS 119 612").map((f) => f.key)).toEqual([
      "eaa-providers",
      "qeaa-providers",
    ]);
    expect(familiesForStandard("TS 119 602")).toHaveLength(6);
  });

  it("carries the onboarding route and lifecycle action of each XML family", () => {
    const eaa = findFamily("eaa-providers");
    expect(eaa?.onboardingRoute).toBe("/onboarding/eaa-provider");
    expect(eaa?.lifecycleActions.map((a) => a.label)).toEqual([
      "Deprecate national recognition",
    ]);
    const qeaa = findFamily("qeaa-providers");
    expect(qeaa?.onboardingRoute).toBe("/onboarding/qeaa-provider");
    expect(qeaa?.lifecycleActions[0]?.destructive).toBe(true);
  });

  it("publishes the family's service type as its profile identifier", () => {
    expect(findFamily("eaa-providers")?.profileIdentifier).toBe(SVCTYPE_EAA);
    expect(findFamily("qeaa-providers")?.profileIdentifier).toBe(SVCTYPE_QEAA);
    expect(findFamily("wallet-providers")?.profileIdentifier).toBe(
      PROFILE_REGISTRY["wallet-providers"].loTEType,
    );
  });

  it("exposes both allowed statuses of an XML family in lifecycle order", () => {
    expect(findFamily("eaa-providers")?.allowedStatuses).toEqual([
      SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
      SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL,
    ]);
  });

  it("reports no status for a family that publishes none", () => {
    expect(findFamily("wallet-providers")?.allowedStatuses).toEqual([]);
    expect(findFamily("wallet-providers")?.lifecycleActions).toEqual([]);
  });

  it("enables both XML families and keeps Registrars disabled", () => {
    const enabled = getEnabledFamilies().map((f) => f.key);
    expect(enabled).toContain("eaa-providers");
    expect(enabled).toContain("qeaa-providers");
    expect(enabled).not.toContain("registrars");
  });

  it("answers isXmlFamily without a view having to know family names", () => {
    expect(isXmlFamily("eaa-providers")).toBe(true);
    expect(isXmlFamily("qeaa-providers")).toBe(true);
    expect(isXmlFamily("pub-eaa-providers")).toBe(false);
  });

  it("gives every family a colour class app.css declares", () => {
    const css = readFileSync(
      resolve(import.meta.dirname, "..", "src", "web", "assets", "app.css"),
      "utf-8",
    );
    for (const family of LIST_FAMILIES) {
      expect(css).toContain(`.${familyColorClass(family.key)} {`);
    }
    expect(familyColorClass("eaa-providers")).not.toBe(
      familyColorClass("qeaa-providers"),
    );
  });
});
