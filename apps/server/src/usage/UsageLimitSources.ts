import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ModelSelection,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ProviderDriverKind,
  type ServerSettings,
  UsageLimitSourceConfig,
  settingsSecretLiteral,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import {
  codexModelCooldownAt,
  usageLimitSourceAtEndpoint,
  weeklyAllowanceUsd,
} from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";
import * as UsageBurnRate from "../statusLine/UsageBurnRate.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as UsageService from "./UsageService.ts";
import {
  createStatusLineUsageLedgerCache,
  readStatusLineUsageLedger,
  statusLineExecutionPriceRecord,
} from "../statusLine/StatusLineUsageLedger.ts";
import * as Settings from "../serverSettings.ts";
import { windowLimitsModel } from "../provider/claudeUsageLimits.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly recheckCodexCooldown: (
      endpoint: string,
      model: string,
    ) => Effect.Effect<string | null | undefined>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
  }
>()("t3/usage/UsageLimitSources") {}

function cliproxyEndpoint(value: string) {
  const url = URL.parse(value);
  return url && /^https?:$/.test(url.protocol)
    ? {
        origin: url.origin,
        endpoint: `${url.origin}${url.pathname.replace(/(\/management\.html)?\/*$/i, "")}`,
      }
    : {};
}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

/**
 * A refused read of one account keeps its last good reading, as provider probes keep their bars
 * (see ServerProviderUsageLimits); a reading with none to keep stays listed as unreadable.
 */
function keepLastGoodReadings(
  previous: ReadonlyArray<UsageLimitSourceSnapshot>,
  next: ReadonlyArray<UsageLimitSourceSnapshot>,
): ReadonlyArray<UsageLimitSourceSnapshot> {
  return next.map((source) => {
    // Auth file names can be reused, so only the same hub and login may lend a reading.
    const before = previous.find(
      (candidate) => candidate.id === source.id && candidate.endpoint === source.endpoint,
    );
    if (!before) return source;
    return {
      ...source,
      accounts: source.accounts.map((account) => {
        if (account.usageLimits.unavailable?.reason !== "probeFailed") return account;
        // Without a listed login, a reused auth file name cannot be told apart from the old one.
        if (account.email === undefined && account.workspaceId === undefined) return account;
        const last = before.accounts.find(
          (candidate) =>
            candidate.id === account.id &&
            candidate.driver === account.driver &&
            // Fingerprinted Antigravity readings omit the listed identity, so they are never lent.
            candidate.usageLimits.credentialFingerprint === undefined &&
            candidate.email === account.email &&
            candidate.workspaceId === account.workspaceId,
        );
        return last && !last.usageLimits.unavailable ? last : account;
      }),
    };
  });
}

function missingManagementKey(config: UsageLimitSourceConfig): string {
  return typeof config.managementKey === "string"
    ? "No management key configured."
    : "Could not read the management key from its secret provider.";
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const burnRate = yield* UsageBurnRate.UsageBurnRate;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const projection = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
  const usage = yield* Effect.serviceOption(UsageService.UsageService);
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  const ledgerCache = createStatusLineUsageLedgerCache();
  const recordAccounts = Effect.fn("UsageLimitSources.recordAccounts")(function* (
    hub: UsageLimitSourceSnapshot,
    config: UsageLimitSourceConfig,
  ) {
    const directory = config.usageLedgerDir;
    let coverageStartMs: number | undefined;
    const chargesByAccount = new Map<string, UsageBurnRate.StatusLineAccountCharge[]>();
    if (
      directory &&
      Option.isSome(projection) &&
      Option.isSome(usage) &&
      Option.isSome(fs) &&
      Option.isSome(path)
    ) {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      const executions = yield* readStatusLineUsageLedger(
        directory,
        now - weekMs - 86_400_000,
        now,
        ledgerCache,
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fs.value),
        Effect.provideService(Path.Path, path.value),
      );
      if (executions.length > 0) {
        coverageStartMs = executions.reduce(
          (first, entry) => Math.min(first, Date.parse(entry.timestamp)),
          now,
        );
        const ids = [
          ...new Set(executions.flatMap((entry) => (entry.thread_id ? [entry.thread_id] : []))),
        ];
        const known = yield* projection.value
          .knownNativeThreadIds(ids)
          .pipe(Effect.orElseSucceed(() => new Set<string>()));
        for (const provider of ["codex", "claude"] as const) {
          const driver = provider === "claude" ? "claudeAgent" : "codex";
          const accounts = new Map(
            hub.accounts
              .filter((account) => account.driver === driver && account.authIndex)
              .map((account) => [account.authIndex, account]),
          );
          if (accounts.size === 0) continue;
          const records = executions.flatMap((entry) => {
            if (
              entry.failed ||
              entry.provider !== provider ||
              !entry.thread_id ||
              !known.has(entry.thread_id)
            )
              return [];
            const account = accounts.get(entry.auth_index);
            const record = statusLineExecutionPriceRecord(entry);
            if (
              !account?.quotaAccountFingerprint ||
              account.quotaAccountFingerprint !== entry.account_fingerprint ||
              !record
            )
              return [];
            const plan =
              provider === "claude" && account.plan === "Claude Subscription" && config.claudeUltra
                ? "Claude Ultra Subscription"
                : account.plan;
            const allowance = weeklyAllowanceUsd(provider, plan, entry.model);
            return allowance === null ? [] : [{ entry, record, account, allowance }];
          });
          const prices = yield* usage.value
            .priceRecords(
              provider,
              records.map((row) => row.record),
            )
            .pipe(Effect.orElseSucceed(() => []));
          for (const account of accounts.values()) {
            if (account.quotaAccountFingerprint) chargesByAccount.set(account.id, []);
          }
          for (const [index, row] of records.entries()) {
            const price = prices[index];
            if (!price || price.costSource === "unpriced") continue;
            chargesByAccount.get(row.account.id)?.push({
              atMs: Date.parse(row.entry.timestamp),
              percent: (100 * price.costUsd) / row.allowance,
              model: row.entry.model,
            });
          }
        }
      }
    }
    return yield* Effect.forEach(hub.accounts, (account: UsageLimitSourceAccount) =>
      burnRate
        .record(
          [
            "hub",
            hub.endpoint,
            hub.id,
            account.driver,
            account.id,
            account.email,
            account.workspaceId,
            account.quotaAccountFingerprint,
            account.usageLimits.credentialFingerprint,
          ],
          account.usageLimits,
          chargesByAccount.get(account.id),
          coverageStartMs,
        )
        .pipe(Effect.map((usageLimits) => ({ ...account, usageLimits }))),
    );
  });
  const readManagementKey = Effect.fn("UsageLimitSources.readManagementKey")(function* (
    config: UsageLimitSourceConfig,
  ) {
    const resolved = yield* resolveSettingsSecrets(secrets, UsageLimitSourceConfig, config);
    return settingsSecretLiteral(resolved.managementKey);
  });
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const providerRoute = config.providerRoute ? URL.parse(config.providerRoute) : null;
    const base = {
      id,
      kind: config.kind,
      label: sourceLabel(id, config),
      ...cliproxyEndpoint(config.url),
      ...(providerRoute
        ? { providerRoute: providerRoute.origin + providerRoute.pathname.replace(/\/+$/, "") }
        : {}),
      ...(config.claudeUltra === true ? { claudeUltra: true } : {}),
      checkedAt,
    } as const;
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return { ...base, accounts: [], error: missingManagementKey(config) };
    }
    const accounts = yield* api
      .readSnapshot({ url: config.url, managementKey })
      .pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    const { codexModelCooldowns, accounts: readings } = accounts.success;
    const snapshot = {
      ...base,
      ...(codexModelCooldowns === undefined ? {} : { codexModelCooldowns }),
      accounts: readings,
    };
    return { ...snapshot, accounts: yield* recordAccounts(snapshot, config) };
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    next: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer refreshes.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    yield* publish(keepLastGoodReadings(yield* Ref.get(stateRef), snapshots));
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  const recheckCodexCooldown = Effect.fn("UsageLimitSources.recheckCodexCooldown")(
    function* (endpoint: string, model: string) {
      const settings = yield* settingsService.getSettings;
      const matches = Object.values(settings.usageLimitSources).filter(
        (source) => source.enabled && cliproxyEndpoint(source.url).endpoint === endpoint,
      );
      const config = matches.length === 1 ? matches[0] : undefined;
      if (config === undefined) return undefined;
      const managementKey = yield* readManagementKey(config);
      if (managementKey.length === 0) return undefined;
      return yield* api.recheckCodexCooldown({ url: config.url, managementKey }, model);
    },
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() => undefined),
  );

  const refreshCodexCooldowns = Effect.fn("UsageLimitSources.refreshCodexCooldowns")(
    function* () {
      const settings = yield* settingsService.getSettings;
      const previous = yield* Ref.get(stateRef);
      const next = yield* Effect.forEach(
        previous,
        (source) =>
          Effect.gen(function* () {
            const config = settings.usageLimitSources[source.id];
            if (!config?.enabled || source.codexModelCooldowns === undefined) return source;
            const managementKey = yield* readManagementKey(config);
            const cooldowns =
              managementKey.length === 0
                ? undefined
                : yield* api
                    .readCodexCooldowns({ url: config.url, managementKey })
                    .pipe(Effect.orElseSucceed(() => source.codexModelCooldowns));
            if (Equal.equals(cooldowns, source.codexModelCooldowns)) return source;
            const { codexModelCooldowns: _previous, ...unchanged } = source;
            return cooldowns === undefined
              ? unchanged
              : { ...unchanged, codexModelCooldowns: cooldowns };
          }),
        { concurrency: 4 },
      );
      if (next.some((source, index) => source !== previous[index])) yield* publish(next);
    },
    refreshLock.withPermits(1),
    Effect.ignoreCause({ log: true }),
  );

  yield* Effect.forever(
    Effect.sleep("15 seconds").pipe(
      Effect.andThen(backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })),
      Effect.flatMap((shouldRun) => (shouldRun ? refreshCodexCooldowns() : Effect.void)),
    ),
  ).pipe(Effect.forkScoped);

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = Effect.fn("UsageLimitSources.consumeResetCredit")(function* (
    input: UsageLimitSourceConsumeResetCreditInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const config = settings.usageLimitSources[input.sourceId];
    if (!config?.enabled) {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return yield* new UsageLimitSourceError({ detail: missingManagementKey(config) });
    }
    const result = yield* api.consume(
      { url: config.url, managementKey },
      input.accountId,
      input.creditId,
    );
    // A redemption changes the reading, so a refused re-read must not bring back the one before it.
    const snapshot = yield* readSource(input.sourceId, config);
    const previous = yield* Ref.get(stateRef);
    yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
    return result;
  }, refreshLock.withPermits(1));

  const settingsChanges = yield* settingsService.subscribeChanges;
  yield* Stream.concat(
    Stream.fromEffect(
      settingsService.getSettings.pipe(
        Effect.map((settings) => settings.usageLimitSources),
        Effect.orElseSucceed(() => ({})),
      ),
    ),
    settingsChanges.pipe(Stream.map((settings) => settings.usageLimitSources)),
  ).pipe(
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(interval),
      Effect.flatMap((current) =>
        Duration.isPositive(current)
          ? backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })
          : Effect.succeed(false),
      ),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  const refreshLedger = Effect.fn("UsageLimitSources.refreshLedger")(function* () {
    const settings = yield* settingsService.getSettings;
    const snapshots = yield* Ref.get(stateRef);
    const next = yield* Effect.forEach(snapshots, (snapshot) => {
      const config = settings.usageLimitSources[snapshot.id];
      return config?.enabled && config.usageLedgerDir && !snapshot.error
        ? recordAccounts(snapshot, config).pipe(
            Effect.map((accounts) => ({ ...snapshot, accounts })),
          )
        : Effect.succeed(snapshot);
    });
    yield* publish(next);
  }, refreshLock.withPermits(1));
  yield* Effect.forever(
    Effect.sleep("30 seconds").pipe(
      Effect.andThen(backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })),
      Effect.flatMap((shouldRun) => (shouldRun ? refreshLedger() : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    consumeResetCredit,
    refresh,
    recheckCodexCooldown,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make).pipe(
  Layer.provide(SecretResolverLayer.layer),
);

/** A hub answers with a usage limit only when every account it routes the driver to is spent. */
export function hubPoolResetAt(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  driver: ProviderDriverKind,
  model: string | null,
  now: number,
): string | null {
  let earliest: number | null = null;
  for (const source of sources) {
    for (const account of source.accounts) {
      if (account.driver !== driver) continue;
      // An unread account may be the one still blocked, so its refill is unknown.
      if (account.usageLimits.unavailable) return null;
      const spent = account.usageLimits.windows.filter(
        (window) => window.usedPercent >= 100 && windowLimitsModel(window, model),
      );
      if (spent.length === 0) return null;
      const resets = spent.map((window) => Date.parse(window.resetsAt ?? ""));
      if (resets.some((reset) => !Number.isFinite(reset))) return null;
      const recoversAt = Math.max(...resets);
      if (recoversAt <= now) return null;
      earliest = earliest === null ? recoversAt : Math.min(earliest, recoversAt);
    }
  }
  return earliest === null ? null : DateTime.formatIso(DateTime.makeUnsafe(earliest));
}

export class UsageLimitResetFallback extends Context.Reference<{
  readonly resetAt: (
    driver: ProviderDriverKind,
    endpoint: string,
    model: string | null,
  ) => Effect.Effect<string | null>;
}>("t3/usage/UsageLimitResetFallback", {
  defaultValue: () => ({ resetAt: () => Effect.succeed(null) }),
}) {}

export const layerResetFallback = Layer.effect(
  UsageLimitResetFallback,
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources;
    return {
      resetAt: Effect.fn("UsageLimitResetFallback.resetAt")(function* (driver, endpoint, model) {
        // Only the hub at the instance's endpoint serves its turns.
        const atEndpoint = Effect.map(sources.current, (current) =>
          usageLimitSourceAtEndpoint(current, endpoint),
        );
        if (!(yield* atEndpoint)) return null;
        // The pool usually ran out after the last poll, so the cached accounts still show room.
        yield* sources.refresh.pipe(Effect.timeout("5 seconds"), Effect.ignore);
        const source = yield* atEndpoint;
        if (!source) return null;
        return hubPoolResetAt([source], driver, model, DateTime.toEpochMillis(yield* DateTime.now));
      }),
    };
  }),
);

export class ModelCooldowns extends Context.Reference<{
  readonly retryAt: (selection: ModelSelection, now: number) => Effect.Effect<string | null>;
  readonly recheck: (selection: ModelSelection) => Effect.Effect<string | null | undefined>;
}>("t3/usage/ModelCooldowns", {
  defaultValue: () => ({
    retryAt: () => Effect.succeed(null),
    recheck: () => Effect.undefined,
  }),
}) {}

export const layerModelCooldowns = Layer.effect(
  ModelCooldowns,
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const endpointFor = Effect.fn("ModelCooldowns.endpointFor")(function* (
      selection: ModelSelection,
    ) {
      const instance = yield* instances.getInstance(selection.instanceId);
      if (instance === undefined || instance.driverKind !== "codex") return undefined;
      return (yield* instance.snapshot.getSnapshot).auth.endpoint;
    });
    return {
      retryAt: Effect.fn("ModelCooldowns.retryAt")(function* (selection, now) {
        const retryAt = codexModelCooldownAt(
          yield* sources.current,
          yield* endpointFor(selection),
          selection.model,
        );
        return retryAt !== null && Date.parse(retryAt) > now ? retryAt : null;
      }),
      recheck: Effect.fn("ModelCooldowns.recheck")(function* (selection) {
        const endpoint = yield* endpointFor(selection);
        if (endpoint === undefined) return undefined;
        return yield* sources.recheckCodexCooldown(endpoint, selection.model);
      }),
    };
  }),
);
