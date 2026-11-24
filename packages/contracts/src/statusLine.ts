import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const StatusLineTargetRate = Schema.NullOr(Schema.Finite.check(Schema.isGreaterThan(0)));

const SlidingStatusLineEstimator = Schema.Struct({
  kind: Schema.Literal("sliding"),
  minutes: Schema.Finite.check(Schema.isGreaterThan(0)),
});

export const StatusLineRateEstimator = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ema") }),
  SlidingStatusLineEstimator,
  Schema.Struct({ kind: Schema.Literal("reset") }),
]);
export type StatusLineRateEstimator = typeof StatusLineRateEstimator.Type;

const StatusLineUsageScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("provider"), providerInstanceId: ProviderInstanceId }),
  Schema.Struct({ kind: Schema.Literal("models"), models: Schema.Array(TrimmedNonEmptyString) }),
  Schema.Struct({
    kind: Schema.Literal("accounts"),
    accountIds: Schema.Array(TrimmedNonEmptyString),
  }),
]);

const StatusLineUsageWindow = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ema") }),
  SlidingStatusLineEstimator,
  Schema.Struct({ kind: Schema.Literal("reset"), accountId: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("command"), command: TrimmedNonEmptyString }),
]);

export const StatusLineCustomBar = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  visible: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  showQuotaPace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  targetPercentPerHour: StatusLineTargetRate,
  estimator: Schema.optionalKey(StatusLineRateEstimator),
  source: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("quota"),
      providerInstanceId: ProviderInstanceId,
      limitId: TrimmedNonEmptyString,
    }),
    Schema.Struct({ type: Schema.Literal("metric"), key: TrimmedNonEmptyString }),
    Schema.Struct({
      type: Schema.Literal("usage"),
      scope: StatusLineUsageScope,
      window: StatusLineUsageWindow,
      basis: Schema.Literals(["percentages", "homucode"]),
    }),
  ]),
});
export type StatusLineCustomBar = typeof StatusLineCustomBar.Type;

export const StatusLineMetricValues = Schema.Record(
  Schema.String,
  Schema.Struct({
    remainingPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    resetsAt: Schema.optionalKey(IsoDateTime),
    burnRatePercentPerHour: Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
  }),
);
export type StatusLineMetricValues = typeof StatusLineMetricValues.Type;

/** Claude Code's status line input: https://code.claude.com/docs/en/statusline */
export const StatusLineRenderInput = Schema.Struct({
  input: Schema.Record(Schema.String, Schema.Unknown),
  mode: Schema.optionalKey(Schema.Literal("metrics")),
});
export type StatusLineRenderInput = typeof StatusLineRenderInput.Type;

export const StatusLineRenderResult = Schema.Struct({
  /** The command's first line of stdout, ANSI escapes included. Empty when it printed nothing. */
  text: Schema.String,
  error: Schema.optionalKey(Schema.String),
  metrics: Schema.optionalKey(StatusLineMetricValues),
  customStarts: Schema.optionalKey(Schema.Record(Schema.String, IsoDateTime)),
});
export type StatusLineRenderResult = typeof StatusLineRenderResult.Type;

export const StatusLineAccountingInput = Schema.Struct({ threadId: ThreadId });
export type StatusLineAccountingInput = typeof StatusLineAccountingInput.Type;

export const StatusLineAccounting = Schema.Struct({
  apiCostUsd: Schema.NullOr(Schema.Finite),
  weeklyUsagePercent: Schema.optionalKey(Schema.Tuple([Schema.Finite, Schema.Finite])),
  weeklyUsageByAccount: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        label: Schema.NullOr(TrimmedNonEmptyString),
        percent: Schema.Finite,
      }),
    ),
  ),
  subscriptionCostUsd: Schema.NullOr(Schema.Finite),
  partial: Schema.Boolean,
  apiDurationMs: Schema.NullOr(NonNegativeInt),
  outputStyle: Schema.NullOr(Schema.String),
});
export type StatusLineAccounting = typeof StatusLineAccounting.Type;
