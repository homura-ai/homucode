import type { OrchestrationV2ProviderTurn, StatusLineAccountingInput } from "@t3tools/contracts";
import type { StatusLineAccounting as Accounting } from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import { usageLimitSourceAtEndpoint } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as UsageService from "../usage/UsageService.ts";
import type { PricedRecord, PricedUsage } from "../usage/usagePricing.ts";

export class StatusLineAccounting extends Context.Reference<{
  readonly read: (input: StatusLineAccountingInput) => Effect.Effect<Accounting | null>;
}>("t3/statusLine/StatusLineAccounting", {
  defaultValue: () => ({ read: () => Effect.succeed(null) }),
}) {}

// Measured plan/API shares from 01-1's subsidy README, November 2026.
function subscriptionShare(provider: "codex" | "claude", plan: string | undefined, model: string) {
  if (provider === "codex" && plan === "ChatGPT Pro 100 Subscription") return 0.047;
  if (provider === "claude" && (plan === "Ultra" || plan === "Claude Ultra Subscription")) {
    if (/(?:^|[-/])fable(?:-|$)/i.test(model)) return 0.057;
    if (/(?:^|[-/])(?:opus|sonnet|haiku)(?:-|$)/i.test(model)) return 0.032;
  }
  return null;
}

export function summarizeStatusLineCost(
  provider: "codex" | "claude",
  plan: string | undefined,
  records: readonly PricedRecord[],
  prices: readonly PricedUsage[],
  partial: boolean,
): Pick<Accounting, "apiCostUsd" | "subscriptionCostUsd" | "partial"> {
  let apiCostUsd: number | null = null;
  let subscriptionCostUsd: number | null = 0;
  for (const [index, record] of records.entries()) {
    const price = prices[index];
    if (price === undefined || price.costSource === "unpriced") {
      partial = true;
      continue;
    }
    const amount = price.costUsd;
    apiCostUsd = (apiCostUsd ?? 0) + amount;
    const share = subscriptionShare(provider, plan, record.model);
    subscriptionCostUsd =
      share === null || subscriptionCostUsd === null ? null : subscriptionCostUsd + amount * share;
  }
  return {
    apiCostUsd,
    subscriptionCostUsd: apiCostUsd === null ? null : subscriptionCostUsd,
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
        const provider = (yield* providers.getProviders).find(
          (entry) => entry.instanceId === active?.providerInstanceId,
        );
        const matchingHub =
          provider?.auth.endpoint === undefined
            ? undefined
            : usageLimitSourceAtEndpoint(yield* hubs.current, provider.auth.endpoint, {
                useProviderRoute: driver === "claudeAgent",
              });
        const plans = matchingHub?.accounts
          .filter((account) => account.driver === driver)
          .map((account) => account.plan);
        const plan =
          provider?.auth.endpoint === undefined
            ? provider?.auth.label
            : plans?.length && plans.every((candidate) => candidate === plans[0])
              ? plans[0]
              : undefined;

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
          if (record === null || turn.turnTokenUsage?.usageStatus !== "complete") partial = true;
          if (record !== null) records.push(record);
        }
        const kind = driver === "codex" ? "codex" : "claude";
        const prices = yield* usage
          .priceRecords(kind, records)
          .pipe(Effect.orElseSucceed(() => []));
        return {
          ...summarizeStatusLineCost(kind, plan, records, prices, partial),
          apiDurationMs,
          outputStyle,
        };
      },
      Effect.orElseSucceed(() => null),
    ),
  };
});

export const layer = Layer.effect(StatusLineAccounting, make);
