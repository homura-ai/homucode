import * as DateTime from "effect/DateTime";
import { ProviderDriverKind, ProviderInstanceId, UsageLimitSourceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "./state/contextWindow.ts";
import {
  buildStatusLineInput,
  buildStatusLineModelUsage,
  buildStatusLineStats,
  expandStatusLineLabel,
  formatStatusLineSpan,
  formatStatusLineTokens,
  parseAnsiLines,
  stampStatusLineInput,
  statusLineColorRole,
  statusLineModelName,
  statusLineGaugeTone,
  reserveStatusLineText,
  splitStatusLineItems,
  type StatusLineInputSource,
  type StatusLineItem,
} from "./statusLine.ts";

const plain = { background: null, bold: false, dim: false, italic: false, underline: false };

describe("parseAnsiLines", () => {
  it("styles text the way the 01-1/statusline script colors it", () => {
    const text = "\u001b[38;5;15m~/code \u001b[38;5;183mi@o\u001b[38;5;8m |\u001b[0m";
    expect(parseAnsiLines(text)).toEqual([
      [
        { text: "~/code ", color: null, ...plain },
        { text: "i@o", color: "#d7afff", ...plain },
        { text: " |", color: "#808080", ...plain },
      ],
    ]);
  });

  it("handles basic, truecolor, attributes, and resets", () => {
    expect(parseAnsiLines("\u001b[1;31mred\u001b[22;38;2;1;2;3mrgb\u001b[39;4mu\u001b[mx")).toEqual(
      [
        [
          { text: "red", color: "#cd0000", ...plain, bold: true },
          { text: "rgb", color: "#010203", ...plain },
          { text: "u", color: null, ...plain, underline: true },
          { text: "x", color: null, ...plain },
        ],
      ],
    );
  });

  it("carries style across lines and drops other escapes", () => {
    expect(
      parseAnsiLines(
        "\u001b]0;title\u0007\u001b[32mone\u001b[2K\ntwo\u001b]8;;https://x\u001b\\\n\n",
      ),
    ).toEqual([
      [{ text: "one", color: "#00cd00", ...plain }],
      [{ text: "two", color: "#00cd00", ...plain }],
    ]);
  });
});

describe("statusLineColorRole", () => {
  it.each([
    ["#cd0000", "error"],
    ["#ff5f87", "error"],
    ["#cdcd00", "warning"],
    ["#ffaf00", "warning"],
    ["#00cd00", "success"],
    ["#00cdcd", "info"],
    ["#5c5cff", "info"],
    ["#d7afff", "accent"],
    ["#cd00cd", "accent"],
    ["#808080", "muted"],
    ["#d0d0d0", "foreground"],
    ["red", "foreground"],
  ] as const)("maps %s to %s", (color, role) => {
    expect(statusLineColorRole(color)).toBe(role);
  });
});

describe("splitStatusLineItems", () => {
  const muted = { color: "#808080", ...plain };
  const accent = { color: "#d7afff", ...plain };

  it("splits the built-in line into directory, items, and clock", () => {
    const [line = []] = parseAnsiLines(
      "\u001b[38;5;15m~/code/homucode \u001b[38;5;183muser@workstation \u001b[38;5;8m| \u001b[38;5;183mO5.5\u001b[38;5;8m, up \u001b[38;5;183m1h02m [21:41:07] \u001b[38;5;8mcache \u001b[38;5;183m37%\u001b[38;5;8m, v\u001b[38;5;183m2.1.3",
    );
    const pipe = [{ text: "|", ...muted }];
    const comma = [{ text: ",", ...muted }];
    expect(splitStatusLineItems(line)).toEqual([
      {
        kind: "directory",
        segments: [{ text: "~/code/homucode", color: null, ...plain }],
        dropAt: 3,
        // With `user@host` dropped, its ` |` follows the directory.
        separators: [[], [], pipe, []],
      },
      {
        kind: "text",
        segments: [{ text: "user@workstation", ...accent }],
        dropAt: 2,
        separators: [pipe, pipe, [], []],
      },
      {
        kind: "text",
        segments: [{ text: "O5.5", ...accent }],
        dropAt: 0,
        separators: [comma, comma, comma, comma],
      },
      {
        kind: "text",
        segments: [
          { text: "up ", ...muted },
          { text: "1h02m", ...accent },
        ],
        dropAt: 0,
        separators: [comma, comma, comma, comma],
      },
      {
        kind: "clock",
        segments: [{ text: "[21:41:07]", ...accent }],
        dropAt: 0,
        separators: [[], [], [], []],
      },
      {
        kind: "text",
        segments: [
          { text: "cache ", ...muted },
          { text: "37%", ...accent },
        ],
        dropAt: 0,
        // With the version dropped, nothing follows and the comma goes too.
        separators: [comma, [], [], []],
      },
      {
        kind: "text",
        segments: [
          { text: "v", ...muted },
          { text: "2.1.3", ...accent },
        ],
        dropAt: 1,
        separators: [[], [], [], []],
      },
    ]);
  });

  it("keeps a styled directory with spaces whole", () => {
    const [line = []] = parseAnsiLines("/repos/My Project \u001b[38;5;183muser@workstation");
    expect(splitStatusLineItems(line).map((item) => [item.kind, item.segments[0]?.text])).toEqual([
      ["directory", "/repos/My Project"],
      ["text", "user@workstation"],
    ]);
  });

  it("does not take a clock styled with the directory into the directory", () => {
    const [line = []] = parseAnsiLines("~/repo up 2h [12:34:56] \u001b[38;5;183mmain");
    expect(splitStatusLineItems(line).map((item) => item.kind)).toEqual([
      "directory",
      "text",
      "clock",
      "text",
    ]);
  });

  it("keeps a line without separators, directory, or clock as one item", () => {
    const line = [{ text: "A6 medium [1:2]", color: null, ...plain }];
    expect(splitStatusLineItems(line)).toEqual([
      { kind: "text", segments: line, dropAt: 0, separators: [[], [], [], []] },
    ]);
  });

  // An item's text, then the separator after it while nothing is dropped.
  const texts = (item: StatusLineItem) =>
    [...item.segments, ...(item.separators[0] ?? [])].map((segment) => segment.text);

  it("gives each labelled value its own item", () => {
    const [line = []] = parseAnsiLines(
      "\u001b[38;5;118m+3 \u001b[38;5;8mcache \u001b[38;5;183m37%\u001b[38;5;8m, in \u001b[38;5;183m5k \u001b[38;5;8mout \u001b[38;5;183m6\u001b[38;5;8m, ctx \u001b[38;5;46m8% \u001b[38;5;8m(\u001b[38;5;46m80k\u001b[38;5;8m)",
    );
    expect(splitStatusLineItems(line).map(texts)).toEqual([
      ["+3"],
      ["cache ", "37%", ","],
      ["in ", "5k"],
      ["out ", "6", ","],
      ["ctx ", "8% ", "(", "80k", ")"],
    ]);
  });

  it("keeps a line made only of items it could drop", () => {
    const line = [{ text: "~/repo ci@build-host", color: null, ...plain }];
    expect(splitStatusLineItems(line).map((item) => item.dropAt)).toEqual([0, 0]);
  });

  it("drops a version by its muted label, whatever the provider calls it", () => {
    const [line = []] = parseAnsiLines(
      "\u001b[38;5;8mfast \u001b[38;5;183moff\u001b[38;5;8m, v\u001b[38;5;183magy_acp_server_20260818_01_RC01",
    );
    expect(splitStatusLineItems(line).map((item) => item.dropAt)).toEqual([0, 1]);
  });

  it("gives a clock at the end of an item no extra comma", () => {
    const line = [{ text: "up 5s [9:05], v2", color: null, ...plain }];
    expect(splitStatusLineItems(line).map(texts)).toEqual([["up 5s", ","], ["[9:05]"], ["v2"]]);
  });
});

describe("expandStatusLineLabel", () => {
  it("writes out a muted label and leaves other text alone", () => {
    expect(expandStatusLineLabel({ text: "conx ", color: "#808080", ...plain })).toBe("context ");
    expect(expandStatusLineLabel({ text: "v", color: "#808080", ...plain })).toBe("version ");
    expect(expandStatusLineLabel({ text: "), 5h ", color: "#808080", ...plain })).toBe(
      "), 5h limit ",
    );
    expect(expandStatusLineLabel({ text: "in ", color: "#d7afff", ...plain })).toBeNull();
    expect(expandStatusLineLabel({ text: "style ", color: "#808080", ...plain })).toBeNull();
  });

  it("writes out the model name the built-in script shortened", () => {
    const model = { text: "O5.5 ", color: "#d7afff", ...plain };
    expect(expandStatusLineLabel(model, "Opus 5.5")).toBe("Opus 5.5 ");
    expect(expandStatusLineLabel(model, "Sol 6.2")).toBeNull();
    expect(expandStatusLineLabel(model)).toBeNull();
    // A name with nothing to shorten is not treated as a short form of itself.
    expect(expandStatusLineLabel({ ...model, text: "o" }, "o")).toBeNull();
  });
});

describe("reserveStatusLineText", () => {
  it.each([
    ["8%", "00%"],
    ["100%", "000%"],
    ["5s", "00s"],
    ["1d02h", "00d00h"],
    ["9m59s", "00m00s"],
    ["79.7k ", "00.0k "],
    ["(80k)", "(00k)"],
    ["6", "00"],
    ["999", "000"],
    ["1.0k", "00.0k"],
    ["101.3k", "000.0k"],
    ["+3 ", "+3 "],
    ["-120", "-120"],
    ["O5.5 medium", "O5.5 medium"],
    ["Opus 5.5", "Opus 5.5"],
    ["2.1.325", "2.1.325"],
    ["[21:41:07]", "[21:41:07]"],
  ])("reserves %s as %s", (text, reserved) => {
    expect(reserveStatusLineText({ text, color: "#d7afff", ...plain })).toBe(reserved);
  });

  it("leaves labels alone", () => {
    expect(reserveStatusLineText({ text: "5h ", color: "#808080", ...plain })).toBe("5h ");
  });
});

const context: ContextWindowSnapshot = {
  usedTokens: 341_000,
  totalProcessedTokens: null,
  maxTokens: 1_000_000,
  remainingTokens: 659_000,
  usedPercentage: 34.1,
  remainingPercentage: 65.9,
  inputTokens: 338_000,
  cachedInputTokens: 334_620,
  outputTokens: 21_400,
  reasoningOutputTokens: null,
  lastUsedTokens: null,
  lastInputTokens: null,
  lastCachedInputTokens: null,
  lastOutputTokens: null,
  lastReasoningOutputTokens: null,
  toolUses: null,
  durationMs: null,
  compactsAutomatically: true,
  autoCompactThreshold: null,
  cost: null,
  updatedAt: "2026-11-16T00:00:00.000Z",
};

describe("buildStatusLineInput", () => {
  const source: StatusLineInputSource = {
    threadId: "thread-1",
    cwd: "/home/user/code",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
      options: [
        { id: "effort", value: "high" },
        { id: "fastMode", value: false },
      ],
    },
    providers: [
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-11-16T00:00:00.000Z",
        version: "2.1.311",
        models: [
          {
            slug: "claude-opus-5-5",
            name: "Claude Opus 5.5",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
        usageLimits: {
          checkedAt: "2026-11-16T00:00:00.000Z",
          windows: [
            {
              id: "weekly-fable",
              kind: "weekly",
              label: "Fable",
              modelIds: ["claude-fable-5-2"],
              usedPercent: 90,
            },
            {
              id: "session",
              kind: "session",
              label: "5h",
              usedPercent: 47.4,
              resetsAt: "2026-11-16T02:01:00.000Z",
            },
            { id: "weekly", kind: "weekly", label: "7d", usedPercent: 43 },
          ],
        },
      },
    ],
    usageLimitSources: [],
    contextWindow: context,
    nowMs: Date.parse("2026-11-16T00:48:31.000Z"),
  };

  it("maps a thread onto Claude Code's status line fields", () => {
    const input = stampStatusLineInput(
      buildStatusLineInput(source),
      "2026-11-16T00:00:00.000Z",
      Date.parse("2026-11-16T00:48:31.000Z"),
    );
    expect(input).toEqual({
      session_id: "thread-1",
      cwd: "/home/user/code",
      workspace: { current_dir: "/home/user/code", project_dir: "/home/user/code" },
      model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
      effort: { level: "high" },
      fast_mode: false,
      version: "2.1.311",
      cost: { total_duration_ms: 2_911_000 },
      context_window: {
        context_window_size: 1_000_000,
        used_percentage: 34,
        remaining_percentage: 66,
        current_usage: { input_tokens: 341_000 },
        total_input_tokens: 338_000,
        total_output_tokens: 21_400,
      },
      prompt_cache: { hit_ratio: 0.99 },
      rate_limits: {
        five_hour: {
          used_percentage: 47,
          resets_at: Date.parse("2026-11-16T02:01:00.000Z") / 1000,
        },
        seven_day: { used_percentage: 43 },
      },
    });
  });

  it("uses only the selected proxy's account pool for both status line outputs", () => {
    const provider = source.providers[0]!;
    const origin = "http://127.0.0.1:8318";
    const endpoint = origin + "/team-a";
    const reset = "2026-11-16T02:01:00.000Z";
    const hub = {
      id: UsageLimitSourceId.make("proxy"),
      kind: "cliproxy" as const,
      label: "CLIProxyAPI",
      origin,
      endpoint,
      checkedAt: provider.checkedAt,
      accounts: [30, 70].map((usedPercent, index) => ({
        id: String(index),
        driver: provider.driver,
        usageLimits: {
          checkedAt: provider.checkedAt,
          windows: [
            {
              id: "five_hour",
              kind: "session" as const,
              label: "Session",
              usedPercent,
              resetsAt: reset,
              windowDurationMins: 180,
            },
            { id: "seven_day", kind: "weekly" as const, label: "Weekly", usedPercent: 60 },
          ],
        },
      })),
    };
    const routed = {
      ...source,
      nowMs: Date.parse(reset) - 60 * 60_000,
      providers: [{ ...provider, auth: { ...provider.auth, endpoint } }],
      usageLimitSources: [
        { ...hub, id: UsageLimitSourceId.make("other-proxy"), endpoint: origin + "/team-b" },
        hub,
      ],
    };

    expect(buildStatusLineModelUsage(routed)[0]?.limits).toEqual([
      {
        id: "five_hour",
        label: "Session",
        scope: [],
        remainingPercent: 50,
        projectedRemainingPercent: 25,
        resetsAtMs: Date.parse(reset),
      },
      {
        id: "seven_day",
        label: "Weekly",
        scope: [],
        remainingPercent: 40,
        projectedRemainingPercent: null,
        resetsAtMs: null,
      },
      {
        id: "weekly-fable",
        label: "Fable",
        scope: ["claude-fable-5-2"],
        remainingPercent: 10,
        projectedRemainingPercent: null,
        resetsAtMs: null,
      },
    ]);
    expect(buildStatusLineStats(routed)).toMatchObject({
      fiveHour: {
        remainingPercent: 50,
        projectedRemainingPercent: 25,
        resetsAtMs: Date.parse(reset),
      },
      weekly: { remainingPercent: 40, resetsAtMs: null },
    });
    expect(buildStatusLineInput(routed).rate_limits).toEqual({
      five_hour: { used_percentage: 50, resets_at: Date.parse(reset) / 1000 },
      seven_day: { used_percentage: 60 },
    });
    expect(
      buildStatusLineStats({ ...source, usageLimitSources: routed.usageLimitSources }).weekly,
    ).toMatchObject({ remainingPercent: 57 });
    expect(
      buildStatusLineStats({ ...routed, usageLimitSources: [routed.usageLimitSources[0]!] }).weekly,
    ).toMatchObject({ remainingPercent: 57 });
    const staggered = hub.accounts.map((account, index) => ({
      ...account,
      usageLimits: {
        ...account.usageLimits,
        windows: account.usageLimits.windows.map((window) =>
          window.kind === "session"
            ? {
                ...window,
                usedPercent: 30,
                resetsAt: DateTime.formatIso(
                  DateTime.makeUnsafe(Date.parse(reset) + index * 45 * 60_000),
                ),
              }
            : window,
        ),
      },
    }));
    expect(
      buildStatusLineStats({
        ...routed,
        nowMs: Date.parse(reset) - 90 * 60_000,
        usageLimitSources: [{ ...hub, accounts: staggered }],
      }).fiveHour,
    ).toEqual({
      remainingPercent: 70,
      projectedRemainingPercent: 25,
      resetsAtMs: Date.parse(reset),
    });
    const accountsAfterReset = hub.accounts.map((account, index) => ({
      ...account,
      usageLimits: {
        ...account.usageLimits,
        windows: account.usageLimits.windows.map((window) =>
          index === 0 && window.kind === "session"
            ? { ...window, resetsAt: provider.checkedAt }
            : window,
        ),
      },
    }));
    expect(
      buildStatusLineStats({
        ...routed,
        usageLimitSources: [{ ...hub, accounts: accountsAfterReset }],
      }).fiveHour,
    ).toEqual({
      remainingPercent: 30,
      projectedRemainingPercent: -5,
      resetsAtMs: Date.parse(reset),
    });

    const weeklyOnly = hub.accounts.map((account) => ({
      ...account,
      usageLimits: {
        ...account.usageLimits,
        windows: account.usageLimits.windows.filter((window) => window.kind === "weekly"),
      },
    }));
    expect(
      buildStatusLineStats({
        ...routed,
        usageLimitSources: [{ ...hub, accounts: weeklyOnly }],
      }),
    ).toMatchObject({
      fiveHour: { remainingPercent: 53, resetsAtMs: Date.parse(reset) },
      weekly: { remainingPercent: 40, resetsAtMs: null },
    });
  });

  it("binds a quota adapter only to its explicit provider route", () => {
    const provider = source.providers[0]!;
    const providerRoute = "http://127.0.0.1:8318";
    const endpoint = "http://127.0.0.1:8838";
    const { usageLimits, ...providerWithoutLimits } = provider;
    const adapter = {
      id: UsageLimitSourceId.make("claude-local-quota"),
      kind: "cliproxy" as const,
      label: "Claude quota adapter",
      origin: endpoint,
      endpoint,
      checkedAt: provider.checkedAt,
      accounts: [
        {
          id: "claude-quota",
          driver: provider.driver,
          usageLimits: {
            ...usageLimits!,
            windows: usageLimits!.windows.map((window) =>
              window.id === "weekly" ? { ...window, id: "seven_day" } : window,
            ),
          },
        },
      ],
    };
    const withAdapter = (route: string, explicitRoute?: string): StatusLineInputSource => ({
      ...source,
      providers: [{ ...providerWithoutLimits, auth: { ...provider.auth, endpoint: route } }],
      usageLimitSources: [
        { ...adapter, ...(explicitRoute === undefined ? {} : { providerRoute: explicitRoute }) },
      ],
    });

    const associated = withAdapter(providerRoute, providerRoute);
    expect(buildStatusLineStats(associated)).toMatchObject({
      fiveHour: { remainingPercent: 53, resetsAtMs: Date.parse("2026-11-16T02:01:00.000Z") },
      weekly: { remainingPercent: 57, resetsAtMs: null },
    });
    expect(buildStatusLineInput(associated).rate_limits).toMatchObject({
      five_hour: { used_percentage: 47 },
      seven_day: { used_percentage: 43 },
    });
    for (const unmatched of [
      withAdapter(providerRoute),
      withAdapter(providerRoute + "/unrelated", providerRoute),
      withAdapter(endpoint, providerRoute),
    ]) {
      expect(buildStatusLineStats(unmatched)).toMatchObject({ fiveHour: null, weekly: null });
    }
    const codex = ProviderInstanceId.make("codex");
    const codexDriver = ProviderDriverKind.make("codex");
    expect(
      buildStatusLineStats({
        ...associated,
        modelSelection: { instanceId: codex, model: "gpt-6.2-sol" },
        providers: [
          {
            ...providerWithoutLimits,
            instanceId: codex,
            driver: codexDriver,
            auth: { ...provider.auth, endpoint: providerRoute },
          },
        ],
        usageLimitSources: [
          ...associated.usageLimitSources,
          {
            ...adapter,
            id: UsageLimitSourceId.make("codex-hub"),
            origin: providerRoute,
            endpoint: providerRoute,
            accounts: adapter.accounts.map((account) => ({ ...account, driver: codexDriver })),
          },
        ],
      }).weekly,
    ).toEqual({ remainingPercent: 57, projectedRemainingPercent: null, resetsAtMs: null });
  });

  it("lists every enabled provider's models and keeps their limits separate", () => {
    const claude = source.providers[0]!;
    const codex = {
      ...claude,
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Work Codex",
      models: [{ ...claude.models[0]!, slug: "gpt-6.2-sol", name: "GPT-6.2 Sol" }],
      usageLimits: { checkedAt: claude.checkedAt, windows: [] },
    };
    const usage = buildStatusLineModelUsage({
      ...source,
      providers: [claude, codex, { ...codex, enabled: false }],
    });

    expect(usage).toMatchObject([
      { name: "Claude", models: ["Claude Opus 5.5"], limits: [{ id: "weekly-fable" }, {}, {}] },
      { name: "Work Codex", models: ["GPT-6.2 Sol"], limits: [] },
    ]);
  });

  it.each([
    [0, 150, 100, 100, "success"],
    [25.1, 150, 75, 50, "warning"],
    [30, 225, 70, -20, "error"],
    [44, 300, 56, null, "success"],
    [55, 0, 45, null, "warning"],
  ] as const)(
    "uses %s%% spent with %s minutes to reset for the remaining dial and its color",
    (usedPercent, minutesToReset, remainingPercent, projectedRemainingPercent, tone) => {
      const provider = source.providers[0]!;
      const stats = buildStatusLineStats({
        ...source,
        providers: [
          {
            ...provider,
            usageLimits: {
              checkedAt: provider.checkedAt,
              windows: [
                {
                  id: "session",
                  kind: "session",
                  label: "5h",
                  usedPercent,
                  windowDurationMins: 300,
                  resetsAt: DateTime.formatIso(
                    DateTime.makeUnsafe(source.nowMs + minutesToReset * 60_000),
                  ),
                },
              ],
            },
          },
        ],
      });
      expect(stats.fiveHour).toMatchObject({ remainingPercent, projectedRemainingPercent });
      expect(statusLineGaugeTone(remainingPercent, "limit", projectedRemainingPercent)).toBe(tone);
    },
  );

  it.each([
    [25, 50, 33],
    [50, 0, 100],
    [60, -20, 150],
    [0, 100, 0],
    [100, -100, undefined],
  ] as const)(
    "reports a weekly depletion ratio for %s%% spent when enabled",
    (usedPercent, projected, ratio) => {
      const provider = source.providers[0]!;
      const weeklySource = {
        ...source,
        providers: [
          {
            ...provider,
            usageLimits: {
              checkedAt: provider.checkedAt,
              windows: [
                {
                  id: "weekly",
                  kind: "weekly" as const,
                  label: "7d",
                  usedPercent,
                  windowDurationMins: 10_080,
                  resetsAt: DateTime.formatIso(DateTime.makeUnsafe(source.nowMs + 5_040 * 60_000)),
                },
              ],
            },
          },
        ],
      };
      expect(buildStatusLineStats(weeklySource).weekly?.depletionRatioPercent).toBeUndefined();
      const weekly = buildStatusLineStats({
        ...weeklySource,
        showWeeklyDepletionRatio: true,
      }).weekly;
      expect(weekly?.projectedRemainingPercent).toBe(projected);
      expect(weekly?.depletionRatioPercent).toBe(ratio);
    },
  );

  it("gives a client the same facts to draw itself", () => {
    expect(buildStatusLineStats(source)).toEqual({
      modelName: "Opus 5.5",
      effort: "high",
      fastMode: false,
      version: "2.1.311",
      cwd: "/home/user/code",
      contextPercent: 34,
      contextTokens: 341_000,
      contextMaxTokens: 1_000_000,
      fiveHour: {
        remainingPercent: 53,
        projectedRemainingPercent: null,
        resetsAtMs: Date.parse("2026-11-16T02:01:00.000Z"),
      },
      weekly: { remainingPercent: 57, projectedRemainingPercent: null, resetsAtMs: null },
      cachePercent: 99,
      inputTokens: 338_000,
      outputTokens: 21_400,
    });
  });
});

describe("formatStatusLineTokens", () => {
  it.each([
    [588, "588"],
    [1_000, "1k"],
    [68_800, "68.8k"],
    [99_960, "100k"],
    [341_000, "341k"],
    [999_600, "1M"],
    [1_234_567, "1.2M"],
  ])("%d is %s", (tokens, text) => {
    expect(formatStatusLineTokens(tokens)).toBe(text);
  });
});

describe("formatStatusLineSpan", () => {
  it.each([
    [59_000, "0m"],
    [48 * 60_000, "48m"],
    [108 * 60_000, "1h48m"],
    [(2 * 1440 + 4 * 60 + 59) * 60_000, "2d04h"],
  ])("%d ms is %s", (ms, text) => {
    expect(formatStatusLineSpan(ms)).toBe(text);
  });
});

describe("statusLineModelName", () => {
  it.each([
    ["Claude Opus 5.5", "Opus 5.5"],
    ["GPT-6.1-Sol", "Sol 6.1"],
    ["GPT-6-Astra", "Astra 6"],
    ["claude-fable-5-2", "fable 5 2"],
  ])("%s becomes %s", (name, expected) => {
    expect(statusLineModelName(name)).toBe(expected);
  });
});
