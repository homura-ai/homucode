// @effect-diagnostics globalTimers:off -- The Node socket client owns its response deadline and clears it on every completion path.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect stat follows symlinks; IPC ownership validation requires lstat.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  AppScriptLoadError,
  AppScriptName,
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationErrorCode,
  MAX_APP_SCRIPT_SOURCE_BYTES,
  DesktopAppActivationResponse,
  type DesktopAppActivationPlatform,
  type DesktopAppActivationRequest,
} from "@t3tools/contracts";
import {
  resolveDesktopAppControlAddress,
  type DesktopAppControlAddress,
} from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/cli";

import { stripAppScriptTypes } from "../appScripts.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

const CLI_RESPONSE_TIMEOUT_MS = 17_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const isDesktopAppActivationResponse = Schema.is(DesktopAppActivationResponse);
const isAppScriptName = Schema.is(AppScriptName);

export class DesktopAppSshUnsupportedError extends Schema.TaggedError<DesktopAppSshUnsupportedError>()(
  "DesktopAppSshUnsupportedError",
  {},
) {
  override get message(): string {
    return "`t3 app` only controls a desktop app on the same machine. It cannot run over SSH.";
  }
}

export class DesktopAppPlatformUnsupportedError extends Schema.TaggedError<DesktopAppPlatformUnsupportedError>()(
  "DesktopAppPlatformUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `\`t3 app\` is not supported on ${this.platform}.`;
  }
}

export class DesktopAppUnreachableError extends Schema.TaggedError<DesktopAppUnreachableError>()(
  "DesktopAppUnreachableError",
  {
    candidateAddresses: Schema.Array(Schema.String),
    requestId: Schema.String,
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not reach the T3 Code desktop app. Start or update the desktop app on this machine, then run `t3 app` again. A running T3 Code server is not enough.";
  }
}

export class DesktopAppRequestFailedError extends Schema.TaggedError<DesktopAppRequestFailedError>()(
  "DesktopAppRequestFailedError",
  {
    code: DesktopAppActivationErrorCode,
    requestId: Schema.String,
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `T3 Code could not open ${this.workspaceRoot} (${this.code}).`;
  }
}

export class DesktopAppScriptFailedError extends Schema.TaggedError<DesktopAppScriptFailedError>()(
  "DesktopAppScriptFailedError",
  {
    code: DesktopAppActivationErrorCode,
    requestId: Schema.String,
    script: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.script}: ${this.detail}`;
  }
}

function isDesktopPlatform(platform: NodeJS.Platform): platform is DesktopAppActivationPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

async function sendDesktopAppActivationRequest(input: {
  readonly address: DesktopAppControlAddress;
  readonly fallbackAddress?: DesktopAppControlAddress;
  readonly userId: number | undefined;
  readonly request: DesktopAppActivationRequest;
  readonly timeoutMs?: number;
}): Promise<DesktopAppActivationResponse> {
  if (input.address.directory !== null) {
    const stat = await NodeFSP.lstat(input.address.directory);
    if (
      !stat.isDirectory() ||
      input.userId === undefined ||
      stat.uid !== input.userId ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error("The desktop app socket directory is not private or owned by this user.");
    }
  }
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(input.address.address);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let connected = false;

    const finish = (
      result:
        | { readonly type: "success"; readonly response: DesktopAppActivationResponse }
        | { readonly type: "failure"; readonly error: Error },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (result.type === "success") resolve(result.response);
      else reject(result.error);
    };

    const timeout = setTimeout(() => {
      finish({
        type: "failure",
        error: new Error("The desktop app did not respond in time."),
      });
    }, input.timeoutMs ?? CLI_RESPONSE_TIMEOUT_MS);

    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(input.request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        finish({ type: "failure", error: new Error("The desktop app response is too large.") });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish({
          type: "failure",
          error: new Error("The desktop app response is not valid JSON."),
        });
        return;
      }
      if (!isDesktopAppActivationResponse(parsed)) {
        finish({ type: "failure", error: new Error("The desktop app response is invalid.") });
        return;
      }
      if (parsed.requestId !== input.request.requestId) {
        finish({
          type: "failure",
          error: new Error("The desktop app response did not match this request."),
        });
        return;
      }
      finish({ type: "success", response: parsed });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (
        !settled &&
        !connected &&
        input.fallbackAddress !== undefined &&
        (error.code === "ENOENT" || error.code === "ECONNREFUSED")
      ) {
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        resolve(
          sendDesktopAppActivationRequest({
            address: input.fallbackAddress,
            userId: input.userId,
            request: input.request,
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          }),
        );
        return;
      }
      finish({ type: "failure", error });
    });
    socket.once("end", () => {
      finish({ type: "failure", error: new Error("The desktop app closed the connection.") });
    });
  });
}

const appEnvironment = Config.all({
  t3Home: Config.String("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  sshConnection: Config.String("SSH_CONNECTION").pipe(Config.option),
  sshTty: Config.String("SSH_TTY").pipe(Config.option),
  // Agents' shells carry their thread id; the integrated terminal strips it.
  agentThreadId: Config.String("T3CODE_THREAD_ID").pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)?.trim() || undefined),
  ),
});

/** Finds this machine's desktop app and sends it one request. */
const sendToDesktopApp = Effect.fn("cli.app.send")(function* (input: {
  readonly baseDir: Option.Option<string>;
  readonly workspaceRoot: string;
  readonly makeRequest: (
    base: {
      readonly version: typeof DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly platform: DesktopAppActivationPlatform;
    },
    caller: { readonly agentThreadId: string | undefined },
  ) => DesktopAppActivationRequest;
}) {
  const environment = yield* appEnvironment;
  const hostPlatform = yield* HostProcess.Platform;
  if (Option.isSome(environment.sshConnection) || Option.isSome(environment.sshTty)) {
    return yield* new DesktopAppSshUnsupportedError({});
  }
  if (!isDesktopPlatform(hostPlatform)) {
    return yield* new DesktopAppPlatformUnsupportedError({ platform: hostPlatform });
  }

  const path = yield* Path.Path;
  const configuredBaseDir = Option.getOrUndefined(input.baseDir) ?? environment.t3Home;
  const baseDir = yield* resolveBaseDir(configuredBaseDir);
  const allowDevFallback = Option.isNone(input.baseDir) && !environment.t3Home?.trim();
  const userId = yield* HostProcess.UserId;
  const resolveAddress = (stateSubdirectory: "userdata" | "dev") =>
    resolveDesktopAppControlAddress({
      stateDir: path.join(baseDir, stateSubdirectory),
      platform: hostPlatform,
      tempDir: NodeOS.tmpdir(),
      userId,
      joinPath: path.join,
    });
  const random = yield* SecureRandom.SecureRandom;
  const requestId = yield* random.uuidV4();
  const request = input.makeRequest(
    { version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION, requestId, platform: hostPlatform },
    { agentThreadId: environment.agentThreadId },
  );
  const address = resolveAddress("userdata");
  const fallbackAddress = allowDevFallback ? resolveAddress("dev") : undefined;

  const response = yield* Effect.tryPromise({
    try: () =>
      sendDesktopAppActivationRequest({
        address,
        userId,
        ...(fallbackAddress === undefined ? {} : { fallbackAddress }),
        request,
      }),
    catch: (cause) =>
      new DesktopAppUnreachableError({
        candidateAddresses:
          fallbackAddress === undefined
            ? [address.address]
            : [address.address, fallbackAddress.address],
        requestId: request.requestId,
        workspaceRoot: input.workspaceRoot,
        cause,
      }),
  });
  return response;
});

const runAppCommand = Effect.fn("cli.app")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly workspaceRoot: Option.Option<string>;
}) {
  const path = yield* Path.Path;
  const rawWorkspaceRoot =
    Option.getOrUndefined(flags.workspaceRoot) ?? (yield* HostProcess.WorkingDirectory);
  const workspaceRoot = path.resolve(yield* expandHomePath(rawWorkspaceRoot));
  const response = yield* sendToDesktopApp({
    baseDir: flags.baseDir,
    workspaceRoot,
    makeRequest: (base) => ({ ...base, type: "open-workspace", workspaceRoot }),
  });
  if (!response.ok) {
    return yield* new DesktopAppRequestFailedError({
      code: response.code,
      requestId: response.requestId,
      workspaceRoot,
      cause: response,
    });
  }

  yield* Console.log(`Opened ${workspaceRoot} in T3 Code.`);
});

/** A bare name runs `<T3 home>/userdata/scripts/<name>.ts` in the app; anything else is a file. */
const readScriptArgument = Effect.fn("cli.app.run.readScript")(function* (argument: string) {
  if (isAppScriptName(argument)) {
    return { kind: "name", name: argument } as const;
  }
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const scriptPath = path.resolve(yield* expandHomePath(argument));
  const failure = (reason: AppScriptLoadError["reason"], detail?: string) =>
    new AppScriptLoadError({
      reason,
      path: scriptPath,
      ...(detail === undefined ? {} : { detail }),
    });
  const info = yield* fileSystem
    .stat(scriptPath)
    .pipe(
      Effect.mapError((error) =>
        failure(error.reason._tag === "NotFound" ? "not-found" : "read-failed"),
      ),
    );
  if (info.type !== "File") return yield* failure("not-found");
  if (Number(info.size) > MAX_APP_SCRIPT_SOURCE_BYTES) return yield* failure("too-large");
  const source = yield* fileSystem
    .readFileString(scriptPath)
    .pipe(Effect.mapError(() => failure("read-failed")));
  const code = yield* Effect.try({
    try: () => stripAppScriptTypes(source),
    catch: (cause) =>
      failure("invalid-typescript", cause instanceof Error ? cause.message : String(cause)),
  });
  return { kind: "code", label: path.basename(scriptPath), code } as const;
});

const runAppScriptCommand = Effect.fn("cli.app.run")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly script: string;
}) {
  const script = yield* readScriptArgument(flags.script);
  const label = script.kind === "name" ? script.name : script.label;
  const response = yield* sendToDesktopApp({
    baseDir: flags.baseDir,
    workspaceRoot: label,
    makeRequest: (base, { agentThreadId }) => ({
      ...base,
      type: "run-script",
      script,
      ...(agentThreadId === undefined ? {} : { agentThreadId }),
    }),
  });
  if (!response.ok) {
    return yield* new DesktopAppScriptFailedError({
      code: response.code,
      requestId: response.requestId,
      script: label,
      detail: response.message,
    });
  }
  if ("output" in response && response.output !== null) yield* Console.log(response.output);
});

const appRunCommand = Command.make("run", {
  baseDir: baseDirFlag,
  script: Argument.String("script").pipe(
    Argument.withDescription(
      "A script name from the scripts folder in T3 Code's data folder, or a .ts file path.",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Run an app script in the T3 Code desktop window. Off unless enabled in Settings → HomuCode → Interface → App scripts.",
  ),
  Command.withHandler(runAppScriptCommand),
);

export const appCommand = Command.make("app", {
  baseDir: baseDirFlag,
  workspaceRoot: Argument.String("path").pipe(
    Argument.withDescription("Project directory. Default: current directory."),
    Argument.optional,
  ),
}).pipe(
  Command.withDescription("Open a project in the running T3 Code desktop app."),
  Command.withHandler(runAppCommand),
  Command.withSubcommands([appRunCommand]),
);
