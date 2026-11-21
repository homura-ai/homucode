import { resolveProvidersForCwd } from "@t3tools/client-runtime/providerSkills";
import { msg, useGT, useMessages } from "gt-react";
import {
  buildStatusLineModelUsage,
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
  type StatusLineUsageSource,
} from "@t3tools/client-runtime/status-line";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  DatabaseIcon,
  FolderIcon,
  RotateCwIcon,
  TimerIcon,
  ZapIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { MessageResolver } from "../../i18n/messages";

const EFFORT_BAR_HEIGHTS = ["h-1", "h-1.5", "h-2", "h-2.5", "h-3"];

function gaugeColor(
  percent: number,
  kind: "context" | "limit",
  projectedRemainingPercent?: number | null,
): string {
  return {
    error:
      kind === "context"
        ? "light-dark(var(--color-red-700), var(--color-red-400))"
        : "var(--destructive)",
    warning: "var(--warning-foreground)",
    success: "var(--success-foreground)",
  }[statusLineGaugeTone(percent, kind, projectedRemainingPercent)];
}

function limitNote(limit: StatusLineLimit, nowMs: number, resolve: MessageResolver): string {
  if (statusLineLimitEnded(limit, nowMs)) return resolve(msg("window ended"));
  const left = statusLineLimitRemaining(limit, nowMs);
  return left === null ? "" : resolve(msg("resets in {time}", { time: left }));
}

/** Effort as signal bars, one lit for low and all five for max. Other levels are written out. */
function Effort(props: { readonly effort: string }) {
  const level = statusLineEffortBars(props.effort);
  if (level === 0) {
    return <span className="font-normal text-2xs text-muted-foreground">{props.effort}</span>;
  }
  return (
    <span
      role="img"
      aria-label={`${props.effort} effort`}
      className="flex shrink-0 items-end gap-px"
    >
      {EFFORT_BAR_HEIGHTS.map((height, index) => (
        <span
          key={height}
          className={`w-[3px] rounded-xs ${height} ${index < level ? "bg-foreground" : "bg-foreground/30"}`}
        />
      ))}
    </span>
  );
}

// At the error level the disc fills too, since a theme's error color can sit close to its accent.
function Ring(props: {
  readonly percent: number;
  readonly alarm: boolean;
  readonly projectedRemainingPercent?: number | null;
}) {
  return (
    <svg viewBox="0 0 26 26" className="size-[26px] shrink-0" aria-hidden>
      <circle
        cx="13"
        cy="13"
        r="10.5"
        fill={props.alarm ? "currentColor" : "none"}
        fillOpacity="0.3"
        stroke="currentColor"
        strokeOpacity="0.22"
        strokeWidth="3"
      />
      {props.percent === 0 ? null : (
        <circle
          cx="13"
          cy="13"
          r="10.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          pathLength="100"
          strokeDasharray={`${props.percent} 100`}
          transform="rotate(-90 13 13)"
        />
      )}
      {props.projectedRemainingPercent == null ? null : (
        <line
          x1="13"
          y1="1"
          x2="13"
          y2="6"
          stroke="var(--foreground)"
          strokeWidth="1.5"
          strokeLinecap="round"
          transform={`rotate(${statusLineGaugeTickRotation(props.projectedRemainingPercent)} 13 13)`}
        />
      )}
      <text
        x="13"
        y="13.4"
        textAnchor="middle"
        dominantBaseline="central"
        className={`fill-foreground font-semibold ${props.percent === 100 ? "text-4xs" : "text-3xs"}`}
      >
        {props.percent}
      </text>
    </svg>
  );
}

/** A ring filled to `percent` with the number inside, then what it measures and a detail. */
function Dial(props: {
  readonly percent: number;
  readonly kind: "context" | "limit";
  readonly projectedRemainingPercent?: number | null;
  readonly name: string;
  readonly detail: ReactNode;
  readonly label: string;
  readonly className?: string;
}) {
  const percent = statusLineGaugePercent(props.percent);
  return (
    <span
      role="img"
      aria-label={props.label}
      className={`flex shrink-0 items-center gap-1.5 ${props.className ?? ""}`}
      style={{ color: gaugeColor(percent, props.kind, props.projectedRemainingPercent) }}
    >
      <Ring
        percent={percent}
        projectedRemainingPercent={props.projectedRemainingPercent ?? null}
        alarm={
          statusLineGaugeTone(percent, props.kind, props.projectedRemainingPercent) === "error"
        }
      />
      <span className="grid @max-[20rem]/dials:hidden">
        <span className="font-medium text-2xs/3.5 text-foreground">{props.name}</span>
        {props.detail === null ? null : (
          <span className="flex items-center gap-0.5 text-3xs/3 text-muted-foreground @max-[24rem]/dials:hidden [&_svg]:size-2.5">
            {props.detail}
          </span>
        )}
      </span>
    </span>
  );
}

function LimitDial(props: {
  readonly limit: StatusLineLimit;
  readonly nowMs: number;
  readonly name: string;
  readonly title: string;
  readonly className: string;
}) {
  const gt = useGT();
  const left = statusLineLimitRemaining(props.limit, props.nowMs);
  const note = limitNote(props.limit, props.nowMs, useMessages());
  const { remainingPercent, projectedRemainingPercent, depletionRatioPercent } = props.limit;
  const remaining = gt("{percent}% remaining", { percent: remainingPercent });
  const projected =
    projectedRemainingPercent === null
      ? ""
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
      name={props.name}
      detail={
        left === null ? null : (
          <>
            <RotateCwIcon />
            {left}
            {depletionRatioPercent === undefined ? null : (
              <span className="ms-0.5 border-s ps-1">{depletionRatioPercent}%</span>
            )}
          </>
        )
      }
      label={[props.title, remaining, note, projected, depletionRatio].filter(Boolean).join(", ")}
      className={`${props.className} ${statusLineLimitEnded(props.limit, props.nowMs) ? "opacity-50" : ""}`}
    />
  );
}

function Stat(props: {
  readonly label: string;
  readonly className: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      role="img"
      aria-label={props.label}
      className={`flex shrink-0 items-center gap-1 text-2xs [&_svg]:size-3 ${props.className}`}
    >
      {props.children}
    </span>
  );
}

/**
 * The status line as gauges in the top bar. What runs out (context and the usage limits) is a
 * dial; the rest are small icons. As the bar narrows the icons leave first, then the captions,
 * and the dials last.
 */
export function StatusDialStrip(props: {
  readonly stats: StatusLineStats;
  readonly createdAt: string | null;
  readonly nowMs: number;
}) {
  const gt = useGT();
  const { stats, nowMs } = props;
  const uptime = statusLineUptime(props.createdAt, nowMs);
  const context = stats.contextTokens === null ? null : formatStatusLineTokens(stats.contextTokens);
  const hasDial = stats.contextPercent !== null || stats.fiveHour !== null || stats.weekly !== null;
  return (
    <div className="@container/dials">
      <div className="flex items-center gap-3.5 overflow-hidden whitespace-nowrap tabular-nums">
        {stats.modelName === null ? null : (
          <span
            // Beside dials the model goes when room is short; alone it stays, or nothing would.
            className={`flex min-w-0 items-center gap-1.5 font-medium text-foreground ${hasDial ? "@max-[14rem]/dials:hidden" : ""}`}
          >
            <span className="max-w-40 truncate">{stats.modelName}</span>
            {stats.effort === null ? null : <Effort effort={stats.effort} />}
            {stats.fastMode ? (
              <ZapIcon aria-label={gt("Fast mode")} className="size-3.5 shrink-0 fill-foreground" />
            ) : null}
          </span>
        )}
        {context === null ? null : stats.contextPercent === null ? (
          // No known maximum, so no ring: the count stands in for it.
          <Stat
            label={gt("Context {context} tokens", { context })}
            className="@max-[20rem]/dials:hidden"
          >
            <span className="font-medium text-foreground">
              {gt("context", { $context: "model context window" })}
            </span>
            {context}
          </Stat>
        ) : (
          <Dial
            percent={stats.contextPercent}
            kind="context"
            name={gt("context", { $context: "model context window" })}
            detail={context}
            label={gt("Context {percent}% used, {context} tokens", {
              percent: stats.contextPercent,
              context,
            })}
          />
        )}
        {stats.fiveHour === null ? null : (
          <LimitDial
            limit={stats.fiveHour}
            nowMs={nowMs}
            name="5h"
            title={gt("5-hour limit")}
            className="@max-[4rem]/dials:hidden"
          />
        )}
        {stats.weekly === null ? null : (
          <LimitDial
            limit={stats.weekly}
            nowMs={nowMs}
            name={gt("week", { $context: "weekly usage limit" })}
            title={gt("Weekly limit")}
            className="@max-[6.5rem]/dials:hidden"
          />
        )}
        {uptime === null ? null : (
          <>
            <span aria-hidden className="h-4 w-px shrink-0 bg-border @max-[29rem]/dials:hidden" />
            <Stat label={gt("Uptime {uptime}", { uptime })} className="@max-[29rem]/dials:hidden">
              <TimerIcon />
              {uptime}
            </Stat>
          </>
        )}
        {stats.cachePercent === null ? null : (
          <Stat
            label={gt("Cache hits {percent}%", { percent: stats.cachePercent })}
            className="@max-[37rem]/dials:hidden"
          >
            <DatabaseIcon />
            {stats.cachePercent}%
          </Stat>
        )}
        {stats.inputTokens === null ? null : (
          <Stat
            label={gt("{input} tokens in, {output} out", {
              input: stats.inputTokens,
              output: stats.outputTokens ?? 0,
            })}
            className="@max-[44rem]/dials:hidden"
          >
            <ArrowDownIcon />
            {formatStatusLineTokens(stats.inputTokens)}
            <ArrowUpIcon />
            {formatStatusLineTokens(stats.outputTokens ?? 0)}
          </Stat>
        )}
      </div>
    </div>
  );
}

function Fact(props: {
  readonly name: string;
  readonly meter?: {
    readonly percent: number;
    readonly kind: "context" | "limit";
    readonly projectedRemainingPercent?: number | null;
  };
  readonly dimmed?: boolean;
  readonly details?: ReadonlyArray<string>;
  readonly children: ReactNode;
}) {
  return (
    <div className={`grid min-w-0 content-start gap-0.5 ${props.dimmed ? "opacity-50" : ""}`}>
      <span className="text-2xs text-muted-foreground">{props.name}</span>
      <span className="break-words font-medium">{props.children}</span>
      {props.meter === undefined ? null : (
        <span
          aria-hidden
          className="mt-0.5 h-1 overflow-hidden rounded-full bg-current/20"
          style={{
            color: gaugeColor(
              props.meter.percent,
              props.meter.kind,
              props.meter.projectedRemainingPercent,
            ),
          }}
        >
          <span
            className="block h-full rounded-full bg-current"
            style={{ width: `${Math.min(100, props.meter.percent)}%` }}
          />
        </span>
      )}
      {props.details?.map((detail) => (
        <span key={detail} className="text-2xs break-words text-muted-foreground tabular-nums">
          {detail}
        </span>
      ))}
    </div>
  );
}

function LimitFact(props: {
  readonly name: string;
  readonly limit: StatusLineLimit;
  readonly nowMs: number;
}) {
  const gt = useGT();
  const note = limitNote(props.limit, props.nowMs, useMessages());
  const { remainingPercent, projectedRemainingPercent, depletionRatioPercent } = props.limit;
  return (
    <Fact
      name={props.name}
      meter={{ percent: remainingPercent, kind: "limit", projectedRemainingPercent }}
      dimmed={statusLineLimitEnded(props.limit, props.nowMs)}
      details={[
        ...(note === "" ? [] : [note]),
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
      <span className="tabular-nums">
        {gt("{percent}% remaining", { percent: remainingPercent })}
      </span>
    </Fact>
  );
}

/** Every value by name, with the folder and version the strip leaves out. */
export function StatusDialCard(props: {
  readonly stats: StatusLineStats;
  readonly createdAt: string | null;
  readonly nowMs: number;
}) {
  const gt = useGT();
  const { stats, nowMs } = props;
  const uptime = statusLineUptime(props.createdAt, nowMs);
  const model = [stats.modelName, stats.effort, stats.fastMode ? "fast" : null].filter(Boolean);
  return (
    <div className="grid gap-3 tabular-nums">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-x-6 gap-y-3">
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
              : ` of ${formatStatusLineTokens(stats.contextMaxTokens)}`}
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
        {model.length === 0 ? null : <Fact name={gt("Model")}>{model.join(" · ")}</Fact>}
      </div>
      {stats.cwd === null && stats.version === null ? null : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2 text-2xs text-muted-foreground">
          {stats.cwd === null ? null : (
            <span className="flex min-w-0 items-center gap-1">
              <FolderIcon className="size-3 shrink-0" />
              <span className="break-all">{stats.cwd}</span>
            </span>
          )}
          {stats.version === null ? null : <span>version {stats.version}</span>}
        </div>
      )}
    </div>
  );
}

export function StatusLineModelUsage({
  source,
}: {
  readonly source: StatusLineUsageSource & { readonly cwd: string | null };
}) {
  const gt = useGT();
  const providers = buildStatusLineModelUsage({
    ...source,
    providers: resolveProvidersForCwd(source.providers, source.cwd),
  });
  if (providers.length === 0) return null;
  return (
    <section aria-label={gt("All models")} className="mt-3 grid gap-3 border-t pt-3 tabular-nums">
      <h3 className="font-semibold">{gt("All models")}</h3>
      {providers.map((provider) => (
        <div key={provider.instanceId} className="grid gap-1.5">
          <h4 className="font-medium">{provider.name}</h4>
          <p className="break-words text-2xs text-muted-foreground">
            {provider.models.join(" · ")}
          </p>
          {provider.limits.length === 0 ? (
            <p className="text-2xs text-muted-foreground">{gt("Usage limits unavailable")}</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] gap-x-6 gap-y-2">
              {provider.limits.map((limit) => (
                <LimitFact
                  key={limit.id}
                  name={[limit.label, ...limit.scope].join(" · ")}
                  limit={limit}
                  nowMs={source.nowMs}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
