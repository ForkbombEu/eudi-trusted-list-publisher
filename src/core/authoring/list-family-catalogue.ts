/**
 * The one catalogue of user-facing Trusted List families, across both
 * standards this publisher implements.
 *
 * Two standards meet here and they are not interchangeable. A TS 119 602
 * family publishes a JSON List of Trusted Entities signed as Compact JAdES; a
 * TS 119 612 family publishes an XML Trust Service Status List signed as
 * enveloped XAdES-B-B. Every page that names a family also has to say which,
 * so the standard and the artifact format are members of the catalogue rather
 * than something a view infers from the family name.
 *
 * The two registries stay separate: `PROFILE_REGISTRY` keeps describing
 * TS 119 602 and nothing else.
 */
import { PROFILE_REGISTRY, type ProfileFamily } from "../profiles/registry.js";
import {
  TSL_PROFILE_REGISTRY,
  isTslFamily,
  type TslFamily,
} from "../tsl612/registry.js";

export type FamilyKey = ProfileFamily | TslFamily;

export type ListStandard = "TS 119 602" | "TS 119 612";
export type ArtifactFormat = "JSON / Compact JAdES" | "XML / XAdES-B-B";

export interface LifecycleAction {
  /** Stable identifier used in routes and form bodies. */
  readonly id: string;
  /** Button and heading wording. */
  readonly label: string;
  readonly description: string;
  /** Whether the action publishes an irreversible new version. */
  readonly destructive: boolean;
}

export interface ListFamily {
  readonly key: FamilyKey;
  readonly label: string;
  readonly enabled: boolean;
  readonly notImplementedNote: string;
  readonly standard: ListStandard;
  readonly artifactFormat: ArtifactFormat;
  /**
   * What the standard calls the thing this family profiles: a LoTE type URI
   * for TS 119 602, a service type identifier for TS 119 612.
   */
  readonly profileIdentifier: string;
  /**
   * Every service status the family can publish, in lifecycle order. Empty
   * where the profile publishes no status at all, which is its own statement:
   * presence in the current version is then the only claim the list makes.
   */
  readonly allowedStatuses: readonly string[];
  /** Absent for a family with no onboarding form. */
  readonly onboardingRoute?: string;
  readonly lifecycleActions: readonly LifecycleAction[];
}

/** The onboarding route of a family, by convention `<family without the plural>`. */
const ONBOARDING_ROUTES: Readonly<Partial<Record<FamilyKey, string>>> =
  Object.freeze({
    "pid-providers": "/onboarding/pid-provider",
    "wallet-providers": "/onboarding/wallet-provider",
    "wrpac-providers": "/onboarding/wrpac-provider",
    "wrprc-providers": "/onboarding/wrprc-provider",
    "pub-eaa-providers": "/onboarding/pub-eaa-provider",
    "eaa-providers": "/onboarding/eaa-provider",
    "qeaa-providers": "/onboarding/qeaa-provider",
  });

const WITHDRAW_NOTIFICATION: LifecycleAction = Object.freeze({
  id: "withdraw",
  label: "Withdraw notification",
  description:
    "Publishes a new version in which every service of the provider reads withdrawn, keeping the previous state in ServiceHistory.",
  destructive: true,
});

function ts119602Family(family: ProfileFamily): ListFamily {
  const profile = PROFILE_REGISTRY[family];
  const statuses = profile.serviceStatuses
    ? [profile.serviceStatuses.notified, profile.serviceStatuses.withdrawn]
    : [];
  const route = ONBOARDING_ROUTES[family];
  return Object.freeze({
    key: profile.family,
    label: profile.label,
    enabled: profile.enabled,
    notImplementedNote: profile.notImplementedNote ?? "",
    standard: "TS 119 602" as const,
    artifactFormat: "JSON / Compact JAdES" as const,
    profileIdentifier: profile.loTEType ?? "",
    allowedStatuses: Object.freeze(statuses),
    ...(profile.enabled && route ? { onboardingRoute: route } : {}),
    lifecycleActions: Object.freeze(
      profile.usesServiceStatus ? [WITHDRAW_NOTIFICATION] : [],
    ),
  });
}

function ts119612Family(family: TslFamily): ListFamily {
  const profile = TSL_PROFILE_REGISTRY[family];
  return Object.freeze({
    key: profile.family,
    label: profile.label,
    enabled: true,
    notImplementedNote: "",
    standard: "TS 119 612" as const,
    artifactFormat: "XML / XAdES-B-B" as const,
    profileIdentifier: profile.serviceTypeIdentifier,
    allowedStatuses: profile.statuses,
    onboardingRoute: ONBOARDING_ROUTES[family],
    lifecycleActions: Object.freeze([
      Object.freeze({
        id: "deprecate",
        label: profile.lifecycleActionLabel,
        description: profile.lifecycleActionDescription,
        destructive: true,
      }),
    ]),
  });
}

/**
 * Catalogue order: the five implemented TS 119 602 families in annex order,
 * then the two TS 119 612 families, then what is not implemented. Grouping by
 * standard keeps the two artifact formats from interleaving on the page.
 */
export const LIST_FAMILIES: readonly ListFamily[] = Object.freeze([
  ts119602Family("pid-providers"),
  ts119602Family("wallet-providers"),
  ts119602Family("wrpac-providers"),
  ts119602Family("wrprc-providers"),
  ts119602Family("pub-eaa-providers"),
  ts119612Family("eaa-providers"),
  ts119612Family("qeaa-providers"),
  ts119602Family("registrars"),
]);

export function getEnabledFamilies(): readonly ListFamily[] {
  return LIST_FAMILIES.filter((family) => family.enabled);
}

export function findFamily(key: string): ListFamily | undefined {
  return LIST_FAMILIES.find((family) => family.key === key);
}

/** The families of one standard, in catalogue order. */
export function familiesForStandard(
  standard: ListStandard,
): readonly ListFamily[] {
  return LIST_FAMILIES.filter((family) => family.standard === standard);
}

/**
 * Whether a family publishes XML. Views ask this rather than testing the
 * family name, so a page cannot promise JSON for an XML family.
 */
export function isXmlFamily(key: string): key is TslFamily {
  return isTslFamily(key);
}
