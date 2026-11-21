import { FEATURE_OFFERS } from "@t3tools/client-runtime/feature-offers";
import { DEFAULT_SERVER_SETTINGS, type ServerSettingsPatch } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    model: { instanceId: "codex", model: "gpt-6.2-sol" },
    branchNaming: { onChange: (_patch: ServerSettingsPatch) => {} },
    updateSettings: vi.fn(),
    buildToolsState: vi.fn((_request: { environmentId: string; input: object }) => null),
    alert: vi.fn(),
    targets: [] as ReturnType<typeof environment>[],
    readOnly: new Set<string>(),
    accessWriters: new Set<string>(),
    projectSelected: false,
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  TextInput: () => null,
  Alert: { alert: mocks.alert },
  Pressable: ({
    children,
    disabled,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress: () => void;
    accessibilityLabel?: string;
  }) => (
    <button disabled={disabled} onClick={onPress} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (typeof atom === "boolean" ? atom : AsyncResult.success({})),
  useAtomSet: () => () => {},
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  mobileSettingsSyncEnabledAtom: {},
  updateMobilePreferencesAtom: {},
  saveMobilePreferences: {},
}));
vi.mock("./components/AutoSettleDaysField", () => ({ AutoSettleDaysField: () => null }));
vi.mock("./components/IssueTrackerSection", () => ({ IssueTrackerSection: () => null }));
vi.mock("./components/SourceControlProvidersSection", () => ({
  SourceControlProvidersSection: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () =>
    new Set(
      mocks.targets
        .map((target) => target.environmentId)
        .filter((environmentId) => !mocks.readOnly.has(environmentId)),
    ),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateSettings: {
      permissionAtom: (environmentId: string, input?: { patch: ServerSettingsPatch }) =>
        input?.patch.connectDeviceLongSessions === undefined ||
        mocks.accessWriters.has(environmentId),
    },
    buildToolsState: mocks.buildToolsState,
    messageDevices: () => null,
  },
}));
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: (id: string) =>
    mocks.targets.find((target) => target.environmentId === id)?.serverConfig,
  useProjects: () => [],
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({}) }));
vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: () => [{ key: "sol", label: "Sol", selection: mocks.model }],
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.updateSettings,
}));
vi.mock("../threads/thread-settings-options", () => ({
  RUNTIME_MODE_CHOICES: [],
  withManagedRuntimeModeLimits: (choices: readonly unknown[]) => choices,
}));
vi.mock("../../components/ui/Menu", () => ({ Menu: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("../../components/ui/ListToggleRow", () => ({ ListToggleRow: () => null }));
vi.mock("./MobileAgentMemorySettings", () => ({ MobileAgentMemorySettings: () => null }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({
    title: "Filter",
    icon: "line.3.horizontal.decrease.circle",
    items: [],
  }),
}));
vi.mock("./components/DatabaseStorageNotice", () => ({ DatabaseStorageNotice: () => null }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("../../components/ui/Sheet", () => ({ Sheet: Children }));
vi.mock("../../components/ui/ListActionRow", () => ({ ListActionRow: ChoiceButton }));
vi.mock("../../components/ui/ListChoiceRow", () => ({ ListChoiceRow: ChoiceButton }));
vi.mock("./components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: ({
    label,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    value: boolean | null;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <button
      role="switch"
      aria-checked={value ?? "mixed"}
      disabled={disabled}
      onClick={() => onValueChange(!value)}
    >
      {label}
    </button>
  ),
}));
vi.mock("./components/SettingsRow", () => ({ SettingsRow: () => null }));
vi.mock("./components/BranchNamingSettings", () => ({
  BranchNamingSettings: (props: { onChange: (patch: ServerSettingsPatch) => void }) => {
    mocks.branchNaming.onChange = props.onChange;
    return null;
  },
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: mocks.targets,
    projectGroups: [
      {
        key: "project",
        label: "Project",
        members: mocks.targets.map((target) => ({
          project: { environmentId: target.environmentId, id: "project" },
        })),
      },
    ],
    selectedProjectKey: mocks.projectSelected ? "project" : null,
  }),
}));

import { SettingsHomuCodeRouteScreen } from "./SettingsHomuCodeRouteScreen";
import {
  SettingsThreadsRouteScreen,
  SettingsWorktreesRouteScreen,
} from "./SettingsServerControlsRouteScreen";

function ChoiceButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  );
}

function environment(environmentId: string, label: string) {
  return {
    environmentId,
    label,
    connection: { phase: "connected" },
    serverConfig: {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        defaultAutoPull: false,
        sidebarAutoSettleOnMerge: false,
      },
      environment: {
        serverVersion: "0.1.10",
        platform: { os: "linux" },
        capabilities: {
          homuSetup: true,
          statusLine: true,
          buildTools: true,
          projectSettingsOverrides: true,
          threadAutoSettlement: true,
        },
      },
    },
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.targets = [environment("local", "Local")];
  mocks.projectSelected = false;
  mocks.readOnly = new Set();
  mocks.accessWriters = new Set();
  mocks.alert.mockReset();
  mocks.buildToolsState.mockClear();
  mocks.updateSettings.mockReset();
  mocks.updateSettings.mockResolvedValue(AsyncResult.success(undefined));
});

afterEach(() => {
  act(() => root.unmount());
});

describe("SettingsServerControlsRouteScreen", () => {
  it("renders setup controls and applies Quick model and T3 Connect to their own environments", () => {
    mocks.targets.push(environment("remote", "Remote"));
    mocks.accessWriters.add("remote");
    act(() => root.render(<SettingsHomuCodeRouteScreen />));
    const buttons = [...container.querySelectorAll("button")];
    const labels = new Set(buttons.map((button) => button.textContent));
    for (const offer of FEATURE_OFFERS) {
      if (offer.page !== 2 || !offer.setting || offer.setting === "buildToolsSettingsVisible")
        continue;
      const label =
        offer.id === "subagents"
          ? "Use Homu delegation (delegate_task)"
          : offer.id === "thread-only-stop"
            ? "Stop stops only this thread"
            : offer.title;
      expect(labels, offer.id).toContain(label);
    }

    act(() => buttons.find((button) => button.textContent === "Quick model")?.click());
    act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Sol")
        ?.click(),
    );
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      environmentId: "local",
      input: { patch: { quickModelSelection: mocks.model } },
    });

    const connectSwitches = buttons.filter(
      (button) => button.textContent === "Stay signed in for 30 days",
    );
    expect(connectSwitches.map((button) => button.disabled)).toEqual([true, false]);
    mocks.updateSettings.mockClear();
    act(() => connectSwitches[1]?.click());
    expect(mocks.updateSettings.mock.calls).toEqual([
      [{ environmentId: "remote", input: { patch: { connectDeviceLongSessions: true } } }],
    ]);
  });

  it("subscribes to build status only on environments that support it", () => {
    const upstream = environment("upstream", "Upstream");
    upstream.serverConfig.environment.capabilities.buildTools = false;
    upstream.serverConfig.environment.capabilities.homuSetup = false;
    mocks.targets.push(upstream);
    act(() => root.render(<SettingsHomuCodeRouteScreen />));

    expect(mocks.buildToolsState.mock.calls).toEqual([[{ environmentId: "local", input: {} }]]);
    expect(container.textContent).toContain("This server does not support this HomuCode feature.");
    const buildSwitches = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="switch"]'),
    ].filter((button) => button.textContent === "Show Building Homu settings");
    expect(buildSwitches.map((button) => button.disabled)).toEqual([false, true]);
    act(() => buildSwitches[1]?.click());
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("saves HomuCode server switches across the selected environments", async () => {
    mocks.targets.push(environment("remote", "Remote"));
    mocks.accessWriters = new Set(["local", "remote"]);
    act(() => root.render(<SettingsHomuCodeRouteScreen />));

    for (const [label, key] of [
      ["Status line", "statusLineEnabled"],
      ["Weekly depletion ratio", "statusLineShowWeeklyDepletionRatio"],
      ["Use API prices for thread cost", "statusLineUseApiPrice"],
      ["Subagents inherit parent pin", "subagentsInheritParentPin"],
      ["Autoreviewers (not recommended)", "autoreviewEnabled"],
    ] as const) {
      const matches = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="switch"]'),
      ).filter((button) => button.textContent === label);
      expect(matches).toHaveLength(1);
      const toggle = matches[0]!;
      const next = toggle.getAttribute("aria-checked") !== "true";
      mocks.updateSettings.mockClear();

      await act(async () => toggle.click());

      expect(mocks.updateSettings.mock.calls.map(([request]) => request)).toEqual([
        { environmentId: "local", input: { patch: { [key]: next } } },
        { environmentId: "remote", input: { patch: { [key]: next } } },
      ]);
    }
    mocks.readOnly.add("remote");
    act(() => root.render(<SettingsHomuCodeRouteScreen key="read-only" />));
    expect(container.querySelectorAll('[role="switch"]:disabled')).toHaveLength(5);
  });

  it("sends a draft saved during a pending write once that write settles", async () => {
    const pending = Promise.withResolvers<AsyncResult.Success<void>>();
    mocks.updateSettings.mockReturnValueOnce(pending.promise);
    act(() => root.render(<SettingsWorktreesRouteScreen />));

    act(() => mocks.branchNaming.onChange({ branchNamingMode: "custom" }));
    act(() => mocks.branchNaming.onChange({ branchNameInstructions: "Use issue IDs." }));
    expect(mocks.updateSettings).toHaveBeenCalledOnce();

    await act(async () => pending.resolve(AsyncResult.success(undefined)));

    expect(mocks.updateSettings).toHaveBeenCalledTimes(2);
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: {
        patch: { branchNamingMode: "custom", branchNameInstructions: "Use issue IDs." },
      },
    });
  });

  it("holds auto-settle changes until a pending project override write settles", async () => {
    mocks.projectSelected = true;
    const pending = Promise.withResolvers<AsyncResult.Success<void>>();
    mocks.updateSettings.mockReturnValueOnce(pending.promise);
    act(() => root.render(<SettingsThreadsRouteScreen />));
    const toggle = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
        (button) => button.textContent === label,
      )!;

    act(() => toggle("Agent browser access").click());
    act(() => toggle("Auto-settle merged threads").click());

    // Both rewrite the whole project override, so a second write planned now would drop the first.
    expect(mocks.updateSettings).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(AsyncResult.success(undefined)));
  });

  it("disables auto-settle when a selected environment cannot save settings", () => {
    const remote = environment("remote", "Remote");
    // Auto-settle rows skip a server without auto-settlement, but the page still saves to it.
    remote.serverConfig.environment.capabilities.threadAutoSettlement = false;
    mocks.targets = [environment("local", "Local"), remote];
    mocks.readOnly = new Set(["remote"]);
    act(() => root.render(<SettingsThreadsRouteScreen />));

    const autoSettle = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
      (button) => button.textContent === "Auto-settle merged threads",
    )!;
    expect(autoSettle.disabled).toBe(true);
  });
});
