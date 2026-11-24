import type {
  OrchestrationV2ProviderTurn,
  ServerProvider,
  StatusLineAccountingInput,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import type { StatusLineAccounting as Accounting } from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import {
  resolveLimitAccountMetadata,
  usageLimitSourceAtEndpoint,
  statusLineAccountKey,
  weeklyAllowanceUsd,
} from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as UsageService from "../usage/UsageService.ts";
import type { PricedRecord, PricedUsage } from "../usage/usagePricing.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  createStatusLineUsageLedgerCache,
  readStatusLineUsageLedger,
  statusLineExecutionPriceRecord,
} from "./StatusLineUsageLedger.ts";

export class StatusLineAccounting extends Context.Reference<{
  readonly read: (input: StatusLineAccountingInput) => Effect.Effect<Accounting | null>;
}>("t3/statusLine/StatusLineAccounting", {
  defaultValue: () => ({ read: () => Effect.succeed(null) }),
}) {}

// Measured plan/API shares from 01-1's subsidy README, November 2026. CLIProxyAPI reports
// every Claude account as "Claude Subscription", so an untiered one takes Ultra's share.
const CLAUDE_SUBSCRIPTION_PLANS = new Set([
  "Ultra",
  "Claude Ultra Subscription",
  "Claude Subscription",
]);

function subscriptionShare(provider: "codex" | "claude", plan: string | undefined, model: string) {
  if (provider === "codex" && plan === "ChatGPT Pro 100 Subscription") return 0.047;
  if (provider === "claude" && plan !== undefined && CLAUDE_SUBSCRIPTION_PLANS.has(plan)) {
    if (/(?:^|[-/])fable(?:-|$)/i.test(model)) return 0.057;
    if (/(?:^|[-/])(?:opus|sonnet|haiku)(?:-|$)/i.test(model)) return 0.032;
  }
  return null;
}

interface StatusLinePlans {
  readonly weekly: readonly (string | undefined)[];
  readonly legacy: string | undefined;
}

export function statusLineProxyPlans(
  provider: ServerProvider,
  providers: readonly ServerProvider[],
  sources: readonly UsageLimitSourceSnapshot[],
): StatusLinePlans {
  if (provider.auth.endpoint === undefined) return { weekly: [], legacy: undefined };
  const hub = usageLimitSourceAtEndpoint(sources, provider.auth.endpoint, {
    useProviderRoute: provider.driver === "claudeAgent",
  });
  if (!hub || hub.error) return { weekly: [], legacy: undefined };
  const { resolveKey, plans } = resolveLimitAccountMetadata(providers, sources, hub);
  const accounts = hub.accounts.filter((account) => account.driver === provider.driver);
  const legacy = accounts[0]?.plan;
  const weekly = accounts.map((account) =>
    resolveStatusLineAccountPlan(account, resolveKey, plans, hub),
  );
  return {
    weekly: [...new Set(weekly)],
    legacy: accounts.every((account) => account.plan === legacy) ? legacy : undefined,
  };
}

function resolveStatusLineAccountPlan(
  account: UsageLimitSourceSnapshot["accounts"][number],
  resolveKey: ReturnType<typeof resolveLimitAccountMetadata>["resolveKey"],
  plans: ReturnType<typeof resolveLimitAccountMetadata>["plans"],
  hub: UsageLimitSourceSnapshot,
) {
  const key = resolveKey(account);
  const plan = (key === null ? undefined : plans.get(key)?.plan) ?? account.plan;
  return account.driver === "claudeAgent" &&
    plan === "Claude Subscription" &&
    hub.claudeUltra === true
    ? "Claude Ultra Subscription"
    : plan;
}

export function summarizeStatusLineAccountUsage(
  provider: "codex" | "claude",
  records: ReadonlyArray<{
    readonly accountId: string;
    readonly label: string | null;
    readonly plan: string | undefined;
    readonly model: string;
  }>,
  prices: readonly PricedUsage[],
) {
  const byId = new Map<string, { id: string; label: string | null; percent: number }>();
  let partial = false;
  for (const [index, record] of records.entries()) {
    const price = prices[index];
    const allowance = weeklyAllowanceUsd(provider, record.plan, record.model);
    if (!price || price.costSource === "unpriced" || allowance === null) {
      partial = true;
      continue;
    }
    const percent = (100 * price.costUsd) / allowance;
    const previous = byId.get(record.accountId);
    byId.set(record.accountId, {
      id: record.accountId,
      label: record.label,
      percent: (previous?.percent ?? 0) + percent,
    });
  }
  return { weeklyUsageByAccount: [...byId.values()], partial };
}

export function summarizeStatusLineCost(
  provider: "codex" | "claude",
  plans: StatusLinePlans,
  records: readonly PricedRecord[],
  prices: readonly PricedUsage[],
  partial: boolean,
): Pick<Accounting, "apiCostUsd" | "subscriptionCostUsd" | "weeklyUsagePercent" | "partial"> {
  let apiCostUsd: number | null = null;
  let subscriptionCostUsd: number | null = 0;
  let minimumPercent = 0;
  let maximumPercent = 0;
  let weeklyEstimateAvailable = plans.weekly.length > 0;
  for (const [index, record] of records.entries()) {
    const price = prices[index];
    if (price === undefined || price.costSource === "unpriced") {
      partial = true;
      continue;
    }
    const amount = price.costUsd;
    apiCostUsd = (apiCostUsd ?? 0) + amount;
    if (weeklyEstimateAvailable) {
      const allowances = plans.weekly.map((candidate) =>
        weeklyAllowanceUsd(provider, candidate, record.model),
      );
      if (allowances.every((allowance) => allowance !== null)) {
        minimumPercent += (100 * amount) / Math.max(...allowances);
        maximumPercent += (100 * amount) / Math.min(...allowances);
      } else {
        weeklyEstimateAvailable = false;
      }
    }
    const share = subscriptionShare(provider, plans.legacy, record.model);
    subscriptionCostUsd =
      share === null || subscriptionCostUsd === null ? null : subscriptionCostUsd + amount * share;
  }
  return {
    apiCostUsd,
    subscriptionCostUsd: apiCostUsd === null ? null : subscriptionCostUsd,
    ...(apiCostUsd !== null && weeklyEstimateAvailable
      ? { weeklyUsagePercent: [minimumPercent, maximumPercent] }
      : {}),
    partial,
  };
}

function recordForTurn(
  turn: OrchestrationV2ProviderTurn,
  selection: Parameters<typeof getModelSelectionBooleanOptionValue>[0],
): PricedRecord | null {
  const usage = turn.turnTokenUsage;
  const model = usage?.models?.length === 1 ? usage.models[0] : (turn.model ?? selection?.model);
  if (
    !model ||
    (usage?.models?.length ?? 0) > 1 ||
    usage?.inputTokens === undefined ||
    usage.outputTokens === undefined ||
    usage.usageStatus === "unavailable"
  )
    return null;
  const cached = usage.cachedInputTokens ?? 0;
  const write = usage.cacheCreationTokens ?? 0;
  const tier = getModelSelectionStringOptionValue(selection, "serviceTier");
  const speed =
    turn.apiSpeed ??
    (tier === "ultrafast"
      ? "ultrafast"
      : tier === "priority" ||
          tier === "fast" ||
          getModelSelectionBooleanOptionValue(selection, "fastMode")
        ? "fast"
        : "standard");
  return {
    model,
    speed,
    reportedCostUsd: null,
    ...(usage.cacheCreation1hTokens === undefined
      ? {}
      : { cacheCreation1hTokens: usage.cacheCreation1hTokens }),
    totals: {
      uncachedInputTokens: Math.max(0, usage.inputTokens - cached - write),
      cachedInputTokens: cached,
      cacheCreationTokens: write,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens ?? 0,
    },
  };
}

const make = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const hubs = yield* UsageLimitSources.UsageLimitSources;
  const usage = yield* UsageService.UsageService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ledgerCache = createStatusLineUsageLedgerCache();

  return {
    read: Effect.fn("StatusLineAccounting.read")(
      function* ({ threadId }: StatusLineAccountingInput) {
        const { thread } = yield* store.getThreadRecords(threadId, []);
        const activeId = thread.activeProviderThreadId;
        if (activeId === null) return null;
        const current = yield* store.getThreadRecords(
          threadId,
          ["providerThreads", "providerTurns"],
          { providerThreadIds: [activeId], providerTurnThreadIds: [activeId] },
        );
        if (current.thread.activeProviderThreadId !== activeId) return null;
        const { providerThreads, providerTurns } = current;
        const active = providerThreads.find((entry) => entry.id === activeId);
        const driver = active?.driver;
        if (driver !== "codex" && driver !== "claudeAgent") return null;
        const snapshots = yield* providers.getProviders;
        const provider = snapshots.find((entry) => entry.instanceId === active?.providerInstanceId);
        const sources = yield* hubs.current;
        const endpoint = provider?.auth.endpoint;
        const hub =
          endpoint === undefined
            ? undefined
            : usageLimitSourceAtEndpoint(sources, endpoint, {
                useProviderRoute: driver === "claudeAgent",
              });
        const plans =
          endpoint === undefined
            ? { weekly: [provider?.auth.label], legacy: provider?.auth.label }
            : {
                weekly: [],
                legacy: provider
                  ? statusLineProxyPlans(provider, snapshots, sources).legacy
                  : undefined,
              };

        const turns = providerTurns.filter(
          (turn) =>
            turn.providerThreadId === activeId &&
            turn.startedAt !== null &&
            turn.completedAt !== null &&
            turn.runAttemptId !== null,
        );
        if (turns.length === 0) return null;
        const attemptIds = [
          ...new Set(
            turns.flatMap((turn) => (turn.runAttemptId === null ? [] : [turn.runAttemptId])),
          ),
        ];
        const { attempts } = yield* store.getThreadRecords(threadId, ["attempts"], { attemptIds });
        const runIds = [...new Set(attempts.map((attempt) => attempt.runId))];
        const { runs } = yield* store.getThreadRecords(threadId, ["runs"], { runIds });
        const runById = new Map(runs.map((run) => [run.id, run]));
        const selections = new Map(
          attempts.map((attempt) => [
            attempt.id,
            runById.get(attempt.runId)?.modelSelection ?? null,
          ]),
        );

        const records: PricedRecord[] = [];
        let partial = false;
        let apiDurationMs: number | null = null;
        let outputStyle: string | null = null;
        let styleOrdinal = 0;
        for (const turn of turns) {
          if (turn.outputStyle !== undefined && turn.ordinal >= styleOrdinal) {
            outputStyle = turn.outputStyle;
            styleOrdinal = turn.ordinal;
          }
          if (turn.apiDurationMs !== undefined) {
            apiDurationMs = (apiDurationMs ?? 0) + turn.apiDurationMs;
          }
          if (turn.turnTokenUsage?.localCommand) continue;
          const record = recordForTurn(turn, selections.get(turn.runAttemptId!) ?? null);
          // Without Claude's TTL split, cache writes are priced at the cheaper five-minute rate.
          const unknownCacheTtl =
            driver === "claudeAgent" &&
            record !== null &&
            record.totals.cacheCreationTokens > 0 &&
            record.cacheCreation1hTokens === undefined;
          if (
            record === null ||
            unknownCacheTtl ||
            turn.turnTokenUsage?.usageStatus !== "complete"
          ) {
            partial = true;
          }
          if (record !== null) records.push(record);
        }
        const kind = driver === "codex" ? "codex" : "claude";
        const prices = yield* usage
          .priceRecords(kind, records)
          .pipe(Effect.orElseSucceed(() => []));
        const base = summarizeStatusLineCost(kind, plans, records, prices, partial);
        if (endpoint === undefined) return { ...base, apiDurationMs, outputStyle };
        const currentSettings = yield* settings.getSettings;
        const directory =
          hub && !hub.error ? currentSettings.usageLimitSources[hub.id]?.usageLedgerDir : undefined;
        const nativeThreadId = active?.nativeThreadRef?.nativeId?.toLowerCase();
        if (!directory || !hub || !nativeThreadId) {
          return { ...base, weeklyUsageByAccount: [], partial: true, apiDurationMs, outputStyle };
        }
        const now = yield* Clock.currentTimeMillis;
        const firstTurn = turns.reduce(
          (earliest, turn) =>
            turn.startedAt === null
              ? earliest
              : Math.min(earliest, DateTime.toEpochMillis(turn.startedAt)),
          now,
        );
        const executions = yield* readStatusLineUsageLedger(
          directory,
          firstTurn,
          now,
          ledgerCache,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        const { resolveKey, plans: accountPlans } = resolveLimitAccountMetadata(
          snapshots,
          sources,
          hub,
        );
        const accounts = new Map(
          hub.accounts
            .filter((account) => account.driver === driver && account.authIndex)
            .map((account) => [account.authIndex, account]),
        );
        const matching = executions.filter(
          (execution) =>
            execution.thread_id === nativeThreadId &&
            execution.provider === kind &&
            !execution.failed,
        );
        const seenTurnIds = new Set(matching.map((execution) => execution.turn_id));
        const priced = matching.flatMap((execution) => {
          const account = accounts.get(execution.auth_index);
          const record = statusLineExecutionPriceRecord(execution);
          if (
            !account?.quotaAccountFingerprint ||
            account.quotaAccountFingerprint !== execution.account_fingerprint ||
            !record
          )
            return [];
          const accountId = statusLineAccountKey(hub.id, account.id);
          return [
            {
              record,
              accountId,
              label: currentSettings.statusLineAccountNames[accountId] ?? null,
              plan: resolveStatusLineAccountPlan(account, resolveKey, accountPlans, hub),
              model: record.model,
            },
          ];
        });
        const accountPrices = yield* usage
          .priceRecords(
            kind,
            priced.map(({ record }) => record),
          )
          .pipe(Effect.orElseSucceed(() => []));
        const perAccount = summarizeStatusLineAccountUsage(kind, priced, accountPrices);
        const missingCodexTurn =
          kind === "codex" &&
          turns.some(
            (turn) =>
              !turn.turnTokenUsage?.localCommand &&
              (!turn.nativeTurnRef?.nativeId ||
                !seenTurnIds.has(turn.nativeTurnRef.nativeId.toLowerCase())),
          );
        return {
          ...base,
          ...perAccount,
          partial:
            perAccount.partial ||
            priced.length !== matching.length ||
            matching.length === 0 ||
            missingCodexTurn ||
            (kind === "claude" &&
              base.apiCostUsd !== null &&
              accountPrices.reduce((total, price) => total + price.costUsd, 0) + 0.00001 <
                base.apiCostUsd),
          apiDurationMs,
          outputStyle,
        };
      },
      Effect.orElseSucceed(() => null),
    ),
  };
});

export const layer = Layer.effect(StatusLineAccounting, make);
