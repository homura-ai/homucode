// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous digest keeps the on-disk key a pure function.
import * as NodeCrypto from "node:crypto";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

const Sample = Schema.fromJsonString(
  Schema.Struct({
    resetMs: Schema.Finite,
    sampledAtMs: Schema.Finite,
    usedPercent: Schema.Finite,
    rate: Schema.Finite,
  }),
);
type Sample = typeof Sample.Type;
const decodeSample = Schema.decodeEffect(Sample);
const encodeSample = Schema.encodeEffect(Sample);

const MINUTE_MS = 60_000;
const RESET_TOLERANCE_MS = 10 * MINUTE_MS;

function windowKey(account: readonly (string | undefined)[], window: ServerProviderUsageWindow) {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([account, window.id, window.kind]))
    .digest("hex");
}

export class UsageBurnRate extends Context.Reference<{
  readonly record: (
    account: readonly (string | undefined)[],
    limits: ServerProviderUsageLimits,
  ) => Effect.Effect<ServerProviderUsageLimits>;
}>("t3/statusLine/UsageBurnRate", {
  defaultValue: () => ({ record: (_account, limits) => Effect.succeed(limits) }),
}) {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const directory = path.join(config.stateDir, "status-line-burn-rate");
  const lock = yield* Semaphore.make(1);
  const samples = new Map<string, Sample | null>();

  const recordWindow = Effect.fn("UsageBurnRate.recordWindow")(function* (
    account: readonly (string | undefined)[],
    window: ServerProviderUsageWindow,
    observedAtMs: number,
    tauMinutes: number,
  ) {
    if (window.kind !== "session" && window.kind !== "weekly") return window;
    const resetMs = Date.parse(window.resetsAt ?? "");
    if (!Number.isFinite(resetMs) || !Number.isFinite(observedAtMs) || resetMs <= observedAtMs) {
      return window;
    }
    const windowMinutes = window.windowDurationMins ?? (window.kind === "weekly" ? 10_080 : 300);
    const key = windowKey(account, window);
    const filePath = path.join(directory, key + ".json");
    const cached = samples.get(key);
    const previous =
      cached === undefined
        ? yield* fs.readFileString(filePath).pipe(
            Effect.flatMap(decodeSample),
            Effect.orElseSucceed(() => null),
          )
        : cached;
    if (cached === undefined) samples.set(key, previous);
    const usedPercent = window.usedPercent;
    const sameWindow =
      previous !== null && Math.abs(resetMs - previous.resetMs) <= RESET_TOLERANCE_MS;
    const dtMs = previous === null ? Infinity : observedAtMs - previous.sampledAtMs;
    if (previous !== null && dtMs < 0) return window;
    if (sameWindow && dtMs < MINUTE_MS) {
      return { ...window, burnRatePercentPerSecond: previous.rate };
    }

    const elapsedSeconds = (observedAtMs - resetMs + windowMinutes * MINUTE_MS) / 1000;
    const dtSeconds = dtMs / 1000;
    const rate = sameWindow
      ? previous.rate +
        -Math.expm1(-dtMs / (tauMinutes * MINUTE_MS)) *
          (Math.max(0, (usedPercent - previous.usedPercent) / dtSeconds) - previous.rate)
      : elapsedSeconds > 0
        ? usedPercent / elapsedSeconds
        : 0;
    if (dtMs >= MINUTE_MS) {
      const next = { resetMs, sampledAtMs: observedAtMs, usedPercent, rate };
      samples.set(key, next);
      yield* encodeSample(next).pipe(
        Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.ignore({ log: true }),
      );
    }
    return { ...window, burnRatePercentPerSecond: rate };
  });

  return {
    record: Effect.fn("UsageBurnRate.record")(function* (
      account: readonly (string | undefined)[],
      limits: ServerProviderUsageLimits,
    ) {
      if (limits.unavailable || limits.windows.length === 0) return limits;
      const current = yield* settings.getSettings.pipe(Effect.option);
      if (current._tag === "None") return limits;
      const observedAtMs = Date.parse(limits.checkedAt);
      const windows = yield* Effect.forEach(limits.windows, (window) =>
        recordWindow(
          account,
          window,
          observedAtMs,
          window.kind === "weekly"
            ? current.value.statusLineWeeklyBurnTauMinutes
            : current.value.statusLineSessionBurnTauMinutes,
        ),
      );
      return { ...limits, windows };
    }, lock.withPermit),
  };
});

export const layer = Layer.effect(UsageBurnRate, make);
