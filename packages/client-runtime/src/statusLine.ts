import type {
  ModelSelection,
  ServerProvider,
  ServerProviderModel,
  ServerProviderUsageWindow,
  StatusLineAccounting,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import {
  collectLimitPools,
  collectProviderUsageLimits,
  isSubscriptionWeeklyWindow,
  remainingPercent,
  resolveLimitAccountMetadata,
  usageLimitSourceAtEndpoint,
  usageWindowForForecast,
} from "@t3tools/shared/usageLimits";

import type { ContextWindowSnapshot } from "./state/contextWindow.ts";
import {
  providerInstanceInitials,
  resolveProviderInstanceDisplayName,
} from "./state/providerInstanceDisplay.ts";
import { REASONING_EFFORT_OPTION_IDS } from "./state/threadExecution.ts";

export interface StatusLineInputSource {
  readonly threadId: string;
  readonly cwd: string | null;
  readonly modelSelection: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly usageLimitSources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
  /** Usage limits are read as of this time. */
  readonly nowMs: number;
  readonly hideSessionLimit?: boolean;
  readonly showSessionDepletionRatio?: boolean;
  readonly showWeeklyDepletionRatio?: boolean;
  readonly accounting?: StatusLineAccounting | null;
}

export type StatusLineUsageSource = Pick<
  StatusLineInputSource,
  "providers" | "usageLimitSources" | "nowMs"
>;

type StatusLineUsageWindow = ServerProviderUsageWindow & {
  readonly remainingPercent?: number;
  readonly account?: { readonly key: string; readonly label: string };
};

function summaryWindow(provider: ServerProvider, window: ServerProviderUsageWindow): boolean {
  return (
    window.modelIds === undefined &&
    window.providerIds === undefined &&
    (window.kind === "session" ||
      (window.kind === "weekly" &&
        (provider.driver !== "claudeAgent" || window.id === "seven_day" || window.id === "weekly")))
  );
}

function hubUsageWindows(
  provider: ServerProvider,
  { providers, usageLimitSources: sources, nowMs: now }: StatusLineUsageSource,
  includeAll: boolean,
): ReadonlyArray<StatusLineUsageWindow> {
  if (!provider.auth.endpoint) return [];
  const hub = usageLimitSourceAtEndpoint(sources, provider.auth.endpoint, {
    useProviderRoute: provider.driver === "claudeAgent",
  });
  if (!hub || hub.error) return [];
  const { resolveKey, plans } = resolveLimitAccountMetadata(providers, sources, hub);
  const accounts = hub.accounts
    .filter((account) => account.driver === provider.driver && !account.usageLimits.unavailable)
    .map((account) => {
      const key = resolveKey(account);
      const plan = key === null ? undefined : plans.get(key);
      return {
        key: account.id,
        driver: account.driver,
        displayName: null,
        email: account.email,
        plan: plan?.plan ?? account.plan,
        planType: plan?.planType,
        accentColor: undefined,
        environments: [],
        sourceLabel: hub.label,
        redeem: null,
        limits: {
          ...account.usageLimits,
          windows: account.usageLimits.windows.filter(
            (window) =>
              (isSubscriptionWeeklyWindow(account.driver, window.kind) ||
                window.resetsAt === undefined ||
                Date.parse(window.resetsAt) > now) &&
              (includeAll || summaryWindow(provider, window)),
          ),
        },
      };
    });
  const [pool] = collectLimitPools(accounts, now, { ignoreExpiredWeeklyForSessions: true });
  return (
    pool?.windows.flatMap((window): StatusLineUsageWindow[] => {
      if (window.usedPercent === null || window.remainingPercent === null) {
        const seen = new Map<string, number>();
        return window.members.map(({ account, window: reported }, index) => {
          const name = providerInstanceInitials(account.email ?? account.key) || String(index + 1);
          const count = (seen.get(name) ?? 0) + 1;
          seen.set(name, count);
          return {
            ...usageWindowForForecast(reported, account.driver, account.limits.checkedAt, now),
            account: { key: account.key, label: count === 1 ? name : `${name}${count}` },
          };
        });
      }
      const resetsAt = window.resets[0]?.member.window.resetsAt;
      const reported = window.members[0]?.window;
      return [
        {
          id: reported?.id ?? window.id,
          label: window.label,
          ...(reported?.modelIds === undefined ? {} : { modelIds: reported.modelIds }),
          ...(reported?.providerIds === undefined ? {} : { providerIds: reported.providerIds }),
          kind: window.kind,
          usedPercent: window.usedPercent,
          remainingPercent: window.remainingPercent,
          ...(resetsAt === undefined ? {} : { resetsAt }),
          ...(window.burnRatePercentPerSecond === undefined
            ? {}
            : {
                burnRatePercentPerSecond: window.burnRatePercentPerSecond,
              }),
        },
      ];
    }) ?? []
  );
}

function usageWindows(source: StatusLineInputSource): ReadonlyArray<StatusLineUsageWindow> {
  const instanceId = source.modelSelection?.instanceId;
  const provider = source.providers.find((candidate) => candidate.instanceId === instanceId);
  if (instanceId === undefined || !provider) return [];
  return providerUsageWindows(provider, source, false);
}

function providerUsageWindows(
  provider: ServerProvider,
  source: StatusLineUsageSource,
  includeAll: boolean,
): ReadonlyArray<StatusLineUsageWindow> {
  const { instanceId } = provider;
  const hubWindows = hubUsageWindows(provider, source, includeAll);
  const report = collectProviderUsageLimits(
    instanceId,
    source.providers,
    source.usageLimitSources,
    source.nowMs,
  );
  // Another account in the report may be a different login, so only this instance's entry counts.
  const limits =
    report?.accounts.find((entry) => entry.instanceId === instanceId)?.limits ??
    provider.usageLimits;
  const nativeWindows = limits?.unavailable === undefined ? (limits?.windows ?? []) : [];
  return [
    ...hubWindows,
    ...nativeWindows
      .filter(
        (window) =>
          // Claude's scoped weekly windows, such as `seven_day_fable`, never stand in for its main one.
          (includeAll || provider.driver !== "claudeAgent" || summaryWindow(provider, window)) &&
          !hubWindows.some(
            (hub) =>
              hub.kind === window.kind &&
              (hub.id === window.id ||
                (summaryWindow(provider, hub) && summaryWindow(provider, window))),
          ),
      )
      .map((window) =>
        usageWindowForForecast(
          window,
          provider.driver,
          limits?.checkedAt ?? provider.checkedAt,
          source.nowMs,
        ),
      ),
  ];
}

export function buildStatusLineModelUsage(source: StatusLineUsageSource) {
  return source.providers
    .filter((provider) => provider.enabled && provider.models.length > 0)
    .map((provider) => {
      const names = new Map(provider.models.map((model) => [model.slug, model.name]));
      return {
        instanceId: provider.instanceId,
        name: resolveProviderInstanceDisplayName(provider),
        models: [...names.values()],
        limits: providerUsageWindows(provider, source, true).map((window) => {
          return {
            id: window.account ? JSON.stringify([window.id, window.account.key]) : window.id,
            label: window.account ? `${window.label} · ${window.account.label}` : window.label,
            scope: [
              ...(window.modelIds?.map((id) => names.get(id) ?? id) ?? []),
              ...(window.providerIds ?? []),
            ],
            ...limitFromWindow(window, source.nowMs),
          };
        }),
      };
    });
}

function findUsageWindow(
  windows: ReadonlyArray<StatusLineUsageWindow>,
  kind: ServerProviderUsageWindow["kind"],
) {
  const matching = windows.filter((window) => window.kind === kind && !window.account);
  return matching.find((candidate) => candidate.modelIds === undefined) ?? matching[0];
}

function rateLimit(
  windows: ReadonlyArray<StatusLineUsageWindow>,
  kind: ServerProviderUsageWindow["kind"],
) {
  const window = findUsageWindow(windows, kind);
  if (window === undefined) return undefined;
  const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  return {
    used_percentage: Math.round(window.usedPercent),
    ...(Number.isFinite(resetsAt) ? { resets_at: Math.floor(resetsAt / 1000) } : {}),
  };
}

/** "Claude Opus 5.5" and "GPT-6.1-Sol" become "Opus 5.5" and "Sol 6.1", the shape Claude Code reports. */
export function statusLineModelName(name: string): string {
  const words = name.split(/[\s-]+/).filter((word) => word !== "" && !/^(claude|gpt)$/i.test(word));
  const versions = words.filter((word) => /^\d/.test(word));
  const rest = words.filter((word) => !/^\d/.test(word));
  return [...rest, ...versions].join(" ") || name;
}

function effortLevel(
  selection: ModelSelection | null,
  model: ServerProviderModel | undefined,
): string | undefined {
  const stated = REASONING_EFFORT_OPTION_IDS.map((id) =>
    getModelSelectionStringOptionValue(selection, id),
  ).find(Boolean);
  if (stated !== undefined) return stated;
  for (const id of REASONING_EFFORT_OPTION_IDS) {
    const descriptor = model?.capabilities?.optionDescriptors?.find(
      (candidate) => candidate.id === id,
    );
    if (descriptor?.type !== "select") continue;
    const value =
      descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
    if (value !== undefined) return value;
  }
  return undefined;
}

function statusLineFastMode(
  selection: ModelSelection | null,
  model: ServerProviderModel | undefined,
): boolean | null {
  const tier = getModelSelectionStringOptionValue(selection, "serviceTier");
  if (tier !== undefined) return ["fast", "priority", "ultrafast"].includes(tier);
  return (
    getModelSelectionBooleanOptionValue(selection, "fastMode") ??
    (model?.capabilities?.optionDescriptors?.some(
      (option) => option.id === "fastMode" || option.id === "serviceTier",
    )
      ? false
      : null)
  );
}

function selectedModel(source: Pick<StatusLineInputSource, "modelSelection" | "providers">) {
  const selection = source.modelSelection;
  const provider =
    selection === null
      ? undefined
      : source.providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === selection?.model);
  return { selection, provider, model };
}

/** The model name the status line script is given, such as `Opus 5.5`. Null without a model. */
export function statusLineInputModelName(
  source: Pick<StatusLineInputSource, "modelSelection" | "providers">,
): string | null {
  const { selection, model } = selectedModel(source);
  return selection === null ? null : statusLineModelName(model?.name ?? selection.model);
}

export interface StatusLineLimit {
  readonly remainingPercent: number;
  readonly projectedRemainingPercent: number | null;
  readonly depletionRatioPercent?: number;
  readonly resetsAtMs: number | null;
  readonly usedPercent?: number;
  readonly burnRatePercentPerSecond?: number;
}

export function formatStatusLineWeeklyUsage(
  accounting: StatusLineAccounting | null | undefined,
): string | null {
  if (accounting?.weeklyUsagePercent === undefined) return null;
  const [minimum, maximum] = accounting.weeklyUsagePercent;
  const lower = minimum.toFixed(2);
  const upper = maximum.toFixed(2);
  if (minimum !== maximum) {
    const range =
      lower === upper ? `${minimum.toPrecision(2)}–${maximum.toPrecision(2)}` : `${lower}–${upper}`;
    return `≈${range}%${accounting.partial ? "+" : ""}`;
  }
  if (accounting.partial) return `≥${(Math.floor(minimum * 100) / 100).toFixed(2)}%`;
  return maximum > 0 && maximum < 0.01 ? "<0.01%" : `≈${lower}%`;
}

/** What a client draws its own status line from, when no custom command draws it. */
export interface StatusLineStats {
  readonly modelName: string | null;
  readonly effort: string | null;
  readonly fastMode: boolean | null;
  readonly version: string | null;
  readonly threadWeeklyUsage: string | null;
  readonly threadWeeklyUsagePartial: boolean;
  readonly apiTime: string | null;
  readonly outputStyle: string | null;
  readonly cwd: string | null;
  readonly contextPercent: number | null;
  readonly contextTokens: number | null;
  readonly contextMaxTokens: number | null;
  readonly fiveHour: StatusLineLimit | null;
  readonly weekly: StatusLineLimit | null;
  readonly weeklyAccounts: ReadonlyArray<
    StatusLineLimit & { readonly id: string; readonly label: string }
  >;
  readonly cachePercent: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

function smoothedBurnToReset(
  rate: number | undefined,
  resetsAtMs: number | null,
  nowMs: number,
): number | null {
  if (rate === undefined || resetsAtMs === null || resetsAtMs <= nowMs) return null;
  return (rate * (resetsAtMs - nowMs)) / 1_000;
}

function limitFromWindow(
  window: StatusLineUsageWindow,
  nowMs: number,
  showDepletionRatio = false,
): StatusLineLimit {
  const reset = Date.parse(window.resetsAt ?? "");
  const resetsAtMs = Number.isFinite(reset) ? reset : null;
  const burn = smoothedBurnToReset(window.burnRatePercentPerSecond, resetsAtMs, nowMs);
  const exactRemaining = 100 - window.usedPercent;
  const depletionRatio =
    showDepletionRatio && burn !== null && exactRemaining > 0
      ? Math.round((100 * burn) / exactRemaining)
      : null;
  const remaining = window.remainingPercent ?? remainingPercent(window);
  return {
    remainingPercent: remaining,
    projectedRemainingPercent: burn === null ? null : Math.round(exactRemaining - burn),
    ...(depletionRatio === null ? {} : { depletionRatioPercent: depletionRatio }),
    resetsAtMs,
    ...(window.usedPercent === 100 - remaining ? {} : { usedPercent: window.usedPercent }),
    ...(window.burnRatePercentPerSecond === undefined
      ? {}
      : { burnRatePercentPerSecond: window.burnRatePercentPerSecond }),
  };
}

function statusLineLimit(
  windows: ReadonlyArray<StatusLineUsageWindow>,
  kind: ServerProviderUsageWindow["kind"],
  nowMs: number,
  showDepletionRatio = false,
): StatusLineLimit | null {
  const window = findUsageWindow(windows, kind);
  return window === undefined ? null : limitFromWindow(window, nowMs, showDepletionRatio);
}

/** The same facts `buildStatusLineInput` gives a script, typed for a client to draw. */
export function buildStatusLineStats(source: StatusLineInputSource): StatusLineStats {
  const { selection, provider, model } = selectedModel(source);
  const context = source.contextWindow;
  const windows = usageWindows(source);
  const weekly = statusLineLimit(windows, "weekly", source.nowMs, source.showWeeklyDepletionRatio);
  const inputTokens = context?.inputTokens ?? null;
  const cachedInputTokens = context?.cachedInputTokens ?? null;
  return {
    modelName: statusLineInputModelName(source),
    effort: effortLevel(selection, model) ?? null,
    fastMode: statusLineFastMode(selection, model),
    version: provider?.version || null,
    threadWeeklyUsage: formatStatusLineWeeklyUsage(source.accounting),
    threadWeeklyUsagePartial: source.accounting?.partial === true,
    apiTime:
      source.accounting?.apiDurationMs == null
        ? null
        : formatStatusLineApiTime(source.accounting.apiDurationMs),
    outputStyle: source.accounting?.outputStyle ?? null,
    cwd: source.cwd,
    contextPercent:
      context === null || context.usedPercentage === null ? null : context.usedPercentage,
    contextTokens: context?.usedTokens ?? null,
    contextMaxTokens: context?.maxTokens ?? null,
    fiveHour: source.hideSessionLimit
      ? null
      : statusLineLimit(windows, "session", source.nowMs, source.showSessionDepletionRatio),
    weekly,
    weeklyAccounts:
      weekly !== null
        ? []
        : windows.flatMap((window) =>
            window.kind === "weekly" && window.account
              ? [
                  {
                    id: JSON.stringify([window.id, window.account.key]),
                    label: window.account.label,
                    ...limitFromWindow(window, source.nowMs, source.showWeeklyDepletionRatio),
                  },
                ]
              : [],
          ),
    cachePercent:
      inputTokens !== null && inputTokens > 0 && cachedInputTokens !== null
        ? 100 * Math.min(1, cachedInputTokens / inputTokens)
        : null,
    inputTokens,
    outputTokens: context?.outputTokens ?? null,
  };
}

export const STATUS_LINE_EFFORT_COLORS = [
  ["#6322b6", "#be9dff"],
  ["#8835a0", "#dc9af5"],
  ["#a60068", "#ff83c7"],
  ["#ba124a", "#ff769d"],
  ["#bd171c", "#ff7775"],
] as const;

export function statusLineEffortPosition(effort: string): number | undefined {
  switch (effort.toLowerCase()) {
    case "minimal":
    case "low":
      return 0;
    case "medium":
      return 25;
    case "high":
      return 50;
    case "xhigh":
    case "extra high":
    case "extra-high":
    case "extra_high":
      return 75;
    case "max":
    case "ultra":
    case "ultrathink":
    case "ultracode":
      return 100;
    default:
      return undefined;
  }
}

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

export function statusLineGaugePercent(percent: number): number {
  return Math.round(clampPercent(percent));
}

// A 2% miss is halfway along the scale, and a 10% miss reaches red.
export function statusLineCacheRisk(percent: number): number {
  const miss = Math.max(0, 100 - percent);
  return clampPercent(miss <= 2 ? 25 * miss : 50 + (50 * (miss - 2)) / 8);
}

export function statusLineBurnRisk(limit: StatusLineLimit, nowMs: number): number {
  const used = limit.usedPercent ?? 100 - limit.remainingPercent;
  if (used >= 100) return 100;
  const burn = smoothedBurnToReset(limit.burnRatePercentPerSecond, limit.resetsAtMs, nowMs);
  if (burn === null) return 0;
  const depletionRatio = burn / (100 - used);
  // The extra term keeps the first half and its slope at 1×, and raises 2× to 90 risk.
  const excess = Math.max(0, depletionRatio - 1);
  const odds = depletionRatio ** 2 * (1 + 1.25 * excess ** 2);
  return 100 / (1 + 1 / odds);
}

export function statusLineQuotaColorPercent(limit: StatusLineLimit, nowMs: number): number {
  if (
    limit.resetsAtMs !== null &&
    limit.resetsAtMs > nowMs &&
    limit.burnRatePercentPerSecond !== undefined
  ) {
    return statusLineBurnRisk(limit, nowMs);
  }
  return clampPercent(100 - limit.remainingPercent);
}

export function statusLineUsageHue(percent: number): number {
  return 120 * (1 - clampPercent(percent) / 100);
}

export function statusLineColorMix(
  percent: number,
  colors: readonly [string, string, ...string[]],
  mix: (from: string, to: string, amount: number) => string,
): string {
  const position = (clampPercent(percent) / 100) * (colors.length - 1);
  const index = Math.floor(position);
  const from = colors[index]!;
  const to = colors[index + 1];
  return to === undefined || position === index ? from : mix(from, to, position - index);
}

export function statusLineNativeColorMix(from: string, to: string, amount: number): string {
  const channels = (color: string) => {
    const hex = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(color)?.[1];
    if (hex) return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
    return /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color)?.slice(1).map(Number);
  };
  const start = channels(from);
  const end = channels(to);
  if (!start || !end) return from;
  return `rgb(${start.map((channel, index) => Math.round(channel + (end[index]! - channel) * amount)).join(", ")})`;
}

export function fitStatusLineItems<Item extends string>(
  width: number,
  core: { readonly full: number; readonly compact: number },
  items: ReadonlyArray<{ readonly id: Item; readonly full: number; readonly compact?: number }>,
): { readonly compact: boolean; readonly visible: ReadonlySet<Item> } {
  const compact = core.full + items.reduce((sum, item) => sum + item.full, 0) > width;
  let available = width - (compact ? core.compact : core.full);
  const visible = new Set<Item>();
  for (const item of items) {
    const itemWidth = compact ? (item.compact ?? item.full) : item.full;
    if (itemWidth > available) continue;
    visible.add(item.id);
    available -= itemWidth;
  }
  return { compact, visible };
}

export const STATUS_LINE_BURN_TAU_PRESETS = {
  statusLineSessionBurnTauMinutes: [15, 30, 60, 120],
  statusLineWeeklyBurnTauMinutes: [360, 720, 1440, 2880],
} as const;
export type StatusLineBurnTauKey = keyof typeof STATUS_LINE_BURN_TAU_PRESETS;

export function parseStatusLineBurnTau(input: string): number | null {
  const minutes = Number(input.trim());
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

export function statusLineGaugeTickRotation(percent: number): number {
  return statusLineGaugePercent(percent) * 3.6;
}

export function statusLineLimitEnded(limit: StatusLineLimit, nowMs: number): boolean {
  return limit.resetsAtMs !== null && limit.resetsAtMs <= nowMs;
}

export function statusLineLimitRemaining(limit: StatusLineLimit, nowMs: number): string | null {
  return limit.resetsAtMs === null || statusLineLimitEnded(limit, nowMs)
    ? null
    : formatStatusLineSpan(limit.resetsAtMs - nowMs);
}

export function statusLineUptime(createdAt: string | null, nowMs: number): string | null {
  const startedMs = createdAt === null ? Number.NaN : Date.parse(createdAt);
  return Number.isFinite(startedMs) ? formatStatusLineSpan(nowMs - startedMs) : null;
}

/** A token count the way the status line writes it: `588`, `68.8k`, `341k`, `1.2M`. */
export function formatStatusLineTokens(tokens: number): string {
  const short = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 99_950) return `${short(tokens / 1_000)}k`;
  return tokens < 999_500 ? `${Math.round(tokens / 1_000)}k` : `${short(tokens / 1_000_000)}M`;
}

/** A span of time the way the status line writes it: `2d04h`, `1h48m`, `48m`. */
export function formatStatusLineSpan(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const pad = (value: number) => String(value).padStart(2, "0");
  if (minutes >= 1440)
    return `${Math.floor(minutes / 1440)}d${pad(Math.floor((minutes % 1440) / 60))}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`;
  return `${minutes}m`;
}

function formatStatusLineApiTime(ms: number): string {
  return ms < 60_000 ? `${Math.floor(ms / 1000)}s` : formatStatusLineSpan(ms);
}

/** Claude Code's status line JSON, so scripts written for it run unchanged. Unknown fields are left out. */
export function buildStatusLineInput(source: StatusLineInputSource): Record<string, unknown> {
  const { selection, provider, model } = selectedModel(source);
  const displayName = statusLineInputModelName(source);
  const effort = effortLevel(selection, model);
  const fastMode = getModelSelectionBooleanOptionValue(selection, "fastMode");
  const context = source.contextWindow;
  const windows = usageWindows(source);
  const accounting = source.accounting;
  const cost = {
    ...(accounting?.apiCostUsd == null || accounting.partial
      ? {}
      : { total_cost_usd: accounting.apiCostUsd }),
    ...(accounting?.apiDurationMs == null
      ? {}
      : { total_api_duration_ms: accounting.apiDurationMs }),
  };
  const fiveHour = rateLimit(windows, "session");
  const sevenDay = rateLimit(windows, "weekly");
  const inputTokens = context?.inputTokens ?? null;
  const cachedInputTokens = context?.cachedInputTokens ?? null;

  return {
    session_id: source.threadId,
    ...(Object.keys(cost).length > 0 ? { cost } : {}),
    ...(accounting?.outputStyle == null ? {} : { output_style: { name: accounting.outputStyle } }),
    ...(source.cwd === null
      ? {}
      : { cwd: source.cwd, workspace: { current_dir: source.cwd, project_dir: source.cwd } }),
    ...(selection === null ? {} : { model: { id: selection.model, display_name: displayName } }),
    ...(effort === undefined ? {} : { effort: { level: effort } }),
    ...(fastMode === undefined ? {} : { fast_mode: fastMode }),
    ...(provider?.version ? { version: provider.version } : {}),
    ...(context === null
      ? {}
      : {
          context_window: {
            ...(context.maxTokens === null ? {} : { context_window_size: context.maxTokens }),
            ...(context.usedPercentage === null
              ? {}
              : { used_percentage: Math.round(context.usedPercentage) }),
            ...(context.remainingPercentage === null
              ? {}
              : { remaining_percentage: Math.round(context.remainingPercentage) }),
            current_usage: { input_tokens: context.usedTokens },
            ...(inputTokens === null ? {} : { total_input_tokens: inputTokens }),
            ...(context.outputTokens === null ? {} : { total_output_tokens: context.outputTokens }),
          },
          ...(inputTokens !== null && inputTokens > 0 && cachedInputTokens !== null
            ? { prompt_cache: { hit_ratio: Math.min(1, cachedInputTokens / inputTokens) } }
            : {}),
        }),
    ...(fiveHour === undefined && sevenDay === undefined
      ? {}
      : {
          rate_limits: {
            ...(fiveHour === undefined ? {} : { five_hour: fiveHour }),
            ...(sevenDay === undefined ? {} : { seven_day: sevenDay }),
          },
        }),
  };
}

/** The clock-driven fields, added when the line is drawn so a stable input can key its refresh. */
export function stampStatusLineInput(
  input: Record<string, unknown>,
  createdAt: string | null,
  nowMs: number,
): Record<string, unknown> {
  const started = createdAt === null ? Number.NaN : Date.parse(createdAt);
  return Number.isFinite(started)
    ? {
        ...input,
        cost: {
          ...(typeof input.cost === "object" && input.cost !== null ? input.cost : {}),
          total_duration_ms: Math.max(0, nowMs - started),
        },
      }
    : input;
}

export interface AnsiSegment {
  readonly text: string;
  /** A CSS color, or null for the default foreground. */
  readonly color: string | null;
  readonly background: string | null;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
}

const BASE_COLORS = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#808080",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];
// White and black would vanish on one theme or the other, so they take the theme's foreground.
const THEME_FOREGROUND_INDEXES = new Set([0, 7, 15]);

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function xterm256Color(index: number): string | null {
  if (THEME_FOREGROUND_INDEXES.has(index)) return null;
  if (index < 16) return BASE_COLORS[index] ?? null;
  if (index < 232) {
    const cube = index - 16;
    const level = (step: number) => (step === 0 ? 0 : 55 + step * 40);
    return `#${hex(level(Math.floor(cube / 36)))}${hex(level(Math.floor(cube / 6) % 6))}${hex(level(cube % 6))}`;
  }
  if (index < 256) {
    const gray = 8 + (index - 232) * 10;
    return `#${hex(gray)}${hex(gray)}${hex(gray)}`;
  }
  return null;
}

/** The app color a status line color takes, so scripts written for terminals follow the active theme. */
export type StatusLineColorRole =
  | "foreground"
  | "muted"
  | "error"
  | "warning"
  | "success"
  | "info"
  | "accent";

export function statusLineColorRole(color: string): StatusLineColorRole {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return "foreground";
  const value = Number.parseInt(color.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  if (chroma < 40) return max < 200 ? "muted" : "foreground";
  const hue =
    max === r
      ? (60 * ((g - b) / chroma) + 360) % 360
      : max === g
        ? 60 * ((b - r) / chroma) + 120
        : 60 * ((r - g) / chroma) + 240;
  if (hue < 20 || hue >= 330) return "error";
  if (hue < 70) return "warning";
  if (hue < 165) return "success";
  if (hue < 250) return "info";
  return "accent";
}

interface AnsiStyle {
  color: string | null;
  background: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

const RESET_STYLE: AnsiStyle = {
  color: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
};

function extendedColor(codes: ReadonlyArray<number>, index: number): [string | null, number] {
  if (codes[index + 1] === 5) return [xterm256Color(codes[index + 2] ?? -1), index + 2];
  if (codes[index + 1] === 2) {
    const [r = 0, g = 0, b = 0] = codes.slice(index + 2, index + 5);
    return [`#${hex(r & 255)}${hex(g & 255)}${hex(b & 255)}`, index + 4];
  }
  return [null, index];
}

function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((part) => Number(part) || 0);
  let next = { ...style };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;
    if (code === 0) next = { ...RESET_STYLE };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) next = { ...next, bold: false, dim: false };
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code >= 30 && code <= 37) next.color = xterm256Color(code - 30);
    else if (code >= 90 && code <= 97) next.color = xterm256Color(code - 82);
    else if (code === 39) next.color = null;
    else if (code >= 40 && code <= 47) next.background = xterm256Color(code - 40);
    else if (code >= 100 && code <= 107) next.background = xterm256Color(code - 92);
    else if (code === 49) next.background = null;
    else if (code === 38 || code === 48) {
      const [color, end] = extendedColor(codes, index);
      if (code === 38) next.color = color;
      else next.background = color;
      index = end;
    }
  }
  return next;
}

// SGR sequences style text; every other escape (cursor moves, OSC titles and links) is dropped.
const ESCAPE_PATTERN =
  /\u001b\[([0-9;:]*)m|\u001b\[[0-9;:?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b./g;

/** Splits terminal output into styled lines, the way a terminal would draw Claude Code's status line. */
export function parseAnsiLines(text: string): ReadonlyArray<ReadonlyArray<AnsiSegment>> {
  const lines: AnsiSegment[][] = [];
  let style = RESET_STYLE;
  for (const line of text.split(/\r?\n/)) {
    const segments: AnsiSegment[] = [];
    let cursor = 0;
    const push = (value: string) => {
      if (value === "") return;
      const last = segments.at(-1);
      if (
        last !== undefined &&
        last.color === style.color &&
        last.background === style.background &&
        last.bold === style.bold &&
        last.dim === style.dim &&
        last.italic === style.italic &&
        last.underline === style.underline
      ) {
        segments[segments.length - 1] = { ...last, text: last.text + value };
      } else {
        segments.push({ text: value, ...style });
      }
    };
    for (const match of line.matchAll(ESCAPE_PATTERN)) {
      push(line.slice(cursor, match.index));
      cursor = match.index + match[0].length;
      if (match[1] !== undefined) style = applySgr(style, match[1]);
    }
    push(line.slice(cursor));
    lines.push(segments);
  }
  while (lines.length > 0 && lines.at(-1)?.length === 0) lines.pop();
  return lines;
}

const CLOCK_PATTERN = /\[\d{1,2}:\d{2}(?::\d{2})?\]/;

function sliceSegments(
  line: ReadonlyArray<AnsiSegment>,
  start: number,
  end: number,
): ReadonlyArray<AnsiSegment> {
  const sliced: AnsiSegment[] = [];
  let offset = 0;
  for (const segment of line) {
    const from = Math.max(start, offset);
    const to = Math.min(end, offset + segment.text.length);
    if (from < to)
      sliced.push({ ...segment, text: segment.text.slice(from - offset, to - offset) });
    offset += segment.text.length;
  }
  return sliced;
}

export interface StatusLineItem {
  readonly kind: "directory" | "clock" | "text";
  /** The item's text, without the separator that follows it in the line. */
  readonly segments: ReadonlyArray<AnsiSegment>;
  /**
   * The level at which a line short of room drops the item: a version at 1, `user@host` at 2 and
   * the directory at 3. 0 is never dropped.
   */
  readonly dropAt: 0 | 1 | 2 | 3;
  /**
   * The separator (`,` or ` |`) after the item at each drop level, 0 to 3. A dropped item leaves
   * its neighbours the stronger separator, and the last item left has none.
   */
  readonly separators: ReadonlyArray<ReadonlyArray<AnsiSegment>>;
}

const ITEM_SEPARATOR_PATTERN = /,\s+|\s+\|\s+/g;
const DIRECTORY_PATTERN = /^[~/]\S*(?=\s|$)/;
const HOST_PATTERN = /^[\w.-]+@[\w.-]+$/;
const VERSION_PATTERN = /^v(?:ersion)?\s*\d+(?:\.\d+)+\S*$/i;

interface SeparatedItem {
  readonly kind: StatusLineItem["kind"];
  readonly segments: ReadonlyArray<AnsiSegment>;
  readonly separator: ReadonlyArray<AnsiSegment>;
  readonly dropAt: StatusLineItem["dropAt"];
}

const segmentsText = (segments: ReadonlyArray<AnsiSegment>) =>
  segments.map((segment) => segment.text).join("");

function dropLevel(
  kind: StatusLineItem["kind"],
  segments: ReadonlyArray<AnsiSegment>,
): StatusLineItem["dropAt"] {
  if (kind === "directory") return 3;
  if (kind === "clock") return 0;
  const text = segmentsText(segments);
  if (HOST_PATTERN.test(text)) return 2;
  // The built-in script's version is a muted `v` and whatever the provider reports after it.
  const [label] = segments;
  const labelled =
    segments.length > 1 &&
    label !== undefined &&
    label.color !== null &&
    statusLineColorRole(label.color) === "muted" &&
    /^v(?:ersion)?\s*$/i.test(label.text);
  return labelled || VERSION_PATTERN.test(text) ? 1 : 0;
}

// A ` |` between two parts of the line outranks a `,` inside one.
const separatorStrength = (separator: ReadonlyArray<AnsiSegment>) =>
  separator.length === 0 ? 0 : segmentsText(separator).includes("|") ? 2 : 1;

const staysAt = (item: SeparatedItem, level: number) =>
  item.kind !== "clock" && (item.dropAt === 0 || item.dropAt > level);

// The strongest separator between the item and the next one still shown at the level.
function separatorAt(
  items: ReadonlyArray<SeparatedItem>,
  index: number,
  level: number,
): ReadonlyArray<AnsiSegment> {
  const item = items[index];
  if (item === undefined || !staysAt(item, level)) return [];
  let strongest = item.separator;
  for (let at = index + 1; at < items.length; at += 1) {
    const other = items[at];
    if (other === undefined) break;
    if (staysAt(other, level)) return strongest;
    if (separatorStrength(other.separator) > separatorStrength(strongest)) {
      strongest = other.separator;
    }
  }
  return [];
}

// Where a muted label such as `cache ` starts a new value in the middle of an item.
function mutedLabelStarts(line: ReadonlyArray<AnsiSegment>, text: string): ReadonlyArray<number> {
  const starts: number[] = [];
  let offset = 0;
  for (const segment of line) {
    const indent = /^\s*(?=[a-z])/i.exec(segment.text)?.[0].length;
    const spaced = indent !== undefined && (indent > 0 || /\s$/.test(text.slice(0, offset)));
    if (spaced && segment.color !== null && statusLineColorRole(segment.color) === "muted") {
      starts.push(offset + indent);
    }
    offset += segment.text.length;
  }
  return starts;
}

/**
 * Splits a line into the items a client lays out one by one: a leading directory, the `[HH:MM:SS]`
 * clock, and the text between `, ` and ` | `, split again where a muted label starts a new value.
 * The text around the clock is joined by the line's own comma, when it has one.
 */
export function splitStatusLineItems(
  line: ReadonlyArray<AnsiSegment>,
): ReadonlyArray<StatusLineItem> {
  const text = segmentsText(line);
  const separators = [...text.matchAll(ITEM_SEPARATOR_PATTERN)];
  const firstComma = separators.find((match) => match[0].startsWith(","));
  const comma = firstComma ? sliceSegments(line, firstComma.index, firstComma.index + 1) : [];
  const labelStarts = mutedLabelStarts(line, text);
  const items: SeparatedItem[] = [];
  const push = (
    kind: StatusLineItem["kind"],
    start: number,
    end: number,
    separator: ReadonlyArray<AnsiSegment> = [],
  ) => {
    const from = end - text.slice(start, end).trimStart().length;
    const to = from + text.slice(from, end).trimEnd().length;
    if (from >= to) return;
    const segments = sliceSegments(line, from, to);
    items.push({ kind, segments, separator, dropAt: dropLevel(kind, segments) });
  };
  const pushValues = (start: number, end: number, separator: ReadonlyArray<AnsiSegment>) => {
    let from = start;
    for (const cut of labelStarts) {
      if (cut <= from || cut >= end || text.slice(from, cut).trim() === "") continue;
      push("text", from, cut);
      from = cut;
    }
    push("text", from, end, separator);
  };
  // One stretch between separators: its directory if it opens the line, then the values around
  // its clock.
  const pushStretch = (start: number, end: number, separator: ReadonlyArray<AnsiSegment>) => {
    let from = start;
    const directory = start === 0 ? DIRECTORY_PATTERN.exec(text.slice(0, end)) : null;
    if (directory !== null) {
      // A script that styles its path apart from what follows keeps a path with spaces whole.
      const first = line.length > 1 ? (line[0]?.text.trimEnd() ?? "") : "";
      const styled = CLOCK_PATTERN.test(first) ? 0 : first.length;
      from = Math.min(end, Math.max(styled, directory[0].length));
      push("directory", 0, from);
    }
    const clock = CLOCK_PATTERN.exec(text.slice(from, end));
    if (clock === null) {
      pushValues(from, end, separator);
      return;
    }
    const clockStart = from + clock.index;
    const clockEnd = clockStart + clock[0].length;
    const hasAfter = text.slice(clockEnd, end).trim() !== "";
    pushValues(from, clockStart, hasAfter ? comma : separator);
    push("clock", clockStart, clockEnd);
    pushValues(clockEnd, end, separator);
  };
  let cursor = 0;
  for (const match of separators) {
    // The separator's own character, without the space a ` |` has before it.
    const from = match.index + match[0].length - match[0].trimStart().length;
    pushStretch(cursor, match.index, sliceSegments(line, from, from + 1));
    cursor = match.index + match[0].length;
  }
  pushStretch(cursor, text.length, []);
  // A line made only of items that can be dropped keeps them, or nothing would be left to hover.
  const kept: ReadonlyArray<SeparatedItem> = items.some(
    (item) => item.kind !== "clock" && item.dropAt === 0,
  )
    ? items
    : items.map((item) => ({ ...item, dropAt: 0 }));
  return kept.map((item, index) => ({
    kind: item.kind,
    segments: item.segments,
    dropAt: item.dropAt,
    separators: [0, 1, 2, 3].map((level) => separatorAt(kept, index, level)),
  }));
}

// The built-in script's labels, and `conx` from 01-1/statusline. `v` runs into its number, so its
// expansion brings the space.
const STATUS_LINE_LABELS: Readonly<Record<string, string>> = {
  conx: "context",
  ctx: "context",
  up: "uptime",
  in: "input",
  out: "output",
  api: "API time",
  "5h": "5h limit",
  "7d": "7d limit",
  v: "version ",
};

// The built-in script prints `Opus 5.5` as `O5.5`: the first word's initial, then the second word.
function shortModelName(name: string): string {
  const [first = "", second = ""] = name.trim().split(/\s+/);
  return `${first.slice(0, 1)}${second}`;
}

/**
 * The segment's text with its abbreviated label, or the short form of `modelName`, written out.
 * Null when the segment is neither.
 */
export function expandStatusLineLabel(
  segment: AnsiSegment,
  modelName: string | null = null,
): string | null {
  if (segment.color === null || statusLineColorRole(segment.color) !== "muted") {
    if (modelName === null) return null;
    const name = modelName.trim();
    const short = shortModelName(name);
    // One letter could be anything, so only a short form of two or more is taken for the model.
    return short.length > 1 && short !== name && segment.text.trim() === short
      ? segment.text.replace(short, name)
      : null;
  }
  // A label can share its segment with the punctuation before it, as in `), 5h `.
  const [, before, label, after] = /^([^a-z0-9]*)(\S+)(\s*)$/i.exec(segment.text) ?? [];
  const expanded = label === undefined ? undefined : STATUS_LINE_LABELS[label];
  return expanded === undefined ? null : `${before}${expanded}${after}`;
}

// A value that ticks while a thread runs: a percentage, duration, or count.
const CHANGING_VALUE = /^(?:\d+(?:\.\d+)?%|(?:\d+[dhms]){1,2}|\d+(?:\.\d+)?[kM]|\d+)$/;

/**
 * The segment's text with each changing value given room: every whole number in it is held at
 * two digits or its own length, whichever is longer. A client lays the value out in that room, so
 * the line stays put until a value grows past it.
 */
export function reserveStatusLineText(segment: AnsiSegment): string {
  if (segment.color !== null && statusLineColorRole(segment.color) === "muted") return segment.text;
  return segment.text
    .split(/([\s/(),]+)/)
    .map((token) =>
      CHANGING_VALUE.test(token)
        ? token.replace(/\d/g, "0").replace(/(?<![.\d])0(?!\d)/g, "00")
        : token,
    )
    .join("");
}
