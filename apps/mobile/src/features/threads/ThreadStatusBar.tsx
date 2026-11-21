import { useGT } from "gt-react-native";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { isManagedSettingPath, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import {
  type AnsiSegment,
  buildStatusLineInput,
  buildStatusLineStats,
  parseAnsiLines,
  stampStatusLineInput,
  type StatusLineColorRole,
  statusLineColorRole,
  type StatusLineInputSource,
} from "@t3tools/client-runtime/status-line";
import { AsyncResult, Atom } from "effect/reactivity";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useContext, useEffect, useLayoutEffect, useState, type ReactElement } from "react";
import {
  AppState,
  Platform,
  Pressable,
  useWindowDimensions,
  View,
  type TextStyle,
} from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { StatusLineTypography } from "./StatusLineTypography";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { Sheet } from "../../components/ui/Sheet";
import { useBarOverlap } from "../../components/ui/useBarInset";
import { SetThreadBarInsetConsumed } from "./thread-status-bar-inset";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useThreadContextWindow } from "../../state/entities";
import {
  minimumStatusDialWidth,
  ThreadStatusDialDetails,
  ThreadStatusDialStrip,
} from "./ThreadStatusDials";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { StatusLineBurnTauControl } from "../settings/components/StatusLineBurnTauControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { useNowMinuteMs } from "../../lib/clock";
import type { MobileThemeVariables } from "../../lib/mobileTheme";

// Claude Code redraws on events; the timer keeps clocks and countdowns current while idle.
const REFRESH_MS = 30_000;
const DEBOUNCE_MS = 300;
const emptyAccountingAtom = Atom.make(AsyncResult.success(null));

// Scripts pick terminal colors; each text color takes the theme color with the same meaning.
function roleColors(
  theme: MobileThemeVariables,
  dark: boolean,
): Record<StatusLineColorRole, string | undefined> {
  return {
    foreground: undefined,
    muted: theme["--color-foreground-muted"],
    error: theme["--color-danger-foreground"],
    warning: theme["--color-warning-foreground"],
    // Success and info are not theme roles; these match the web's emerald and blue.
    success: dark ? "#34d399" : "#047857",
    info: dark ? "#60a5fa" : "#1d4ed8",
    accent: theme["--color-focus"],
  };
}

function segmentStyle(
  segment: AnsiSegment,
  colors: Record<StatusLineColorRole, string | undefined>,
  subtle: string,
): TextStyle {
  const color = segment.color === null ? undefined : colors[statusLineColorRole(segment.color)];
  return {
    ...(color === undefined ? {} : { color }),
    ...(segment.background === null ? {} : { backgroundColor: subtle }),
    ...(segment.bold ? { fontWeight: "600" } : {}),
    ...(segment.dim ? { opacity: 0.6 } : {}),
    ...(segment.italic ? { fontStyle: "italic" } : {}),
    ...(segment.underline ? { textDecorationLine: "underline" } : {}),
  };
}

export interface ThreadStatusSource {
  readonly environmentId: EnvironmentId;
  readonly createdAt: string | null;
  readonly thread: ScopedThreadRef | null;
  readonly source: Omit<StatusLineInputSource, "nowMs" | "contextWindow">;
}

function CommandLine(props: {
  readonly line: ReadonlyArray<AnsiSegment>;
  readonly expanded?: boolean;
}) {
  const { themeAppearance, themeVariables } = useAppearancePreferences();
  const colors = roleColors(themeVariables, themeAppearance === "dark");
  return (
    <Text
      numberOfLines={props.expanded ? undefined : 1}
      className="shrink font-mono text-2xs leading-4"
    >
      {props.line.map((segment, index) => (
        <Text
          // oxlint-disable-next-line react/no-array-index-key -- segments have no identity beyond order
          key={index}
          style={segmentStyle(segment, colors, themeVariables["--color-subtle"])}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

function useStatusLineCommand(
  props: ThreadStatusSource,
  source: StatusLineInputSource,
  command: string,
) {
  const { createdAt, environmentId } = props;
  const registry = useContext(RegistryContext);
  const inputKey = command ? JSON.stringify(buildStatusLineInput(source)) : "";
  const sessionKey = `${environmentId}:${source.threadId}`;
  const [result, setResult] = useState<{
    readonly sessionKey: string;
    readonly command: string;
    readonly text: string;
    readonly error: string | null;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the server's custom status line command
  useEffect(() => {
    if (!command) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const draw = async () => {
      if (AppState.currentState === "active") {
        const input = stampStatusLineInput(JSON.parse(inputKey), createdAt, Date.now());
        const response = await runAtomCommand(
          registry,
          serverEnvironment.renderStatusLine,
          { environmentId, input: { input } },
          { reportFailure: false },
        );
        if (cancelled) return;
        if (response._tag === "Success") {
          setResult({
            sessionKey,
            command,
            text: response.value.text,
            error: response.value.error ?? null,
          });
        }
      }
      timer = setTimeout(() => void draw(), REFRESH_MS);
    };
    timer = setTimeout(() => void draw(), DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [command, inputKey, createdAt, environmentId, sessionKey, registry]);

  return command !== "" && result?.sessionKey === sessionKey && result.command === command
    ? result
    : null;
}

export function ThreadStatusBar(
  props: ThreadStatusSource & {
    readonly controlsWidth: number;
    readonly renderHeader: (titleAccessory?: ReactElement) => ReactElement;
  },
) {
  const gt = useGT();
  const { fontScale } = useWindowDimensions();
  const [paneWidth, setPaneWidth] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const enabled =
    config?.environment.capabilities.statusLine === true &&
    config.settings.statusLineEnabled !== false;
  const custom = enabled ? (config.settings.statusLineCommand ?? "") : "";
  const contextWindow = useThreadContextWindow(props.thread);
  const accounting = useAtomValue(
    enabled &&
      props.thread !== null &&
      config?.environment.capabilities.statusLineAccounting === true
      ? serverEnvironment.statusLineAccounting({
          environmentId: props.environmentId,
          input: { threadId: props.thread.threadId },
        })
      : emptyAccountingAtom,
    (result) => AsyncResult.getOrElse(result, () => null),
  );
  const canWrite = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const nowMs = useNowMinuteMs();
  const source = {
    ...props.source,
    contextWindow,
    nowMs,
    accounting,
    useApiPrice: config?.settings.statusLineUseApiPrice === true,
    showWeeklyDepletionRatio: config?.settings.statusLineShowWeeklyDepletionRatio === true,
  };
  const command = useStatusLineCommand(props, source, custom);
  const stats = enabled && !custom ? buildStatusLineStats(source) : null;
  const lines = command === null ? [] : parseAnsiLines(command.text);
  const firstLine = lines.find((line) => line.length > 0);
  const error = firstLine === undefined ? command?.error : null;
  const minimumWidth = stats === null ? 200 : minimumStatusDialWidth(stats, fontScale);
  const titleRoom = 120 * fontScale + 20;
  const inlineRoom = paneWidth - props.controlsWidth - titleRoom;
  const inline = inlineRoom >= minimumWidth;
  const availableWidth = inline ? inlineRoom : paneWidth - 56;
  const canExpand = stats !== null || firstLine !== undefined;
  const barOverlap = useBarOverlap();
  const setBarInsetConsumed = useContext(SetThreadBarInsetConsumed);
  const clearsBar = !inline && Boolean(canExpand || error) && barOverlap > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the sibling feed the fixed status row already cleared the native bar
  useLayoutEffect(() => {
    if (!clearsBar) return;
    setBarInsetConsumed(true);
    return () => setBarInsetConsumed(false);
  }, [clearsBar, setBarInsetConsumed]);
  const strip =
    canExpand || error ? (
      <Pressable
        accessibilityRole={canExpand ? "button" : undefined}
        accessibilityLabel={canExpand ? gt("Status line") : undefined}
        accessibilityState={canExpand ? { expanded } : undefined}
        disabled={!canExpand}
        onPress={() => setExpanded(true)}
        className={`min-w-0 flex-row items-center gap-1.5 ${
          inline ? "min-h-10" : "min-h-9 max-w-full self-start rounded-full bg-subtle px-3"
        }`}
        style={inline ? { maxWidth: stats === null ? 200 : availableWidth } : undefined}
      >
        {stats !== null ? (
          <StatusLineTypography>
            <ThreadStatusDialStrip
              stats={stats}
              createdAt={props.createdAt}
              nowMs={nowMs}
              availableWidth={availableWidth}
              fontScale={fontScale}
            />
          </StatusLineTypography>
        ) : firstLine !== undefined ? (
          <CommandLine line={firstLine} />
        ) : error ? (
          <Text numberOfLines={1} className="shrink text-2xs text-foreground-muted">
            {gt("Status line failed: {error}", { error })}
          </Text>
        ) : null}
        {canExpand ? (
          <SymbolView name="chevron.down" size={10} tintColorClassName="accent-foreground-muted" />
        ) : null}
      </Pressable>
    ) : null;
  return (
    <View onLayout={(event) => setPaneWidth(event.nativeEvent.layout.width)}>
      {props.renderHeader(inline ? (strip ?? undefined) : undefined)}
      {inline || strip === null ? null : (
        <View
          pointerEvents="box-none"
          className={
            Platform.OS === "android" ? "bg-thread-canvas px-4 py-1" : "bg-screen px-4 py-1"
          }
          style={clearsBar ? { marginTop: barOverlap } : undefined}
        >
          {strip}
        </View>
      )}
      {expanded && canExpand ? (
        <Sheet title={gt("Status line")} onClose={() => setExpanded(false)}>
          <ScreenScrollView contentContainerClassName="gap-1 px-4 py-4">
            {stats !== null ? (
              <StatusLineTypography>
                <ThreadStatusDialDetails stats={stats} nowMs={nowMs} createdAt={props.createdAt} />
              </StatusLineTypography>
            ) : (
              lines.map((line, index) => (
                <CommandLine
                  // oxlint-disable-next-line react/no-array-index-key -- lines have no identity beyond order
                  key={index}
                  line={line}
                  expanded
                />
              ))
            )}
            {stats !== null && config?.environment.capabilities.statusLineAccounting === true ? (
              <View className="gap-2 border-t border-border pt-3">
                {(
                  ["statusLineSessionBurnTauMinutes", "statusLineWeeklyBurnTauMinutes"] as const
                ).map((setting) => (
                  <StatusLineBurnTauControl
                    key={setting}
                    setting={setting}
                    value={config.settings[setting]}
                    disabled={!canWrite || isManagedSettingPath(config.managedPolicy, setting)}
                    onChange={(minutes) =>
                      void update({
                        environmentId: props.environmentId,
                        input: { patch: { [setting]: minutes } },
                      })
                    }
                  />
                ))}
              </View>
            ) : null}
          </ScreenScrollView>
        </Sheet>
      ) : null}
    </View>
  );
}
