import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";

export function isAutomaticCompletionRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

export function queuedMessageHeadForSteering(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  targetRunId: OrchestrationV2Run["id"],
): OrchestrationV2Run | undefined {
  const ordered = queuedRunsInDeliveryOrder(projection);
  const head = ordered[0];
  if (head === undefined || !isAutomaticCompletionRun(projection, head)) return head;

  const candidate = ordered.find((run) => !isAutomaticCompletionRun(projection, run));
  const message = projection.messages.find((message) => message.id === candidate?.userMessageId);
  const target = projection.runs.find((run) => run.id === targetRunId);
  return candidate !== undefined &&
    target !== undefined &&
    message?.attachments.length === 0 &&
    message.followsThreadSelection !== true &&
    modelSelectionsEqual(candidate.modelSelection, target.modelSelection)
    ? candidate
    : head;
}

export function queuedRunsInDeliveryOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): ReadonlyArray<OrchestrationV2Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  const queued = projection.runs
    .filter((run) => run.status === "queued")
    .toSorted(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    );
  const completions = queued.filter((run) => automaticCompletionMessageIds.has(run.userMessageId));
  const messages = queued.filter((run) => !automaticCompletionMessageIds.has(run.userMessageId));
  // Completions and messages each keep their queue order and interleave by request time,
  // so neither kind can hold the other back while more of it keeps arriving.
  const ordered: Array<OrchestrationV2Run> = [];
  let completionIndex = 0;
  let messageIndex = 0;
  for (;;) {
    const completion = completions[completionIndex];
    const message = messages[messageIndex];
    if (completion === undefined || message === undefined) {
      return [...ordered, ...completions.slice(completionIndex), ...messages.slice(messageIndex)];
    }
    if (
      DateTime.toEpochMillis(completion.requestedAt) <= DateTime.toEpochMillis(message.requestedAt)
    ) {
      ordered.push(completion);
      completionIndex += 1;
    } else {
      ordered.push(message);
      messageIndex += 1;
    }
  }
}
