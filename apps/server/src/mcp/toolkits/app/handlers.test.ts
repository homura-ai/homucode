import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as WorktreeSetupTracker from "../../../project/WorktreeSetupTracker.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as AppHandlers from "./handlers.ts";
import { AppToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:app");
const threadId = ThreadId.make("thread:app");

it.effect("a thread diff defaults to the newest ready turn and pages a long diff", () => {
  const requests: Array<unknown> = [];
  const diff = "x".repeat(AppHandlers.DIFF_PAGE_CHARS + 10);
  const checkpoint = (appRunOrdinal: number, status: string) => ({
    appRunOrdinal,
    status,
    runId: `run-${appRunOrdinal}`,
  });
  return Effect.gen(function* () {
    const toolkit = yield* AppToolkit;
    const read = (params: Record<string, unknown>) =>
      toolkit.handle("t3_thread_diff", params as never).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((chunks) => chunks.at(-1)?.result),
      );
    expect(yield* read({})).toMatchObject({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 3,
      diff: diff.slice(0, AppHandlers.DIFF_PAGE_CHARS),
      nextOffset: AppHandlers.DIFF_PAGE_CHARS,
    });
    expect(yield* read({ offset: AppHandlers.DIFF_PAGE_CHARS })).toMatchObject({
      diff: "x".repeat(10),
      nextOffset: null,
    });
    expect(requests).toEqual([
      { threadId, toTurnCount: 3 },
      { threadId, toTurnCount: 3 },
    ]);
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(AppHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId,
              requestNamespace: "provider:app",
              thread: {
                threadId,
                providerSessionId: "provider:app",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              client: undefined,
              capabilities: new Set(["orchestration" as const]),
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
              getProjectThreadRecords: () =>
                Effect.succeed({
                  ...idleThreadProjection(liveThreadShell(threadId)),
                  // Run 4 was interrupted with a ready checkpoint; the diff query skips it.
                  runs: [
                    { id: "run-1", status: "completed" },
                    { id: "run-3", status: "completed" },
                    { id: "run-4", status: "interrupted" },
                  ],
                  checkpoints: [
                    checkpoint(1, "ready"),
                    checkpoint(3, "ready"),
                    checkpoint(4, "ready"),
                    checkpoint(5, "capturing"),
                  ],
                } as never),
            }),
            Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({
              getFullThreadDiff: (input) => {
                requests.push(input);
                return Effect.succeed({ ...input, fromTurnCount: 0, diff });
              },
            }),
          ),
        ),
      ),
    ),
  );
});

const caller = Layer.succeed(McpInvocationContext.McpInvocationContext, {
  environmentId,
  requestNamespace: "provider:app",
  thread: {
    threadId,
    providerSessionId: "provider:app",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

it.effect("setup retry reruns the newest failed setup through the launch service", () => {
  const retried: Array<unknown> = [];
  const setupFailure = (runId: string) => ({
    type: "error",
    status: "failed",
    runId,
    failure: { code: ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE },
  });
  return Effect.gen(function* () {
    const toolkit = yield* AppToolkit;
    const result = yield* toolkit.handle("t3_worktree_setup", { action: "retry" } as never).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunks) => chunks.at(-1)?.result),
    );
    expect(result).toEqual({ sequence: 7 });
    expect(retried).toMatchObject([{ threadId, runId: "setup-new" }]);
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(AppHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            caller,
            NodeCrypto.layer,
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
              getProjectThreadRecords: () =>
                Effect.succeed({
                  ...idleThreadProjection(liveThreadShell(threadId)),
                  // A later turn whose setup succeeded and whose provider turn failed is not retried.
                  runs: [
                    { id: "setup-old", status: "failed" },
                    { id: "setup-new", status: "failed" },
                    { id: "turn-failed", status: "failed" },
                  ],
                  turnItems: [
                    setupFailure("setup-old"),
                    setupFailure("setup-new"),
                    {
                      type: "error",
                      status: "failed",
                      runId: "turn-failed",
                      failure: { code: "provider_error" },
                    },
                  ],
                } as never),
            }),
            Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              retryPreparation: (input) => {
                retried.push(input);
                return Effect.succeed({ sequence: 7 } as never);
              },
            }),
          ),
        ),
      ),
    ),
  );
});

it.effect("a keybinding binds only built-in commands with valid shortcut syntax", () => {
  const written: Array<unknown> = [];
  return Effect.gen(function* () {
    const toolkit = yield* AppToolkit;
    const upsert = (params: Record<string, unknown>) =>
      toolkit.handle("t3_keybinding", { action: "upsert", ...params } as never).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((chunks) => chunks.at(-1)?.result),
      );
    expect(JSON.stringify(yield* upsert({ key: "mod+k", command: "bash:rm -rf ~" }))).toContain(
      "`user.<name>.run` or `bash:<command>`",
    );
    expect(JSON.stringify(yield* upsert({ key: "mod+k+j", command: "chat.new" }))).toContain(
      "not valid shortcut syntax",
    );
    yield* upsert({ key: "mod+shift+k", command: "chat.new" });
    expect(written).toMatchObject([{ key: "mod+shift+k", command: "chat.new" }]);
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(AppHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            caller,
            ThreadCommandExecutor.layer,
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
            }),
            Layer.mock(Keybindings.Keybindings)({
              upsertKeybindingRule: (rule) => {
                written.push(rule);
                return Effect.succeed({ keybindings: [], issues: [] } as never);
              },
            }),
          ),
        ),
      ),
    ),
  );
});
