import { PROFILE_REGISTRY, type ProfileFamily } from "../profiles/registry.js";

export interface ListFamily {
  key: ProfileFamily;
  label: string;
  enabled: boolean;
  notImplementedNote: string;
}

export const LIST_FAMILIES: readonly ListFamily[] = Object.freeze(
  Object.values(PROFILE_REGISTRY).map((profile) =>
    Object.freeze({
      key: profile.family,
      label: profile.label,
      enabled: profile.enabled,
      notImplementedNote: profile.notImplementedNote ?? "",
    }),
  ),
);

export function getEnabledFamilies(): readonly ListFamily[] {
  return LIST_FAMILIES.filter((family) => family.enabled);
}

export function findFamily(key: string): ListFamily | undefined {
  return LIST_FAMILIES.find((family) => family.key === key);
}
