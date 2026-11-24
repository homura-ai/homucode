import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  isManagedSettingPath,
  type ServerSettingsPatch,
  type StatusLineCustomBar,
  type StatusLineRateEstimator,
} from "@t3tools/contracts";
import {
  buildStatusLineModelUsage,
  orderStatusLineBars,
  parseStatusLineBurnTau,
  parseStatusLineTargetRate,
} from "@t3tools/client-runtime/status-line";
import { statusLineAccountKey } from "@t3tools/shared/usageLimits";
import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { Menu } from "../../../components/ui/Menu";
import { ThemedSwitch } from "../../../components/ui/ThemedSwitch";
import { useNowMinuteMs } from "../../../lib/clock";
import { uuidv4 } from "../../../lib/uuid";
import { serverEnvironment } from "../../../state/server";
import { readEnvironmentScope } from "../../../state/session";
import {
  planMobileScopedSettingsPatch,
  type ScopedMobileSettingsTarget,
} from "../settings-scoped-server";
import { useSettingsWriter } from "../useSettingsWriter";
import { SettingsSection } from "./SettingsSection";
import {
  STATUS_LINE_INPUT_CLASS as INPUT_CLASS,
  StatusLineChoiceMenu,
  StatusLineEstimatorMenu,
  StatusLineSlidingMinutesInput,
} from "./StatusLineRateEstimatorControl";
import {
  parseStatusLineUsageDraft,
  statusLineUsageDraft,
  StatusLineUsageEditor,
  statusLineUsageOptions,
} from "./StatusLineUsageEditor";

type QuotaSource = Extract<StatusLineCustomBar["source"], { type: "quota" }>;

function quotaKey(source: QuotaSource) {
  return JSON.stringify([source.providerInstanceId, source.limitId]);
}

interface QuotaOption {
  readonly source: QuotaSource;
  readonly title: string;
}

export function StatusLineTargetRateControl(props: {
  readonly label: string;
  readonly value: number | null;
  readonly mixed: boolean;
  readonly disabled: boolean;
  readonly onChange: (rate: number | null) => Promise<boolean>;
}) {
  const gt = useGT();
  const changed = useRef(false);
  const [revision, setRevision] = useState(0);
  return (
    <View className="gap-2">
      <Text className="text-sm">{props.label}</Text>
      <TextInput
        key={`${props.value}:${props.mixed}:${revision}`}
        accessibilityLabel={props.label}
        placeholder={props.mixed ? gt("Mixed") : gt("Default")}
        defaultValue={props.value === null ? "" : String(props.value)}
        className={INPUT_CLASS}
        keyboardType="decimal-pad"
        editable={!props.disabled}
        onChangeText={() => {
          changed.current = true;
        }}
        onEndEditing={({ nativeEvent }) => {
          if (!changed.current) return;
          changed.current = false;
          if (props.disabled) return;
          const rate = parseStatusLineTargetRate(nativeEvent.text);
          if (rate === undefined) setRevision((value) => value + 1);
          else if (rate !== props.value || props.mixed) {
            void props.onChange(rate).then((saved) => {
              if (!saved) setRevision((value) => value + 1);
            });
          }
        }}
      />
    </View>
  );
}

export function StatusLineCustomBarsSettings(props: {
  readonly target: ScopedMobileSettingsTarget;
  readonly canWrite: boolean;
}) {
  const gt = useGT();
  const nowMs = useNowMinuteMs();
  const writeSettings = useSettingsWriter();
  const writing = useRef(false);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<{ readonly bar: StatusLineCustomBar | null } | null>(null);
  const { target } = props;
  const config = target.environment.serverConfig;
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(target.environment.environmentId)) ?? [];
  const usageLimitSources = config.usageLimitSources ?? [];
  const {
    statusLineCustomBars: bars,
    statusLineMetricsCommand: command,
    statusLineBarOrder,
    statusLineAccountNames,
  } = target.settings;
  const canEditBars =
    props.canWrite && !isManagedSettingPath(config.managedPolicy, "statusLineCustomBars");
  const canEditCommand =
    props.canWrite && !isManagedSettingPath(config.managedPolicy, "statusLineMetricsCommand");
  const usageOptions = statusLineUsageOptions(
    { providers, usageLimitSources },
    statusLineAccountNames,
  );
  const options: QuotaOption[] = buildStatusLineModelUsage({
    providers,
    usageLimitSources,
    nowMs,
    statusLineAccountNames,
    statusLineSessionBurnTauMinutes: target.settings.statusLineSessionBurnTauMinutes,
    statusLineWeeklyBurnTauMinutes: target.settings.statusLineWeeklyBurnTauMinutes,
  }).flatMap((provider) =>
    provider.limits.map((limit) => ({
      source: { type: "quota", providerInstanceId: provider.instanceId, limitId: limit.id },
      title: [provider.name, limit.label, ...limit.scope].join(" · "),
    })),
  );
  const write = async (patch: ServerSettingsPatch) => {
    if (
      writing.current ||
      !readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope)
    )
      return false;
    writing.current = true;
    setPending(true);
    return writeSettings([target], planMobileScopedSettingsPatch([target], false, patch)).finally(
      () => {
        writing.current = false;
        setPending(false);
      },
    );
  };

  const canReorder =
    props.canWrite && !isManagedSettingPath(config.managedPolicy, "statusLineBarOrder");
  const canName =
    props.canWrite && !isManagedSettingPath(config.managedPolicy, "statusLineAccountNames");
  const barOrder = orderStatusLineBars(
    [
      { id: "session", label: gt("5-hour limit") },
      { id: "weekly", label: gt("Weekly limit") },
      ...bars.map((bar) => ({ id: `custom:${bar.id}`, label: bar.label })),
    ],
    statusLineBarOrder,
  );
  const move = (index: number, offset: number) => {
    const next = barOrder.map((item) => item.id);
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    void write({ statusLineBarOrder: next });
  };
  return (
    <SettingsSection
      title={gt("Custom status bars · {environment}", { environment: target.environment.label })}
    >
      <View className="gap-3 px-4 py-3">
        <View className="gap-2">
          <Text className="text-sm">{gt("Bar order")}</Text>
          {barOrder.map(({ id, label }, index) => (
            <View key={id} className="flex-row items-center justify-between gap-2">
              <Text className="min-w-0 shrink text-sm">{label}</Text>
              <View className="flex-row gap-2">
                <Button
                  label={gt("Up")}
                  size="compact"
                  tone="text"
                  disabled={pending || !canReorder || index === 0}
                  accessibilityLabel={gt("Move {label} up", { label })}
                  onPress={() => move(index, -1)}
                />
                <Button
                  label={gt("Down")}
                  size="compact"
                  tone="text"
                  disabled={pending || !canReorder || index === barOrder.length - 1}
                  accessibilityLabel={gt("Move {label} down", { label })}
                  onPress={() => move(index, 1)}
                />
              </View>
            </View>
          ))}
        </View>
        {(config.usageLimitSources ?? []).flatMap((hub) =>
          hub.accounts.map((account) => {
            const id = statusLineAccountKey(hub.id, account.id);
            const label = account.email ?? account.id;
            return (
              <View className="gap-1" key={id}>
                <Text className="text-sm">{label}</Text>
                <TextInput
                  className={INPUT_CLASS}
                  editable={!pending && canName}
                  defaultValue={statusLineAccountNames[id] ?? ""}
                  placeholder={gt("Account name")}
                  accessibilityLabel={gt("Account name for {label}", { label })}
                  onEndEditing={(event) => {
                    const value = event.nativeEvent.text.trim();
                    if (value === (statusLineAccountNames[id] ?? "")) return;
                    const next = { ...statusLineAccountNames };
                    if (value) next[id] = value;
                    else delete next[id];
                    void write({ statusLineAccountNames: next });
                  }}
                />
              </View>
            );
          }),
        )}
        <MetricsCommandControl
          key={command}
          command={command}
          disabled={pending || !canEditCommand}
          onSave={(value) => void write({ statusLineMetricsCommand: value })}
        />
        {bars.map((bar) => {
          const source = bar.source;
          let sourceDescription: string;
          switch (source.type) {
            case "metric":
              sourceDescription = gt("Metric key: {key}", { key: source.key });
              break;
            case "quota":
              sourceDescription =
                options.find((option) => quotaKey(option.source) === quotaKey(source))?.title ??
                gt("Quota source unavailable");
              break;
            case "usage":
              sourceDescription = gt("Grouped usage");
              break;
          }
          return (
            <View key={bar.id} className="gap-1 border-t border-border pt-3">
              <View className="flex-row items-center justify-between gap-3">
                <Text className="min-w-0 shrink font-t3-medium">{bar.label}</Text>
                <ThemedSwitch
                  value={bar.visible}
                  accessibilityLabel={gt("Show {label}", { label: bar.label })}
                  disabled={pending || !canEditBars}
                  onValueChange={(visible) =>
                    void write({
                      statusLineCustomBars: bars.map((item) =>
                        item.id === bar.id ? { ...item, visible } : item,
                      ),
                    })
                  }
                />
              </View>
              <View className="flex-row items-center justify-between gap-3">
                <Text className="text-sm">{gt("Quota pace")}</Text>
                <ThemedSwitch
                  value={bar.showQuotaPace}
                  accessibilityLabel={gt("Show quota pace for {label}", { label: bar.label })}
                  disabled={pending || !canEditBars}
                  onValueChange={(showQuotaPace) =>
                    void write({
                      statusLineCustomBars: bars.map((item) =>
                        item.id === bar.id ? { ...item, showQuotaPace } : item,
                      ),
                    })
                  }
                />
              </View>
              <Text className="text-xs text-foreground-muted">{sourceDescription}</Text>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label={gt("Edit")}
                  accessibilityLabel={gt("Edit {label}", { label: bar.label })}
                  size="compact"
                  disabled={pending || !canEditBars}
                  onPress={() => setEditing({ bar })}
                />
                <Button
                  label={gt("Remove")}
                  accessibilityLabel={gt("Remove {label}", { label: bar.label })}
                  size="compact"
                  tone="text"
                  disabled={pending || !canEditBars}
                  onPress={() => {
                    if (editing?.bar?.id === bar.id) setEditing(null);
                    void write({ statusLineCustomBars: bars.filter((item) => item.id !== bar.id) });
                  }}
                />
              </View>
            </View>
          );
        })}
        {editing === null ? (
          <Button
            label={gt("Add custom bar")}
            icon="plus"
            size="compact"
            disabled={pending || !canEditBars}
            onPress={() => setEditing({ bar: null })}
          />
        ) : (
          <CustomBarEditor
            key={editing.bar?.id ?? "new"}
            bar={editing.bar}
            options={options}
            usageOptions={usageOptions}
            disabled={pending || !canEditBars}
            onCancel={() => setEditing(null)}
            onSave={async (bar) => {
              const saved = editing.bar;
              if (saved !== null && !bars.some((item) => item.id === saved.id)) return;
              const next =
                saved === null
                  ? [...bars, bar]
                  : bars.map((item) =>
                      item.id === saved.id
                        ? { ...bar, visible: item.visible, showQuotaPace: item.showQuotaPace }
                        : item,
                    );
              if (await write({ statusLineCustomBars: next })) setEditing(null);
            }}
          />
        )}
      </View>
    </SettingsSection>
  );
}

function MetricsCommandControl(props: {
  readonly command: string;
  readonly disabled: boolean;
  readonly onSave: (command: string) => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState(props.command);
  const label = gt("Metrics command");
  return (
    <View className="gap-2">
      <Text className="text-sm">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        className={INPUT_CLASS}
        value={draft}
        editable={!props.disabled}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setDraft}
      />
      <Text className="text-xs text-foreground-muted">
        {gt(
          "Runs on the server and returns a JSON object keyed by metric name. Each metric needs remainingPercent and can include burnRatePercentPerHour.",
        )}
      </Text>
      {draft.trim() !== props.command ? (
        <Button
          label={gt("Save command")}
          size="compact"
          disabled={props.disabled}
          onPress={() => props.onSave(draft.trim())}
        />
      ) : null}
    </View>
  );
}

function CustomBarEditor(props: {
  readonly bar: StatusLineCustomBar | null;
  readonly options: readonly QuotaOption[];
  readonly usageOptions: ReturnType<typeof statusLineUsageOptions>;
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onSave: (bar: StatusLineCustomBar) => Promise<void>;
}) {
  const gt = useGT();
  const savedSource = props.bar?.source;
  const [label, setLabel] = useState(props.bar?.label ?? "");
  const [target, setTarget] = useState(props.bar?.targetPercentPerHour?.toString() ?? "");
  const [type, setType] = useState<StatusLineCustomBar["source"]["type"]>(
    savedSource?.type ?? "quota",
  );
  const [quota, setQuota] = useState(savedSource?.type === "quota" ? savedSource : null);
  const [metricKey, setMetricKey] = useState(savedSource?.type === "metric" ? savedSource.key : "");
  const [usage, setUsage] = useState(() =>
    statusLineUsageDraft(savedSource?.type === "usage" ? savedSource : undefined),
  );
  const [estimatorKind, setEstimatorKind] = useState<StatusLineRateEstimator["kind"] | "default">(
    props.bar?.estimator?.kind ?? "default",
  );
  const [minutes, setMinutes] = useState(
    props.bar?.estimator?.kind === "sliding" ? String(props.bar.estimator.minutes) : "30",
  );
  const slidingMinutes = parseStatusLineBurnTau(minutes);
  const quotaId = quota === null ? null : quotaKey(quota);
  const quotaLabel = props.options.find((option) => quotaKey(option.source) === quotaId)?.title;
  const source =
    type === "quota"
      ? quota
      : type === "usage"
        ? parseStatusLineUsageDraft(usage)
        : { type: "metric" as const, key: metricKey.trim() };
  const estimator: StatusLineRateEstimator | undefined =
    type !== "quota" || estimatorKind === "default"
      ? undefined
      : estimatorKind === "sliding"
        ? slidingMinutes === null
          ? undefined
          : { kind: estimatorKind, minutes: slidingMinutes }
        : { kind: estimatorKind };
  const rate = parseStatusLineTargetRate(target);
  const canSave =
    label.trim() !== "" &&
    source !== null &&
    (source.type !== "metric" || source.key !== "") &&
    rate !== undefined &&
    (type !== "quota" || estimatorKind !== "sliding" || slidingMinutes !== null);
  const nameLabel = gt("Bar label");
  const targetLabel = gt("Target rate (pp/hour)");
  const trackedQuota = gt("Tracked quota");
  const customMetric = gt("Custom metric");
  const metricKeyLabel = gt("Metric key");

  return (
    <View className="gap-2 border-t border-border pt-3">
      <Text className="text-sm">{nameLabel}</Text>
      <TextInput
        accessibilityLabel={nameLabel}
        className={INPUT_CLASS}
        editable={!props.disabled}
        value={label}
        onChangeText={setLabel}
      />
      <Text className="text-sm">{targetLabel}</Text>
      <TextInput
        accessibilityLabel={targetLabel}
        placeholder={gt("Default")}
        className={INPUT_CLASS}
        keyboardType="decimal-pad"
        editable={!props.disabled}
        value={target}
        onChangeText={setTarget}
      />
      {rate === undefined ? (
        <Text className="text-xs text-foreground-muted">
          {gt("Enter a rate greater than zero or leave it blank.")}
        </Text>
      ) : null}
      <StatusLineChoiceMenu<StatusLineCustomBar["source"]["type"]>
        label={gt("Bar source")}
        placeholder=""
        choices={[
          { id: "quota", title: trackedQuota },
          { id: "metric", title: customMetric },
          { id: "usage", title: gt("Grouped usage") },
        ]}
        selected={[type]}
        disabled={props.disabled}
        onSelect={setType}
      />
      {type === "metric" ? (
        <>
          <Text className="text-sm">{metricKeyLabel}</Text>
          <TextInput
            accessibilityLabel={metricKeyLabel}
            className={INPUT_CLASS}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!props.disabled}
            value={metricKey}
            onChangeText={setMetricKey}
          />
        </>
      ) : type === "usage" ? (
        <StatusLineUsageEditor
          draft={usage}
          options={props.usageOptions}
          disabled={props.disabled}
          onChange={setUsage}
        />
      ) : (
        <>
          <Menu
            title={trackedQuota}
            accessibilityLabel={trackedQuota}
            actions={
              props.disabled
                ? []
                : props.options.map((option) => ({
                    id: quotaKey(option.source),
                    title: option.title,
                    state: quotaKey(option.source) === quotaId ? "on" : "off",
                  }))
            }
            onPressAction={({ nativeEvent }) => {
              const option = props.options.find(
                (item) => quotaKey(item.source) === nativeEvent.event,
              );
              if (option) setQuota(option.source);
            }}
          >
            <View className={INPUT_CLASS}>
              <Text className="text-sm">
                {quotaLabel ??
                  (quota !== null || props.options.length === 0
                    ? gt("Quota source unavailable")
                    : gt("Choose provider quota"))}
              </Text>
            </View>
          </Menu>
          <StatusLineEstimatorMenu
            label={gt("Rate estimator")}
            kind={estimatorKind}
            optional
            disabled={props.disabled}
            onSelect={setEstimatorKind}
          />
          {estimatorKind === "sliding" ? (
            <StatusLineSlidingMinutesInput
              value={minutes}
              disabled={props.disabled}
              onChangeText={setMinutes}
            />
          ) : null}
        </>
      )}
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={gt("Save")}
          size="compact"
          tone="primary"
          disabled={props.disabled || !canSave}
          onPress={() => {
            if (!canSave) return;
            void props.onSave({
              id: props.bar?.id ?? uuidv4(),
              visible: props.bar?.visible ?? true,
              showQuotaPace: props.bar?.showQuotaPace ?? true,
              label: label.trim(),
              source,
              targetPercentPerHour: rate,
              ...(estimator === undefined ? {} : { estimator }),
            });
          }}
        />
        <Button
          label={gt("Cancel")}
          size="compact"
          tone="text"
          disabled={props.disabled}
          onPress={props.onCancel}
        />
      </View>
    </View>
  );
}
