import { ProviderDriverKind, ProviderInstanceId, UsageLimitSourceId } from "@t3tools/contracts";
import type {
  ServerProvider,
  StatusLineRenderInput,
  StatusLineCustomBar,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import {
  statusLineProxyPlans,
  summarizeStatusLineAccountUsage,
  summarizeStatusLineCost,
} from "./StatusLineAccounting.ts";
import * as UsageBurnRate from "./UsageBurnRate.ts";
import type { PricedRecord, PricedUsage } from "../usage/usagePricing.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as StatusLine from "./StatusLine.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

// A real directory, resolved the way `pwd -P` prints it.
const tempDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
}).pipe(Effect.provide(NodeServices.layer));

const render = (
  settings: {
    statusLineEnabled?: boolean;
    statusLineCommand?: string;
    statusLineMetricsCommand?: string;
    statusLineCustomBars?: readonly StatusLineCustomBar[];
  },
  input: Record<string, unknown>,
  mode?: StatusLineRenderInput["mode"],
) =>
  Effect.gen(function* () {
    const statusLine = yield* StatusLine.StatusLine;
    return yield* statusLine.render({ input, ...(mode === undefined ? {} : { mode }) });
  }).pipe(
    Effect.provide(
      StatusLine.layer.pipe(
        Layer.provide(ServerSettings.layerTest({ statusLineEnabled: true, ...settings })),
        Layer.provide(ProcessRunner.layer),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

it.live.skipIf(windowsHost)("runs the command in the workspace with the input on stdin", () =>
  Effect.gen(function* () {
    const dir = yield* tempDirectory;
    const result = yield* render(
      { statusLineCommand: `printf '%s ' "$(pwd -P)"; cat` },
      { workspace: { current_dir: dir }, model: { display_name: "Opus 5.5" } },
    );
    assert.deepStrictEqual(result, {
      text: `${dir} {"workspace":{"current_dir":"${dir}"},"model":{"display_name":"Opus 5.5"}}`,
    });
  }),
);

it.live.skipIf(windowsHost)("falls back to home for a missing workspace", () =>
  Effect.gen(function* () {
    const home = yield* tempDirectory;
    const result = yield* render(
      { statusLineCommand: "pwd -P" },
      { workspace: { current_dir: `${home}/missing` } },
    ).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
    assert.strictEqual(result.text, home);
  }),
);

it.live.skipIf(windowsHost)("reports a failing command", () =>
  Effect.gen(function* () {
    const result = yield* render(
      { statusLineCommand: "printf partial; echo broken >&2; exit 3" },
      {},
    );
    assert.deepStrictEqual(result, { text: "partial", error: "broken" });
  }),
);

it.live.skipIf(windowsHost)("runs the configured metrics command and validates its values", () =>
  Effect.gen(function* () {
    const settings = {
      statusLineCommand: "echo text",
      statusLineMetricsCommand: "cat",
    };
    const metric = { remainingPercent: 40, burnRatePercentPerHour: 2 };
    assert.deepStrictEqual(yield* render(settings, { build: metric }, "metrics"), {
      text: "",
      metrics: { build: metric },
    });
    assert.deepStrictEqual(yield* render(settings, {}, undefined), { text: "text" });
    assert.deepStrictEqual(
      yield* render(settings, { build: { remainingPercent: 101 } }, "metrics"),
      {
        text: "",
        error: "Invalid status line metrics JSON",
      },
    );
    assert.deepStrictEqual(yield* render({ statusLineCommand: "echo text" }, {}, "metrics"), {
      text: "",
    });
  }),
);

it.live.skipIf(windowsHost)("runs visible custom start commands independently of metrics", () =>
  Effect.gen(function* () {
    const result = yield* render(
      {
        statusLineCustomBars: [
          {
            id: "build",
            label: "Build",
            visible: true,
            showQuotaPace: true,
            targetPercentPerHour: null,
            source: {
              type: "usage",
              basis: "percentages",
              scope: { kind: "accounts", accountIds: ["account"] },
              window: { kind: "command", command: "printf '2026-11-24T12:00:00Z'" },
            },
          },
        ],
      },
      {},
      "metrics",
    );
    assert.deepStrictEqual(result, {
      text: "",
      customStarts: { build: "2026-11-24T12:00:00.000Z" },
    });
  }),
);

it.live("renders nothing while disabled", () =>
  Effect.gen(function* () {
    const result = yield* render(
      { statusLineEnabled: false, statusLineCommand: "echo should-not-run" },
      {},
    );
    assert.deepStrictEqual(result, { text: "" });
  }),
);

it.effect("prices each routed account separately", () =>
  Effect.sync(() => {
    const price: PricedUsage = {
      costUsd: 1,
      costSource: "modelPriced",
      categoryCostUsd: null,
      speedPremiumUsd: 0,
    };
    const result = summarizeStatusLineAccountUsage(
      "codex",
      [
        {
          accountId: "pro",
          label: "Work",
          plan: "ChatGPT Pro 100 Subscription",
          model: "gpt-6.2-sol",
        },
        {
          accountId: "edu",
          label: null,
          plan: "ChatGPT Edu Plus Subscription",
          model: "gpt-6.2-sol",
        },
        {
          accountId: "pro",
          label: "Work",
          plan: "ChatGPT Pro 100 Subscription",
          model: "gpt-6.2-sol",
        },
      ],
      [price, price, price],
    );
    assert.deepStrictEqual(result, {
      weeklyUsageByAccount: [
        { id: "pro", label: "Work", percent: 200 / 489 },
        { id: "edu", label: null, percent: 100 / 64 },
      ],
      partial: false,
    });
  }),
);

it.effect("persists an EMA by account and window and initializes after a reset", () =>
  Effect.gen(function* () {
    const dir = yield* tempDirectory;
    const recorder = UsageBurnRate.layer.pipe(
      Layer.provide(ServerConfig.layerTest(dir, dir)),
      Layer.provide(ServerSettings.layerTest({ statusLineSessionBurnTauMinutes: 30 })),
      Layer.provide(NodeServices.layer),
    );
    const hourMs = 60 * 60_000;
    yield* TestClock.setTime(10 * hourMs);
    const record = (account: string, usedPercent: number, resetMs = 14 * hourMs) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const burnRate = yield* UsageBurnRate.UsageBurnRate;
        const limits = yield* burnRate.record(["codex", account], {
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          windows: [
            {
              id: "5h",
              kind: "session",
              label: "5h",
              usedPercent,
              resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetMs)),
              windowDurationMins: 300,
            },
          ],
        });
        const window = limits.windows[0];
        assert.isDefined(window);
        assert.isDefined(window.burnRatePercentPerSecond);
        return { rate: window.burnRatePercentPerSecond, interval: window.burnRateInterval };
      });
    const firstRate = 10 / 3600;
    const updatedRate = firstRate + (1 - Math.exp(-60 / 1800)) * (2 / 60 - firstRate);
    yield* Effect.gen(function* () {
      assert.closeTo((yield* record("one", 10)).rate, firstRate, 1e-12);
      yield* TestClock.adjust("30 seconds");
      assert.closeTo((yield* record("one", 11)).rate, firstRate, 1e-12);
    }).pipe(Effect.provide(recorder));

    yield* TestClock.adjust("30 seconds");
    // A freshly built layer has an empty memory cache.
    yield* Effect.gen(function* () {
      assert.closeTo((yield* record("one", 12)).rate, updatedRate, 1e-12);
      assert.closeTo((yield* record("two", 12)).rate, 12 / 3660, 1e-12);
    }).pipe(Effect.provide(recorder));

    yield* Effect.gen(function* () {
      const cached = yield* record("one", 12);
      assert.deepStrictEqual(cached.interval, {
        elapsedMs: 60_000,
        previousRate: firstRate,
        observedRate: 2 / 60,
      });
      yield* TestClock.adjust("60 seconds");
      const reset = yield* record("one", 5, 14.5 * hourMs);
      assert.closeTo(reset.rate, 5 / 1920, 1e-12);
      assert.strictEqual(reset.interval, undefined);
    }).pipe(Effect.provide(recorder));
  }),
);

it.effect("converts measured weekly allowances per account and model", () =>
  Effect.sync(() => {
    const record = (model: string): PricedRecord => ({
      model,
      speed: "standard",
      reportedCostUsd: null,
      totals: {
        uncachedInputTokens: 1,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
    });
    const priced: PricedUsage = {
      costUsd: 10,
      costSource: "modelPriced",
      categoryCostUsd: null,
      speedPremiumUsd: 0,
    };
    const unpriced: PricedUsage = { ...priced, costUsd: 0, costSource: "unpriced" };
    const records = [record("claude-opus-5-5"), record("claude-fable-5-2")];
    const ultra = summarizeStatusLineCost(
      "claude",
      { weekly: ["Ultra"], legacy: "Ultra" },
      records,
      [priced, priced],
      false,
    );
    assert.strictEqual(ultra.apiCostUsd, 20);
    const claudePercent = 1000 / 1447 + 1000 / 811;
    assert.deepStrictEqual(ultra.weeklyUsagePercent, [claudePercent, claudePercent]);
    for (const plan of ["Claude Subscription", "Claude Pro Subscription"]) {
      assert.isUndefined(
        summarizeStatusLineCost(
          "claude",
          { weekly: [plan], legacy: plan },
          records,
          [priced, priced],
          false,
        ).weeklyUsagePercent,
      );
    }
    const codexRecords = [record("gpt-6.2-sol")];
    assert.deepStrictEqual(
      summarizeStatusLineCost(
        "codex",
        {
          weekly: ["ChatGPT Pro 100 Subscription", "ChatGPT Edu Plus Subscription"],
          legacy: undefined,
        },
        codexRecords,
        [priced],
        false,
      ).weeklyUsagePercent,
      [1000 / 489, 1000 / 64],
    );
    assert.strictEqual(
      summarizeStatusLineCost(
        "codex",
        { weekly: ["ChatGPT Pro 100 Subscription", "ChatGPT Edu Subscription"], legacy: undefined },
        codexRecords,
        [priced],
        false,
      ).weeklyUsagePercent,
      undefined,
    );
    assert.deepStrictEqual(
      summarizeStatusLineCost(
        "claude",
        { weekly: [], legacy: undefined },
        records,
        [priced, unpriced],
        false,
      ),
      {
        apiCostUsd: 10,
        subscriptionCostUsd: null,
        partial: true,
      },
    );
    assert.deepStrictEqual(
      summarizeStatusLineCost(
        "codex",
        { weekly: ["ChatGPT Pro 100 Subscription"], legacy: "ChatGPT Pro 100 Subscription" },
        [record("gpt-6.2-sol")],
        [unpriced],
        false,
      ),
      {
        apiCostUsd: null,
        subscriptionCostUsd: null,
        partial: true,
      },
    );
  }),
);

it.effect("uses account metadata before a hub's declared Claude Ultra plan", () =>
  Effect.sync(() => {
    const driver = ProviderDriverKind.make("claudeAgent");
    const checkedAt = "2026-11-20T00:00:00.000Z";
    const source = {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy",
      label: "Hub",
      endpoint: "https://hub.example",
      providerRoute: "https://proxy.example",
      checkedAt,
      accounts: [
        {
          id: "account",
          driver,
          email: "subscriber@example.com",
          plan: "Claude Subscription",
          usageLimits: { checkedAt, windows: [] },
        },
      ],
    } satisfies UsageLimitSourceSnapshot;
    const proxy: ServerProvider = {
      instanceId: ProviderInstanceId.make("proxy"),
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      checkedAt,
      auth: { status: "authenticated", type: "customEndpoint", endpoint: source.providerRoute },
      models: [],
      slashCommands: [],
      skills: [],
    };
    const declared = { ...source, claudeUltra: true };
    assert.deepStrictEqual(statusLineProxyPlans(proxy, [proxy], [source]), {
      weekly: ["Claude Subscription"],
      legacy: "Claude Subscription",
    });
    assert.deepStrictEqual(statusLineProxyPlans(proxy, [proxy], [declared]), {
      weekly: ["Claude Ultra Subscription"],
      legacy: "Claude Subscription",
    });
    const direct: ServerProvider = {
      ...proxy,
      instanceId: ProviderInstanceId.make("native"),
      auth: {
        status: "authenticated",
        label: "Claude Pro Subscription",
        email: "subscriber@example.com",
      },
    };
    assert.deepStrictEqual(statusLineProxyPlans(proxy, [proxy, direct], [declared]), {
      weekly: ["Claude Pro Subscription"],
      legacy: "Claude Subscription",
    });
  }),
);
