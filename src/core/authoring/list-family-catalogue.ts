export interface ListFamily {
  key: string;
  label: string;
  enabled: boolean;
  notImplementedNote: string;
}

export const LIST_FAMILIES: readonly ListFamily[] = Object.freeze([
  {
    key: "pid-providers",
    label: "PID Providers",
    enabled: false,
    notImplementedNote: "Not implemented yet",
  },
  {
    key: "non-qualified-eaa-providers",
    label: "Non-qualified EAA Providers",
    enabled: false,
    notImplementedNote: "Not implemented yet",
  },
  {
    key: "qeaa-providers",
    label: "QEAA Providers",
    enabled: false,
    notImplementedNote: "Not implemented yet",
  },
  {
    key: "wallet-providers",
    label: "Wallet Providers",
    enabled: true,
    notImplementedNote: "",
  },
  {
    key: "wrpac-access-ca-providers",
    label: "WRPAC / Access CA Providers",
    enabled: false,
    notImplementedNote: "Not implemented yet",
  },
  {
    key: "wrprc-providers",
    label: "WRPRC Providers",
    enabled: false,
    notImplementedNote: "Not implemented yet",
  },
  {
    key: "registrars",
    label: "Registrars",
    enabled: false,
    notImplementedNote: "Not implemented yet",
  },
]) as readonly ListFamily[];

export function getEnabledFamilies(): readonly ListFamily[] {
  return LIST_FAMILIES.filter((f) => f.enabled);
}

export function findFamily(key: string): ListFamily | undefined {
  return LIST_FAMILIES.find((f) => f.key === key);
}
