import {
  buildStatusLineModelUsage,
  orderStatusLineBars,
  parseStatusLineTargetRate,
} from "@t3tools/client-runtime/status-line";
import {
  isManagedSettingPath,
  type StatusLineCustomBar,
  type StatusLineRateEstimator,
} from "@t3tools/contracts";
import { statusLineAccountKey } from "@t3tools/shared/usageLimits";
import { useGT } from "gt-react";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useEnvironmentProviders } from "../../state/environments";
import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { StatusLineEstimatorControl } from "./StatusLineEstimatorControl";
import { StatusLineGroupedBarFields, type GroupedBarSource } from "./StatusLineGroupedBarFields";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

type QuotaSource = Extract<StatusLineCustomBar["source"], { type: "quota" }>;

function quotaValue(source: QuotaSource) {
  return JSON.stringify([source.providerInstanceId, source.limitId]);
}

export function StatusLineCustomBarsSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { connectedEnvironments, scope } = useSettingsScope();
  const {
    statusLineCustomBars,
    statusLineMetricsCommand,
    statusLineBarOrder,
    statusLineAccountNames,
  } = useScopedSettings();
  const update = useUpdateScopedSettings();
  const canWrite = useScopedSettingsWriteAllowed();
  const [editing, setEditing] = useState<{ readonly id: string | null } | null>(null);
  const nowMs = useNowMinuteMs();
  const providerMap = useEnvironmentProviders();
  const config = connectedEnvironments.length === 1 ? connectedEnvironments[0]?.serverConfig : null;
  if (!config || scope.kind === "project" || scope.kind === "checkout") {
    return (
      <SettingsRow
        {...searchableSetting("status-line-custom-bars")}
        description={gt("Select one environment to edit its custom bars.")}
      />
    );
  }
  if (config.environment.capabilities.statusLineCustomBars !== true) return null;
  const providers = providerMap.get(config.environment.environmentId) ?? [];
  const options = buildStatusLineModelUsage({
    providers: providers,
    usageLimitSources: config.usageLimitSources ?? [],
    nowMs,
    statusLineAccountNames,
  }).flatMap((provider) =>
    provider.limits.map((limit) => ({
      label: [provider.name, limit.label, ...limit.scope].join(" · "),
      source: {
        type: "quota",
        providerInstanceId: provider.instanceId,
        limitId: limit.id,
      } as const,
    })),
  );
  const edited =
    editing === null ? null : statusLineCustomBars.find((bar) => bar.id === editing.id);
  const canEditBars =
    canWrite && !isManagedSettingPath(config.managedPolicy, "statusLineCustomBars");
  const canReorder = canWrite && !isManagedSettingPath(config.managedPolicy, "statusLineBarOrder");
  const barOrder = orderStatusLineBars(
    [
      { id: "session", label: gt("5-hour limit") },
      { id: "weekly", label: gt("Weekly limit") },
      ...statusLineCustomBars.map((bar) => ({ id: `custom:${bar.id}`, label: bar.label })),
    ],
    statusLineBarOrder,
  );
  const accounts = (config.usageLimitSources ?? []).flatMap((source) =>
    source.accounts.map((account) => ({
      id: statusLineAccountKey(source.id, account.id),
      label: account.email ?? account.id,
    })),
  );
  const providerOptions = providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      id: provider.instanceId,
      label: provider.displayName ?? provider.driver,
    }));
  const modelOptions = [
    ...new Map(
      providers.flatMap((provider) =>
        provider.models.map((model) => [model.slug, model.name] as const),
      ),
    ).entries(),
  ].map(([id, label]) => ({ id, label }));
  const move = (index: number, offset: number) => {
    const next = barOrder.map((item) => item.id);
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    update({ statusLineBarOrder: next });
  };
  return (
    <>
      <SettingsRow serverScoped settingKeys={["statusLineBarOrder"]} title={gt("Bar order")}>
        <div className="space-y-1 pb-2">
          {barOrder.map(({ id, label }, index) => (
            <div key={id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm">{label}</span>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={!canReorder || index === 0}
                  aria-label={gt("Move {label} up", { label })}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={!canReorder || index === barOrder.length - 1}
                  aria-label={gt("Move {label} down", { label })}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDownIcon />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </SettingsRow>
      {accounts.map(({ id, label }) => (
        <SettingsRow
          key={id}
          serverScoped
          settingKeys={["statusLineAccountNames"]}
          title={gt("Account name")}
          description={label}
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-48"
              value={statusLineAccountNames[id] ?? ""}
              aria-label={gt("Account name for {label}", { label })}
              onCommit={(value) => {
                const next = { ...statusLineAccountNames };
                if (value.trim()) next[id] = value.trim();
                else delete next[id];
                update({ statusLineAccountNames: next });
              }}
            />
          }
        />
      ))}
      <SettingsRow
        serverScoped
        settingKeys={["statusLineCustomBars"]}
        {...searchableSetting("status-line-custom-bars")}
        control={
          <Button size="sm" variant="outline" onClick={() => setEditing({ id: null })}>
            {gt("Add custom bar")}
          </Button>
        }
      >
        <div className="space-y-2 pb-2">
          {statusLineCustomBars.map((bar) => (
            <div key={bar.id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm">{bar.label}</span>
              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  size="sm"
                  checked={bar.visible}
                  disabled={!canEditBars}
                  aria-label={gt("Show {label}", { label: bar.label })}
                  onCheckedChange={(visible) =>
                    update({
                      statusLineCustomBars: statusLineCustomBars.map((item) =>
                        item.id === bar.id ? { ...item, visible } : item,
                      ),
                    })
                  }
                />
                <Switch
                  size="sm"
                  checked={bar.showQuotaPace}
                  disabled={!canEditBars}
                  aria-label={gt("Show quota pace for {label}", { label: bar.label })}
                  onCheckedChange={(showQuotaPace) =>
                    update({
                      statusLineCustomBars: statusLineCustomBars.map((item) =>
                        item.id === bar.id ? { ...item, showQuotaPace } : item,
                      ),
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canEditBars}
                  onClick={() => setEditing({ id: bar.id })}
                >
                  {gt("Edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost-destructive"
                  disabled={!canEditBars}
                  onClick={() => {
                    if (editing?.id === bar.id) setEditing(null);
                    update({
                      statusLineCustomBars: statusLineCustomBars.filter(
                        (item) => item.id !== bar.id,
                      ),
                    });
                  }}
                >
                  {gt("Remove")}
                </Button>
              </div>
            </div>
          ))}
          {editing === null ? null : (
            <CustomBarForm
              key={JSON.stringify([config.environment.environmentId, editing.id])}
              bar={edited}
              options={options}
              providers={providerOptions}
              models={modelOptions}
              accounts={accounts}
              disabled={!canEditBars}
              onCancel={() => setEditing(null)}
              onSave={(bar) => {
                update({
                  statusLineCustomBars: edited
                    ? statusLineCustomBars.map((item) => (item.id === bar.id ? bar : item))
                    : [...statusLineCustomBars, bar],
                });
                setEditing(null);
              }}
            />
          )}
        </div>
      </SettingsRow>
      <SettingsRow
        serverScoped
        settingKeys={["statusLineMetricsCommand"]}
        {...searchableSetting("status-line-custom-metrics-command")}
        description={gt(
          "Runs on the server and returns a JSON object keyed by metric name. Each metric needs remainingPercent and can include burnRatePercentPerHour.",
        )}
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={statusLineMetricsCommand}
            onCommit={(next) => update({ statusLineMetricsCommand: next.trim() })}
            aria-label={gt("Metrics command")}
          />
        }
      />
    </>
  );
}

function CustomBarForm(props: {
  readonly bar?: StatusLineCustomBar | null | undefined;
  readonly options: ReadonlyArray<{ readonly label: string; readonly source: QuotaSource }>;
  readonly providers: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly models: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly accounts: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onSave: (bar: StatusLineCustomBar) => void;
}) {
  const gt = useGT();
  const previous = props.bar?.source;
  const [label, setLabel] = useState(props.bar?.label ?? "");
  const [type, setType] = useState(previous?.type ?? "quota");
  const [quota, setQuota] = useState(previous?.type === "quota" ? quotaValue(previous) : "");
  const [metric, setMetric] = useState(previous?.type === "metric" ? previous.key : "");
  const [estimator, setEstimator] = useState<StatusLineRateEstimator | undefined>(
    props.bar?.estimator,
  );
  const [grouped, setGrouped] = useState<GroupedBarSource | undefined>(
    previous?.type === "usage" ? previous : undefined,
  );
  const [target, setTarget] = useState(props.bar?.targetPercentPerHour?.toString() ?? "");
  const selectedQuota =
    props.options.find((option) => quotaValue(option.source) === quota)?.source ??
    (previous?.type === "quota" && quotaValue(previous) === quota ? previous : undefined);
  const source: StatusLineCustomBar["source"] | undefined =
    type === "quota"
      ? selectedQuota
      : type === "usage"
        ? grouped
        : metric.trim()
          ? { type: "metric", key: metric.trim() }
          : undefined;
  const targetPercentPerHour = parseStatusLineTargetRate(target);
  const ready = label.trim() !== "" && source !== undefined && targetPercentPerHour !== undefined;
  const selectClass = "h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (props.disabled || !ready) return;
        props.onSave({
          id: props.bar?.id ?? randomUUID(),
          visible: props.bar?.visible ?? true,
          showQuotaPace: props.bar?.showQuotaPace ?? true,
          label: label.trim(),
          source,
          targetPercentPerHour,
          ...(source.type === "quota" && estimator ? { estimator } : {}),
        });
      }}
    >
      <fieldset
        disabled={props.disabled}
        className="grid gap-2 rounded-md border border-border p-2"
      >
        <Input
          size="sm"
          value={label}
          onValueChange={setLabel}
          placeholder={gt("Bar label")}
          aria-label={gt("Bar label")}
        />
        <select
          className={selectClass}
          aria-label={gt("Bar source")}
          value={type}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setType(value === "metric" || value === "usage" ? value : "quota");
          }}
        >
          <option value="quota">{gt("Tracked quota")}</option>
          <option value="metric">{gt("Custom metric")}</option>
          <option value="usage">{gt("Grouped usage")}</option>
        </select>
        {type === "quota" ? (
          <select
            className={selectClass}
            aria-label={gt("Tracked quota")}
            value={quota}
            onChange={(event) => setQuota(event.currentTarget.value)}
          >
            <option value="">{gt("Choose provider quota")}</option>
            {previous?.type === "quota" &&
            !props.options.some((option) => quotaValue(option.source) === quotaValue(previous)) ? (
              <option value={quotaValue(previous)}>{gt("Quota source unavailable")}</option>
            ) : null}
            {props.options.map(({ label, source }) => (
              <option key={quotaValue(source)} value={quotaValue(source)}>
                {label}
              </option>
            ))}
          </select>
        ) : type === "usage" ? (
          <StatusLineGroupedBarFields
            initial={grouped}
            providers={props.providers}
            models={props.models}
            accounts={props.accounts}
            onChange={setGrouped}
          />
        ) : (
          <Input
            size="sm"
            value={metric}
            onValueChange={setMetric}
            placeholder={gt("Metric key")}
            aria-label={gt("Metric key")}
          />
        )}
        {type === "quota" ? (
          <StatusLineEstimatorControl
            label={gt("Rate estimator")}
            value={estimator}
            allowDefault
            defaultMinutes={30}
            onChange={setEstimator}
          />
        ) : null}
        <Input
          size="sm"
          inputMode="decimal"
          value={target}
          onValueChange={setTarget}
          aria-invalid={targetPercentPerHour === undefined}
          placeholder={gt("Target rate (pp/hour)")}
          aria-label={gt("Target rate (pp/hour)")}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={props.onCancel}>
            {gt("Cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={!ready}>
            {gt("Save")}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
