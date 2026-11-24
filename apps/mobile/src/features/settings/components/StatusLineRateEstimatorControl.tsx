import { parseStatusLineBurnTau } from "@t3tools/client-runtime/status-line";
import type { StatusLineRateEstimator } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Menu } from "../../../components/ui/Menu";

export const STATUS_LINE_INPUT_CLASS = "min-h-10 rounded-lg bg-subtle px-3 py-2 text-foreground";

export interface StatusLineChoice<T extends string = string> {
  readonly id: T;
  readonly title: string;
}

export function StatusLineChoiceMenu<T extends string>(props: {
  readonly label: string;
  readonly placeholder: string;
  readonly choices: readonly StatusLineChoice<T>[];
  readonly selected: readonly T[];
  readonly disabled: boolean;
  readonly onSelect: (id: T) => void;
}) {
  const value = props.selected
    .map((id) => props.choices.find((choice) => choice.id === id)?.title ?? id)
    .join(", ");
  const trigger = (
    <View className={STATUS_LINE_INPUT_CLASS}>
      <Text className="text-sm">{props.label}</Text>
      <Text className="text-xs text-foreground-muted">{value || props.placeholder}</Text>
    </View>
  );
  return props.disabled || props.choices.length === 0 ? (
    trigger
  ) : (
    <Menu
      title={props.label}
      accessibilityLabel={`${props.label}, ${value || props.placeholder}`}
      actions={props.choices.map(({ id, title }) => ({
        id,
        title,
        state: props.selected.includes(id) ? "on" : "off",
      }))}
      onPressAction={({ nativeEvent }) => {
        const choice = props.choices.find(({ id }) => id === nativeEvent.event);
        if (choice) props.onSelect(choice.id);
      }}
    >
      {trigger}
    </Menu>
  );
}

export function StatusLineSlidingMinutesInput(props: {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChangeText?: ((text: string) => void) | undefined;
  readonly onCommit?: ((text: string) => void) | undefined;
}) {
  const gt = useGT();
  const label = gt("Sliding window (minutes)");
  return (
    <View className="gap-1">
      <Text className="text-sm">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        className={STATUS_LINE_INPUT_CLASS}
        keyboardType="decimal-pad"
        editable={!props.disabled}
        {...(props.onChangeText === undefined
          ? { defaultValue: props.value }
          : { value: props.value, onChangeText: props.onChangeText })}
        onEndEditing={({ nativeEvent }) => props.onCommit?.(nativeEvent.text)}
      />
    </View>
  );
}

type EstimatorKind = StatusLineRateEstimator["kind"];

export function StatusLineEstimatorMenu(props: {
  readonly label: string;
  readonly kind: EstimatorKind | "default" | null;
  readonly optional?: boolean;
  readonly disabled: boolean;
  readonly onSelect: (kind: EstimatorKind | "default") => void;
}) {
  const gt = useGT();
  const choices: StatusLineChoice<EstimatorKind | "default">[] = [
    { id: "ema", title: gt("Exponential moving average") },
    { id: "sliding", title: gt("Sliding window") },
    { id: "reset", title: gt("Since last reset") },
  ];
  if (props.optional) choices.unshift({ id: "default", title: gt("Default") });
  return (
    <StatusLineChoiceMenu
      label={props.label}
      placeholder={gt("Mixed")}
      choices={choices}
      selected={props.kind === null ? [] : [props.kind]}
      disabled={props.disabled}
      onSelect={props.onSelect}
    />
  );
}

export function StatusLineRateEstimatorControl(props: {
  readonly label: string;
  readonly value: StatusLineRateEstimator | null;
  readonly defaultMinutes: number;
  readonly disabled: boolean;
  readonly onChange: (estimator: StatusLineRateEstimator) => Promise<boolean>;
}) {
  const [revision, setRevision] = useState(0);
  const minutes = props.value?.kind === "sliding" ? props.value.minutes : null;
  return (
    <View className="gap-2">
      <StatusLineEstimatorMenu
        label={props.label}
        kind={props.value?.kind ?? null}
        disabled={props.disabled}
        onSelect={(kind) => {
          if (kind === "default" || kind === props.value?.kind) return;
          void props.onChange(
            kind === "sliding" ? { kind, minutes: props.defaultMinutes } : { kind },
          );
        }}
      />
      {minutes !== null ? (
        <StatusLineSlidingMinutesInput
          key={`${minutes}:${revision}`}
          value={String(minutes)}
          disabled={props.disabled}
          onCommit={(text) => {
            if (props.disabled) return;
            const next = parseStatusLineBurnTau(text);
            if (next === null) setRevision((value) => value + 1);
            else if (next !== minutes) {
              void props.onChange({ kind: "sliding", minutes: next }).then((saved) => {
                if (!saved) setRevision((value) => value + 1);
              });
            }
          }}
        />
      ) : null}
    </View>
  );
}

export function statusLineEstimatorKey(estimator: StatusLineRateEstimator): string {
  return estimator.kind === "sliding" ? `${estimator.kind}:${estimator.minutes}` : estimator.kind;
}
