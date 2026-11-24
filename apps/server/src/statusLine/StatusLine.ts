import {
  StatusLineMetricValues,
  type StatusLineRenderInput,
  type StatusLineRenderResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BUILT_IN_STATUS_LINE_SCRIPT } from "./builtInScript.ts";

const TIMEOUT = "5 seconds";
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_ERROR_LENGTH = 500;

export class StatusLine extends Context.Service<
  StatusLine,
  {
    /** Runs the configured status line command with Claude Code's JSON on stdin. */
    readonly render: (input: StatusLineRenderInput) => Effect.Effect<StatusLineRenderResult>;
  }
>()("t3/statusLine/StatusLine") {}

const invocation = Effect.fnUntraced(function* (command: string) {
  if (command === "") return { command: "bash", args: ["-c", BUILT_IN_STATUS_LINE_SCRIPT] };
  if ((yield* HostProcess.Platform) === "win32") {
    const comSpec = (yield* HostProcess.Environment).ComSpec;
    return { command: comSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { command: "/bin/sh", args: ["-c", command] };
});

function workspaceDirectory(input: StatusLineRenderInput["input"]): string | null {
  const workspace = input.workspace;
  const dir =
    typeof workspace === "object" && workspace !== null && "current_dir" in workspace
      ? workspace.current_dir
      : input.cwd;
  return typeof dir === "string" && dir !== "" ? dir : null;
}

function lastLines(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_ERROR_LENGTH ? trimmed.slice(-MAX_ERROR_LENGTH) : trimmed;
}

const encodeInput = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeMetrics = Schema.decodeEffect(Schema.fromJsonString(StatusLineMetricValues));

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;

  const render = Effect.fn("StatusLine.render")(function* ({ input, mode }: StatusLineRenderInput) {
    const current = yield* settings.getSettings.pipe(Effect.option);
    if (current._tag === "None" || !current.value.statusLineEnabled) return { text: "" };
    const metrics = mode === "metrics";
    const command = metrics
      ? current.value.statusLineMetricsCommand
      : current.value.statusLineCommand;
    const anchorCommands = metrics
      ? current.value.statusLineCustomBars.flatMap((bar) =>
          bar.visible && bar.source.type === "usage" && bar.source.window.kind === "command"
            ? [{ id: bar.id, command: bar.source.window.command }]
            : [],
        )
      : [];
    if (metrics && command === "" && anchorCommands.length === 0) return { text: "" };
    const requested = workspaceDirectory(input);
    const isDirectory =
      requested === null
        ? false
        : yield* fs.stat(requested).pipe(
            Effect.map((info) => info.type === "Directory"),
            Effect.orElseSucceed(() => false),
          );
    const stdin = yield* encodeInput(input).pipe(Effect.orElseSucceed(() => "{}"));
    const cwd = isDirectory && requested !== null ? requested : yield* HostProcess.HomeDirectory;
    const run = Effect.fnUntraced(function* (shellCommand: string) {
      const spawn = yield* invocation(shellCommand);
      return yield* runner
        .run({
          ...spawn,
          cwd,
          stdin,
          ignoreStdinErrors: true,
          timeout: TIMEOUT,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          outputMode: "truncate",
        })
        .pipe(
          Effect.map((output) => {
            const text = output.stdout.trimEnd();
            return output.code === 0
              ? { text }
              : {
                  text,
                  error: lastLines(output.stderr) || `Exited with code ${String(output.code)}`,
                };
          }),
          Effect.catch((error) => Effect.succeed({ text: "", error: error.message })),
        );
    });
    if (!metrics) return yield* run(command);

    const [metricResult, anchors] = yield* Effect.all(
      [
        command === ""
          ? Effect.succeed({ text: "" } satisfies StatusLineRenderResult)
          : run(command).pipe(
              Effect.flatMap((result): Effect.Effect<StatusLineRenderResult> =>
                result.error
                  ? Effect.succeed({ text: "", error: result.error })
                  : decodeMetrics(result.text).pipe(
                      Effect.map((metrics) => ({ text: "", metrics })),
                      Effect.orElseSucceed(() => ({
                        text: "",
                        error: "Invalid status line metrics JSON",
                      })),
                    ),
              ),
            ),
        Effect.forEach(
          anchorCommands,
          ({ id, command }) =>
            Effect.gen(function* () {
              const result = yield* run(command);
              const timestamp = Date.parse(result.text.trim());
              return !result.error && Number.isFinite(timestamp)
                ? [[id, DateTime.formatIso(DateTime.makeUnsafe(timestamp))] as const]
                : [];
            }),
          { concurrency: 4 },
        ),
      ],
      { concurrency: 2 },
    );
    return {
      ...metricResult,
      ...(anchors.some((entry) => entry.length > 0)
        ? { customStarts: Object.fromEntries(anchors.flat()) }
        : {}),
    };
  });

  return StatusLine.of({ render });
});

export const layer = Layer.effect(StatusLine, make);
