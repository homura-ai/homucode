import {
  AgentSessionImportInput,
  AgentSessionImportResult,
  AgentSessionScanResult,
  NonNegativeInt,
  OrchestrationV2DispatchCommandResult,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectId,
  RunId,
  ServerUpsertKeybindingResult,
  ThreadId,
  ThreadTranscriptImportInput,
  ThreadTranscriptImportResult,
  UsageSummary,
  UsageSummaryInput,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as AgentSessionImporter from "../../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../../project/AgentSessionScanner.ts";
import * as ScratchThreadPromotion from "../../../project/ScratchThreadPromotion.ts";
import * as WorktreeSetupTracker from "../../../project/WorktreeSetupTracker.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
};
const threadDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];

const SessionImportTool = Tool.make("t3_session_import", {
  ...shared,
  description:
    "Import Claude Code and Codex sessions from this machine into T3 Code threads. scan: list importable projects. import: import a project's recent sessions by `projectId`. transcript: create a thread in `projectId` from `title`, `modelSelection`, and `messages`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    action: Schema.Literals(["scan", "import", "transcript"]),
    projectId: Schema.optional(ProjectId),
    expectedWorkspaceRoot: AgentSessionImportInput.fields.expectedWorkspaceRoot,
    title: Schema.optional(ThreadTranscriptImportInput.fields.title),
    modelSelection: Schema.optional(ThreadTranscriptImportInput.fields.modelSelection),
    messages: Schema.optional(ThreadTranscriptImportInput.fields.messages),
  }),
  success: Schema.Union([
    AgentSessionScanResult,
    AgentSessionImportResult,
    ThreadTranscriptImportResult,
  ]),
  dependencies: [
    ...threadDependencies,
    AgentSessionScanner.AgentSessionScanner,
    AgentSessionImporter.AgentSessionImporter,
  ],
}).annotate(Tool.Destructive, false);

const ThreadDiffTool = Tool.make("t3_thread_diff", {
  ...shared,
  description:
    "Read a thread's checkpoint diff, as its Diff panel shows. Omit `threadId` for this thread. No `fromTurnCount`: everything up to `toTurnCount` (default: newest turn). Long diffs page by `offset`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    fromTurnCount: Schema.optional(NonNegativeInt),
    toTurnCount: Schema.optional(NonNegativeInt),
    ignoreWhitespace: Schema.optional(Schema.Boolean),
    offset: Schema.optional(NonNegativeInt),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    fromTurnCount: NonNegativeInt,
    toTurnCount: NonNegativeInt,
    diff: Schema.String,
    nextOffset: Schema.NullOr(NonNegativeInt),
  }),
  dependencies: [...threadDependencies, CheckpointDiffQuery.CheckpointDiffQuery],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const KeybindingTool = Tool.make("t3_keybinding", {
  ...shared,
  description:
    "Add, change, or remove a T3 Code keyboard shortcut, only when the user asks. upsert: bind `key` (such as `mod+shift+k`) to a built-in `command` id; an unknown id returns the valid ones. Optional `when` clause; `replace` names the rule it replaces. remove: drop the rule `replace` names. Asks the user first below full access. " +
    'A key can also run a script, which this tool does not bind. When no built-in does what the user wants, write an app script at `~/.t3/userdata/scripts/<name>.ts` (T3 home\'s `userdata`): `export default async (t3: T3App) => {...}`, where `t3.current()` gives the open project and thread and window APIs such as `navigator.clipboard` work. Then add `{"key": ..., "command": "user.<name>.run"}` to `~/.t3/userdata/keybindings.json`. Or bind `bash:<command>` there, which runs one shell line in a new terminal in the thread\'s checkout. App scripts run in the desktop app or a browser on the same machine, once the user turns on Settings → HomuCode → Interface → App scripts on that device; agents cannot, so tell the user.',
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    action: Schema.Literals(["upsert", "remove"]),
    key: Schema.optional(Schema.String),
    command: Schema.optional(Schema.String),
    when: Schema.optional(Schema.String),
    replace: Schema.optional(
      Schema.Struct({
        key: Schema.String,
        command: Schema.String,
        when: Schema.optional(Schema.String),
      }),
    ),
  }),
  success: ServerUpsertKeybindingResult,
  dependencies: [
    ...threadDependencies,
    Keybindings.Keybindings,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
}).annotate(Tool.Destructive, true);

const UsageReadTool = Tool.make("t3_usage_read", {
  ...shared,
  description:
    "Read provider token usage and cost between `sinceDay` and `untilDay` (YYYY-MM-DD) in IANA `timeZone`, as Settings > Usage shows.",
  parameters: UsageSummaryInput,
  success: UsageSummary,
  dependencies: [...threadDependencies, UsageService.UsageService],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ProjectFromThreadTool = Tool.make("t3_project_from_thread", {
  ...shared,
  description:
    "Turn a scratch thread's folder into a named project, as its Create project button does. Omit `threadId` for this thread.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
  }),
  success: Schema.Struct({ projectId: ProjectId }),
  dependencies: [...threadDependencies, ScratchThreadPromotion.ScratchThreadPromotion],
}).annotate(Tool.Destructive, false);

const WorktreeSetupTool = Tool.make("t3_worktree_setup", {
  ...shared,
  description:
    "A thread's worktree setup script. Omit `threadId` for this thread. cancel: stop it while it runs. retry: run it again after it failed (`runId`, default the newest failed setup).",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals(["cancel", "retry"]),
    runId: Schema.optional(RunId),
  }),
  success: Schema.Union([
    Schema.Struct({ cancelled: Schema.Boolean }),
    OrchestrationV2DispatchCommandResult,
  ]),
  dependencies: [
    ...threadDependencies,
    WorktreeSetupTracker.WorktreeSetupTracker,
    ThreadLaunchService.ThreadLaunchService,
    SecureRandom.SecureRandom,
  ],
}).annotate(Tool.Destructive, true);

export const AppToolkit = Toolkit.make(
  SessionImportTool,
  ThreadDiffTool,
  KeybindingTool,
  UsageReadTool,
  ProjectFromThreadTool,
  WorktreeSetupTool,
);
