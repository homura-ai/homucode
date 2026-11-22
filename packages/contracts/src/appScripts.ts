import * as Schema from "effect/Schema";

import { AppScriptName } from "./keybindings.ts";

export const AppScriptLoadInput = Schema.Struct({ name: AppScriptName });
export type AppScriptLoadInput = typeof AppScriptLoadInput.Type;

export const AppScriptLoadResult = Schema.Struct({
  /** JavaScript with the TypeScript types removed. */
  code: Schema.String,
  path: Schema.String,
});
export type AppScriptLoadResult = typeof AppScriptLoadResult.Type;

export class AppScriptLoadError extends Schema.TaggedError<AppScriptLoadError>()(
  "AppScriptLoadError",
  {
    reason: Schema.Literals(["not-found", "too-large", "invalid-typescript", "read-failed"]),
    path: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return `No app script at ${this.path}.`;
      case "too-large":
        return `The app script at ${this.path} is larger than 48 KB.`;
      case "invalid-typescript":
        return `Could not read the TypeScript in ${this.path}: ${this.detail ?? "invalid syntax"}`;
      case "read-failed":
        return `Could not read ${this.path}.`;
    }
  }
}

export const MAX_APP_SCRIPT_SOURCE_BYTES = 48 * 1024;
export const APP_SCRIPTS_DIRECTORY_NAME = "scripts";
export const APP_SCRIPT_TYPES_FILE_NAME = "t3.d.ts";

/**
 * Written beside the scripts as `t3.d.ts`. Keep it in step with the API the web client builds
 * (`apps/web/src/appScripts/appScriptApi.ts`); a test there checks each member is declared.
 */
export const APP_SCRIPT_TYPE_DEFINITIONS = `// Written by T3 Code. Reference it from a script for editor autocomplete:
//   /// <reference path="./t3.d.ts" />
//   export default async (t3: T3App) => { ... };

interface T3Project {
  readonly id: string;
  readonly environmentId: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

interface T3Thread {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: string;
}

interface T3NewThreadOptions {
  /** Text to put in the composer. It is not sent. */
  readonly prompt?: string;
  /** A model slug from the model picker, such as "claude-opus-5-5". */
  readonly model?: string;
}

interface T3App {
  /** Runs a keybinding command, such as "terminal.toggle", as if its shortcut were pressed. */
  command(command: string): Promise<void>;
  /** The project and thread on screen. */
  current(): { readonly project: T3Project | null; readonly thread: T3Thread | null };
  /** Projects this window knows about, archived ones left out. */
  projects(): T3Project[];
  /** Threads this window knows about, optionally for one project. Archived ones are left out. */
  threads(projectId?: string): T3Thread[];
  /** Shows a thread. */
  openThread(threadId: string): Promise<void>;
  /** Opens a new-thread composer for a project, by id or folder path. */
  newThread(project: string, options?: T3NewThreadOptions): Promise<void>;
  /** Sends a message to a thread. A busy thread queues it until its current turn ends. */
  send(threadId: string, text: string): Promise<void>;
  /** Shows a short notice in the window. */
  toast(title: string, description?: string): void;
}
`;

export type AppScriptRunSource = "keybinding" | "terminal";

interface AppScriptGates {
  readonly appScriptsEnabled: boolean;
  readonly appScriptsFromTerminal: boolean;
  readonly appScriptsFromAgents: boolean;
}

/** Why this device's settings refuse a run, or null when every gate it needs is on. */
export function appScriptRunRefusal(
  gates: AppScriptGates | null,
  input: { readonly source: AppScriptRunSource; readonly fromAgent: boolean },
): string | null {
  if (gates?.appScriptsEnabled !== true) {
    return "App scripts are off. Turn them on in Settings → HomuCode → Interface → App scripts on this device.";
  }
  if (input.source === "terminal" && !gates.appScriptsFromTerminal) {
    return "Running app scripts from a terminal is off. Turn it on in Settings → HomuCode → Interface → App scripts.";
  }
  if (input.fromAgent && !gates.appScriptsFromAgents) {
    return "Agents may not run app scripts. Allow it in Settings → HomuCode → Interface → App scripts.";
  }
  return null;
}
