import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "@effect/vitest";

import {
  clientSettingsPatchFromSyncedValues,
  formatSyncedSettingValue,
  syncedSettingValuePreview,
  planClientSettingsSync,
  resolveClientSettingsSync,
  syncedValuesFromClientSettings,
} from "./clientSettingsSync.ts";

describe("planClientSettingsSync", () => {
  it("pushes this device's settings to a server that has none", () => {
    const local = { wordWrap: false };
    expect(
      planClientSettingsSync({ local, base: null, remote: { revision: 0, values: {} } }),
    ).toEqual({ merged: local, conflicts: [] });
  });

  it("asks on first setup about each setting that differs, and only those", () => {
    const plan = planClientSettingsSync({
      local: { wordWrap: false, chatWidth: "wide", diffLayout: "split" },
      base: null,
      remote: {
        revision: 3,
        values: { wordWrap: true, chatWidth: "wide", futureSetting: 1 },
      },
    });
    expect(plan.conflicts).toEqual([{ key: "wordWrap", local: false, remote: true }]);
    expect(plan.merged).toEqual({ chatWidth: "wide", diffLayout: "split", futureSetting: 1 });
  });

  it("merges changes made on one side and asks when both changed a setting", () => {
    const plan = planClientSettingsSync({
      local: { wordWrap: false, chatWidth: "wide", diffLayout: "stacked", fontSmoothing: true },
      base: {
        revision: 4,
        values: {
          wordWrap: true,
          chatWidth: "comfortable",
          diffLayout: "split",
          fontSmoothing: true,
        },
      },
      remote: {
        revision: 5,
        values: { wordWrap: true, chatWidth: "full", diffLayout: "stacked", fontSmoothing: false },
      },
    });
    expect(plan.merged).toEqual({ wordWrap: false, diffLayout: "stacked", fontSmoothing: false });
    expect(plan.conflicts).toEqual([{ key: "chatWidth", local: "wide", remote: "full" }]);
    expect(resolveClientSettingsSync(plan, {})).toBeUndefined();
    expect(resolveClientSettingsSync(plan, { chatWidth: "local" })).toEqual({
      ...plan.merged,
      chatWidth: "wide",
    });
  });

  it("compares objects regardless of key order", () => {
    const plan = planClientSettingsSync({
      local: { threadDetailsItems: { a: true, b: false } },
      base: null,
      remote: { revision: 1, values: { threadDetailsItems: { b: false, a: true } } },
    });
    expect(plan.conflicts).toEqual([]);
  });
});

describe("synced client setting values", () => {
  it("leaves device settings out and skips values this client cannot decode", () => {
    const values = syncedValuesFromClientSettings({
      ...DEFAULT_CLIENT_SETTINGS,
      settingsSyncEnabled: false,
      onboardingCompletedAt: "2026-11-16T00:00:00.000Z",
      statusLineShowAllModels: false,
      statusLineShowModelNames: true,
    });
    expect(values).not.toHaveProperty("settingsSyncEnabled");
    expect(values).not.toHaveProperty("onboardingCompletedAt");
    expect(values).not.toHaveProperty("statusLineShowAllModels");
    expect(values).not.toHaveProperty("statusLineShowModelNames");
    expect(values).toHaveProperty("wordWrap", true);
    expect(
      clientSettingsPatchFromSyncedValues({
        wordWrap: false,
        chatWidth: "not-a-width",
        settingsSyncEnabled: false,
        statusLineShowAllModels: false,
        statusLineShowModelNames: true,
        futureSetting: 1,
      }),
    ).toEqual({ wordWrap: false });
  });

  it("never syncs the app script gates in either direction", () => {
    const gates = {
      appScriptsEnabled: true,
      appScriptsFromTerminal: true,
      appScriptsFromAgents: true,
    };
    const values = syncedValuesFromClientSettings({ ...DEFAULT_CLIENT_SETTINGS, ...gates });
    for (const key of Object.keys(gates)) expect(values).not.toHaveProperty(key);
    expect(clientSettingsPatchFromSyncedValues(gates)).toEqual({});
  });

  it("shows whole synced values, never shortened", () => {
    const favorites = Array.from({ length: 5 }, (_, index) => ({
      provider: "claudeAgent",
      model: `claude-model-${index}`,
    }));
    expect(formatSyncedSettingValue("favorites", favorites)).toBe(
      JSON.stringify(favorites, null, 2),
    );
    const themes = [{ id: "lavender", css: "x".repeat(200) }];
    expect(formatSyncedSettingValue("customThemes", JSON.stringify(themes))).toBe(
      JSON.stringify(themes, null, 2),
    );
    expect(formatSyncedSettingValue("theme", "lavender-darker")).toBe('"lavender-darker"');
    expect(formatSyncedSettingValue("buildPath", "[ 1 ]")).toBe('"[ 1 ]"');
    expect(formatSyncedSettingValue("buildPath", "")).toBe('""');
    expect(formatSyncedSettingValue("theme", null)).toBe("null");
    expect(formatSyncedSettingValue("theme", undefined)).toBe("not set");
    expect(syncedSettingValuePreview("a\nb")).toBeNull();
    expect(syncedSettingValuePreview(formatSyncedSettingValue("favorites", favorites))).toBe(
      JSON.stringify(favorites, null, 2).split("\n").slice(0, 8).join("\n"),
    );
  });
});
