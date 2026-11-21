import {
  STATUS_LINE_EFFORT_COLORS,
  statusLineColorMix,
  statusLineEffortPosition,
} from "@t3tools/client-runtime/status-line";

function oklabMix(from: string, to: string, amount: number): string {
  return `color-mix(in oklab, ${from}, ${to} ${amount * 100}%)`;
}

export function statusUsedColor(percent: number): string {
  return statusLineColorMix(
    percent,
    ["var(--success-foreground)", "var(--warning-foreground)", "var(--error-foreground)"],
    oklabMix,
  );
}

export function statusEffortColor(effort: string): string | undefined {
  const position = statusLineEffortPosition(effort);
  if (position === undefined) return undefined;
  const colors = STATUS_LINE_EFFORT_COLORS.map(([light, dark]) => `light-dark(${light}, ${dark})`);
  return statusLineColorMix(position, [colors[0]!, colors[1]!, ...colors.slice(2)], oklabMix);
}
