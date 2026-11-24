import * as Schema from "effect/Schema";
import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";

/** Claude Code's status line input: https://code.claude.com/docs/en/statusline */
export const StatusLineRenderInput = Schema.Struct({
  input: Schema.Record(Schema.String, Schema.Unknown),
});
export type StatusLineRenderInput = typeof StatusLineRenderInput.Type;

export const StatusLineRenderResult = Schema.Struct({
  /** The command's first line of stdout, ANSI escapes included. Empty when it printed nothing. */
  text: Schema.String,
  error: Schema.optionalKey(Schema.String),
});
export type StatusLineRenderResult = typeof StatusLineRenderResult.Type;

export const StatusLineAccountingInput = Schema.Struct({ threadId: ThreadId });
export type StatusLineAccountingInput = typeof StatusLineAccountingInput.Type;

export const StatusLineAccounting = Schema.Struct({
  apiCostUsd: Schema.NullOr(Schema.Finite),
  weeklyUsagePercent: Schema.optionalKey(Schema.Tuple([Schema.Finite, Schema.Finite])),
  subscriptionCostUsd: Schema.NullOr(Schema.Finite),
  partial: Schema.Boolean,
  apiDurationMs: Schema.NullOr(NonNegativeInt),
  outputStyle: Schema.NullOr(Schema.String),
});
export type StatusLineAccounting = typeof StatusLineAccounting.Type;
