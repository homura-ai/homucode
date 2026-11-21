import IconDatabase from "@tabler/icons-react-native/IconDatabase";
import {
  formatStatusLineTokens,
  statusLineEffortBars,
  statusLineGaugePercent,
  statusLineGaugeTickRotation,
  statusLineGaugeTone,
  statusLineLimitEnded,
  statusLineLimitRemaining,
  statusLineUptime,
  type StatusLineLimit,
  type StatusLineStats,
} from "@t3tools/client-runtime/status-line";
import { useGT } from "gt-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

type GaugeKind = "context" | "limit";
const DIAL_SIZE = 26;
const RING_RADIUS = 10.5;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const EFFORT_HEIGHTS = [4, 6, 8, 10, 12];

function useGaugeColor(
  percent: number,
  kind: GaugeKind,
  projectedRemainingPercent?: number | null,
) {
  const { themeAppearance, themeVariables } = useAppearancePreferences();
  const tone = statusLineGaugeTone(percent, kind, projectedRemainingPercent);
  return {
    color: {
      success: themeAppearance === "dark" ? "#34d399" : "#047857",
      warning: themeVariables["--color-warning-foreground"],
      error:
        kind === "context"
          ? themeAppearance === "dark"
            ? "#f87171"
            : "#b91c1c"
          : themeVariables["--color-danger-foreground"],
    }[tone],
    alarm: tone === "error",
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
  const percent = statusLineGaugePercent(props.percent);
  const { color, alarm, foreground } = useGaugeColor(
    percent,
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
          fill={alarm ? color : "none"}
          fillOpacity={0.3}
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
          fontWeight="600"
          textAnchor="middle"
          alignmentBaseline="central"
        >
          {percent}
        </SvgText>
      </Svg>
      {props.caption === undefined && props.detail == null ? null : (
        <View>
          {props.caption === undefined ? null : (
            <Text numberOfLines={1} className="text-2xs font-medium">
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
  const level = statusLineEffortBars(effort);
  if (level === 0) return <Text className="text-2xs text-foreground-muted">{effort}</Text>;
  return (
    <View className="shrink-0 flex-row items-end gap-px">
      {EFFORT_HEIGHTS.map((height, index) => (
        <View
          key={height}
          className={`w-[3px] rounded-sm ${index < level ? "bg-foreground" : "bg-foreground/30"}`}
          style={{ height }}
        />
      ))}
    </View>
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
}) {
  const gt = useGT();
  const note = useLimitNote(props.limit, props.nowMs);
  const remaining = statusLineLimitRemaining(props.limit, props.nowMs);
  const { remainingPercent, projectedRemainingPercent } = props.limit;
  const remainingLabel = gt("{percent}% remaining", { percent: remainingPercent });
  const projectedLabel =
    projectedRemainingPercent === null
      ? null
      : gt("{percent}% projected remaining at reset", { percent: projectedRemainingPercent });
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
            <StripValue>{remaining}</StripValue>
          </View>
        ) : null
      }
      dimmed={statusLineLimitEnded(props.limit, props.nowMs)}
      label={[props.title, remainingLabel, note, projectedLabel].filter(Boolean).join(", ")}
    />
  );
}

export function minimumStatusDialWidth(stats: StatusLineStats, fontScale: number): number {
  return (
    24 +
    (stats.contextPercent === null ? 0 : 34) +
    (stats.fiveHour === null ? 0 : 34) +
    (stats.weekly === null ? 0 : 34) +
    ((stats.contextTokens === null ? 0 : 44) + (stats.modelName === null ? 0 : 102)) * fontScale
  );
}

function StripValue(props: { readonly children: ReactNode }) {
  return (
    <Text
      numberOfLines={1}
      className="text-2xs text-foreground-muted"
      style={{ fontVariant: ["tabular-nums"] }}
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
  const uptime = statusLineUptime(props.createdAt, nowMs);
  const compactWidth = minimumStatusDialWidth(stats, fontScale);
  const captionWidth =
    compactWidth +
    ((stats.fiveHour === null ? 0 : 38) + (stats.weekly === null ? 0 : 38)) * fontScale;
  const showCaptions = availableWidth >= captionWidth;
  const uptimeWidth = captionWidth + (uptime === null ? 0 : 60 * fontScale);
  const cacheWidth = uptimeWidth + (stats.cachePercent === null ? 0 : 55 * fontScale);
  const tokensWidth =
    cacheWidth +
    ((stats.inputTokens === null ? 0 : 48) + (stats.outputTokens === null ? 0 : 47)) * fontScale;
  return (
    <View className="min-w-0 shrink flex-row items-center gap-2">
      {stats.modelName === null ? null : (
        <View className="min-w-0 shrink flex-row items-center gap-1">
          <Text numberOfLines={1} className="max-w-24 shrink text-xs font-medium">
            {stats.modelName}
          </Text>
          {stats.effort === null ? null : <Effort effort={stats.effort} />}
          {stats.fastMode ? (
            <SymbolView
              name={{ ios: "bolt.fill", android: "bolt" }}
              size={12}
              accessibilityLabel={gt("Fast mode")}
            />
          ) : null}
        </View>
      )}
      {stats.contextPercent !== null && context !== null ? (
        <Dial
          percent={stats.contextPercent}
          kind="context"
          caption={showCaptions ? contextLabel : undefined}
          detail={<StripValue>{context}</StripValue>}
          label={gt("Context {percent}% used, {context} tokens", {
            percent: stats.contextPercent,
            context,
          })}
        />
      ) : context === null ? null : (
        <Text className="shrink-0 text-2xs text-foreground-muted">
          {showCaptions ? `${contextLabel} ${context}` : context}
        </Text>
      )}
      {stats.fiveHour === null ? null : (
        <LimitDial
          limit={stats.fiveHour}
          nowMs={nowMs}
          title={gt("5-hour limit")}
          {...(showCaptions ? { caption: "5h" } : {})}
        />
      )}
      {stats.weekly === null ? null : (
        <LimitDial
          limit={stats.weekly}
          nowMs={nowMs}
          title={gt("Weekly limit")}
          {...(showCaptions ? { caption: gt("week", { $context: "weekly usage limit" }) } : {})}
        />
      )}
      {uptime === null || availableWidth < uptimeWidth ? null : (
        <View className="shrink-0 flex-row items-center gap-1">
          <View className="mr-1 h-4 w-px bg-border" />
          <SymbolView name="timer" size={12} tintColorClassName="accent-foreground-muted" />
          <StripValue>{uptime}</StripValue>
        </View>
      )}
      {stats.cachePercent === null || availableWidth < cacheWidth ? null : (
        <View className="shrink-0 flex-row items-center gap-1">
          <IconDatabase size={12} color={themeVariables["--color-foreground-muted"]} />
          <StripValue>{stats.cachePercent}%</StripValue>
        </View>
      )}
      {(stats.inputTokens === null && stats.outputTokens === null) ||
      availableWidth < tokensWidth ? null : (
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
  readonly children: ReactNode;
}) {
  return (
    <View
      className="min-w-32 grow basis-[45%] gap-0.5"
      style={props.dimmed ? { opacity: 0.5 } : undefined}
    >
      <Text className="text-xs text-foreground-muted">{props.name}</Text>
      <Text className="text-sm font-medium" style={{ fontVariant: ["tabular-nums"] }}>
        {props.children}
      </Text>
      {props.meter ? <Meter {...props.meter} /> : null}
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
  const { remainingPercent, projectedRemainingPercent } = props.limit;
  return (
    <Fact
      name={props.name}
      meter={{ percent: remainingPercent, kind: "limit", projectedRemainingPercent }}
      dimmed={statusLineLimitEnded(props.limit, props.nowMs)}
    >
      {gt("{percent}% remaining", { percent: remainingPercent })}
      {note === null ? null : ` · ${note}`}
      {projectedRemainingPercent === null
        ? null
        : ` · ${gt("{percent}% projected remaining at reset", { percent: projectedRemainingPercent })}`}
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
  const model = [stats.modelName, stats.effort, stats.fastMode ? gt("Fast mode") : null]
    .filter(Boolean)
    .join(" · ");
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
            {stats.contextPercent === null ? null : `${stats.contextPercent}% · `}
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
        {uptime === null ? null : <Fact name={gt("Uptime")}>{uptime}</Fact>}
        {stats.inputTokens === null ? null : (
          <Fact name={gt("Tokens")}>
            {stats.cachePercent === null
              ? gt("{input} in · {output} out", {
                  input: formatStatusLineTokens(stats.inputTokens),
                  output: formatStatusLineTokens(stats.outputTokens ?? 0),
                })
              : gt("{input} in · {output} out · {percent}% cached", {
                  input: formatStatusLineTokens(stats.inputTokens),
                  output: formatStatusLineTokens(stats.outputTokens ?? 0),
                  percent: stats.cachePercent,
                })}
          </Fact>
        )}
        {model ? <Fact name={gt("Model")}>{model}</Fact> : null}
      </View>
      {stats.cwd === null && stats.version === null ? null : (
        <View className="gap-1 border-t border-border pt-2">
          {stats.cwd === null ? null : (
            <View className="flex-row items-start gap-1.5">
              <SymbolView name="folder" size={13} tintColorClassName="accent-foreground-muted" />
              <Text selectable className="shrink text-xs text-foreground-muted">
                {stats.cwd}
              </Text>
            </View>
          )}
          {stats.version === null ? null : (
            <Text className="text-xs text-foreground-muted">v{stats.version}</Text>
          )}
        </View>
      )}
    </View>
  );
}
