import { ThreadActivityResult, ThreadAssistResult } from "@t3tools/contracts";
import {
  OrchestratorMcpFailure,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpClientRequestId,
  ProviderOptionSelections,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
  ThreadMetadataMcpUpdateResult,
  ProjectId,
  RunId,
  MessageId,
  RuntimeRequestId,
  ProviderUserInputAnswers,
  OrchestrationV2DispatchCommandResult,
  ThreadId,
  TrimmedNonEmptyString,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadRun,
  type OrchestratorMcpThreadStatus,
  type OrchestratorMcpThreadTimelineItem,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession, type McpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import { T3_THREAD_CLI_LABEL } from "../mcp/McpInvocationContext.ts";
import { expandHomePath } from "../os-jank.ts";
import * as ProcessRunner from "../processRunner.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

/**
 * Short enough that a run which stops to ask the user something is noticed
 * soon, since `t3_thread_wait` only returns on a terminal run.
 */
const WAIT_SLICE_MS = 15_000;
const WAKE_GRACE_MS = 10_000;
const WAKE_POLL_MS = 500;
const TERMINAL_RUN_STATUSES = new Set<OrchestratorMcpThreadRun["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);
const READ_PAGE_LIMIT = 100;
const READ_ITEM_MAX_CHARS = 20_000;
const TITLE_MAX_CHARS = 80;

export class ThreadServerNotRunningError extends Schema.TaggedError<ThreadServerNotRunningError>()(
  "ThreadServerNotRunningError",
  { baseDir: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `No running T3 Code server uses ${this.baseDir}. Start T3 Code, then retry.`;
  }
}

export class ThreadServerUnreachableError extends Schema.TaggedError<ThreadServerUnreachableError>()(
  "ThreadServerUnreachableError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    const reason = this.cause instanceof Error ? ` ${this.cause.message}` : "";
    return `Could not reach the T3 Code server at ${this.origin}.${reason}`;
  }
}

export class ThreadToolFailedError extends Schema.TaggedError<ThreadToolFailedError>()(
  "ThreadToolFailedError",
  { tool: Schema.String, detail: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

export class ThreadUsageError extends Schema.TaggedError<ThreadUsageError>()("ThreadUsageError", {
  detail: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

export class ThreadProjectNotFoundError extends Schema.TaggedError<ThreadProjectNotFoundError>()(
  "ThreadProjectNotFoundError",
  { identifier: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `No T3 Code project matches '${this.identifier}'. Pass a project id or a path inside a project.`;
  }
}

/** Exit code 2 lets a script tell "needs a human" apart from a failed run. */
export class ThreadNeedsInputError extends Schema.TaggedError<ThreadNeedsInputError>()(
  "ThreadNeedsInputError",
  { threadId: ThreadId },
) {
  override readonly [Runtime.errorReported] = false;
  override readonly [Runtime.errorExitCode] = 2;

  override get message(): string {
    return `Thread ${this.threadId} is waiting for an answer. Open it in T3 Code to respond.`;
  }
}

export class ThreadRunEndedError extends Schema.TaggedError<ThreadRunEndedError>()(
  "ThreadRunEndedError",
  { threadId: ThreadId, status: Schema.String, error: Schema.optional(Schema.String) },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    const reason = this.error === undefined ? "." : `: ${this.error}`;
    return `Thread ${this.threadId} stopped with status ${this.status}${reason}`;
  }
}

const ThreadCliError = Schema.Union([
  ThreadServerNotRunningError,
  ThreadServerUnreachableError,
  ThreadToolFailedError,
  ThreadUsageError,
  ThreadProjectNotFoundError,
  ThreadNeedsInputError,
  ThreadRunEndedError,
]);
const isThreadCliError = Schema.is(ThreadCliError);

/**
 * These errors are expected outcomes for a script, so they print as one line
 * on stderr instead of the runtime's logged stack trace.
 */
const reportThreadErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      isThreadCliError(error) ? Console.error(error.message) : Effect.void,
    ),
  );

const decodeFailureText = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestratorMcpFailure));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const printJson = (value: unknown) => Console.log(encodeJson(value));

const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  ),
});

const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);

const ProjectListResult = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({ id: ProjectId, title: Schema.String, workspaceRoot: Schema.String }),
  ),
  nextCursor: Schema.NullOr(Schema.Int),
});

const ThreadLaunchResult = Schema.Struct({
  messageId: Schema.optional(Schema.NullOr(MessageId)),
  threadId: ThreadId,
  projectId: ProjectId,
  runId: Schema.NullOr(RunId),
});

const toolFailureDetail = (result: typeof ToolResult.Type) => {
  const text = result.content?.find((part) => part.text !== undefined)?.text ?? "";
  return Option.match(decodeFailureText(text), {
    onNone: () => text || "The tool call failed.",
    onSome: (failure) => failure.message,
  });
};

const makeThreadTools = (session: McpToolSession, origin: string) => {
  const unexpected = (tool: string) =>
    new ThreadToolFailedError({
      tool,
      detail: `The server sent an unexpected ${tool} result. Update the t3 CLI to match the server.`,
    });
  return {
    call: Effect.fn("cli.thread.callTool")(function* <S extends Schema.Decoder<unknown>>(
      tool: string,
      args: Readonly<Record<string, unknown>>,
      schema: S,
    ): Effect.fn.Return<S["Type"], ThreadServerUnreachableError | ThreadToolFailedError> {
      const raw = yield* session
        .call(tool, args)
        .pipe(Effect.mapError((cause) => new ThreadServerUnreachableError({ origin, cause })));
      const result = yield* decodeToolResult(raw).pipe(Effect.mapError(() => unexpected(tool)));
      if (result.isError === true) {
        return yield* new ThreadToolFailedError({ tool, detail: toolFailureDetail(result) });
      }
      return yield* Schema.decodeUnknownEffect(schema)(result.structuredContent).pipe(
        Effect.mapError(() => unexpected(tool)),
      );
    }),
  };
};
export type ThreadTools = ReturnType<typeof makeThreadTools>;

/**
 * Signs in as a short-lived MCP client of the running server, the same way an
 * outside agent does, and revokes that session when the command ends.
 */
const withThreadTools = Effect.fn("cli.thread.withThreadTools")(function* <A, E, R>(
  flags: { readonly baseDir: Option.Option<string>; readonly json: boolean },
  run: (tools: ThreadTools) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: flags.json });
  const minimumLogLevel = flags.json ? "Error" : config.logLevel;
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new ThreadServerNotRunningError({ baseDir: config.baseDir });
    }
    const origin = runtimeState.value.origin;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* Effect.acquireRelease(
      environmentAuth.issueMcpClientSession({
        label: T3_THREAD_CLI_LABEL,
        localCli: true,
        // The CLI runs as the machine's owner. New threads still start at
        // the project's default mode, never at this ceiling by default.
        access: "full-access",
        peerLink: false,
        client: { deviceType: "bot" },
      }),
      (session) =>
        environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const session = yield* mcpToolSession({
      endpoint: new URL("/mcp", origin).href,
      authorization: `Bearer ${issued.token}`,
      clientName: "t3-thread-cli",
    }).pipe(Effect.mapError((cause) => new ThreadServerUnreachableError({ origin, cause })));
    return yield* run(makeThreadTools(session, origin));
  }).pipe(
    Effect.scoped,
    Effect.provideService(References.MinimumLogLevel, minimumLogLevel),
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const readMessageArgument = Effect.fn("cli.thread.readMessage")(function* (argument: string) {
  const text =
    argument === "-"
      ? yield* Stdio.Stdio.pipe(
          Effect.flatMap((stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)),
        )
      : argument;
  if (text.trim().length === 0) {
    return yield* new ThreadUsageError({ detail: "The message is empty." });
  }
  return text;
});

const listAllProjects = Effect.fn("cli.thread.listAllProjects")(function* (tools: ThreadTools) {
  const projects: Array<(typeof ProjectListResult.Type)["projects"][number]> = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: typeof ProjectListResult.Type = yield* tools.call(
      "t3_project_list",
      { cursor, limit: 100 },
      ProjectListResult,
    );
    projects.push(...page.projects);
    cursor = page.nextCursor;
  }
  return projects;
});

/** The checkouts of the git repository at `directory`, or none outside a repository. */
const listGitCheckouts = Effect.fn("cli.thread.listGitCheckouts")(function* (directory: string) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const list = (args: ReadonlyArray<string>) =>
    processRunner
      .run({ command: "git", args: ["worktree", "list", "--porcelain", ...args], cwd: directory })
      .pipe(
        Effect.option,
        Effect.map((result) =>
          Option.isSome(result) && result.value.code === 0 ? result.value.stdout : undefined,
        ),
      );
  // Pre-2.36 Git rejects worktree list -z; normalize its line output to NUL records.
  const stdout = (yield* list(["-z"])) ?? (yield* list([]))?.replaceAll("\n", "\0") ?? "";
  return stdout.split("\0\0").flatMap((record) => {
    const [first = "", ...attributes] = record.split("\0");
    return first.startsWith("worktree ") && !attributes.includes("bare")
      ? [first.slice("worktree ".length)]
      : [];
  });
});

/**
 * A project id, or a path inside a project's folder (deepest project wins).
 * A path inside a git worktree resolves as the same path in the repository's
 * other checkouts.
 */
export const resolveProject = Effect.fn("cli.thread.resolveProject")(function* (
  tools: ThreadTools,
  identifier: string,
) {
  const projects = yield* listAllProjects(tools);
  const byId = projects.find((project) => project.id === identifier);
  if (byId !== undefined) return byId;

  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  // Stored roots keep the path the project was added with, which may pass
  // through a symlink (macOS /tmp), so both sides compare as real paths.
  const realPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));
  const target = yield* realPath(
    path.resolve(yield* HostProcess.WorkingDirectory, yield* expandHomePath(identifier)),
  );
  const roots = yield* Effect.forEach(projects, (project) =>
    Effect.map(realPath(project.workspaceRoot), (root) => ({ project, root })),
  );
  const contains = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const deepestContaining = (candidate: string) =>
    roots
      .filter(({ root }) => contains(root, candidate))
      .toSorted((left, right) => right.root.length - left.root.length)[0]?.project;

  const containing = deepestContaining(target);
  if (containing !== undefined) return containing;
  const targetInfo = yield* fileSystem.stat(target).pipe(Effect.option);
  const gitDirectory =
    Option.isSome(targetInfo) && targetInfo.value.type === "File" ? path.dirname(target) : target;
  const listed = yield* listGitCheckouts(gitDirectory).pipe(
    Effect.flatMap((paths) => Effect.forEach(paths, realPath)),
    Effect.provide(ProcessRunner.layer),
  );
  const ownCheckout = listed
    .filter((checkout) => contains(checkout, target))
    .toSorted((left, right) => right.length - left.length)[0];
  if (ownCheckout === undefined) {
    return yield* new ThreadProjectNotFoundError({ identifier });
  }
  const relative = path.relative(ownCheckout, target);
  const matches = new Map<ProjectId, (typeof projects)[number]>();
  for (const checkout of listed) {
    if (checkout === ownCheckout) continue;
    const project = deepestContaining(path.join(checkout, relative));
    if (project !== undefined) matches.set(project.id, project);
  }
  const [match, ...others] = matches.values();
  if (match === undefined) {
    return yield* new ThreadProjectNotFoundError({ identifier });
  }
  if (others.length > 0) {
    const names = [match, ...others].map((project) => `${project.title} (${project.id})`);
    return yield* new ThreadUsageError({
      detail: `'${identifier}' is in a git worktree shared by several projects: ${names.join(", ")}. Pass a project id instead.`,
    });
  }
  return match;
});

/** Every item on a timeline view, oldest first. */
const readTimeline = Effect.fn("cli.thread.readTimeline")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  view: "messages" | "activity",
) {
  const items: Array<OrchestratorMcpThreadTimelineItem> = [];
  let afterPosition: number | undefined;
  let page: OrchestratorMcpThreadReadResult;
  do {
    page = yield* tools.call(
      "t3_thread_read",
      {
        threadId,
        view,
        limit: READ_PAGE_LIMIT,
        maxCharsPerItem: READ_ITEM_MAX_CHARS,
        runLimit: 1,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      },
      OrchestratorMcpThreadReadResult,
    );
    items.push(...page.items);
    afterPosition = page.nextPosition ?? undefined;
  } while (page.hasMore && afterPosition !== undefined);
  return { thread: page.thread, items };
});

/**
 * The latest `count` user and assistant messages, oldest first. Positions
 * count every timeline item, so the read starts near the end and widens
 * backward only while tool and plan items leave too few messages.
 */
export const readLatestMessages = Effect.fn("cli.thread.readLatestMessages")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  count: number,
) {
  let { thread } = yield* tools.call(
    "t3_thread_read",
    { threadId, limit: 1, runLimit: 1 },
    OrchestratorMcpThreadReadResult,
  );
  let messages: Array<OrchestratorMcpThreadTimelineItem> = [];
  // The newest window has no upper bound, so items added since the first
  // read are still shown.
  let before: number | undefined;
  let start = thread.itemCount;
  let span = Math.max(count, READ_PAGE_LIMIT);
  do {
    const end = before;
    start = Math.max(0, start - span);
    const window: Array<OrchestratorMcpThreadTimelineItem> = [];
    let afterPosition = start - 1;
    let page: OrchestratorMcpThreadReadResult;
    do {
      page = yield* tools.call(
        "t3_thread_read",
        {
          threadId,
          view: "messages",
          limit: READ_PAGE_LIMIT,
          maxCharsPerItem: READ_ITEM_MAX_CHARS,
          runLimit: 1,
          ...(afterPosition < 0 ? {} : { afterPosition }),
        },
        OrchestratorMcpThreadReadResult,
      );
      window.push(
        ...page.items.filter(
          (item) =>
            (item.type === "user_message" || item.type === "assistant_message") &&
            (end === undefined || item.position < end),
        ),
      );
      afterPosition = page.nextPosition ?? Number.POSITIVE_INFINITY;
    } while (page.hasMore && afterPosition < (end ?? Number.POSITIVE_INFINITY) - 1);
    thread = page.thread;
    // A window can hold the whole --messages count, too many to spread as arguments.
    messages = window.concat(messages);
    before = start;
    span *= 2;
  } while (messages.length < count && start > 0);
  return { thread, messages: messages.slice(Math.max(0, messages.length - count)) };
});

/** Item text past the read's per-item cap. */
const readFullText = Effect.fn("cli.thread.readFullText")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  item: OrchestratorMcpThreadTimelineItem,
) {
  let text = item.text ?? "";
  let nextTextOffset = item.textTruncated ? (item.nextTextOffset ?? null) : null;
  while (nextTextOffset !== null) {
    const page = yield* tools.call(
      "t3_thread_read",
      {
        threadId,
        itemId: item.itemId,
        textOffset: nextTextOffset,
        runLimit: 1,
        maxCharsPerItem: READ_ITEM_MAX_CHARS,
      },
      OrchestratorMcpThreadReadResult,
    );
    const chunk = page.items.find((candidate) => candidate.itemId === item.itemId);
    if (chunk === undefined) break;
    text += chunk.text ?? "";
    nextTextOffset = chunk.textTruncated ? (chunk.nextTextOffset ?? null) : null;
  }
  return text;
});

/** The run's last assistant message, or its last error when it did not complete. */
const runResultText = Effect.fn("cli.thread.runResultText")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  runId: RunId,
  type: "assistant_message" | "error",
) {
  const { items } = yield* readTimeline(
    tools,
    threadId,
    type === "assistant_message" ? "messages" : "activity",
  );
  const item = items.findLast((candidate) => candidate.runId === runId && candidate.type === type);
  return item === undefined ? null : yield* readFullText(tools, threadId, item);
});

type WaitOutcome =
  | {
      readonly type: "ended";
      readonly runId: RunId | null;
      readonly status: OrchestratorMcpThreadStatus;
    }
  | { readonly type: "needs_input" };

/**
 * Whether the thread has nothing left to do: no active run and no delegated
 * or background work. Only then is the work a later wait settles on this
 * send's own.
 */
const threadIsIdle = Effect.fn("cli.thread.threadIsIdle")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
) {
  const waited = yield* tools.call(
    "t3_thread_wait",
    { threadId, timeoutMs: 1, untilDelegatedWorkSettled: true },
    OrchestratorMcpThreadWaitResult,
  );
  return !waited.timedOut;
});

/**
 * The runs after `runId`, and whether one holds a message someone sent.
 * Background work wakes a run with a notification, never a user message, so
 * such a run is another request and its reply is not this one's.
 */
const runsAfter = Effect.fn("cli.thread.runsAfter")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  runId: RunId,
) {
  const { recentRuns } = yield* tools.call(
    "t3_thread_read",
    { threadId, limit: 1, runLimit: 50 },
    OrchestratorMcpThreadReadResult,
  );
  const own = recentRuns.find((run) => run.runId === runId);
  if (own === undefined) return { later: [], sent: true };
  const later = recentRuns.filter((run) => run.ordinal > own.ordinal);
  if (later.length === 0) return { later, sent: false };
  const { items } = yield* readTimeline(tools, threadId, "messages");
  const sent = items.some(
    (item) => item.type === "user_message" && later.some((run) => run.runId === item.runId),
  );
  return { later, sent };
});

/**
 * Waits for this exact run, following a restart to its continuation, so a
 * message another client sends meanwhile cannot stand in for its result.
 * With `followWakes`, a completed run is followed further to the runs its
 * background work wakes, as long as no one else sends to the thread.
 */
export const waitForRun = Effect.fn("cli.thread.waitForRun")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  runId: RunId,
  followWakes = false,
) {
  const waitSlice = (timeoutMs: number, untilDelegatedWorkSettled?: true) =>
    tools.call(
      "t3_thread_wait",
      {
        threadId,
        runId,
        timeoutMs,
        ...(untilDelegatedWorkSettled ? { untilDelegatedWorkSettled } : {}),
      },
      OrchestratorMcpThreadWaitResult,
    );
  const ended = (waited: OrchestratorMcpThreadWaitResult) =>
    ({ type: "ended", runId: waited.runId, status: waited.status }) satisfies WaitOutcome;
  const ownRun = Effect.gen(function* () {
    while (true) {
      const waited = yield* waitSlice(WAIT_SLICE_MS);
      if (!waited.timedOut) return ended(waited);
      // A pending request on this run, or on an earlier run this one is queued
      // behind, blocks it until someone answers.
      const { thread } = yield* tools.call(
        "t3_thread_read",
        { threadId, limit: 1, runLimit: 1 },
        OrchestratorMcpThreadReadResult,
      );
      if (thread.pendingRequestCount > 0) {
        // The count is thread-wide: if this run ended since the slice, the
        // request belongs to a later run.
        const recheck = yield* waitSlice(1);
        return recheck.timedOut ? ({ type: "needs_input" } satisfies WaitOutcome) : ended(recheck);
      }
    }
  });
  const outcome = yield* ownRun;
  if (!followWakes || outcome.type !== "ended" || outcome.status !== "completed") return outcome;
  const finalRunId = outcome.runId ?? runId;
  // A provider records the run that background work wakes only after that
  // work has ended, so the thread briefly looks settled in between.
  const wakeRunRecorded = Effect.gen(function* () {
    for (let waited = 0; waited < WAKE_GRACE_MS; waited += WAKE_POLL_MS) {
      yield* Effect.sleep(WAKE_POLL_MS);
      const after = yield* runsAfter(tools, threadId, finalRunId);
      if (after.sent) return false;
      if (after.later.length > 0) return true;
    }
    return false;
  });
  let workOutlivedRun = false;
  while (true) {
    const waited = yield* waitSlice(WAIT_SLICE_MS, true);
    // `resultRun` is the thread's latest finished run, whoever sent it.
    const result = waited.timedOut ? undefined : waited.resultRun;
    const after = yield* runsAfter(tools, threadId, finalRunId);
    if (after.sent) return outcome;
    if (!waited.timedOut) {
      if (result !== undefined && after.later.some((run) => run.runId === result.runId)) {
        return { type: "ended", runId: result.runId, status: result.status } satisfies WaitOutcome;
      }
      if (!workOutlivedRun) return outcome;
      if (after.later.some((run) => !TERMINAL_RUN_STATUSES.has(run.status))) continue;
      if (after.later.length === 0 && (yield* wakeRunRecorded)) continue;
      return outcome;
    }
    workOutlivedRun = true;
    const { thread } = yield* tools.call(
      "t3_thread_read",
      { threadId, limit: 1, runLimit: 1 },
      OrchestratorMcpThreadReadResult,
    );
    // Earlier runs have ended, so the request is on a run this one's work woke.
    if (thread.pendingRequestCount > 0) return { type: "needs_input" } satisfies WaitOutcome;
  }
});

/**
 * With --json the result always reaches stdout, so a script keeps the thread
 * id even when the run fails.
 */
const finishRun = Effect.fn("cli.thread.finishRun")(function* (
  tools: ThreadTools,
  input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly json: boolean;
    readonly followWakes: boolean;
  },
) {
  const outcome = yield* waitForRun(tools, input.threadId, input.runId, input.followWakes);
  const runId = outcome.type === "ended" ? (outcome.runId ?? input.runId) : input.runId;
  const status = outcome.type === "ended" ? outcome.status : "waiting";
  const reply =
    status === "completed"
      ? yield* runResultText(tools, input.threadId, runId, "assistant_message")
      : null;
  const error =
    status === "completed" || status === "waiting"
      ? null
      : yield* runResultText(tools, input.threadId, runId, "error");
  if (input.json) {
    yield* printJson({ threadId: input.threadId, runId, status, reply, error });
  } else if (reply !== null) {
    yield* Console.log(reply);
  }
  if (outcome.type === "needs_input") {
    return yield* new ThreadNeedsInputError({ threadId: input.threadId });
  }
  if (status !== "completed") {
    return yield* new ThreadRunEndedError({
      threadId: input.threadId,
      status,
      ...(error === null ? {} : { error }),
    });
  }
});

export const titleFromMessage = (message: string) => {
  const firstLine = message.trim().split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= TITLE_MAX_CHARS) return firstLine;
  let end = TITLE_MAX_CHARS - 1;
  const previous = firstLine.charCodeAt(end - 1);
  const next = firstLine.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  return `${firstLine.slice(0, end).trimEnd()}…`;
};

const launchWorkspaceStrategy = (input: {
  readonly worktree: Option.Option<string>;
  readonly branch: Option.Option<string>;
}) =>
  Option.match(input.worktree, {
    onNone: () =>
      Option.isSome(input.branch)
        ? Effect.fail(new ThreadUsageError({ detail: "--branch needs --worktree <base-ref>." }))
        : Effect.void,
    onSome: (baseRef) =>
      Effect.succeed({
        type: "worktree" as const,
        baseRef,
        ...Option.match(input.branch, { onNone: () => ({}), onSome: (branch) => ({ branch }) }),
      }),
  });

/**
 * Options are model specific, so they need an explicit model. `true` and
 * `false` become booleans because boolean options such as fastMode only match
 * a boolean.
 */
export const launchModelSelection = Effect.fn("cli.thread.launchModelSelection")(function* (input: {
  readonly provider: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly option: ReadonlyArray<string>;
}) {
  if (Option.isSome(input.provider) !== Option.isSome(input.model)) {
    return yield* new ThreadUsageError({ detail: "--provider and --model go together." });
  }
  if (Option.isNone(input.provider) || Option.isNone(input.model)) {
    if (input.option.length > 0) {
      return yield* new ThreadUsageError({ detail: "--option needs --provider and --model." });
    }
    return undefined;
  }
  const options = yield* parseLaunchOptions(input.option);
  return {
    instanceId: input.provider.value,
    model: input.model.value,
    ...(options.length === 0 ? {} : { options }),
  };
});

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text."),
  Flag.withDefault(false),
);
const waitFlag = Flag.Boolean("wait").pipe(
  Flag.withDescription(
    "Wait for the agent to finish and print its reply. Exits 1 if the run fails and 2 if it waits for an answer.",
  ),
  Flag.withDefault(false),
);
const messageArgument = Argument.String("message").pipe(
  Argument.withDescription("Message for the agent, or - to read it from stdin."),
);
const threadArgument = Argument.String("thread").pipe(Argument.withDescription("Thread id."));

const decodeProviderOptions = Schema.decodeEffect(ProviderOptionSelections);
const decodeClientRequestId = Schema.decodeEffect(OrchestratorMcpClientRequestId);
const decodeRuntimeRequestId = Schema.decodeEffect(RuntimeRequestId);
const decodeUserInputAnswers = Schema.decodeEffect(Schema.fromJsonString(ProviderUserInputAnswers));
const decodeRunId = Schema.decodeEffect(RunId);
const decodeThreadIdValue = Schema.decodeUnknownEffect(ThreadId);
const decodeTitle = Schema.decodeUnknownEffect(TrimmedNonEmptyString);
const decodeThreadId = (value: string) =>
  decodeThreadIdValue(value.trim()).pipe(
    Effect.mapError(() => new ThreadUsageError({ detail: `'${value}' is not a thread id.` })),
  );

const threadIdCommand = Command.make("id", { json: jsonFlag }).pipe(
  Command.withDescription("Print the current agent's T3 thread ID."),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const value = yield* Config.String("T3CODE_THREAD_ID").pipe(Config.option);
      if (Option.isNone(value) || value.value.trim() === "") {
        return yield* new ThreadUsageError({
          detail: "This shell has no T3 thread ID. Inside a T3 agent, you can use t3_thread_id.",
        });
      }
      const threadId = yield* decodeThreadId(value.value);
      yield* json ? printJson({ threadId }) : Console.log(threadId);
    }).pipe(reportThreadErrors),
  ),
);

const threadListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id or a path inside the project. Defaults to this directory."),
    Flag.withDefault("."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List a project's threads, newest first."),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.thread.list")(function* (tools) {
        const project = yield* resolveProject(tools, flags.project);
        const threads: Array<OrchestratorMcpThreadListItem> = [];
        let cursor: number | null = 0;
        while (cursor !== null) {
          const page: OrchestratorMcpThreadListResult = yield* tools.call(
            "t3_thread_list",
            { projectId: project.id, includeSubagents: false, limit: 100, cursor },
            OrchestratorMcpThreadListResult,
          );
          threads.push(...page.threads);
          cursor = page.nextCursor;
        }
        if (flags.json) {
          return yield* printJson(threads);
        }
        for (const thread of threads) {
          yield* Console.log(`${thread.threadId}  ${thread.status.padEnd(11)}  ${thread.title}`);
        }
      }),
    ).pipe(reportThreadErrors),
  ),
);

export const parseLaunchOptions = Effect.fn("cli.thread.parseLaunchOptions")(function* (
  raw: ReadonlyArray<string>,
  effort?: string,
) {
  const values = effort === undefined ? raw : [...raw, `reasoningEffort=${effort}`];
  const options: Array<{ id: string; value: string | boolean }> = [];
  for (const option of values) {
    const at = option.indexOf("=");
    const id = option.slice(0, at).trim();
    const value = option.slice(at + 1).trim();
    if (at <= 0 || !id || !value) {
      return yield* new ThreadUsageError({
        detail: "Each --option must be an ID=VALUE with a nonempty value.",
      });
    }
    if (options.some((existing) => existing.id === id)) {
      return yield* new ThreadUsageError({
        detail: `--option ${id} is given more than once.`,
      });
    }
    options.push({ id, value: value === "true" ? true : value === "false" ? false : value });
  }
  yield* decodeProviderOptions(options).pipe(
    Effect.mapError(() => new ThreadUsageError({ detail: "Invalid model options." })),
  );
  return options;
});

const threadCapabilitiesCommand = Command.make("capabilities", {
  ...projectLocationFlags,
  json: jsonFlag,
  search: Flag.String("search").pipe(Flag.optional),
}).pipe(
  Command.withDescription("List the running environment's provider models and options."),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.thread.capabilities")(function* (tools) {
        const result = yield* tools.call(
          "orchestrator_capabilities",
          Option.isSome(flags.search) ? { search: flags.search.value } : {},
          OrchestratorMcpCapabilitiesResult,
        );
        yield* printJson(result);
      }),
    ).pipe(reportThreadErrors),
  ),
);

const threadStartCommand = Command.make("start", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or a path inside the project, such as ."),
  ),
  message: messageArgument,
  title: Flag.String("title").pipe(
    Flag.withDescription("Thread title. Defaults to the message's first line."),
    Flag.optional,
  ),
  provider: Flag.String("provider").pipe(
    Flag.withDescription("Provider instance id. Pass with --model."),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(
    Flag.withDescription("Model slug. Defaults to the project's default model."),
    Flag.optional,
  ),
  effort: Flag.String("effort").pipe(
    Flag.withDescription("Reasoning effort (shorthand for --option reasoningEffort=VALUE)."),
    Flag.optional,
  ),
  options: Flag.String("option").pipe(
    Flag.withDescription(
      "Model option ID=VALUE; repeat for several options. true/false are booleans.",
    ),
    Flag.atLeast(0),
  ),
  clientRequestId: Flag.String("client-request-id").pipe(
    Flag.withDescription("Stable retry key; reuse to avoid launching another thread."),
    Flag.optional,
  ),
  worktree: Flag.String("worktree").pipe(
    Flag.withDescription(
      "Run in a new git worktree based on this branch, tag, or commit, instead of the project folder.",
    ),
    Flag.optional,
  ),
  branch: Flag.String("branch").pipe(
    Flag.withDescription("Branch name for the new worktree."),
    Flag.optional,
  ),
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start a thread in a project and print its id."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const message = yield* readMessageArgument(flags.message);
      const workspaceStrategy = yield* launchWorkspaceStrategy(flags);
      if (Option.isSome(flags.provider) !== Option.isSome(flags.model)) {
        return yield* new ThreadUsageError({ detail: "--provider and --model go together." });
      }
      const options = yield* parseLaunchOptions(flags.options, Option.getOrUndefined(flags.effort));
      if (options.length > 0 && Option.isNone(flags.provider)) {
        return yield* new ThreadUsageError({
          detail: "Model options require --provider and --model.",
        });
      }
      const modelSelection =
        Option.isSome(flags.provider) && Option.isSome(flags.model)
          ? {
              instanceId: flags.provider.value,
              model: flags.model.value,
              ...(options.length === 0 ? {} : { options }),
            }
          : undefined;
      const clientRequestId = Option.isNone(flags.clientRequestId)
        ? undefined
        : yield* decodeClientRequestId(flags.clientRequestId.value).pipe(
            Effect.mapError(() => new ThreadUsageError({ detail: "Invalid --client-request-id." })),
          );
      const title = yield* decodeTitle(
        Option.getOrElse(flags.title, () => titleFromMessage(message)),
      ).pipe(Effect.mapError(() => new ThreadUsageError({ detail: "The title is empty." })));
      yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.start")(function* (tools) {
          const project = yield* resolveProject(tools, flags.project);
          const launched = yield* tools.call(
            "t3_thread_launch",
            {
              projectId: project.id,
              title,
              message,
              ...(clientRequestId === undefined ? {} : { clientRequestId }),
              ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
              ...(modelSelection === undefined ? {} : { modelSelection }),
            },
            ThreadLaunchResult,
          );
          if (flags.wait && launched.runId !== null) {
            if (!flags.json) yield* Console.error(`Thread ${launched.threadId}`);
            return yield* finishRun(tools, {
              threadId: launched.threadId,
              runId: launched.runId,
              json: flags.json,
              followWakes: true,
            });
          }
          yield* flags.json ? printJson(launched) : Console.log(launched.threadId);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const sendModeFlag = Flag.Literals("mode", ["queue", "auto", "steer", "restart"]).pipe(
  Flag.withDescription(
    "queue (default): a busy thread gets it as its next turn. auto: steer the running turn, or start a turn when idle. steer: steer the running turn; fails when idle. restart: interrupt the running turn and restart it with the message.",
  ),
  Flag.withDefault("queue"),
);

const threadSendCommand = Command.make("send", {
  ...projectLocationFlags,
  thread: threadArgument,
  message: messageArgument,
  mode: sendModeFlag,
  clientRequestId: Flag.String("client-request-id").pipe(
    Flag.withDescription("Stable retry key to send a message once."),
    Flag.optional,
  ),
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Send a message to a thread. By default a busy thread gets it as its next turn; --mode auto steers it into the running turn instead.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const message = yield* readMessageArgument(flags.message);
      yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.send")(function* (tools) {
          // Work already running when this is sent is not this message's to wait for.
          const followWakes = flags.wait ? yield* threadIsIdle(tools, threadId) : false;
          const clientRequestId = Option.getOrUndefined(flags.clientRequestId);
          const sent = yield* tools.call(
            "t3_thread_send",
            {
              threadId,
              message,
              mode: flags.mode,
              ...(clientRequestId === undefined ? {} : { clientRequestId }),
            },
            OrchestratorMcpThreadSendResult,
          );
          if (flags.wait) {
            return yield* finishRun(tools, {
              threadId,
              runId: sent.runId,
              json: flags.json,
              followWakes,
            });
          }
          yield* flags.json
            ? printJson(sent)
            : Console.log(
                sent.delivery === "queued"
                  ? "Queued."
                  : sent.delivery === "steered"
                    ? "Steered."
                    : sent.delivery === "restarted"
                      ? "Restarted."
                      : "Sent.",
              );
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadJobWaitCommand = Command.make("job-wait", {
  ...projectLocationFlags,
  thread: threadArgument,
  jobId: Flag.String("job-id"),
  label: Flag.String("label").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Set a durable independent job wait, or clear it by omitting --label."),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.thread.jobWait")(function* (tools) {
        const threadId = yield* decodeThreadId(flags.thread);
        const jobLabel = Option.getOrUndefined(flags.label);
        yield* tools.call(
          "t3_thread_update",
          {
            threadId,
            action: "job_wait",
            jobId: flags.jobId,
            ...(jobLabel === undefined ? {} : { jobLabel }),
            clientRequestId: `external-job:${jobLabel === undefined ? "clear" : "set"}:${flags.jobId}`,
          },
          ThreadMetadataMcpUpdateResult,
        );
      }),
    ).pipe(reportThreadErrors),
  ),
);

const threadShowCommand = Command.make("show", {
  ...projectLocationFlags,
  thread: threadArgument,
  messages: Flag.Int("messages").pipe(
    Flag.withDescription("How many of the latest messages to print."),
    Flag.withDefault(10),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show a thread's state and its latest messages."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.show")(function* (tools) {
          const { thread, messages: latest } = yield* readLatestMessages(
            tools,
            threadId,
            flags.messages,
          );
          const messages = yield* Effect.forEach(latest, (item) =>
            readFullText(tools, threadId, item).pipe(
              Effect.map((text) => ({
                role: item.type === "user_message" ? "user" : "assistant",
                runId: item.runId,
                text,
              })),
            ),
          );
          if (flags.json) {
            return yield* printJson({ thread, messages });
          }
          yield* Console.log(thread.title);
          yield* Console.log(
            [thread.threadId, thread.status, `${thread.providerInstanceId}/${thread.model}`].join(
              "  ",
            ),
          );
          if (thread.worktreePath !== null) {
            yield* Console.log(`${thread.branch ?? "(no branch)"}  ${thread.worktreePath}`);
          }
          if (thread.pendingRequestCount > 0) {
            yield* Console.log(`Waiting for ${thread.pendingRequestCount} answer(s).`);
          }
          for (const entry of messages) {
            yield* Console.log(`\n[${entry.role}]\n${entry.text}`);
          }
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const ThreadModes = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: Schema.String,
  interactionMode: Schema.String,
});

const threadConfigureCommand = Command.make("configure", {
  ...projectLocationFlags,
  thread: threadArgument,
  runtimeMode: Flag.Literals("runtime-mode", [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
  ]).pipe(Flag.withDescription("Set the thread's permission mode."), Flag.optional),
  interactionMode: Flag.Literals("interaction-mode", ["default", "plan"]).pipe(
    Flag.withDescription("Set the thread's interaction mode."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show a thread's permission and interaction modes, or set them with --runtime-mode and --interaction-mode.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.configure")(function* (tools) {
          const changes = {
            ...(Option.isSome(flags.runtimeMode) ? { runtimeMode: flags.runtimeMode.value } : {}),
            ...(Option.isSome(flags.interactionMode)
              ? { interactionMode: flags.interactionMode.value }
              : {}),
          };
          if (Object.keys(changes).length > 0) {
            yield* tools.call(
              "t3_thread_configure",
              { threadId, ...changes },
              Schema.Struct({ sequence: Schema.Number }),
            );
          }
          const modes = yield* tools.call("t3_thread_configure", { threadId }, ThreadModes);
          yield* flags.json
            ? printJson(modes)
            : Console.log(`${modes.runtimeMode} ${modes.interactionMode}`);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const PendingQuestionResult = Schema.Struct({
  requestId: RuntimeRequestId,
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      header: Schema.String,
      question: Schema.String,
      options: Schema.Array(
        Schema.Struct({
          label: Schema.String,
          description: Schema.String,
          value: Schema.optional(Schema.String),
        }),
      ),
      multiSelect: Schema.optional(Schema.Boolean),
      allowCustomAnswer: Schema.optional(Schema.Boolean),
      initialAnswer: Schema.optional(Schema.String),
      required: Schema.optional(Schema.Boolean),
    }),
  ),
});
const pendingFlags = { ...projectLocationFlags, thread: threadArgument, json: jsonFlag };
const requestArgument = Argument.String("request");
const pendingListCommand = Command.make("list", pendingFlags).pipe(
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.pendingRequest.list")(function* (tools) {
        const threadId = yield* decodeThreadId(flags.thread);
        const result = yield* tools.call(
          "t3_pending_request",
          { action: "list", threadId },
          Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
        );
        yield* flags.json ? printJson(result) : Console.log(result.requestIds.join("\n"));
      }),
    ).pipe(reportThreadErrors),
  ),
);
const pendingReadCommand = Command.make("read", { ...pendingFlags, request: requestArgument }).pipe(
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.pendingRequest.read")(function* (tools) {
        const threadId = yield* decodeThreadId(flags.thread);
        const requestId = yield* decodeRuntimeRequestId(flags.request);
        const result = yield* tools.call(
          "t3_pending_request",
          { action: "read", threadId, requestId },
          PendingQuestionResult,
        );
        yield* printJson(result);
      }),
    ).pipe(reportThreadErrors),
  ),
);
const pendingRespondCommand = Command.make("respond", {
  ...pendingFlags,
  request: requestArgument,
  answersFile: Flag.String("answers-file").pipe(
    Flag.withDescription("Absolute path to a JSON answers object, or - for stdin."),
  ),
}).pipe(
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.pendingRequest.respond")(function* (tools) {
        const threadId = yield* decodeThreadId(flags.thread);
        const requestId = yield* decodeRuntimeRequestId(flags.request);
        // The native read refuses stale requests, approvals, and secret cards before any answer is read.
        yield* tools.call(
          "t3_pending_request",
          { action: "read", threadId, requestId },
          PendingQuestionResult,
        );
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        if (flags.answersFile !== "-" && !path.isAbsolute(flags.answersFile)) {
          return yield* new ThreadUsageError({
            detail: "--answers-file must be an absolute path or -.",
          });
        }
        const raw =
          flags.answersFile === "-"
            ? yield* readMessageArgument("-")
            : yield* fs.readFileString(flags.answersFile);
        const answers = yield* decodeUserInputAnswers(raw).pipe(
          Effect.mapError(() => new ThreadUsageError({ detail: "Answers must be a JSON object." })),
        );
        const result = yield* tools.call(
          "t3_pending_request",
          { action: "respond", threadId, requestId, answers },
          OrchestrationV2DispatchCommandResult,
        );
        yield* printJson(result);
      }),
    ).pipe(reportThreadErrors),
  ),
);
const pendingDismissCommand = Command.make("dismiss", {
  ...pendingFlags,
  request: requestArgument,
}).pipe(
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.pendingRequest.dismiss")(function* (tools) {
        const threadId = yield* decodeThreadId(flags.thread);
        const requestId = yield* decodeRuntimeRequestId(flags.request);
        const result = yield* tools.call(
          "t3_pending_request",
          { action: "dismiss", threadId, requestId },
          OrchestrationV2DispatchCommandResult,
        );
        yield* printJson(result);
      }),
    ).pipe(reportThreadErrors),
  ),
);
const ORGANIZE_ACTIONS = [
  "pin",
  "unpin",
  "reorder-pin",
  "snooze",
  "unsnooze",
  "settle",
  "unsettle",
  "archive",
  "unarchive",
  "mark-read",
  "mark-unread",
  "move-project",
  "move-under",
  "move-to-root",
  "auto-settle-on",
  "auto-settle-off",
  "stop-session",
  "close-guest-share",
] as const;

const threadOrganizeCommand = Command.make("organize", {
  ...projectLocationFlags,
  thread: threadArgument,
  action: Argument.Literals("action", ORGANIZE_ACTIONS),
  project: Flag.String("project").pipe(
    Flag.withDescription("move-project: destination project id or a path inside it."),
    Flag.optional,
  ),
  parent: Flag.String("parent").pipe(
    Flag.withDescription("move-under: the new parent thread id."),
    Flag.optional,
  ),
  before: Flag.String("before").pipe(
    Flag.withDescription("reorder-pin: the pinned thread to go above. Omit to go last."),
    Flag.optional,
  ),
  until: Flag.String("until").pipe(
    Flag.withDescription("snooze: ISO time to wake the thread."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Pin, snooze, settle, archive, mark read or unread, move a thread to another project or parent, and other thread menu actions.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const parentThreadId = Option.isSome(flags.parent)
        ? yield* decodeThreadId(flags.parent.value)
        : undefined;
      const beforeThreadId = Option.isSome(flags.before)
        ? yield* decodeThreadId(flags.before.value)
        : null;
      yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.organize")(function* (tools) {
          const projectId = Option.isSome(flags.project)
            ? (yield* resolveProject(tools, flags.project.value)).id
            : undefined;
          const result = yield* tools.call(
            "t3_thread_organize",
            {
              threadId,
              action: flags.action.replaceAll("-", "_"),
              ...(projectId === undefined ? {} : { projectId }),
              ...(parentThreadId === undefined ? {} : { parentThreadId }),
              ...(flags.action === "reorder-pin" ? { beforeThreadId } : {}),
              ...(Option.isSome(flags.until) ? { snoozedUntil: flags.until.value } : {}),
            },
            Schema.Unknown,
          );
          yield* flags.json ? printJson(result) : Console.log("ok");
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

export const pendingRequestCommand = Command.make("pending-request").pipe(
  Command.withDescription(
    "Read and answer pending user questions. Secret cards and approvals stay in T3.",
  ),
  Command.withSubcommands([
    pendingListCommand,
    pendingReadCommand,
    pendingRespondCommand,
    pendingDismissCommand,
  ]),
);

const threadActivityCommand = Command.make("activity", {
  ...projectLocationFlags,
  project: Flag.String("project"),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Read MAIN activity metadata, including subagents; never reads messages.",
  ),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.thread.activity")(function* (tools) {
        const project = yield* resolveProject(tools, flags.project);
        const result = yield* tools.call(
          "t3_thread_activity",
          { projectId: project.id },
          ThreadActivityResult,
        );
        yield* printJson(result);
      }),
    ).pipe(reportThreadErrors),
  ),
);

const threadAssistCommand = Command.make("assist", {
  ...projectLocationFlags,
  thread: threadArgument,
  run: Flag.String("run"),
  project: Flag.String("project"),
  origin: Flag.Literals("origin", ["pace-v1"]),
  provider: Flag.String("provider"),
  model: Flag.String("model"),
  option: Flag.String("option").pipe(Flag.atLeast(0)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Start or replay one native making-faster child for an exact eligible MAIN run.",
  ),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.thread.assist")(function* (tools) {
        const project = yield* resolveProject(tools, flags.project);
        const threadId = yield* decodeThreadId(flags.thread);
        const options = yield* parseLaunchOptions(flags.option);
        const result = yield* tools.call(
          "t3_thread_assist",
          {
            projectId: project.id,
            threadId,
            runId: yield* decodeRunId(flags.run).pipe(
              Effect.mapError(() => new ThreadUsageError({ detail: "Invalid --run id." })),
            ),
            origin: flags.origin,
            providerInstanceId: flags.provider,
            model: flags.model,
            options,
          },
          ThreadAssistResult,
        );
        yield* printJson(result);
      }),
    ).pipe(reportThreadErrors),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Start, message, and read threads on the running server."),
  Command.withSubcommands([
    threadIdCommand,
    threadListCommand,
    threadActivityCommand,
    threadAssistCommand,
    threadStartCommand,
    threadCapabilitiesCommand,
    threadSendCommand,
    threadJobWaitCommand,
    threadShowCommand,
    threadConfigureCommand,
    threadOrganizeCommand,
  ]),
);
