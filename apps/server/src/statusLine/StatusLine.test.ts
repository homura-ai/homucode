import { ProviderDriverKind, ProviderInstanceId, UsageLimitSourceId } from "@t3tools/contracts";
import type { ServerProvider, UsageLimitSourceSnapshot } from "@t3tools/contracts";
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
import { statusLineProxyPlans, summarizeStatusLineCost } from "./StatusLineAccounting.ts";
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
  settings: { statusLineEnabled?: boolean; statusLineCommand?: string },
  input: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const statusLine = yield* StatusLine.StatusLine;
    return yield* statusLine.render({ input });
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

it.live("renders nothing while disabled", () =>
  Effect.gen(function* () {
    const result = yield* render(
      { statusLineEnabled: false, statusLineCommand: "echo should-not-run" },
      {},
    );
    assert.deepStrictEqual(result, { text: "" });
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
        return limits.windows[0]?.burnRatePercentPerSecond;
      });
    const firstRate = 10 / 3600;
    const updatedRate = firstRate + (1 - Math.exp(-60 / 1800)) * (2 / 60 - firstRate);
    yield* Effect.gen(function* () {
      assert.closeTo((yield* record("one", 10))!, firstRate, 1e-12);
      yield* TestClock.adjust("30 seconds");
      assert.closeTo((yield* record("one", 11))!, firstRate, 1e-12);
    }).pipe(Effect.provide(recorder));

    yield* TestClock.adjust("30 seconds");
    // A freshly built layer has an empty memory cache.
    yield* Effect.gen(function* () {
      assert.closeTo((yield* record("one", 12))!, updatedRate, 1e-12);
      assert.closeTo((yield* record("two", 12))!, 12 / 3660, 1e-12);
      yield* TestClock.adjust("60 seconds");
      assert.closeTo((yield* record("one", 5, 14.5 * hourMs))!, 5 / 1920, 1e-12);
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
