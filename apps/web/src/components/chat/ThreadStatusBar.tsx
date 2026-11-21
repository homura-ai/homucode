import { useGT } from "gt-react";
import { createPresenceFlag } from "./presenceFlag";
import { isManagedSettingPath, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import {
  type AnsiSegment,
  buildStatusLineInput,
  buildStatusLineStats,
  expandStatusLineLabel,
  parseAnsiLines,
  reserveStatusLineText,
  splitStatusLineItems,
  stampStatusLineInput,
  statusLineInputModelName,
  type StatusLineColorRole,
  statusLineColorRole,
  type StatusLineInputSource,
  type StatusLineItem,
  type StatusLineStats,
  type StatusLineUsageSource,
} from "@t3tools/client-runtime/status-line";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  type CSSProperties,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { useClientSettings, usePrimarySettings } from "../../hooks/useSettings";
import { formatShortTimestamp } from "../../timestampFormat";
import { observeResize } from "~/lib/observeResize";
import { serverEnvironment } from "../../state/server";
import { StatusLineBurnTauControl } from "../settings/StatusLineBurnTauControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { StatusDialCard, StatusDialStrip, StatusLineModelUsage } from "./ThreadStatusDials";

// Claude Code redraws on events; the timer keeps clocks and countdowns current while idle.
const REFRESH_MS = 30_000;
const DEBOUNCE_MS = 300;
const RETRY_MS = 2_000;

// A custom command's output is drawn as text; without one the client draws the stats itself.
type StatusLineResult =
  | {
      readonly lines: ReadonlyArray<ReadonlyArray<AnsiSegment>>;
      readonly error: string | null;
      /** The name the script was given, to write out where the line shortens it. */
      readonly modelName: string | null;
    }
  | {
      readonly stats: StatusLineStats;
      readonly createdAt: string | null;
      readonly environmentId: EnvironmentId;
    };

// The runner sits in the chat view, which has its input; the top bar reads the result from here.
const emptyAccountingAtom = Atom.make(AsyncResult.success(null));

const statusLineResultAtom = Atom.family((_key: string | undefined) =>
  Atom.make<StatusLineResult | null>(null),
);

// Scripts pick terminal colors; each takes the theme color with the same meaning.
const ROLE_COLORS: Record<StatusLineColorRole, string | null> = {
  foreground: null,
  muted: "var(--muted-foreground)",
  error: "var(--error-foreground)",
  warning: "var(--warning-foreground)",
  success: "var(--success-foreground)",
  info: "var(--info-foreground)",
  accent: "var(--ring)",
};

function segmentStyle(segment: AnsiSegment): CSSProperties | undefined {
  const color = segment.color === null ? null : ROLE_COLORS[statusLineColorRole(segment.color)];
  if (
    color === null &&
    segment.background === null &&
    !segment.bold &&
    !segment.dim &&
    !segment.italic &&
    !segment.underline
  ) {
    return undefined;
  }
  return {
    ...(color === null ? {} : { color }),
    ...(segment.background === null ? {} : { backgroundColor: "var(--muted)" }),
    ...(segment.bold ? { fontWeight: 600 } : {}),
    ...(segment.dim ? { opacity: 0.6 } : {}),
    ...(segment.italic ? { fontStyle: "italic" } : {}),
    ...(segment.underline ? { textDecoration: "underline" } : {}),
  };
}

const PERCENT_PATTERN = /(\d+(?:\.\d+)?)%/g;

// Trims the label's box to its digits, so centering it centers what is seen.
const BAR_LABEL = "col-start-1 row-start-1 hidden [text-box:trim-both_cap_alphabetic] leading-none";
const BAR_FILL = "color-mix(in oklab, currentColor 40%, transparent)";

/**
 * A percentage as `8% [bar]`. In a tight line the label moves inside the bar, where it keeps the
 * line's baseline. An empty bar has no baseline, so it is raised to sit centered on the digits.
 * The fill is a background, not a positioned box, which would still paint where the line is cut.
 */
function Percent(props: { readonly value: string }) {
  const filled = `${Math.min(100, Number(props.value))}%`;
  return (
    <>
      <span className="group-data-[room=tight]/status-line:hidden">{props.value}% </span>
      <span
        className="inline-grid h-4 w-8 place-items-center rounded-xs bg-current/25 align-[calc((1cap-1rem)/2)] group-data-[room=tight]/status-line:w-auto group-data-[room=tight]/status-line:px-1.5 group-data-[room=tight]/status-line:align-baseline"
        style={{
          backgroundImage: `linear-gradient(90deg, ${BAR_FILL} ${filled}, transparent ${filled})`,
        }}
      >
        <span
          aria-hidden
          className={`invisible ${BAR_LABEL} group-data-[room=tight]/status-line:block`}
        >
          100%
        </span>
        <span className={`${BAR_LABEL} group-data-[room=tight]/status-line:block`}>
          {props.value}%
        </span>
      </span>
    </>
  );
}

function SegmentText(props: { readonly text: string }) {
  const parts = props.text.split(PERCENT_PATTERN);
  if (parts.length === 1) return props.text;
  return parts.map((part, index) =>
    // oxlint-disable-next-line react/no-array-index-key -- parts have no identity beyond order
    index % 2 === 1 ? <Percent key={index} value={part} /> : part,
  );
}

/**
 * Styled text. A line with room writes abbreviated labels and the model name out. `reserved` gives
 * each changing value its room instead, which is how an item measures the room to hold.
 */
function Segments(props: {
  readonly line: ReadonlyArray<AnsiSegment>;
  readonly modelName?: string | null;
  readonly reserved?: boolean;
}) {
  return props.line.map((segment, segmentIndex) => {
    const expanded = expandStatusLineLabel(segment, props.modelName);
    return (
      <span
        // oxlint-disable-next-line react/no-array-index-key -- segments have no identity beyond order
        key={segmentIndex}
        style={segmentStyle(segment)}
      >
        {expanded === null ? (
          <SegmentText text={props.reserved ? reserveStatusLineText(segment) : segment.text} />
        ) : (
          <>
            <span className="group-data-[labels=long]/status-line:hidden">{segment.text}</span>
            <span className="hidden group-data-[labels=long]/status-line:inline">{expanded}</span>
          </>
        )}
      </span>
    );
  });
}

// The gap after an item grows with the room the line has.
const ITEM_GAP =
  "pe-1.5 group-data-[room=normal]/status-line:pe-2.5 group-data-[room=wide]/status-line:pe-3.5";

// Indexed by drop level: what hides an item dropped at that level, and what shows a separator.
const DROPPED = [
  "",
  "group-data-[drop=1]/status-line:hidden group-data-[drop=2]/status-line:hidden group-data-[drop=3]/status-line:hidden",
  "group-data-[drop=2]/status-line:hidden group-data-[drop=3]/status-line:hidden",
  "group-data-[drop=3]/status-line:hidden",
];
const SHOWN = [
  "group-data-[drop=0]/status-line:inline",
  "group-data-[drop=1]/status-line:inline",
  "group-data-[drop=2]/status-line:inline",
  "group-data-[drop=3]/status-line:inline",
];

// A ` |` stands between two parts of the line, so it keeps the item gap on both sides.
const PIPE_GAP =
  "ps-1.5 group-data-[room=normal]/status-line:ps-2.5 group-data-[room=wide]/status-line:ps-3.5";

/** The separator after an item, which depends on what the line has dropped. */
function Separator(props: { readonly item: StatusLineItem }) {
  const { separators } = props.item;
  // Levels that share a separator share its array, so a Set leaves one span for each.
  return [...new Set(separators)].map((separator, index) => {
    if (separator.length === 0) return null;
    const shown = SHOWN.filter((_, level) => separators[level] === separator).join(" ");
    const pipe = separator.some((segment) => segment.text.includes("|")) ? PIPE_GAP : "";
    return (
      <span
        // oxlint-disable-next-line react/no-array-index-key -- separators have no identity beyond order
        key={index}
        className={`hidden ${shown} ${pipe}`}
      >
        <Segments line={separator} />
      </span>
    );
  });
}

/**
 * One item in a slot of fixed width: an invisible copy with room for its values to change shares
 * the slot, so the items after it stay put while this one's value changes.
 */
function StatusLineSlot(props: {
  readonly item: StatusLineItem;
  readonly modelName: string | null;
}) {
  return (
    <span
      data-status-line-item="value"
      className={`inline-grid ${ITEM_GAP} ${DROPPED[props.item.dropAt]}`}
    >
      <span className="col-start-1 row-start-1">
        <Segments line={props.item.segments} modelName={props.modelName} />
        <Separator item={props.item} />
      </span>
      <span aria-hidden className="invisible col-start-1 row-start-1">
        <Segments line={props.item.segments} modelName={props.modelName} reserved />
        <Separator item={props.item} />
      </span>
    </span>
  );
}

// From roomiest to tightest: labels written out or short, how much room the gaps take, how many
// low-priority items are dropped, and whether the directory may shorten. Tight also moves
// percentages inside their bars.
const FITS = [
  ["long", "wide", 0, false],
  ["long", "normal", 0, false],
  ["short", "normal", 0, false],
  ["short", "normal", 1, false],
  ["short", "normal", 2, false],
  ["short", "normal", 2, true],
  ["short", "normal", 3, true],
  ["short", "tight", 3, true],
] as const;

// What a shortened directory keeps: room for a name or two.
const DIRECTORY_FLOOR_PX = 72;

function itemsWidth(row: HTMLElement, kind: string): number {
  let width = 0;
  for (const item of row.querySelectorAll(`[data-status-line-item="${kind}"]`))
    width += item.getBoundingClientRect().width;
  return width;
}

// A theme can give the top bar its own font; the status line keeps the app's normal one.
function keepBodyFont(element: HTMLElement | null | undefined) {
  if (!element) return;
  const fontFamily = getComputedStyle(document.body).fontFamily;
  if (element.style.fontFamily !== fontFamily) element.style.fontFamily = fontFamily;
}

// Picks the roomiest fit the line has room for, cutting the tail if needed.
function fitRow(row: HTMLElement) {
  // The row's effect runs before its parent's, so the font is set here, ahead of measuring.
  keepBodyFont(row.parentElement);
  // A pixel short of the edge, so rounding never clips the last item.
  const space = row.getBoundingClientRect().width - 1;
  for (const [labels, room, drop, shorten] of FITS) {
    row.dataset.labels = labels;
    row.dataset.room = room;
    row.dataset.drop = String(drop);
    const directory = itemsWidth(row, "directory");
    const rest = itemsWidth(row, "value");
    const floor = Math.min(directory, DIRECTORY_FLOOR_PX);
    row.style.setProperty("--status-line-directory-floor", `${floor}px`);
    if ((shorten ? floor : directory) + rest <= space) return;
  }
}

function StatusLineRow(props: {
  readonly items: ReadonlyArray<StatusLineItem>;
  readonly modelName: string | null;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-measures each new line to fit it
  useLayoutEffect(() => {
    if (rowRef.current !== null) fitRow(rowRef.current);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-measures when the row's width changes
  useEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    return observeResize(row, () => fitRow(row));
  }, []);
  const { items } = props;
  const directory = items[0]?.kind === "directory" ? items[0] : null;
  return (
    <div
      ref={rowRef}
      className="group/status-line flex min-w-0 items-baseline overflow-hidden whitespace-pre tabular-nums"
    >
      {directory === null ? null : (
        <>
          <div
            className={`min-w-(--status-line-directory-floor) shrink-[9999] overflow-hidden text-ellipsis ${DROPPED[directory.dropAt]}`}
          >
            <span data-status-line-item="directory">
              <Segments line={directory.segments} />
            </span>
          </div>
          <div
            data-status-line-item="value"
            className={`shrink-0 ${ITEM_GAP} ${DROPPED[directory.dropAt]}`}
          >
            <Separator item={directory} />
          </div>
        </>
      )}
      <div className="min-w-0 overflow-hidden text-ellipsis">
        {items.map((item, index) =>
          item === directory ? null : (
            <StatusLineSlot
              // oxlint-disable-next-line react/no-array-index-key -- items have no identity beyond order
              key={index}
              item={item}
              modelName={props.modelName}
            />
          ),
        )}
      </div>
    </div>
  );
}

/** Runs the environment's status line command for a thread, the way Claude Code draws its status line. */
export function ThreadStatusLineRunner(props: {
  readonly statusLineKey: string;
  readonly environmentId: EnvironmentId;
  readonly createdAt: string | null;
  readonly source: Omit<StatusLineInputSource, "nowMs">;
}) {
  const { environmentId, createdAt } = props;
  const enabled = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) =>
      config?.environment.capabilities.statusLine === true &&
      config.settings.statusLineEnabled !== false,
  );
  const custom = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => (config?.settings.statusLineCommand ?? "") !== "",
  );
  const showSessionDepletionRatio = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.settings.statusLineShowSessionDepletionRatio === true,
  );
  const showWeeklyDepletionRatio = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.settings.statusLineShowWeeklyDepletionRatio === true,
  );
  const accountingSupported = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.statusLineAccounting === true,
  );
  const useApiPrice = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.settings.statusLineUseApiPrice === true,
  );
  const accounting = useAtomValue(
    enabled && accountingSupported
      ? serverEnvironment.statusLineAccounting({
          environmentId,
          input: { threadId: ThreadId.make(props.source.threadId) },
        })
      : emptyAccountingAtom,
    (result) => AsyncResult.getOrElse(result, () => null),
  );
  const registry = useContext(RegistryContext);
  // Limits are read on the minute so the key, and with it the command, only changes on new data.
  const source = {
    ...props.source,
    nowMs: useNowMinuteMs(),
    showSessionDepletionRatio,
    showWeeklyDepletionRatio,
    accounting,
    useApiPrice,
  };
  // Only the mode in use reads the thread's state; the other key stays empty.
  const inputKey = custom ? JSON.stringify(buildStatusLineInput(source)) : "";
  const statsKey = custom ? "" : JSON.stringify(buildStatusLineStats(source));
  const modelName = statusLineInputModelName(props.source);
  const resultAtom = statusLineResultAtom(props.statusLineKey);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the server's status line command
  useEffect(() => {
    if (!enabled) {
      registry.set(resultAtom, null);
      return;
    }
    if (!custom) {
      // Parsed back from the key, which is what tells the effect the stats changed.
      const stats: StatusLineStats = JSON.parse(statsKey);
      registry.set(resultAtom, { stats, createdAt, environmentId });
      return;
    }
    // Dials left from before a command was set go at once, not when its first draw lands.
    const shown = registry.get(resultAtom);
    if (shown !== null && "stats" in shown) registry.set(resultAtom, null);
    let cancelled = false;
    // The first draw can land before the environment reconnects; it retries without waiting a refresh.
    let quickRetries = 5;
    let timer: number | undefined;
    const draw = async () => {
      let delay = REFRESH_MS;
      if (document.visibilityState !== "hidden") {
        const input = stampStatusLineInput(JSON.parse(inputKey), createdAt, Date.now());
        const response = await runAtomCommand(
          registry,
          serverEnvironment.renderStatusLine,
          { environmentId, input: { input } },
          { reportFailure: false },
        );
        if (cancelled) return;
        if (response._tag === "Success") {
          registry.set(resultAtom, {
            lines: parseAnsiLines(response.value.text),
            error: response.value.error ?? null,
            modelName,
          });
        } else if (quickRetries > 0) {
          quickRetries = quickRetries - 1;
          delay = RETRY_MS;
        }
      }
      timer = window.setTimeout(() => void draw(), delay);
    };
    timer = window.setTimeout(() => void draw(), DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    enabled,
    custom,
    inputKey,
    statsKey,
    modelName,
    createdAt,
    environmentId,
    resultAtom,
    registry,
  ]);

  return null;
}

// Under the top bar, which is the positioned ancestor. The strip before it bridges the gap above,
// so the pointer can reach the panel from the line.
const PANEL =
  "absolute top-full z-50 rounded-md rounded-t-none border border-t-0 bg-popover text-popover-foreground shadow-lg before:absolute before:inset-x-0 before:bottom-full before:h-6";

function LocalHeaderTime() {
  const now = new Date(useNowMinuteMs()).toISOString();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  return <time dateTime={now}>{formatShortTimestamp(now, timestampFormat)}</time>;
}

type HeaderStatusLineUsage = Omit<StatusLineUsageSource, "nowMs"> & {
  readonly cwd: string | null;
};

export const headerStatusLine = createPresenceFlag();

export function ThreadHeaderStatus(props: {
  readonly statusLineKey: string | undefined;
  readonly usage?: HeaderStatusLineUsage | undefined;
}) {
  const result = useAtomValue(statusLineResultAtom(props.statusLineKey));
  const custom = result !== null && "lines" in result ? result : null;
  const items = custom?.lines.flatMap(splitStatusLineItems) ?? [];
  const clock = items.find((item) => item.kind === "clock");
  const values = items.filter((item) => item !== clock);
  const showStatusLine =
    result !== null && (custom === null || values.length > 0 || custom.error !== null);
  return (
    <>
      {showStatusLine ? (
        <HeaderStatusLine
          key={custom === null ? "dials" : "text"}
          result={result}
          items={values}
          usage={props.usage}
        />
      ) : null}
      <span className="ms-auto shrink-0 whitespace-nowrap pe-2 font-sans text-muted-foreground text-2xs tabular-nums">
        {clock === undefined ? <LocalHeaderTime /> : <Segments line={clock.segments} />}
      </span>
    </>
  );
}

function StatusLineBurnControls(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings);
  if (config?.environment.capabilities.statusLineAccounting !== true) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-3 border-t pt-3">
      {(["statusLineSessionBurnTauMinutes", "statusLineWeeklyBurnTauMinutes"] as const).map(
        (setting) => (
          <StatusLineBurnTauControl
            key={setting}
            showLabel
            setting={setting}
            value={config.settings[setting]}
            disabled={!canWrite || isManagedSettingPath(config.managedPolicy, setting)}
            onChange={(minutes) =>
              void update({ environmentId, input: { patch: { [setting]: minutes } } })
            }
          />
        ),
      )}
    </div>
  );
}

function HeaderStatusLine(props: {
  readonly result: StatusLineResult;
  readonly items: ReadonlyArray<StatusLineItem>;
  readonly usage?: HeaderStatusLineUsage | undefined;
}) {
  const gt = useGT();
  headerStatusLine.usePresence();
  const { result } = props;
  const showAllModels = useClientSettings((settings) => settings.statusLineShowAllModels);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Where the line starts in the top bar, which is where the dials' card starts.
  const [left, setLeft] = useState(0);
  const nowMs = useNowMinuteMs();
  const containerRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the theme's font from the page
  useLayoutEffect(() => keepBodyFont(containerRef.current));
  const drawn = "stats" in result;
  const failed = !drawn && result.lines.length === 0;
  const usage = showAllModels && props.usage ? { ...props.usage, nowMs } : null;
  const measure = (line: HTMLElement) => {
    const bar = line.offsetParent?.getBoundingClientRect().left ?? 0;
    setLeft(line.getBoundingClientRect().left - bar);
  };
  // Not positioned itself, so the panel is placed against the whole top bar and opens below it.
  // No-drag, or Electron's title bar drag region swallows the hover.
  return (
    <div
      ref={containerRef}
      data-chat-header-status-line={failed ? "error" : "true"}
      tabIndex={0}
      aria-label={gt("Status line")}
      className="min-w-0 flex-1 rounded-sm text-muted-foreground text-xs outline-none [-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onMouseEnter={(event) => {
        measure(event.currentTarget);
        setHovered(true);
      }}
      // On each move, since the line shifts under the pointer when the title beside it changes.
      onMouseMove={(event) => measure(event.currentTarget)}
      onMouseLeave={() => setHovered(false)}
      onFocus={(event) => {
        // A click focuses it too, and must not pin the panel open.
        if (!event.target.matches(":focus-visible")) return;
        measure(event.currentTarget);
        setFocused(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (event.target !== event.currentTarget) event.currentTarget.focus();
        setHovered(false);
        setFocused(false);
      }}
    >
      {drawn ? (
        <StatusDialStrip stats={result.stats} createdAt={result.createdAt} nowMs={nowMs} />
      ) : failed ? (
        <div className="truncate">{gt("Status line failed: {error}", { error: result.error })}</div>
      ) : (
        <StatusLineRow items={props.items} modelName={result.modelName} />
      )}
      {(!failed || usage !== null) && (hovered || focused) ? (
        <div
          className={`${PANEL} ${drawn ? "w-3xl" : "inset-x-0"}`}
          style={drawn ? { left, maxWidth: `calc(100% - ${left}px - 0.75rem)` } : undefined}
        >
          <div
            role="region"
            aria-label={gt("Status line details")}
            tabIndex={usage === null ? undefined : 0}
            className={`max-h-[min(28rem,60dvh)] overflow-y-auto overscroll-contain ${drawn ? "px-4 py-3" : "px-2 py-1.5"}`}
          >
            {drawn ? (
              <>
                <StatusDialCard stats={result.stats} createdAt={result.createdAt} nowMs={nowMs} />
                <StatusLineBurnControls environmentId={result.environmentId} />
              </>
            ) : (
              <div
                data-labels="long"
                className="group/status-line flex flex-col gap-0.5 tabular-nums"
              >
                {result.lines.map((line, lineIndex) => (
                  // oxlint-disable-next-line react/no-array-index-key -- lines have no identity beyond order
                  <div key={lineIndex} className="whitespace-pre-wrap break-words">
                    <Segments line={line} modelName={result.modelName} />
                  </div>
                ))}
              </div>
            )}
            {usage === null ? null : <StatusLineModelUsage source={usage} />}
          </div>
        </div>
      ) : null}
    </div>
  );
}
