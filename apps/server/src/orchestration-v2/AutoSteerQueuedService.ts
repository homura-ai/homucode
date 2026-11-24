import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { isActiveRun, resolveMessageDispatchIntent } from "./CommandPolicy.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { queuedMessageHeadForSteering } from "./QueuedRunOrder.ts";

/** Safety bound; each promotion consumes one queued run, so a pass ends long before this. */
const MAX_PROMOTIONS_PER_PASS = 500;

/**
 * Promotes opted-in queue heads once steering is available, without jumping held runs. A
 * compaction holds them; once it ends they all steer in, in queue order.
 */
export interface AutoSteerPromotion {
  readonly queuedRunId: OrchestrationV2Run["id"];
  readonly targetRunId: OrchestrationV2Run["id"];
}

export function nextAutoSteerPromotion(projection: {
  readonly thread?: object;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly messages: Parameters<typeof resolveMessageDispatchIntent>[0]["messages"];
  readonly providerTurns: Parameters<typeof resolveMessageDispatchIntent>[0]["providerTurns"];
  readonly providerThreads: Parameters<typeof resolveMessageDispatchIntent>[0]["providerThreads"];
  readonly providerSessions: Parameters<typeof resolveMessageDispatchIntent>[0]["providerSessions"];
  readonly turnItems: Parameters<typeof resolveMessageDispatchIntent>[0]["turnItems"];
}): AutoSteerPromotion | null {
  if (!projection.runs.some(isActiveRun)) return null;
  const mode = resolveMessageDispatchIntent(projection, { type: "start_immediately" }, "auto");
  if (mode.type !== "steer_active") return null;

  const head = queuedMessageHeadForSteering(projection, mode.targetRunId);
  if (
    head === undefined ||
    head.autoSteer !== true ||
    head.queueHeld === true ||
    // Host status-check continuations must reach their own startup guard, never steer.
    head.restartContinuationOfRunId !== undefined ||
    // Retirement fences (added by the role-retirement release); absent fields read as unset.
    ((head as { readonly retirementHold?: unknown }).retirementHold ?? null) !== null ||
    ((projection.thread as { readonly roleRetirement?: unknown } | undefined)?.roleRetirement ??
      null) !== null
  )
    return null;
  return { queuedRunId: head.id, targetRunId: mode.targetRunId };
}

const triggers = (event: OrchestrationV2DomainEvent): boolean =>
  (event.type === "provider-turn.updated" && event.payload.status === "running") ||
  (event.type === "turn-item.updated" &&
    event.payload.type === "compaction" &&
    event.payload.status !== "running") ||
  ((event.type === "run.created" || event.type === "run.updated") &&
    (event.payload.status === "running" ||
      (event.payload.status === "queued" && event.payload.autoSteer === true)));

export interface AutoSteerPassDeps<R, ReadError, DispatchError> {
  /** Threads that got a trigger since their pass last read; a pass consumes its own entry. */
  readonly dirty: Set<ThreadId>;
  readonly read: (threadId: ThreadId) => Effect.Effect<R | null, ReadError>;
  readonly select: (records: R) => AutoSteerPromotion | null;
  readonly dispatch: (
    threadId: ThreadId,
    next: AutoSteerPromotion,
  ) => Effect.Effect<unknown, DispatchError>;
}

/**
 * One drain of a thread's queue. A refused promotion (the locked recheck saw a reorder or a
 * hold) ends the pass unless a trigger arrived meanwhile; then the queue is read again, so the
 * new head is not stranded until the next turn event.
 */
export const runAutoSteerPass = Effect.fn("runAutoSteerPass")(function* <
  R,
  ReadError,
  DispatchError,
>(deps: AutoSteerPassDeps<R, ReadError, DispatchError>, threadId: ThreadId) {
  deps.dirty.delete(threadId);
  for (let pass = 0; pass < MAX_PROMOTIONS_PER_PASS; pass++) {
    const records = yield* deps.read(threadId);
    if (records === null) return;
    const next = deps.select(records);
    if (next === null) {
      if (!deps.dirty.delete(threadId)) return;
      continue;
    }
    const exit = yield* Effect.exit(deps.dispatch(threadId, next));
    if (exit._tag === "Failure") {
      yield* Effect.logDebug("queued send still cannot steer", { threadId, cause: exit.cause });
      if (!deps.dirty.delete(threadId)) return;
    }
  }
  yield* Effect.logWarning("auto-steer pass hit its bound; the next turn event continues", {
    threadId,
  });
});

const AUTO_STEER_RUN_STATUSES = [
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
] as const satisfies ReadonlyArray<OrchestrationV2Run["status"]>;

/**
 * Reads only what a promotion decision looks at: queued and active runs, their messages, the
 * active turns and running compactions. A pass runs on most turn events, so a full read here
 * scales with the thread's whole history.
 */
// Untraced: `runAutoSteerPass` already spans each read, several times a second on a busy thread.
export const readAutoSteerRecords = Effect.fnUntraced(function* (
  projections: ProjectionStore.ProjectionStoreV2Shape,
  threadId: ThreadId,
) {
  const { thread, runs } = yield* projections.getThreadRecords(threadId, ["runs"], {
    runStatuses: AUTO_STEER_RUN_STATUSES,
  });
  if (thread.archivedAt !== null || thread.deletedAt !== null) return null;
  const queued = runs.filter((run) => run.status === "queued");
  const active = runs.filter(isActiveRun);
  if (active.length === 0 || !queued.some((run) => run.autoSteer === true)) {
    return {
      thread,
      runs,
      messages: [],
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
      turnItems: [],
    };
  }
  const records = yield* projections.getThreadRecords(
    threadId,
    ["messages", "providerTurns", "providerThreads", "providerSessions", "turnItems"],
    {
      messageIds: [...queued, ...active].map((run) => run.userMessageId),
      providerTurnAttemptIds: active.flatMap((run) =>
        run.activeAttemptId === null ? [] : [run.activeAttemptId],
      ),
      providerThreadIds: active.flatMap((run) =>
        run.providerThreadId === null ? [] : [run.providerThreadId],
      ),
      turnItemTypes: ["compaction"],
      turnItemStatuses: ["running"],
    },
  );
  return { ...records, runs };
});

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  let sequence = 0;
  // Threads that got a trigger while their pass was running; the pass runs again for them.
  const dirty = new Set<ThreadId>();

  const promote = (threadId: ThreadId) =>
    runAutoSteerPass(
      {
        dirty,
        read: (id) => readAutoSteerRecords(projections, id),
        select: nextAutoSteerPromotion,
        dispatch: (id, next) =>
          DateTime.now.pipe(
            Effect.flatMap((now) =>
              orchestrator.dispatch({
                type: "queued-message.promote-to-steer",
                commandId: CommandId.make(
                  `server:auto-steer:${next.queuedRunId}:${DateTime.toEpochMillis(now)}:${++sequence}`,
                ),
                threadId: id,
                queuedRunId: next.queuedRunId,
                targetRunId: next.targetRunId,
              }),
            ),
          ),
      },
      threadId,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("auto-steer pass could not read the thread", { threadId, cause }),
      ),
    );

  const start = Effect.fn("AutoSteerQueuedService.start")(function* () {
    // Keyed by thread so passes for one thread never race each other.
    const passes = yield* FiberMap.make<ThreadId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        triggers(event)
          ? Effect.sync(() => dirty.add(event.threadId)).pipe(
              Effect.andThen(FiberMap.has(passes, event.threadId)),
              Effect.flatMap((running) =>
                running
                  ? Effect.void
                  : FiberMap.run(passes, event.threadId, promote(event.threadId)).pipe(
                      Effect.asVoid,
                    ),
              ),
            )
          : Effect.void,
      ),
    );
  });
  return { start };
});
