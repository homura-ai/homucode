import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  OrchestratorMcpFailure,
  ServerRemoveKeybindingInput,
  STATIC_KEYBINDING_COMMANDS,
  ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import { compileResolvedKeybindingRule } from "@t3tools/shared/keybindings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../../../config.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as AgentSessionImporter from "../../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../../project/AgentSessionScanner.ts";
import * as ScratchThreadPromotion from "../../../project/ScratchThreadPromotion.ts";
import * as WorktreeSetupTracker from "../../../project/WorktreeSetupTracker.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { dispatchFailure, newCommandId, readThread, unavailable } from "../../threadAccess.ts";
import { AppToolkit } from "./tools.ts";

export const DIFF_PAGE_CHARS = 40_000;
const decodeRemoveKeybinding = Schema.decodeUnknownEffect(ServerRemoveKeybindingInput);
const decodeUpsertKeybinding = Schema.decodeUnknownEffect(ServerUpsertKeybindingInput);

export const unknownKeybindingCommandMessage = (keybindingsPath: string) =>
  `This tool binds only built-in commands. Valid: ${STATIC_KEYBINDING_COMMANDS.join(", ")}. A script (\`user.<name>.run\` or \`bash:<command>\`) goes in ${keybindingsPath} instead; this tool's description says how.`;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(invalid(`This action needs \`${name}\`.`))
    : Effect.succeed(value);

/** One page of a long diff, so a large turn cannot flood the caller's context. */
const diffPage = (diff: string, offset: number) => {
  const end = offset + DIFF_PAGE_CHARS;
  return { diff: diff.slice(offset, end), nextOffset: end < diff.length ? end : null };
};

export const layer = McpToolAccess.toLayer(AppToolkit, {
  t3_session_import: McpToolAccess.either(
    (input) => input.action === "scan",
    McpToolAccess.reads(() =>
      Effect.gen(function* () {
        const scanner = yield* AgentSessionScanner.AgentSessionScanner;
        return yield* scanner.scan.pipe(Effect.mapError(unavailable));
      }),
    ),
    // Imported threads take the importer's modes, so a caller below full access asks first.
    McpToolAccess.writesEnvironment(
      (input) =>
        Effect.gen(function* () {
          const importer = yield* AgentSessionImporter.AgentSessionImporter;
          const projectId = yield* required(input.projectId, "projectId");
          if (input.action === "import") {
            return yield* importer
              .importRecentAgentThreads({
                projectId,
                ...(input.expectedWorkspaceRoot === undefined
                  ? {}
                  : { expectedWorkspaceRoot: input.expectedWorkspaceRoot }),
              })
              .pipe(Effect.mapError((error) => invalid(error.message)));
          }
          return yield* importer
            .importThreadTranscript({
              projectId,
              title: yield* required(input.title, "title"),
              modelSelection: yield* required(input.modelSelection, "modelSelection"),
              messages: yield* required(input.messages, "messages"),
            })
            .pipe(Effect.mapError((error) => invalid(error.message)));
        }),
      { approval: McpToolAccess.approvalPrompt("import agent sessions as threads") },
    ),
  ),
  t3_thread_diff: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["checkpoints", "runs"]);
      // The diff query only counts ready checkpoints of completed runs.
      const completed = new Set(
        projection.runs.filter((run) => run.status === "completed").map((run) => run.id),
      );
      const toTurnCount =
        input.toTurnCount ??
        Math.max(
          0,
          ...projection.checkpoints.flatMap((checkpoint) =>
            checkpoint.status === "ready" &&
            checkpoint.appRunOrdinal != null &&
            checkpoint.runId != null &&
            completed.has(checkpoint.runId)
              ? [checkpoint.appRunOrdinal]
              : [],
          ),
        );
      const fromTurnCount = input.fromTurnCount ?? 0;
      if (fromTurnCount > toTurnCount) {
        return yield* invalid("`fromTurnCount` must not be after `toTurnCount`.");
      }
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const common = {
        threadId: projection.thread.id,
        toTurnCount,
        ...(input.ignoreWhitespace === undefined
          ? {}
          : { ignoreWhitespace: input.ignoreWhitespace }),
      };
      const result = yield* (
        input.fromTurnCount === undefined
          ? query.getFullThreadDiff(common)
          : query.getTurnDiff({ ...common, fromTurnCount })
      ).pipe(Effect.mapError((error) => invalid(error.message)));
      return {
        threadId: result.threadId,
        fromTurnCount: result.fromTurnCount,
        toTurnCount: result.toTurnCount,
        ...diffPage(result.diff, input.offset ?? 0),
      };
    }),
  ),
  t3_keybinding: McpToolAccess.writesEnvironment(
    (input, check) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const keybindings = yield* Keybindings.Keybindings;
        const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
        const write = Effect.gen(function* () {
          // The turn may have ended, or the thread's modes changed, while this waited for the lock.
          yield* check;
          const decodeFailure = (error: { readonly message: string }) =>
            invalid(`Invalid keybinding: ${error.message}`);
          if (input.action === "remove") {
            const rule = yield* decodeRemoveKeybinding(
              yield* required(input.replace, "replace"),
            ).pipe(Effect.mapError(decodeFailure));
            return yield* keybindings
              .removeKeybindingRule(rule)
              .pipe(Effect.mapError((error) => invalid(error.message)));
          }
          const command = yield* required(input.command, "command");
          if (!(STATIC_KEYBINDING_COMMANDS as ReadonlyArray<string>).includes(command)) {
            return yield* invalid(unknownKeybindingCommandMessage(keybindingsConfigPath));
          }
          const rule = yield* decodeUpsertKeybinding({
            key: yield* required(input.key, "key"),
            command,
            ...(input.when === undefined ? {} : { when: input.when }),
            ...(input.replace === undefined ? {} : { replace: input.replace }),
          }).pipe(Effect.mapError(decodeFailure));
          if (compileResolvedKeybindingRule(rule) === null) {
            return yield* invalid("`key` or `when` is not valid shortcut syntax.");
          }
          return yield* keybindings
            .upsertKeybindingRule(rule)
            .pipe(Effect.mapError((error) => invalid(error.message)));
        });
        return yield* scope.thread === undefined
          ? write
          : executor.withLock(scope.thread.threadId, write);
      }),
    { approval: McpToolAccess.approvalPrompt("change a keyboard shortcut") },
  ),
  // Usage is diagnostics data; only the user's own thread agents read it, not outside clients.
  t3_usage_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const usage = yield* UsageService.UsageService;
      return yield* usage
        .readSummary(input)
        .pipe(Effect.mapError((error) => invalid(error.message)));
    }),
  ),
  // Promotion moves every scratch thread in the folder and their scheduled tasks.
  t3_project_from_thread: McpToolAccess.writesEnvironment(
    (input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId);
        const promotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
        return yield* promotion
          .promote({ threadId: projection.thread.id })
          .pipe(Effect.mapError((error) => invalid(error.message)));
      }),
    { approval: McpToolAccess.approvalPrompt("create a project from a scratch thread") },
  ),
  t3_worktree_setup: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        if (input.action === "cancel") {
          const { projection } = yield* readThread(input.threadId);
          const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
          return { cancelled: yield* tracker.cancel(projection.thread.id) };
        }
        const { projection } = yield* readThread(input.threadId, ["runs", "turnItems"], {
          runStatuses: ["failed"],
          turnItemTypes: ["error"],
        });
        // The same failure the orchestrator requires before it accepts a retry.
        const setupRuns = new Set(
          projection.turnItems.flatMap((item) =>
            item.type === "error" &&
            item.status === "failed" &&
            item.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE &&
            item.runId !== null
              ? [item.runId]
              : [],
          ),
        );
        const runId =
          input.runId ??
          projection.runs.findLast((run) => run.status === "failed" && setupRuns.has(run.id))?.id;
        if (runId === undefined) {
          return yield* invalid("This thread has no failed worktree setup to retry.");
        }
        const launch = yield* ThreadLaunchService.ThreadLaunchService;
        const result = yield* launch
          .retryPreparation({
            commandId: yield* newCommandId(),
            threadId: projection.thread.id,
            runId,
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
  ),
});
