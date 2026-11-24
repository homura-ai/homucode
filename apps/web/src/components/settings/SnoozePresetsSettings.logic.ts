import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import { resolveSnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import * as Equal from "effect/Equal";

/**
 * Reads a server value against the editor's writes still in flight. Matching one acknowledges
 * it and every earlier write; anything else came from elsewhere and replaces the draft.
 */
export function reconcileSnoozeDraft<T>(
  pending: ReadonlyArray<T>,
  saved: T,
): { readonly adopt: true } | { readonly adopt: false; readonly pending: ReadonlyArray<T> } {
  const acknowledged = pending.findIndex((snapshot) => Equal.equals(snapshot, saved));
  return acknowledged === -1
    ? { adopt: true }
    : { adopt: false, pending: pending.slice(acknowledged + 1) };
}

/**
 * Orders editor rows the way the menu lists them: soonest wake first, with options that
 * have no wake right now (a passed "Today") last. Ties keep their current order.
 */
export function sortSnoozeRows<K>(
  presets: ReadonlyArray<SnoozePresetSetting>,
  keys: ReadonlyArray<K>,
  now: Date,
): { readonly presets: ReadonlyArray<SnoozePresetSetting>; readonly keys: ReadonlyArray<K> } {
  const order = presets
    .map((preset, index) => {
      const resolved = resolveSnoozePreset(preset, now);
      return { index, wake: resolved ? Date.parse(resolved.snoozedUntil) : Infinity };
    })
    .toSorted((a, b) => a.wake - b.wake);
  return {
    presets: order.map(({ index }) => presets[index]!),
    keys: order.map(({ index }) => keys[index]!),
  };
}
