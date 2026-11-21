import {
  formatStatusLineSpan,
  parseStatusLineBurnTau,
  STATUS_LINE_BURN_TAU_PRESETS,
  type StatusLineBurnTauKey,
} from "@t3tools/client-runtime/status-line";
import { useGT } from "gt-react";
import { useState } from "react";

import { DraftInput } from "../ui/draft-input";

export function StatusLineBurnTauControl(props: {
  readonly setting: StatusLineBurnTauKey;
  readonly value: number | null;
  readonly disabled?: boolean;
  readonly showLabel?: boolean;
  readonly onChange: (value: number) => void;
}) {
  const gt = useGT();
  const [custom, setCustom] = useState(false);
  const presets: readonly number[] = STATUS_LINE_BURN_TAU_PRESETS[props.setting];
  const isCustom = custom || (props.value !== null && !presets.includes(props.value));
  const label =
    props.setting === "statusLineSessionBurnTauMinutes"
      ? gt("5-hour burn-rate smoothing")
      : gt("Weekly burn-rate smoothing");
  return (
    <div className="flex flex-wrap items-center gap-2">
      {props.showLabel ? <span className="text-xs text-muted-foreground">{label}</span> : null}
      <select
        aria-label={label}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
        disabled={props.disabled}
        value={isCustom ? "custom" : (props.value ?? "")}
        onChange={(event) => {
          const selected = event.currentTarget.value;
          setCustom(selected === "custom");
          const minutes = parseStatusLineBurnTau(selected);
          if (minutes !== null) props.onChange(minutes);
        }}
      >
        {props.value === null ? (
          <option value="" disabled>
            {gt("Mixed")}
          </option>
        ) : null}
        {presets.map((minutes) => (
          <option key={minutes} value={minutes}>
            {formatStatusLineSpan(minutes * 60_000)}
          </option>
        ))}
        <option value="custom">
          {gt("Custom", { $context: "custom burn-rate smoothing duration" })}
        </option>
      </select>
      {isCustom ? (
        <DraftInput
          size="sm"
          className="w-24"
          inputMode="decimal"
          value={props.value == null ? "" : String(props.value)}
          aria-label={gt("{setting} in minutes", { setting: label })}
          disabled={props.disabled}
          normalizeDraft={(previous, next) => {
            const minutes = parseStatusLineBurnTau(next);
            return minutes === null ? previous : String(minutes);
          }}
          onCommit={(next) => {
            const minutes = parseStatusLineBurnTau(next);
            if (minutes !== null) props.onChange(minutes);
          }}
        />
      ) : null}
    </div>
  );
}
