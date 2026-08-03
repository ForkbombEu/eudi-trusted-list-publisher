/**
 * The TS 119 612 service profiles this publisher lists.
 *
 * EAA and QEAA share one XML/XAdES engine and one Trusted List structure. What
 * separates them is the service type identifier and the status vocabulary,
 * which is exactly what this registry holds — the rest of the code reads these
 * members instead of switching on a family name.
 *
 * This is deliberately *not* `src/core/profiles/registry.ts`. That registry
 * describes TS 119 602 JSON LoTE profiles: LoTE types, scheme rules, JAdES.
 * None of those members mean anything for an XML Trusted List.
 */
import {
  MAX_NEXT_UPDATE_MONTHS,
  SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL,
  SVCSTATUS_GRANTED,
  SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
  SVCSTATUS_WITHDRAWN,
  SVCTYPE_EAA,
  SVCTYPE_QEAA,
} from "./constants.js";

export type TslFamily = "eaa-providers" | "qeaa-providers";

export interface TslServiceProfile {
  readonly family: TslFamily;
  readonly label: string;
  /** Clause 5.5.1 service type identifier. */
  readonly serviceTypeIdentifier: string;
  /**
   * The status a service is first published with. Its StatusStartingTime is
   * the publication event, not a separate clock reading.
   */
  readonly initialStatus: string;
  /** The status the administration's lifecycle action moves the service to. */
  readonly endStatus: string;
  /** Both statuses, for the settings and review pages that list them. */
  readonly statuses: readonly string[];
  /** The wording of the administration action, e.g. on a destructive button. */
  readonly lifecycleActionLabel: string;
  /**
   * What the action does, in one sentence, for the confirmation copy. A
   * qualified status is withdrawn; a national recognition is deprecated. The
   * two are not synonyms and the pages must not blur them.
   */
  readonly lifecycleActionDescription: string;
  /** Whether the service is a qualified trust service. */
  readonly qualified: boolean;
  readonly maxNextUpdateMonths: number;
  readonly signatureProfile: "XAdES-B-B";
}

export const TSL_PROFILE_REGISTRY: Readonly<
  Record<TslFamily, TslServiceProfile>
> = Object.freeze({
  "eaa-providers": Object.freeze({
    family: "eaa-providers",
    label: "EAA Providers",
    serviceTypeIdentifier: SVCTYPE_EAA,
    initialStatus: SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
    endStatus: SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL,
    statuses: Object.freeze([
      SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
      SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL,
    ]),
    lifecycleActionLabel: "Deprecate national recognition",
    lifecycleActionDescription:
      "Publishes a new version in which the service is deprecated at national level. The recognised state moves into ServiceHistory and stays readable.",
    qualified: false,
    maxNextUpdateMonths: MAX_NEXT_UPDATE_MONTHS,
    signatureProfile: "XAdES-B-B",
  }),
  "qeaa-providers": Object.freeze({
    family: "qeaa-providers",
    label: "QEAA Providers",
    serviceTypeIdentifier: SVCTYPE_QEAA,
    initialStatus: SVCSTATUS_GRANTED,
    endStatus: SVCSTATUS_WITHDRAWN,
    statuses: Object.freeze([SVCSTATUS_GRANTED, SVCSTATUS_WITHDRAWN]),
    lifecycleActionLabel: "Withdraw qualified status",
    lifecycleActionDescription:
      "Publishes a new version in which the qualified status is withdrawn. The granted state moves into ServiceHistory and stays readable.",
    qualified: true,
    maxNextUpdateMonths: MAX_NEXT_UPDATE_MONTHS,
    signatureProfile: "XAdES-B-B",
  }),
});

const TSL_FAMILIES: readonly TslFamily[] = Object.freeze([
  "eaa-providers",
  "qeaa-providers",
]);

export function isTslFamily(value: string): value is TslFamily {
  return (TSL_FAMILIES as readonly string[]).includes(value);
}

export function getTslProfile(family: string): TslServiceProfile {
  if (!isTslFamily(family))
    throw new Error(`Unknown TS 119 612 list family: ${family}`);
  return TSL_PROFILE_REGISTRY[family];
}

/**
 * The family a published service belongs to, identified by its service type.
 * A Trusted List can in principle carry other service types; this publisher
 * only lists these two, and an unknown type is reported rather than guessed.
 */
export function tslProfileForServiceType(
  serviceType: string,
): TslServiceProfile | undefined {
  return Object.values(TSL_PROFILE_REGISTRY).find(
    (profile) => profile.serviceTypeIdentifier === serviceType,
  );
}
