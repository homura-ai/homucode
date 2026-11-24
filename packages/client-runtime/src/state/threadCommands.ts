import { CommandId, type ModelSelection, type ThreadId } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { DevicePins } from "./devicePins.ts";
import {
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";

import { createOptimisticThreadLifecycle } from "./threadLifecycle.ts";
import * as DateTime from "effect/DateTime";

import {
  type AtomCommand,
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  environmentConnectionAtom,
} from "./runtime.ts";
import { waitForTitleRegenerationOutcome } from "./threadTitleRegeneration.ts";
import {
  type InterruptThreadTurnInput,
  type UpdateThreadMetadataInput,
  archiveThread,
  closeGuestShare,
  resolveGuestMessage,
  cancelQueuedRun,
  createThread,
  deleteThread,
  editQueuedRun,
  interruptThreadTurn,
  forkSideChat,
  forkThreadFromRun,
  markThreadUnread,
  mergeThreadBack,
  moveThread,
  moveThreadToProject,
  promoteQueuedRun,
  sendSteerNow,
  resumeThreadQueue,
  retryWorkspacePreparation,
  linkThreadPullRequest,
  linkThreadIssue,
  respondToThreadApproval,
  respondToThreadUserInput,
  dismissThreadUserInput,
  revertThreadCheckpoint,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  pinThread,
  reorderPinnedThread,
  reorderActiveThread,
  setThreadAutoSettle,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unlinkThreadPullRequest,
  unlinkThreadIssue,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMetadata,
  visitThread,
  watchThreadPullRequest,
} from "../operations/commands.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";

export type LoadEarlierThreadHistoryInput = {
  readonly threadId: ThreadId;
  readonly throughEntryId?: string;
  readonly workAnchorId?: string;
};

export function createThreadEnvironmentAtoms<R, E, IdentityError = never>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom.SecureRandom | R, E>,
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
  devicePins?: DevicePins<IdentityError>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  const loadEarlierHistory = Effect.fn("ThreadCommands.loadEarlierHistory")(function* (
    input: LoadEarlierThreadHistoryInput,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const controller = yield* Effect.serviceOption(ThreadHistoryController.ThreadHistoryController);
    if (Option.isNone(controller)) {
      return {
        _tag: "noop",
      } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    }
    return yield* controller.value.loadEarlier(
      supervisor.target.environmentId,
      input.threadId,
      input.throughEntryId,
      input.workAnchorId,
    );
  });

  // Runs whether or not the server accepted the interrupt, so a stale cached item still
  // settles when Stop had nothing to interrupt; the interrupt's own failure still surfaces.
  // The repair is detached: its lookups must not hold the thread's serial command key, and
  // closing the thread cancels the repair, not the Stop that triggered it.
  const interruptTurn = Effect.fn("ThreadCommands.interruptTurn")(function* (
    input: InterruptThreadTurnInput,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const controller = yield* Effect.serviceOption(ThreadHistoryController.ThreadHistoryController);
    return yield* interruptThreadTurn(input).pipe(
      Effect.ensuring(
        Option.match(controller, {
          onNone: () => Effect.void,
          onSome: (value) =>
            value
              .reconcilePendingWork(supervisor.target.environmentId, input.threadId)
              .pipe(Effect.forkDetach, Effect.asVoid),
        }),
      ),
    );
  });

  const armTitleRegeneration = Effect.fn("ThreadCommands.armTitleRegeneration")(function* (input: {
    readonly threadId: ThreadId;
  }) {
    const random = yield* SecureRandom.SecureRandom;
    const requestId = CommandId.make(yield* random.uuidV4());
    const result = yield* updateThreadMetadata({
      threadId: input.threadId,
      regenerateTitle: true,
      commandId: requestId,
    });
    return { requestId, sequence: result.sequence };
  });

  // Counts the commands that move or remove a thread's row. A list that holds its rows while
  // environments synchronize (`stepSteadyShells`) shows the user's own change at once.
  const rowActionsAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive),
  );
  const rowAction = <W extends { readonly environmentId: EnvironmentId }, A, E>(
    command: AtomCommand<W, A, E>,
  ): AtomCommand<W, A, E> => ({
    label: command.label,
    run: (registry, target) =>
      Effect.suspend(() => {
        registry.update(rowActionsAtom(target.environmentId), (count) => count + 1);
        return command.run(registry, target);
      }),
  });

  const sent = {
    armTitleRegeneration: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:regenerate-title",
      execute: armTitleRegeneration,
      scheduler,
      concurrency,
    }),

    stopAutoreviewer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:stop-autoreviewer",
      tag: ORCHESTRATION_V2_WS_METHODS.stopAutoreviewer,
      scheduler,
      concurrency,
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: createThread,
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: deleteThread,
      scheduler,
      concurrency,
    }),
    closeGuestShare: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:close-guest-share",
      execute: closeGuestShare,
      scheduler,
      concurrency,
    }),
    resolveGuestMessage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:resolve-guest-message",
      execute: resolveGuestMessage,
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: archiveThread,
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: unarchiveThread,
      scheduler,
      concurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: settleThread,
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: unsettleThread,
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: snoozeThread,
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: unsnoozeThread,
      scheduler,
      concurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:pin",
      execute: (input: Parameters<typeof pinThread>[0], registry) =>
        devicePins === undefined
          ? pinThread(input)
          : AtomRegistry.getResult(registry, devicePins.deviceIdAtom, {
              suspendOnWaiting: true,
            }).pipe(
              // With no device identity, fall back to a pin shared by every device.
              Effect.matchEffect({
                onFailure: () => pinThread(input),
                onSuccess: (deviceId) => pinThread({ ...input, deviceId }),
              }),
            ),
      scheduler,
      concurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unpin",
      execute: (input: Parameters<typeof unpinThread>[0], registry) =>
        devicePins === undefined
          ? unpinThread(input)
          : AtomRegistry.getResult(registry, devicePins.deviceIdAtom, {
              suspendOnWaiting: true,
            }).pipe(
              // With no device identity, fall back to a pin shared by every device.
              Effect.matchEffect({
                onFailure: () => unpinThread(input),
                onSuccess: (deviceId) => unpinThread({ ...input, deviceId }),
              }),
            ),
      scheduler,
      concurrency,
    }),
    moveToProject: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:move-to-project",
      execute: moveThreadToProject,
      scheduler,
      concurrency,
    }),
    move: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:move",
      execute: moveThread,
      scheduler,
      concurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-pin",
      execute: (input: Parameters<typeof reorderPinnedThread>[0], registry) =>
        devicePins === undefined
          ? reorderPinnedThread(input)
          : AtomRegistry.getResult(registry, devicePins.deviceIdAtom, {
              suspendOnWaiting: true,
            }).pipe(
              // With no device identity, fall back to a pin shared by every device.
              Effect.matchEffect({
                onFailure: () => reorderPinnedThread(input),
                onSuccess: (deviceId) => reorderPinnedThread({ ...input, deviceId }),
              }),
            ),
      scheduler,
      concurrency,
    }),
    setAutoSettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-auto-settle",
      execute: setThreadAutoSettle,
      scheduler,
      concurrency,
    }),
    reorderActive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-active",
      execute: (input: Parameters<typeof reorderActiveThread>[0], registry) =>
        devicePins === undefined
          ? reorderActiveThread(input)
          : AtomRegistry.getResult(registry, devicePins.deviceIdAtom, {
              suspendOnWaiting: true,
            }).pipe(
              // With no device identity, fall back to a pin shared by every device.
              Effect.matchEffect({
                onFailure: () => reorderActiveThread(input),
                onSuccess: (deviceId) => reorderActiveThread({ ...input, deviceId }),
              }),
            ),
      scheduler,
      concurrency,
    }),
    visit: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:visit",
      execute: visitThread,
      scheduler,
      concurrency,
    }),
    markUnread: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:mark-unread",
      execute: markThreadUnread,
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: updateThreadMetadata,
      scheduler,
      concurrency,
    }),
    linkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:link-pull-request",
      execute: linkThreadPullRequest,
      scheduler,
      concurrency,
    }),
    unlinkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unlink-pull-request",
      execute: unlinkThreadPullRequest,
      scheduler,
      concurrency,
    }),
    watchPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:watch-pull-request",
      execute: watchThreadPullRequest,
      scheduler,
      concurrency,
    }),
    setModelSelection: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-model-selection",
      execute: (input: UpdateThreadMetadataInput & { readonly modelSelection: ModelSelection }) =>
        updateThreadMetadata(input),
      scheduler,
      concurrency,
    }),
    linkIssue: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:link-issue",
      execute: linkThreadIssue,
      scheduler,
      concurrency,
    }),
    unlinkIssue: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unlink-issue",
      execute: unlinkThreadIssue,
      scheduler,
      concurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: setThreadRuntimeMode,
      scheduler,
      concurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: setThreadInteractionMode,
      scheduler,
      concurrency,
    }),
    startTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      execute: startThreadTurn,
      scheduler,
      concurrency,
    }),
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: interruptTurn,
      scheduler,
      concurrency,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: respondToThreadApproval,
      scheduler,
      concurrency,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: respondToThreadUserInput,
      scheduler,
      concurrency,
    }),
    dismissUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:dismiss-user-input",
      execute: dismissThreadUserInput,
      scheduler,
      concurrency,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: revertThreadCheckpoint,
      scheduler,
      concurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: stopThreadSession,
      scheduler,
      concurrency,
    }),
    forkFromRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:fork-from-run",
      execute: forkThreadFromRun,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sourceThreadId]),
      },
    }),
    forkSideChat: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:fork-side-chat",
      execute: forkSideChat,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sourceThreadId]),
      },
    }),
    mergeBack: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:merge-back",
      execute: mergeThreadBack,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.sourceThreadId, input.targetThreadId]),
      },
    }),
    resumeThreadQueue: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:resume-queue",
      execute: resumeThreadQueue,
      scheduler,
      concurrency,
    }),
    sendSteerNow: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:send-steer-now",
      execute: sendSteerNow,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.messageId]),
      },
    }),
    promoteQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:promote-queued-run",
      execute: promoteQueuedRun,
      scheduler,
      concurrency,
    }),
    cancelQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:cancel-queued-run",
      execute: cancelQueuedRun,
      scheduler,
      concurrency,
    }),
    retryWorkspacePreparation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:retry-workspace-preparation",
      execute: retryWorkspacePreparation,
      scheduler,
      concurrency,
    }),
    editQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:edit-queued-run",
      execute: editQueuedRun,
      scheduler,
      concurrency,
    }),
    loadEarlierHistory: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:load-earlier-history",
      execute: loadEarlierHistory,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          `history:${JSON.stringify([environmentId, input.threadId])}`,
      },
    }),
    uploadFeedback: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:upload-feedback",
      tag: WS_METHODS.providerUploadFeedback,
      scheduler,
      concurrency,
    }),
  };
  const commands = {
    ...sent,
    delete: rowAction(sent.delete),
    archive: rowAction(sent.archive),
    unarchive: rowAction(sent.unarchive),
    settle: rowAction(sent.settle),
    unsettle: rowAction(sent.unsettle),
    snooze: rowAction(sent.snooze),
    unsnooze: rowAction(sent.unsnooze),
    pin: rowAction(sent.pin),
    unpin: rowAction(sent.unpin),
  };
  const optimistic = createOptimisticThreadLifecycle(
    devicePins?.wrapSnapshot(snapshotAtom) ?? snapshotAtom,
  );
  const disconnectedAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const connection = AsyncResult.getOrElse(
        get(environmentConnectionAtom(runtime, environmentId)),
        () => null,
      );
      return connection !== null && connectionProjectionPhase(connection[0]) === "disconnected";
    }),
  );
  const regenerateTitle = {
    label: commands.armTitleRegeneration.label,
    run: (
      registry: AtomRegistry.AtomRegistry,
      target: { readonly environmentId: EnvironmentId; readonly input: { threadId: ThreadId } },
    ) =>
      commands.armTitleRegeneration.run(registry, target).pipe(
        Effect.flatMap((armed) =>
          waitForTitleRegenerationOutcome(
            registry,
            {
              snapshot: snapshotAtom(target.environmentId),
              disconnected: disconnectedAtom(target.environmentId),
            },
            { threadId: target.input.threadId, ...armed },
          ),
        ),
      ),
  };
  return {
    ...commands,
    regenerateTitle,
    rowActionsAtom,
    snapshotAtom: optimistic.snapshotAtom,
    pendingThreadIdsAtom: optimistic.pendingThreadIdsAtom,
    settle: optimistic.wrap(commands.settle, (thread, _input, now, accepted) =>
      !accepted &&
      thread.pendingRuntimeRequest !== null &&
      !["preparing", "starting", "running", "waiting"].includes(
        thread.activityRunStatus ?? thread.status,
      )
        ? thread
        : {
            ...thread,
            pendingRuntimeRequest: ["preparing", "starting", "running", "waiting"].includes(
              thread.activityRunStatus ?? thread.status,
            )
              ? thread.pendingRuntimeRequest
              : null,
            settledOverride: "settled",
            settledAt: thread.settledOverride === "settled" ? (thread.settledAt ?? now) : now,
            unsettledAt: null,
            activeOrderKey: null,
            pinnedAt: null,
            pinOrderKey: null,
            snoozedAt: null,
            snoozedUntil: null,
          },
    ),
    unsettle: optimistic.wrap(commands.unsettle, (thread, input, now) => ({
      ...thread,
      settledOverride: input.reason === "user" ? "active" : null,
      settledAt: null,
      unsettledAt:
        thread.settledOverride === "active"
          ? (thread.unsettledAt ?? null)
          : input.restoreUnsettledAt === undefined
            ? now
            : input.restoreUnsettledAt === null
              ? null
              : DateTime.makeUnsafe(input.restoreUnsettledAt),
    })),
    snooze: optimistic.wrap(commands.snooze, (thread, input, now, accepted) =>
      (!accepted &&
        ((thread.pendingRuntimeRequest !== null &&
          thread.pendingRuntimeRequest.kind !== "user_input") ||
          ["preparing", "queued", "starting"].includes(thread.status))) ||
      !(Date.parse(input.snoozedUntil) > DateTime.toEpochMillis(now))
        ? thread
        : {
            ...thread,
            snoozedUntil: DateTime.makeUnsafe(input.snoozedUntil),
            snoozedAt: now,
          },
    ),
    unsnooze: optimistic.wrap(commands.unsnooze, (thread) => ({
      ...thread,
      snoozedUntil: null,
      snoozedAt: null,
    })),
    setAutoSettle: optimistic.wrap(commands.setAutoSettle, (thread, input, now) => ({
      ...thread,
      autoSettleDisabledAt: input.enabled ? null : (thread.autoSettleDisabledAt ?? now),
    })),
    pin: optimistic.wrap(commands.pin, (thread, input, now) => ({
      ...thread,
      pinnedAt: thread.pinnedAt ?? now,
      pinOrderKey: thread.pinnedAt == null ? (input.orderKey ?? null) : thread.pinOrderKey,
      ...(thread.settledOverride === "settled"
        ? {
            settledOverride: "active" as const,
            settledAt: null,
            unsettledAt: now,
          }
        : {}),
      snoozedUntil: null,
      snoozedAt: null,
    })),
    unpin: optimistic.wrap(commands.unpin, (thread) => ({
      ...thread,
      pinnedAt: null,
      pinOrderKey: null,
    })),
    reorderPin: optimistic.wrap(commands.reorderPin, (thread, input) => ({
      ...thread,
      pinOrderKey: input.orderKey,
    })),
    reorderActive: optimistic.wrap(commands.reorderActive, (thread, input) => ({
      ...thread,
      activeOrderKey: input.orderKey,
    })),
    // Shown at once, so a composer that releases its accepted pick keeps showing it.
    setModelSelection: optimistic.wrap(commands.setModelSelection, (thread, input) => ({
      ...thread,
      modelSelection: input.modelSelection,
    })),
  };
}
