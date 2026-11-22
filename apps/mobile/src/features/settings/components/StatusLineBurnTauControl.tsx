import {
  formatStatusLineSpan,
  parseStatusLineBurnTau,
  STATUS_LINE_BURN_TAU_PRESETS,
  type StatusLineBurnTauKey,
} from "@t3tools/client-runtime/status-line";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Menu } from "../../../components/ui/Menu";

export function StatusLineBurnTauControl(props: {
  readonly setting: StatusLineBurnTauKey;
  readonly value: number | null;
  readonly disabled?: boolean;
  readonly onChange: (minutes: number) => void;
}) {
  const gt = useGT();
  const [custom, setCustom] = useState(false);
  const [inputVersion, setInputVersion] = useState(0);
  const presets: readonly number[] = STATUS_LINE_BURN_TAU_PRESETS[props.setting];
  const isCustom = custom || (props.value !== null && !presets.includes(props.value));
  const label =
    props.setting === "statusLineSessionBurnTauMinutes"
      ? gt("5-hour burn-rate smoothing")
      : gt("Weekly burn-rate smoothing");
  const value = props.value === null ? gt("Mixed") : formatStatusLineSpan(props.value * 60_000);
  const trigger = (
    <View className="flex-row items-center justify-between gap-3 rounded-lg bg-subtle px-3 py-2">
      <Text className="shrink text-sm">{label}</Text>
      <Text className="shrink-0 text-xs text-foreground-muted">{value}</Text>
    </View>
  );
  return (
    <View className="gap-2">
      {props.disabled ? (
        trigger
      ) : (
        <Menu
          title={label}
          accessibilityLabel={`${label}, ${value}`}
          actions={[
            ...presets.map((minutes) => ({
              id: String(minutes),
              title: formatStatusLineSpan(minutes * 60_000),
              state: minutes === props.value && !isCustom ? ("on" as const) : ("off" as const),
            })),
            {
              id: "custom",
              title: gt("Custom", { $context: "custom burn-rate smoothing duration" }),
              state: isCustom ? ("on" as const) : ("off" as const),
            },
          ]}
          onPressAction={({ nativeEvent }) => {
            setCustom(nativeEvent.event === "custom");
            const minutes = parseStatusLineBurnTau(nativeEvent.event);
            if (minutes !== null) props.onChange(minutes);
          }}
        >
          {trigger}
        </Menu>
      )}
      {isCustom ? (
        <TextInput
          key={`${props.value}:${inputVersion}`}
          accessibilityLabel={gt("{setting} in minutes", { setting: label })}
          defaultValue={props.value == null ? "" : String(props.value)}
          className="rounded-lg bg-subtle px-3 py-2 text-foreground"
          keyboardType="decimal-pad"
          editable={!props.disabled}
          onEndEditing={({ nativeEvent }) => {
            const minutes = parseStatusLineBurnTau(nativeEvent.text);
            if (minutes === null) setInputVersion((version) => version + 1);
            else if (minutes !== props.value) props.onChange(minutes);
          }}
        />
      ) : null}
    </View>
  );
}
