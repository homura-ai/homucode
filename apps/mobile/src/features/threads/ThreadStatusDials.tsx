import IconDatabase from "@tabler/icons-react-native/IconDatabase";
import {
  fitStatusLineItems,
  formatStatusLineTokens,
  STATUS_LINE_EFFORT_COLORS,
  statusLineBurnRisk,
  statusLineCacheRisk,
  statusLineColorMix,
  statusLineEffortPosition,
  statusLineNativeColorMix,
  statusLineGaugeUsedPercent,
  statusLineGaugePercent,
  statusLineGaugeTickRotation,
  statusLineLimitEnded,
  statusLineLimitRemaining,
  statusLineUptime,
  type StatusLineLimit,
  type StatusLineStats,
} from "@t3tools/client-runtime/status-line";
import Constants from "expo-constants";
import { useGT } from "gt-react-native";
import { useContext, type ReactNode } from "react";
import { View } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";

import { StatusLineInterLoaded, StatusLineText as Text } from "./StatusLineTypography";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

type GaugeKind = "context" | "limit";
const DIAL_SIZE = 26;
const RING_RADIUS = 10.5;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const appVersion = Constants.expoConfig?.version ?? null;

function useUsedPalette() {
  const { themeAppearance, themeVariables } = useAppearancePreferences();
  return [
    themeAppearance === "dark" ? "#34d399" : "#047857",
    themeVariables["--color-warning-foreground"],
    themeVariables["--color-danger-foreground"],
  ] as const;
}

function useUsedColor(percent: number) {
  return statusLineColorMix(percent, useUsedPalette(), statusLineNativeColorMix);
}

function useGaugeColor(
  percent: number,
  kind: GaugeKind,
  projectedRemainingPercent?: number | null,
) {
  const { themeVariables } = useAppearancePreferences();
  const used = statusLineGaugeUsedPercent(percent, kind, projectedRemainingPercent);
  return {
    color: useUsedColor(used),
    fillOpacity: 0.3 * (used / 100) ** 4,
    foreground: themeVariables["--color-foreground"],
  };
}

function Dial(props: {
  readonly percent: number;
  readonly kind: GaugeKind;
  readonly projectedRemainingPercent?: number | null;
  readonly label: string;
  readonly caption?: string | undefined;
  readonly detail?: ReactNode;
  readonly dimmed?: boolean;
}) {
  const interLoaded = useContext(StatusLineInterLoaded);
  const percent = statusLineGaugePercent(props.percent);
  const { color, fillOpacity, foreground } = useGaugeColor(
    props.percent,
    props.kind,
    props.projectedRemainingPercent,
  );
  return (
    <View
      accessible
      accessibilityLabel={props.label}
      className="shrink-0 flex-row items-center gap-1"
      style={props.dimmed ? { opacity: 0.5 } : undefined}
    >
      <Svg width={DIAL_SIZE} height={DIAL_SIZE} viewBox="0 0 26 26">
        <Circle
          cx={13}
          cy={13}
          r={RING_RADIUS}
          fill={color}
          fillOpacity={fillOpacity}
          stroke={color}
          strokeOpacity={0.22}
          strokeWidth={3}
        />
        {percent > 0 ? (
          <Circle
            cx={13}
            cy={13}
            r={RING_RADIUS}
            fill="none"
            stroke={color}
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
            rotation={-90}
            originX={13}
            originY={13}
          />
        ) : null}
        {props.projectedRemainingPercent == null ? null : (
          <Line
            x1={13}
            y1={1}
            x2={13}
            y2={6}
            stroke={foreground}
            strokeWidth={1.5}
            strokeLinecap="round"
            rotation={statusLineGaugeTickRotation(props.projectedRemainingPercent)}
            originX={13}
            originY={13}
          />
        )}
        <SvgText
          x={13}
          y={13}
          fill={foreground}
          fontSize={percent === 100 ? 8 : 9}
          fontFamily={interLoaded ? "Inter-SemiBold" : undefined}
          fontWeight={interLoaded ? "normal" : "600"}
          textAnchor="middle"
          alignmentBaseline="central"
        >
          {percent}
        </SvgText>
      </Svg>
      {props.caption === undefined && props.detail == null ? null : (
        <View>
          {props.caption === undefined ? null : (
            <Text medium numberOfLines={1} className="text-2xs font-medium">
              {props.caption}
            </Text>
          )}
          {props.detail}
        </View>
      )}
    </View>
  );
}

function Effort({ effort }: { readonly effort: string }) {
  const { themeAppearance } = useAppearancePreferences();
  const position = statusLineEffortPosition(effort);
  const variant = themeAppearance === "dark" ? 1 : 0;
  const [low, medium, high, extraHigh, max] = STATUS_LINE_EFFORT_COLORS;
  const color =
    position === undefined
      ? undefined
      : statusLineColorMix(
          position,
          [low[variant], medium[variant], high[variant], extraHigh[variant], max[variant]],
          statusLineNativeColorMix,
        );
  return (
    <Text numberOfLines={1} className="text-2xs" style={{ color }}>
      {effort}
    </Text>
  );
}

function useLimitNote(limit: StatusLineLimit, nowMs: number) {
  const gt = useGT();
  if (statusLineLimitEnded(limit, nowMs)) return gt("window ended");
  const time = statusLineLimitRemaining(limit, nowMs);
  return time === null ? null : gt("resets in {time}", { time });
}

function LimitDial(props: {
  readonly limit: StatusLineLimit;
  readonly nowMs: number;
  readonly title: string;
  readonly caption?: string;
  readonly showDepletionRatio?: boolean;
}) {
  const gt = useGT();
  const note = useLimitNote(props.limit, props.nowMs);
  const remaining = statusLineLimitRemaining(props.limit, props.nowMs);
  const resetColor = useUsedColor(statusLineBurnRisk(props.limit, props.nowMs));
  const { remainingPercent, projectedRemainingPercent, depletionRatioPercent } = props.limit;
  const remainingLabel = gt("{percent}% remaining", { percent: remainingPercent });
  const projectedLabel =
    projectedRemainingPercent === null
      ? null
      : gt("{percent}% projected remaining at reset", { percent: projectedRemainingPercent });
  const depletionRatio =
    depletionRatioPercent === undefined
      ? null
      : gt("Reset / depletion {percent}%", { percent: depletionRatioPercent });
  return (
    <Dial
      percent={remainingPercent}
      kind="limit"
      projectedRemainingPercent={projectedRemainingPercent}
      caption={props.caption}
      detail={
        props.caption && remaining !== null ? (
          <View className="flex-row items-center gap-0.5">
            <SymbolView
              name="arrow.clockwise"
              size={10}
              tintColorClassName="accent-foreground-muted"
            />
            <StripValue color={resetColor}>{remaining}</StripValue>
            {props.showDepletionRatio && depletionRatioPercent !== undefined ? (
              <View className="ms-0.5 border-s border-border ps-1">
                <StripValue>{depletionRatioPercent}%</StripValue>
              </View>
            ) : null}
          </View>
        ) : null
      }
      dimmed={statusLineLimitEnded(props.limit, props.nowMs)}
      label={[props.title, remainingLabel, note, projectedLabel, depletionRatio]
        .filter(Boolean)
        .join(", ")}
    />
  );
}

function estimateTextWidth(text: string, fontScale: number): number {
  return (text.length * 5.5 + 3) * fontScale;
}

export function minimumStatusDialWidth(stats: StatusLineStats, fontScale: number): number {
  return (
    24 +
    (stats.contextPercent === null ? 0 : 30) +
    (stats.contextTokens === null
      ? 0
      : estimateTextWidth(formatStatusLineTokens(stats.contextTokens), fontScale)) +
    (stats.modelName === null
      ? 0
      : Math.min(90, estimateTextWidth(stats.modelName, fontScale)) +
        (stats.effort === null ? 0 : estimateTextWidth(stats.effort, fontScale)) +
        10)
  );
}

function StripValue(props: { readonly children: ReactNode; readonly color?: string }) {
  return (
    <Text
      numberOfLines={1}
      className="text-2xs text-foreground-muted"
      style={{ fontVariant: ["tabular-nums"], color: props.color }}
    >
      {props.children}
    </Text>
  );
}

export function ThreadStatusDialStrip(props: {
  readonly stats: StatusLineStats;
  readonly createdAt: string | null;
  readonly nowMs: number;
  readonly availableWidth: number;
  readonly fontScale: number;
}) {
  const gt = useGT();
  const { themeVariables } = useAppearancePreferences();
  const { stats, nowMs, availableWidth, fontScale } = props;
  const context = stats.contextTokens === null ? null : formatStatusLineTokens(stats.contextTokens);
  const contextLabel = gt("Context", { $context: "model context window" });
  const compactContextLabel = gt("ctx", { $context: "short label for model context" });
  const weeklyLabel = gt("week", { $context: "weekly usage limit" });
  const compactWeeklyLabel = gt("wk", { $context: "short label for weekly usage" });
  const uptime = statusLineUptime(props.createdAt, nowMs);
  const cacheColor = useUsedColor(statusLineCacheRisk(stats.cachePercent ?? 100));
  const cost =
    stats.cost === null ? null : `${stats.cost.amount}${stats.cost.basis === "api" ? " API" : ""}`;
  const weeklyRatio = stats.weekly?.depletionRatioPercent;
  const fast =
    stats.fastMode === null
      ? null
      : stats.fastMode
        ? gt("On", { $context: "option state" })
        : gt("Off", { $context: "option state" });
  const textWidth = (text: string) => estimateTextWidth(text, fontScale);
  const tokenWidth = (count: number | null) =>
    count === null ? 0 : 16 + textWidth(formatStatusLineTokens(count));
  const item = <Id extends string>(id: Id, value: string | null, iconWidth = 0) =>
    value === null ? [] : [{ id, full: textWidth(value) + iconWidth + 8 }];
  const limitWidth = (limit: StatusLineLimit, caption: string) => {
    const countdown = statusLineLimitRemaining(limit, nowMs);
    return 38 + Math.max(textWidth(caption), countdown === null ? 0 : 12 + textWidth(countdown));
  };
  const core = minimumStatusDialWidth(stats, fontScale);
  const captionWidth = (caption: string) =>
    context === null
      ? 0
      : stats.contextPercent === null
        ? textWidth(caption)
        : Math.max(0, textWidth(caption) - textWidth(context));
  const { compact, visible } = fitStatusLineItems(
    availableWidth,
    {
      full: core + captionWidth(contextLabel),
      compact: core + captionWidth(compactContextLabel),
    },
    [
      ...(stats.weekly === null
        ? []
        : ([
            {
              id: "weekly",
              full: limitWidth(stats.weekly, weeklyLabel),
              compact: limitWidth(stats.weekly, compactWeeklyLabel),
            },
          ] as const)),
      ...(stats.fiveHour === null
        ? []
        : ([{ id: "fiveHour", full: limitWidth(stats.fiveHour, "5h") }] as const)),
      ...item("cost", cost),
      ...item("weeklyRatio", weeklyRatio === undefined ? null : `${weeklyRatio}%`),
      ...item("uptime", uptime, 16),
      ...item("cache", stats.cachePercent === null ? null : "100%", 16),
      ...(stats.inputTokens === null && stats.outputTokens === null
        ? []
        : ([
            {
              id: "tokens",
              full: tokenWidth(stats.inputTokens) + tokenWidth(stats.outputTokens) + 8,
            },
          ] as const)),
      ...item("api", stats.apiTime, 16),
      ...item("fast", fast, 16),
      ...item("style", stats.outputStyle),
      ...item("appVersion", appVersion),
      ...item("providerVersion", stats.version),
    ],
  );
  const showDepletionRatio = visible.has("weeklyRatio");
  const contextCaption = compact ? compactContextLabel : contextLabel;
  return (
    <View className="min-w-0 shrink flex-row items-center gap-2">
      {stats.modelName === null ? null : (
        <View className="min-w-0 shrink flex-row items-center gap-1">
          <Text medium numberOfLines={1} className="max-w-24 shrink text-xs font-medium">
            {stats.modelName}
          </Text>
          {stats.effort === null ? null : <Effort effort={stats.effort} />}
        </View>
      )}
      {stats.contextPercent !== null && context !== null ? (
        <Dial
          percent={stats.contextPercent}
          kind="context"
          caption={contextCaption}
          detail={<StripValue>{context}</StripValue>}
          label={gt("Context {percent}% used, {context} tokens", {
            percent: statusLineGaugePercent(stats.contextPercent),
            context,
          })}
        />
      ) : context === null ? null : (
        <Text className="shrink-0 text-2xs text-foreground-muted">
          {contextCaption} {context}
        </Text>
      )}
      {stats.fiveHour === null || !visible.has("fiveHour") ? null : (
        <LimitDial limit={stats.fiveHour} nowMs={nowMs} title={gt("5-hour limit")} caption="5h" />
      )}
      {stats.weekly === null || !visible.has("weekly") ? null : (
        <LimitDial
          limit={stats.weekly}
          nowMs={nowMs}
          title={gt("Weekly limit")}
          showDepletionRatio={showDepletionRatio}
          caption={compact ? compactWeeklyLabel : weeklyLabel}
        />
      )}
      {cost === null || !visible.has("cost") ? null : (
        <View
          accessible
          accessibilityLabel={
            stats.cost?.basis === "api" ? gt("API cost") : gt("Subscription cost estimate")
          }
          className="shrink-0"
        >
          <StripValue>{cost}</StripValue>
        </View>
      )}
      {uptime === null || !visible.has("uptime") ? null : (
        <View className="shrink-0 flex-row items-center gap-1">
          <SymbolView name="timer" size={12} tintColorClassName="accent-foreground-muted" />
          <StripValue>{uptime}</StripValue>
        </View>
      )}
      {stats.cachePercent === null || !visible.has("cache") ? null : (
        <View className="shrink-0 flex-row items-center gap-1">
          <IconDatabase size={12} color={themeVariables["--color-foreground-muted"]} />
          <StripValue color={cacheColor}>{Math.round(stats.cachePercent)}%</StripValue>
        </View>
      )}
      {(stats.inputTokens === null && stats.outputTokens === null) ||
      !visible.has("tokens") ? null : (
        <View className="shrink-0 flex-row items-center gap-1">
          {stats.inputTokens === null ? null : (
            <>
              <SymbolView
                name="arrow.down"
                size={12}
                tintColorClassName="accent-foreground-muted"
              />
              <StripValue>{formatStatusLineTokens(stats.inputTokens)}</StripValue>
            </>
          )}
          {stats.outputTokens === null ? null : (
            <>
              <SymbolView name="arrow.up" size={12} tintColorClassName="accent-foreground-muted" />
              <StripValue>{formatStatusLineTokens(stats.outputTokens)}</StripValue>
            </>
          )}
        </View>
      )}
      {stats.apiTime === null || !visible.has("api") ? null : (
        <View
          accessible
          accessibilityLabel={gt("API time")}
          className="shrink-0 flex-row items-center gap-1"
        >
          <SymbolView name="clock" size={12} tintColorClassName="accent-foreground-muted" />
          <StripValue>{stats.apiTime}</StripValue>
        </View>
      )}
      {fast === null || !visible.has("fast") ? null : (
        <View
          accessible
          accessibilityLabel={gt("Fast mode")}
          className="shrink-0 flex-row items-center gap-1"
        >
          <SymbolView name={{ ios: "bolt.fill", android: "bolt" }} size={12} />
          <StripValue>{fast}</StripValue>
        </View>
      )}
      {stats.outputStyle === null || !visible.has("style") ? null : (
        <StripValue>{stats.outputStyle}</StripValue>
      )}
      {appVersion === null || !visible.has("appVersion") ? null : (
        <StripValue>v{appVersion}</StripValue>
      )}
      {stats.version === null || !visible.has("providerVersion") ? null : (
        <StripValue>v{stats.version}</StripValue>
      )}
    </View>
  );
}

interface MeterValue {
  readonly percent: number;
  readonly kind: GaugeKind;
  readonly projectedRemainingPercent?: number | null;
}

function Meter(props: MeterValue) {
  const { color } = useGaugeColor(props.percent, props.kind, props.projectedRemainingPercent);
  return (
    <View className="mt-1 h-1 overflow-hidden rounded-full">
      <View className="absolute inset-0" style={{ backgroundColor: color, opacity: 0.2 }} />
      <View
        className="h-full rounded-full"
        style={{ backgroundColor: color, width: `${statusLineGaugePercent(props.percent)}%` }}
      />
    </View>
  );
}

function Fact(props: {
  readonly name: string;
  readonly meter?: MeterValue;
  readonly dimmed?: boolean;
  readonly details?: ReadonlyArray<string>;
  readonly note?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <View
      className="min-w-32 grow basis-[45%] gap-0.5"
      style={props.dimmed ? { opacity: 0.5 } : undefined}
    >
      <Text className="text-xs text-foreground-muted">{props.name}</Text>
      <Text medium className="text-sm font-medium" style={{ fontVariant: ["tabular-nums"] }}>
        {props.children}
      </Text>
      {props.meter ? <Meter {...props.meter} /> : null}
      {props.note}
      {props.details?.map((detail) => (
        <Text
          key={detail}
          className="text-xs leading-4 text-foreground-muted"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {detail}
        </Text>
      ))}
    </View>
  );
}

function LimitFact(props: {
  readonly name: string;
  readonly limit: StatusLineLimit;
  readonly nowMs: number;
}) {
  const gt = useGT();
  const note = useLimitNote(props.limit, props.nowMs);
  const resetColor = useUsedColor(statusLineBurnRisk(props.limit, props.nowMs));
  const { remainingPercent, projectedRemainingPercent, depletionRatioPercent } = props.limit;
  return (
    <Fact
      name={props.name}
      meter={{ percent: remainingPercent, kind: "limit", projectedRemainingPercent }}
      dimmed={statusLineLimitEnded(props.limit, props.nowMs)}
      note={
        note === null ? null : (
          <Text className="text-xs" style={{ color: resetColor }}>
            {note}
          </Text>
        )
      }
      details={[
        ...(projectedRemainingPercent === null
          ? []
          : [
              gt("{percent}% projected remaining at reset", {
                percent: projectedRemainingPercent,
              }),
            ]),
        ...(depletionRatioPercent === undefined
          ? []
          : [gt("Reset / depletion {percent}%", { percent: depletionRatioPercent })]),
      ]}
    >
      {gt("{percent}% remaining", { percent: remainingPercent })}
    </Fact>
  );
}

export function ThreadStatusDialDetails(props: {
  readonly stats: StatusLineStats;
  readonly createdAt: string | null;
  readonly nowMs: number;
}) {
  const gt = useGT();
  const { stats, nowMs } = props;
  const uptime = statusLineUptime(props.createdAt, nowMs);
  const cacheColor = useUsedColor(statusLineCacheRisk(stats.cachePercent ?? 100));
  return (
    <View className="gap-4">
      <View className="flex-row flex-wrap gap-3">
        {stats.contextTokens === null ? null : (
          <Fact
            name={gt("Context", { $context: "model context window" })}
            {...(stats.contextPercent === null
              ? {}
              : { meter: { percent: stats.contextPercent, kind: "context" } })}
          >
            {stats.contextPercent === null
              ? null
              : `${statusLineGaugePercent(stats.contextPercent)}% · `}
            {formatStatusLineTokens(stats.contextTokens)}
            {stats.contextMaxTokens === null
              ? null
              : ` / ${formatStatusLineTokens(stats.contextMaxTokens)}`}
          </Fact>
        )}
        {stats.fiveHour === null ? null : (
          <LimitFact name={gt("5-hour limit")} limit={stats.fiveHour} nowMs={nowMs} />
        )}
        {stats.weekly === null ? null : (
          <LimitFact name={gt("Weekly limit")} limit={stats.weekly} nowMs={nowMs} />
        )}
        {stats.cost === null ? null : (
          <Fact
            name={stats.cost.basis === "api" ? gt("API cost") : gt("Subscription cost estimate")}
            details={[
              gt("Recorded main-agent usage for the current provider thread."),
              ...(stats.cost.partial ? [gt("Some turns could not be priced in full.")] : []),
            ]}
          >
            {stats.cost.amount}
          </Fact>
        )}
        {uptime === null ? null : <Fact name={gt("Uptime")}>{uptime}</Fact>}
        {stats.cachePercent === null ? null : (
          <Fact name={gt("Cache hits")}>
            <Text style={{ color: cacheColor }}>{Math.round(stats.cachePercent)}%</Text>
          </Fact>
        )}
        {stats.inputTokens === null || stats.outputTokens === null ? null : (
          <Fact name={gt("Tokens")}>
            {gt("{input} in · {output} out", {
              input: formatStatusLineTokens(stats.inputTokens),
              output: formatStatusLineTokens(stats.outputTokens),
            })}
          </Fact>
        )}
        {stats.apiTime === null ? null : <Fact name={gt("API time")}>{stats.apiTime}</Fact>}
        {stats.fastMode === null ? null : (
          <Fact name={gt("Fast mode")}>
            {stats.fastMode
              ? gt("On", { $context: "option state" })
              : gt("Off", { $context: "option state" })}
          </Fact>
        )}
        {stats.outputStyle === null ? null : (
          <Fact name={gt("Output style")}>{stats.outputStyle}</Fact>
        )}
        {stats.modelName === null ? null : (
          <Fact name={gt("Model")}>
            {stats.modelName}
            {stats.effort === null ? null : (
              <>
                {" "}
                <Effort effort={stats.effort} />
              </>
            )}
          </Fact>
        )}
        {appVersion === null ? null : <Fact name={gt("HomuCode version")}>{appVersion}</Fact>}
        {stats.version === null ? null : <Fact name={gt("Provider version")}>{stats.version}</Fact>}
      </View>
      {stats.cwd === null ? null : (
        <View className="flex-row items-start gap-1.5 border-t border-border pt-2">
          <SymbolView name="folder" size={13} tintColorClassName="accent-foreground-muted" />
          <Text selectable className="shrink text-xs text-foreground-muted">
            {stats.cwd}
          </Text>
        </View>
      )}
    </View>
  );
}
