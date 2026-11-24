import { resolveProvidersForCwd } from "@t3tools/client-runtime/providerSkills";
import { msg, useGT, useMessages } from "gt-react";
import {
  buildStatusLineModelUsage,
  formatStatusLineTokens,
  statusLineCacheRisk,
  statusLineQuotaColorPercent,
  statusLineGaugePercent,
  statusLineGaugeTickRotation,
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
  ClockIcon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { observeResize } from "~/lib/observeResize";
import type { MessageResolver } from "../../i18n/messages";

import { APP_VERSION } from "../../branding";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { statusCacheColor, statusDialColor, statusEffortColor } from "./statusLineColors";

function limitNote(limit: StatusLineLimit, nowMs: number, resolve: MessageResolver): string {
  if (statusLineLimitEnded(limit, nowMs)) return resolve(msg("window ended"));
  const left = statusLineLimitRemaining(limit, nowMs);
  return left === null ? "" : resolve(msg("resets in {time}", { time: left }));
}

function Ring(props: {
  readonly percent: number;
  readonly colorPercent: number;
  readonly projectedRemainingPercent?: number | null;
}) {
  return (
    <svg viewBox="0 0 26 26" className="size-[26px] shrink-0" aria-hidden>
      <circle
        cx="13"
        cy="13"
        r="10.5"
        fill="none"
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
        fill={statusDialColor(props.colorPercent, "text")}
        className={`font-semibold ${props.percent === 100 ? "text-4xs" : "text-3xs"}`}
      >
        {props.percent}
      </text>
    </svg>
  );
}

/** A ring filled to `percent` with the number inside, then what it measures and a detail. */
function Dial(props: {
  readonly percent: number;
  readonly colorPercent: number;
  readonly projectedRemainingPercent?: number | null;
  readonly name: ReactNode;
  readonly detail: ReactNode;
  readonly label: string;
  readonly dimmed?: boolean;
}) {
  const percent = statusLineGaugePercent(props.percent);
  return (
    <span
      role="img"
      aria-label={props.label}
      className={`flex shrink-0 items-center gap-1.5 ${props.dimmed ? "opacity-50" : ""}`}
      style={{ color: statusDialColor(props.colorPercent, "ring") }}
    >
      <Ring
        percent={percent}
        projectedRemainingPercent={props.projectedRemainingPercent ?? null}
        colorPercent={props.colorPercent}
      />
      <span className="grid">
        <span className="font-medium text-2xs/3.5 text-foreground">{props.name}</span>
        {props.detail === null ? null : (
          <span className="flex items-center gap-0.5 text-3xs/3 text-muted-foreground [&_svg]:size-2.5">
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
  readonly name: ReactNode;
  readonly title: string;
}) {
  const gt = useGT();
  const left = statusLineLimitRemaining(props.limit, props.nowMs);
  const risk = statusLineQuotaColorPercent(props.limit, props.nowMs);
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
      colorPercent={risk}
      projectedRemainingPercent={projectedRemainingPercent}
      name={
        <>
          {props.name}
          {left !== null && depletionRatioPercent !== undefined ? (
            <span className="ms-1 text-3xs text-muted-foreground">{depletionRatioPercent}%</span>
          ) : null}
        </>
      }
      detail={
        left === null ? null : (
          <>
            <RotateCwIcon />
            <span style={{ color: statusDialColor(risk, "text") }}>{left}</span>
          </>
        )
      }
      label={[props.title, remaining, note, projected, depletionRatio].filter(Boolean).join(", ")}
      dimmed={statusLineLimitEnded(props.limit, props.nowMs)}
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

function CompactLabel(props: { readonly label: string; readonly short: string }) {
  return (
    <>
      <span className="@max-[58rem]/dials:hidden">{props.label}</span>
      <span className="@min-[58rem]/dials:hidden">{props.short}</span>
    </>
  );
}

function useStatusDialVisibility(hasContext: boolean, weeklyKey: string, hasFiveHour: boolean) {
  const rowRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<HTMLSpanElement>(null);
  const weeklyRef = useRef<HTMLSpanElement>(null);
  const fiveHourRef = useRef<HTMLSpanElement>(null);
  const [visibility, setVisibility] = useState({
    weekly: Number.POSITIVE_INFINITY,
    fiveHour: true,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures rendered dial widths to keep weekly ahead of the 5-hour dial
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    const context = hasContext ? contextRef.current : null;
    const weekly = weeklyKey === "" ? [] : Array.from(weeklyRef.current?.children ?? []);
    const { current: fiveHour } = fiveHourRef;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      const width = (element: Element | null) =>
        element === null ? 0 : element.getBoundingClientRect().width + gap;
      let room = row.getBoundingClientRect().width + gap - width(context);
      let showWeekly = 0;
      for (const dial of weekly) {
        const dialWidth = width(dial);
        if (dialWidth > room) break;
        room -= dialWidth;
        showWeekly += 1;
      }
      const showFiveHour = hasFiveHour && width(fiveHour) <= room;
      setVisibility((previous) =>
        previous.weekly === showWeekly && previous.fiveHour === showFiveHour
          ? previous
          : { weekly: showWeekly, fiveHour: showFiveHour },
      );
    };
    measure();
    const elements = [row, context, ...weekly, fiveHour].filter((element) => element !== null);
    return observeResize(elements, measure);
  }, [hasContext, weeklyKey, hasFiveHour]);
  return { rowRef, contextRef, weeklyRef, fiveHourRef, visibility };
}

const HIDDEN_DIAL = "invisible pointer-events-none absolute left-0 top-0 w-max";

export function StatusDialStrip(props: {
  readonly stats: StatusLineStats;
  readonly createdAt: string | null;
  readonly nowMs: number;
}) {
  const gt = useGT();
  const { stats, nowMs } = props;
  const uptime = statusLineUptime(props.createdAt, nowMs);
  const context = stats.contextTokens === null ? null : formatStatusLineTokens(stats.contextTokens);
  const weeklyLimits =
    stats.weekly === null ? stats.weeklyAccounts : [{ ...stats.weekly, id: "weekly", label: null }];
  const weeklyKey = weeklyLimits.map((limit) => limit.id).join("\n");
  const { rowRef, contextRef, weeklyRef, fiveHourRef, visibility } = useStatusDialVisibility(
    context !== null,
    weeklyKey,
    stats.fiveHour !== null,
  );
  const contextName = (
    <CompactLabel
      label={gt("context", { $context: "model context window" })}
      short={gt("ctx", { $context: "short label for model context" })}
    />
  );
  const threadWeeklyUsage = stats.threadWeeklyUsage;
  const fastLabel =
    stats.fastMode === null ? null : stats.fastMode ? gt("Fast mode on") : gt("Fast mode off");
  return (
    <div className="@container/dials">
      <div
        ref={rowRef}
        className="relative flex items-center gap-2 overflow-hidden whitespace-nowrap tabular-nums"
      >
        {context === null ? null : (
          <span ref={contextRef} className="shrink-0">
            {stats.contextPercent === null ? (
              <Stat label={gt("Context {context} tokens", { context })} className="">
                {contextName}
                {context}
              </Stat>
            ) : (
              <Dial
                percent={stats.contextPercent}
                colorPercent={stats.contextPercent}
                name={contextName}
                detail={context}
                label={gt("Context {percent}% used, {context} tokens", {
                  percent: statusLineGaugePercent(stats.contextPercent),
                  context,
                })}
              />
            )}
          </span>
        )}
        {stats.fiveHour === null ? null : (
          <span ref={fiveHourRef} className={visibility.fiveHour ? "shrink-0" : HIDDEN_DIAL}>
            <LimitDial limit={stats.fiveHour} nowMs={nowMs} name="5h" title={gt("5-hour limit")} />
          </span>
        )}
        <span ref={weeklyRef} className="contents">
          {weeklyLimits.map((limit, index) => {
            const account = limit.label === null ? "" : ` · ${limit.label}`;
            return (
              <span key={limit.id} className={index < visibility.weekly ? "shrink-0" : HIDDEN_DIAL}>
                <LimitDial
                  limit={limit}
                  nowMs={nowMs}
                  name={
                    <CompactLabel
                      label={gt("week", { $context: "weekly usage limit" }) + account}
                      short={gt("wk", { $context: "short label for weekly usage" }) + account}
                    />
                  }
                  title={gt("Weekly limit") + account}
                />
              </span>
            );
          })}
        </span>
        {threadWeeklyUsage === null ? null : (
          <Stat
            label={gt("Estimated thread share of weekly limit")}
            className="@max-[14rem]/dials:hidden"
          >
            {threadWeeklyUsage}
          </Stat>
        )}
        {uptime === null ? null : (
          <Stat label={gt("Uptime {uptime}", { uptime })} className="@max-[17rem]/dials:hidden">
            <TimerIcon />
            {uptime}
          </Stat>
        )}
        {stats.cachePercent === null ? null : (
          <Stat
            label={gt("Cache hits {percent}%", { percent: Math.round(stats.cachePercent) })}
            className="@max-[21rem]/dials:hidden"
          >
            <DatabaseIcon />
            <span style={{ color: statusCacheColor(statusLineCacheRisk(stats.cachePercent)) }}>
              {Math.round(stats.cachePercent)}%
            </span>
          </Stat>
        )}
        {stats.inputTokens === null || stats.outputTokens === null ? null : (
          <Stat
            label={gt("{input} tokens in, {output} out", {
              input: stats.inputTokens,
              output: stats.outputTokens,
            })}
            className="@max-[27rem]/dials:hidden"
          >
            <ArrowDownIcon />
            {formatStatusLineTokens(stats.inputTokens)}
            <ArrowUpIcon />
            {formatStatusLineTokens(stats.outputTokens)}
          </Stat>
        )}
        {stats.apiTime === null ? null : (
          <Stat label={gt("API time")} className="@max-[31rem]/dials:hidden">
            <ClockIcon />
            {stats.apiTime}
          </Stat>
        )}
        {fastLabel === null ? null : (
          <Stat label={fastLabel} className="@max-[35rem]/dials:hidden">
            {fastLabel}
          </Stat>
        )}
        {stats.outputStyle === null ? null : (
          <Stat label={gt("Output style")} className="@max-[42rem]/dials:hidden">
            {stats.outputStyle}
          </Stat>
        )}
        <Stat label={gt("HomuCode version")} className="@max-[48rem]/dials:hidden">
          v{APP_VERSION}
        </Stat>
        {stats.version === null ? null : (
          <Stat label={gt("Provider version")} className="@max-[55rem]/dials:hidden">
            v{stats.version}
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
    readonly color: string;
  };
  readonly dimmed?: boolean;
  readonly note?: ReactNode;
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
          style={{ color: props.meter.color }}
        >
          <span
            className="block h-full rounded-full bg-current"
            style={{ width: `${Math.min(100, props.meter.percent)}%` }}
          />
        </span>
      )}
      {props.note === undefined ? null : <span className="text-2xs">{props.note}</span>}
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
  const risk = statusLineQuotaColorPercent(props.limit, props.nowMs);
  const textColor = statusDialColor(risk, "text");
  const { remainingPercent, projectedRemainingPercent, depletionRatioPercent } = props.limit;
  return (
    <Fact
      name={props.name}
      meter={{ percent: remainingPercent, color: statusDialColor(risk, "ring") }}
      dimmed={statusLineLimitEnded(props.limit, props.nowMs)}
      note={note === "" ? undefined : <span style={{ color: textColor }}>{note}</span>}
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
      <span className="tabular-nums" style={{ color: textColor }}>
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
  const threadWeeklyUsage = stats.threadWeeklyUsage;
  const uptime = statusLineUptime(props.createdAt, nowMs);
  return (
    <div className="grid gap-3 tabular-nums">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-x-6 gap-y-3">
        {stats.contextTokens === null ? null : (
          <Fact
            name={gt("Context", { $context: "model context window" })}
            {...(stats.contextPercent === null
              ? {}
              : {
                  meter: {
                    percent: stats.contextPercent,
                    color: statusDialColor(stats.contextPercent, "ring"),
                  },
                })}
          >
            {stats.contextPercent === null ? null : (
              <span style={{ color: statusDialColor(stats.contextPercent, "text") }}>
                {`${statusLineGaugePercent(stats.contextPercent)}% · `}
              </span>
            )}
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
        {stats.weeklyAccounts.map((limit) => (
          <LimitFact
            key={limit.id}
            name={`${gt("Weekly limit")} · ${limit.label}`}
            limit={limit}
            nowMs={nowMs}
          />
        ))}
        {threadWeeklyUsage === null ? null : (
          <Fact
            name={gt("Estimated thread share of weekly limit")}
            details={[
              gt("Recorded main-agent usage for the current provider thread."),
              ...(stats.threadWeeklyUsagePartial
                ? [gt("Some turns could not be priced in full.")]
                : []),
            ]}
          >
            {threadWeeklyUsage}
          </Fact>
        )}
        {uptime === null ? null : <Fact name={gt("Uptime")}>{uptime}</Fact>}
        {stats.cachePercent === null ? null : (
          <Fact name={gt("Cache hits")}>
            <span style={{ color: statusCacheColor(statusLineCacheRisk(stats.cachePercent)) }}>
              {Math.round(stats.cachePercent)}%
            </span>
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
                <span style={{ color: statusEffortColor(stats.effort) }}>{stats.effort}</span>
              </>
            )}
          </Fact>
        )}
        <Fact name={gt("HomuCode version")}>{APP_VERSION}</Fact>
        {stats.version === null ? null : <Fact name={gt("Provider version")}>{stats.version}</Fact>}
      </div>
      {stats.cwd === null ? null : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2 text-2xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1">
            <FolderIcon className="size-3 shrink-0" />
            <span className="break-all">{stats.cwd}</span>
          </span>
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
  const showModelNames = useClientSettings((settings) => settings.statusLineShowModelNames);
  const modelNamesLabel = gt("Show model names");
  const providers = buildStatusLineModelUsage({
    ...source,
    providers: resolveProvidersForCwd(source.providers, source.cwd),
  });
  if (providers.length === 0) return null;
  return (
    <section aria-label={gt("All models")} className="mt-3 grid gap-3 border-t pt-3 tabular-nums">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 className="font-semibold">{gt("All models")}</h3>
        <label className="flex items-center gap-2 text-2xs text-muted-foreground">
          {modelNamesLabel}
          <Switch
            size="sm"
            aria-label={modelNamesLabel}
            checked={showModelNames}
            onCheckedChange={(statusLineShowModelNames) =>
              void updateClientSettings({ statusLineShowModelNames })
            }
          />
        </label>
      </div>
      {providers.map((provider) => (
        <div key={provider.instanceId} className="grid gap-1.5">
          <h4 className="font-medium">{provider.name}</h4>
          {showModelNames && provider.models.length > 0 ? (
            <p className="break-words text-2xs text-muted-foreground">
              {provider.models.join(" · ")}
            </p>
          ) : null}
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
