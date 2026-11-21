import {
  type ClientSettings,
  type ClientSettingsPatch,
  ClientSettingsSchema,
  type SyncedClientSettings,
} from "@t3tools/contracts/settings";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

/** Settings that describe this device rather than the user's preferences. */
const DEVICE_LOCAL_KEYS = new Set<string>([
  "settingsSyncEnabled",
  "fasterPhoneLaunch",
  "showMessageSenderLabels",
  "statusLineShowAllModels",
  "statusLineShowModelNames",
  "onboardingCompletedAt",
  "scratchEnvironmentId",
  "voiceMicrophone",
  "voiceMicrophones",
  // Another device or the server must never turn on code execution here.
  "appScriptsEnabled",
  "appScriptsFromTerminal",
  "appScriptsFromAgents",
] satisfies ReadonlyArray<keyof ClientSettings>);

export type SyncedValues = Readonly<Record<string, unknown>>;

export interface ClientSettingsSyncConflict {
  readonly key: string;
  readonly local: unknown;
  readonly remote: unknown;
}

export interface ClientSettingsSyncPlan {
  /** Every key that merged cleanly; conflicting keys are absent until resolved. */
  readonly merged: SyncedValues;
  readonly conflicts: ReadonlyArray<ClientSettingsSyncConflict>;
}

export type ClientSettingsSyncChoice = "local" | "remote";

const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeClientSettingsExit = Schema.decodeUnknownExit(ClientSettingsSchema);
const CLIENT_SETTINGS_KEYS = new Set(Object.keys(ClientSettingsSchema.fields));

function isSyncedClientSettingKey(key: string): boolean {
  return !DEVICE_LOCAL_KEYS.has(key);
}

export function syncedValuesFromClientSettings(settings: ClientSettings): SyncedValues {
  const encoded = encodeClientSettings(settings) as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(encoded)) {
    if (isSyncedClientSettingKey(key)) values[key] = value;
  }
  return values;
}

/** Keys this client cannot read or that fail to decode stay on the server only. */
export function clientSettingsPatchFromSyncedValues(values: SyncedValues): ClientSettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!CLIENT_SETTINGS_KEYS.has(key) || !isSyncedClientSettingKey(key)) continue;
    const exit = decodeClientSettingsExit({ [key]: value });
    if (Exit.isSuccess(exit)) patch[key] = (exit.value as Record<string, unknown>)[key];
  }
  return patch as ClientSettingsPatch;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );
}

function syncedValueEquals(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

export function syncedValuesEqual(left: SyncedValues, right: SyncedValues): boolean {
  return syncedValueEquals(left, right);
}

/**
 * Three-way merge of this device's settings with the server's copy, against the copy this device
 * last synced. Without a base (first setup) every differing setting is a conflict, unless the
 * server has never been written.
 */
export function planClientSettingsSync(input: {
  readonly local: SyncedValues;
  readonly base: SyncedClientSettings | null;
  readonly remote: SyncedClientSettings;
}): ClientSettingsSyncPlan {
  const { local, base, remote } = input;
  if (base === null && remote.revision === 0) {
    return { merged: local, conflicts: [] };
  }
  const merged: Record<string, unknown> = {};
  const conflicts: Array<ClientSettingsSyncConflict> = [];
  const keys = new Set([
    ...Object.keys(local),
    ...Object.keys(remote.values),
    ...Object.keys(base?.values ?? {}),
  ]);
  for (const key of keys) {
    const hasRemote = Object.hasOwn(remote.values, key);
    const remoteValue = hasRemote ? remote.values[key] : undefined;
    // A key this client does not know has no local opinion.
    const localValue = Object.hasOwn(local, key) ? local[key] : remoteValue;
    const take = (value: unknown) => {
      if (value !== undefined) merged[key] = value;
    };
    if (syncedValueEquals(localValue, remoteValue)) {
      take(localValue);
    } else if (base === null) {
      // First setup: a setting only one side has is not a disagreement.
      if (!hasRemote) take(localValue);
      else conflicts.push({ key, local: localValue, remote: remoteValue });
    } else {
      const baseValue = base.values[key];
      if (syncedValueEquals(localValue, baseValue)) take(remoteValue);
      else if (syncedValueEquals(remoteValue, baseValue)) take(localValue);
      else conflicts.push({ key, local: localValue, remote: remoteValue });
    }
  }
  return { merged, conflicts };
}

/** Undefined when a conflict has no choice yet. */
export function resolveClientSettingsSync(
  plan: ClientSettingsSyncPlan,
  choices: Readonly<Record<string, ClientSettingsSyncChoice>>,
): SyncedValues | undefined {
  const values: Record<string, unknown> = { ...plan.merged };
  for (const conflict of plan.conflicts) {
    const choice = choices[conflict.key];
    if (choice === undefined) return undefined;
    const value = choice === "local" ? conflict.local : conflict.remote;
    if (value !== undefined) values[conflict.key] = value;
  }
  return values;
}

/** Synced settings that are not client settings, named for people. */
const SYNCED_SETTING_LABELS: Readonly<Record<string, string>> = {
  theme: "Theme",
  themeAppearanceMode: "Appearance",
  themeHalves: "Light and dark themes",
  customThemes: "Theme library",
};

export function syncedSettingLabel(key: string): string {
  const label = SYNCED_SETTING_LABELS[key];
  if (label !== undefined) return label;
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Synced settings stored as JSON text, shown parsed. */
const JSON_TEXT_SETTING_KEYS = new Set(["customThemes", "themeHalves"]);

/** The whole value, never shortened. */
export function formatSyncedSettingValue(key: string, value: unknown): string {
  if (value === undefined) return "not set";
  let shown: unknown = value;
  if (typeof value === "string" && JSON_TEXT_SETTING_KEYS.has(key)) {
    try {
      shown = JSON.parse(value) as unknown;
    } catch {
      shown = value;
    }
  }
  return JSON.stringify(shown, null, 2);
}

const SYNCED_VALUE_PREVIEW_LINES = 8;

/** The first lines of a long value for a collapsed view, or null when it fits whole. */
export function syncedSettingValuePreview(text: string): string | null {
  const lines = text.split("\n");
  return lines.length > SYNCED_VALUE_PREVIEW_LINES
    ? lines.slice(0, SYNCED_VALUE_PREVIEW_LINES).join("\n")
    : null;
}
