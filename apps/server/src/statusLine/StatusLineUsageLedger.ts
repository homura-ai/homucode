import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "@t3tools/contracts";

import type { PricedRecord } from "../usage/usagePricing.ts";

const Execution = Schema.Struct({
  request_id: TrimmedNonEmptyString,
  provider: Schema.Literals(["codex", "claude"]),
  auth_index: TrimmedNonEmptyString,
  account_fingerprint: Schema.optionalKey(TrimmedNonEmptyString),
  thread_id: Schema.optionalKey(TrimmedNonEmptyString),
  turn_id: Schema.optionalKey(TrimmedNonEmptyString),
  timestamp: Schema.String,
  model: Schema.String,
  service_tier: Schema.optionalKey(Schema.String),
  failed: Schema.Boolean,
  usage: Schema.Struct({
    quality: Schema.String,
    unclassified_tokens: NonNegativeInt,
    input: Schema.Struct({
      uncached_tokens: NonNegativeInt,
      cache_read_tokens: NonNegativeInt,
      cache_write_tokens: NonNegativeInt,
    }),
    output: Schema.Struct({
      total_tokens: NonNegativeInt,
      reasoning_tokens: NonNegativeInt,
    }),
  }),
  cache_creation_1h_tokens: Schema.optionalKey(NonNegativeInt),
});
type Execution = typeof Execution.Type;
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Execution));
const dateName = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export function createStatusLineUsageLedgerCache() {
  return new Map<
    string,
    {
      readonly size: bigint;
      readonly mtime: number;
      readonly rows: readonly Execution[];
    }
  >();
}

export const readStatusLineUsageLedger = Effect.fn("StatusLineUsageLedger.read")(function* (
  directory: string,
  sinceMs: number,
  untilMs: number,
  cache?: ReturnType<typeof createStatusLineUsageLedgerCache>,
) {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) return [];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const from = DateTime.formatIso(DateTime.makeUnsafe(sinceMs)).slice(0, 10);
  const to = DateTime.formatIso(DateTime.makeUnsafe(untilMs)).slice(0, 10);
  const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
  const filenames = names.filter(
    (name) => dateName.test(name) && name.slice(0, 10) >= from && name.slice(0, 10) <= to,
  );
  if (cache) {
    for (const file of cache.keys()) {
      if (path.dirname(file) === directory && !filenames.includes(path.basename(file)))
        cache.delete(file);
    }
  }
  const readings = yield* Effect.forEach(
    filenames,
    (name) =>
      Effect.gen(function* () {
        const file = path.join(directory, name);
        const info = yield* fs.stat(file).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "File") return [];
        const { size, mtime: modified } = info.value;
        const mtime = Option.match(modified, {
          onNone: () => Number.NaN,
          onSome: (date) => date.getTime(),
        });
        const existing = cache?.get(file);
        if (existing?.size === size && existing.mtime === mtime) return existing.rows;
        const contents = yield* fs.readFileString(file).pipe(Effect.option);
        if (Option.isNone(contents)) return [];
        const rows = contents.value.split("\n").flatMap((line) => {
          if (line === "") return [];
          const reading = decodeLine(line);
          return Option.isSome(reading) ? [reading.value] : [];
        });
        cache?.set(file, { size, mtime, rows });
        return rows;
      }),
    { concurrency: 4 },
  );
  const executions = new Map<string, Execution>();
  for (const reading of readings.flat()) {
    const timestamp = Date.parse(reading.timestamp);
    if (timestamp >= sinceMs && timestamp <= untilMs) executions.set(reading.request_id, reading);
  }
  return [...executions.values()];
});

export function statusLineExecutionPriceRecord(execution: Execution): PricedRecord | null {
  const { input, output, quality, unclassified_tokens: unknownTokens } = execution.usage;
  if (quality !== "complete" || unknownTokens > 0 || execution.model === "") return null;
  return {
    model: execution.model,
    reportedCostUsd: null,
    speed:
      execution.service_tier === "ultrafast"
        ? "ultrafast"
        : execution.service_tier === "priority" || execution.service_tier === "fast"
          ? "fast"
          : "standard",
    ...(execution.cache_creation_1h_tokens === undefined
      ? {}
      : { cacheCreation1hTokens: execution.cache_creation_1h_tokens }),
    totals: {
      uncachedInputTokens: input.uncached_tokens,
      cachedInputTokens: input.cache_read_tokens,
      cacheCreationTokens: input.cache_write_tokens,
      outputTokens: output.total_tokens,
      reasoningTokens: output.reasoning_tokens,
    },
  };
}
