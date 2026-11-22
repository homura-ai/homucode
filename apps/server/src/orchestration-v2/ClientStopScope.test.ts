import { CommandId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withClientStopReason, withClientStopScope } from "./ClientStopScope.ts";

const threadId = ThreadId.make("thread");
const commandId = CommandId.make("command");
const runId = RunId.make("run");

describe("withClientStopScope", () => {
  it("uses the cascade preference while preserving explicit stop scope", () => {
    const command = { type: "thread.stop", commandId, threadId } as const;
    expect(withClientStopScope(command, true)).toEqual({
      ...command,
      leaveSubagentsRunning: false,
    });
    const explicit = { ...command, leaveSubagentsRunning: true };
    expect(withClientStopScope(explicit, true)).toBe(explicit);
    expect(withClientStopScope({ ...command, stopDelegatedTasks: true }, false)).toEqual({
      ...command,
      stopDelegatedTasks: true,
    });
  });

  it("makes an app's Stop leave subagents running, as older phones send it", () => {
    expect(withClientStopScope({ type: "thread.stop", commandId, threadId })).toEqual({
      type: "thread.stop",
      commandId,
      threadId,
      leaveSubagentsRunning: true,
    });
    expect(
      withClientStopScope({ type: "run.interrupt", commandId, threadId, runId, holdQueue: true }),
    ).toEqual({
      type: "run.interrupt",
      commandId,
      threadId,
      runId,
      holdQueue: true,
      leaveSubagentsRunning: true,
    });
  });

  it("turns a /stopall message into a Stop that takes the subagents too", () => {
    const message = (text: string, attachments: ReadonlyArray<never> = []) =>
      ({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId: MessageId.make("message"),
        text,
        attachments,
        createdBy: "user",
        creationSource: "mobile",
        dispatchMode: { type: "start_immediately" },
      }) as const;
    expect(withClientStopScope(message("  /StopAll "))).toEqual({
      type: "thread.stop",
      commandId,
      threadId,
      stopDelegatedTasks: true,
    });
    const other = message("/stopall please");
    expect(withClientStopScope(other)).toBe(other);
  });

  it("keeps an explicit choice and leaves plain interrupts alone", () => {
    const cascade = { type: "thread.stop", commandId, threadId, stopDelegatedTasks: true } as const;
    expect(withClientStopScope(cascade)).toBe(cascade);
    const walk = { type: "thread.stop", commandId, threadId, stopDelegatedTasks: false } as const;
    expect(withClientStopScope(walk)).toBe(walk);
    const interrupt = { type: "run.interrupt", commandId, threadId, runId } as const;
    expect(withClientStopScope(interrupt)).toBe(interrupt);
  });

  it("names who sent a Stop from the socket, not from what the client claims", () => {
    const stop = {
      type: "thread.stop",
      commandId,
      threadId,
      reason: "Stopped by an agent",
    } as const;
    expect(withClientStopReason(stop, { surface: "desktop" })).toEqual({
      ...stop,
      reason: "Stopped by a human",
    });
    const interrupt = { type: "run.interrupt", commandId, threadId, runId } as const;
    expect(withClientStopReason(interrupt, { surface: "cli" })).toEqual({
      ...interrupt,
      reason: "Stopped by an unknown sender",
    });
    expect(withClientStopReason(interrupt, undefined)).toEqual({
      ...interrupt,
      reason: "Stopped by an unknown sender",
    });
  });
});
