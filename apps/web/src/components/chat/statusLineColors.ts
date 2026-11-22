import {
  STATUS_LINE_EFFORT_COLORS,
  statusLineColorMix,
  statusLineEffortPosition,
  statusLineUsageHue,
} from "@t3tools/client-runtime/status-line";
import { statusLineUsageColor } from "@t3tools/shared/themeColors";

function oklabMix(from: string, to: string, amount: number): string {
  return `color-mix(in oklab, ${from}, ${to} ${amount * 100}%)`;
}

export function statusCacheColor(percent: number): string {
  return `hsl(from var(--success-foreground) ${statusLineUsageHue(percent)} s l)`;
}

export function statusDialColor(percent: number, role: "ring" | "text"): string {
  return `light-dark(${statusLineUsageColor(percent, "light", role)}, ${statusLineUsageColor(percent, "dark", role)})`;
}

export function statusEffortColor(effort: string): string | undefined {
  const position = statusLineEffortPosition(effort);
  if (position === undefined) return undefined;
  const colors = STATUS_LINE_EFFORT_COLORS.map(([light, dark]) => `light-dark(${light}, ${dark})`);
  return statusLineColorMix(position, [colors[0]!, colors[1]!, ...colors.slice(2)], oklabMix);
}
