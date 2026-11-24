import { parseStatusLineTargetRate } from "@t3tools/client-runtime/status-line";
import type { StatusLineRateEstimator } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { DraftInput } from "../ui/draft-input";

export function StatusLineEstimatorControl(props: {
  readonly value: StatusLineRateEstimator | undefined;
  readonly label: string;
  readonly defaultMinutes: number;
  readonly allowDefault?: boolean;
  readonly onChange: (value: StatusLineRateEstimator | undefined) => void;
}) {
  const gt = useGT();
  const { value } = props;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label={props.label}
        className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm"
        value={value?.kind ?? ""}
        onChange={(event) => {
          switch (event.currentTarget.value) {
            case "ema":
              props.onChange({ kind: "ema" });
              break;
            case "sliding":
              props.onChange({ kind: "sliding", minutes: props.defaultMinutes });
              break;
            case "reset":
              props.onChange({ kind: "reset" });
              break;
            default:
              props.onChange(undefined);
          }
        }}
      >
        {value === undefined || props.allowDefault ? (
          <option value="" disabled={!props.allowDefault}>
            {props.allowDefault ? gt("Default") : gt("Mixed")}
          </option>
        ) : null}
        <option value="ema">{gt("Exponential moving average")}</option>
        <option value="sliding">{gt("Sliding window")}</option>
        <option value="reset">{gt("Since last reset")}</option>
      </select>
      {value?.kind !== "sliding" ? null : (
        <DraftInput
          size="sm"
          className="w-24"
          inputMode="decimal"
          aria-label={gt("Sliding window (minutes)")}
          value={String(value.minutes)}
          normalizeDraft={(previous, next) => {
            const parsed = parseStatusLineTargetRate(next);
            return parsed == null ? previous : String(parsed);
          }}
          onCommit={(next) => {
            const minutes = parseStatusLineTargetRate(next);
            if (minutes != null) props.onChange({ kind: "sliding", minutes });
          }}
        />
      )}
    </div>
  );
}
