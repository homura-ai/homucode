import type { ReactNode } from "react";
import { useGT, T } from "gt-react";
import { DEFAULT_UNIFIED_SETTINGS, SidebarThreadFolderStyle } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { AgentMemorySettings } from "./AgentMemorySettings";
import { AppScriptsSettingsSection } from "./AppScriptsSettings";
import { BehaviorSettingsSection, ExtraFeaturesSettings } from "./BehaviorSettings";
import { BuildToolsSetup } from "./BuildToolsSettings";
import { MadoHomuSettings } from "./MadoHomuSettings";
import { LocalThreadsUseDefaultBranchRow, QuickModelRow } from "./ProjectDefaultsSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { ScratchEnvironmentSettings } from "./ScratchEnvironmentSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { StatusLineBurnTauControl } from "./StatusLineBurnTauControl";
import { StagedBuildSettingsRow } from "./StagedBuildSettingsRow";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingResetButton,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const SIDEBAR_THREAD_FOLDER_STYLE_LABELS: Record<SidebarThreadFolderStyle, string> = {
  cards: "Cards",
  tabs: "Tab groups",
};
const isSidebarThreadFolderStyle = Schema.is(SidebarThreadFolderStyle);

function useUnavailableReason() {
  const gt = useGT();
  const { scope, connectedEnvironments } = useSettingsScope();
  return scope.kind === "unavailable"
    ? scope.message
    : scope.kind === "environment" && connectedEnvironments.length === 0
      ? gt("Reconnect {label} to change its settings.", { label: scope.label })
      : null;
}

function EnvironmentSettingsPage({ children }: { readonly children: ReactNode }) {
  const unavailableReason = useUnavailableReason();
  return (
    <SettingsPageContainer>
      {unavailableReason === null ? (
        children
      ) : (
        <p className="text-sm text-muted-foreground">{unavailableReason}</p>
      )}
    </SettingsPageContainer>
  );
}

export function HomuCodeSettingsPanel() {
  return (
    <SettingsPageContainer searchTargetFallbacks={{ homucode: "settings-sync" }}>
      <HomuCodeDeviceSettings />
    </SettingsPageContainer>
  );
}

export function MadoHomuSettingsPanel() {
  return (
    <SettingsPageContainer>
      <MadoHomuSettings />
    </SettingsPageContainer>
  );
}

export function AgentBehaviorSettingsPanel() {
  const unavailableReason = useUnavailableReason();
  return (
    <SettingsPageContainer>
      <ExtraFeaturesSettings showServerOffers={unavailableReason === null} />
      {unavailableReason === null ? (
        <AgentBehaviorSettings />
      ) : (
        <p className="text-sm text-muted-foreground">{unavailableReason}</p>
      )}
    </SettingsPageContainer>
  );
}

export function BuildingHomuSettingsPanel() {
  return (
    <EnvironmentSettingsPage>
      <BuildingHomuSettings />
    </EnvironmentSettingsPage>
  );
}

function HomuCodeDeviceSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const settings = useClientSettings();
  const { environments } = useEnvironments();
  const scratchEnvironments = environments.filter(
    (environment) => environment.entry.enabled && environment.connection.phase !== "unsupported",
  );

  return (
    <>
      <SettingsSection title={gt("Settings sync")}>
        <SettingsRow
          {...searchableSetting("settings-sync")}
          description={gt(
            "Keep this device's settings the same as your other devices', through connected servers. When a setting changed in two places, or on first setup, you choose which value to keep.",
          )}
          control={
            <Switch
              checked={settings.settingsSyncEnabled}
              onCheckedChange={(checked) =>
                void updateClientSettings({ settingsSyncEnabled: Boolean(checked) })
              }
              aria-label={gt("Settings sync")}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title={gt("Sent messages")}>
        <SettingsRow
          {...searchableSetting("show-message-sender-labels")}
          description={gt("Show who sent each message above its bubble in chat.")}
          control={
            <Switch
              checked={settings.showMessageSenderLabels}
              onCheckedChange={(showMessageSenderLabels) =>
                void updateClientSettings({ showMessageSenderLabels })
              }
              aria-label={gt("Show message sender labels")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("user-message-markdown")}
          description={gt("Off shows your sent messages as the plain text you typed.")}
          resetAction={
            settings.userMessageMarkdownEnabled !==
            DEFAULT_UNIFIED_SETTINGS.userMessageMarkdownEnabled ? (
              <SettingResetButton
                ariaLabel={gt("Reset sent message formatting to default")}
                onClick={() =>
                  void updateClientSettings({
                    userMessageMarkdownEnabled: DEFAULT_UNIFIED_SETTINGS.userMessageMarkdownEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.userMessageMarkdownEnabled}
              onCheckedChange={(checked) =>
                void updateClientSettings({ userMessageMarkdownEnabled: Boolean(checked) })
              }
              aria-label={gt("Format sent messages as Markdown")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("user-message-plus-bullets")}
          description={gt(
            "Off keeps a + at the start of a line in your sent messages as you typed it.",
          )}
          resetAction={
            settings.userMessagePlusBullets !== DEFAULT_UNIFIED_SETTINGS.userMessagePlusBullets ? (
              <SettingResetButton
                ariaLabel={gt("Reset + bullets to default")}
                onClick={() =>
                  void updateClientSettings({
                    userMessagePlusBullets: DEFAULT_UNIFIED_SETTINGS.userMessagePlusBullets,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.userMessagePlusBullets}
              disabled={!settings.userMessageMarkdownEnabled}
              onCheckedChange={(checked) =>
                void updateClientSettings({ userMessagePlusBullets: Boolean(checked) })
              }
              aria-label={gt("Lines starting with + become bullets")}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title={gt("Sidebar")}>
        <SettingsRow
          {...searchableSetting("thread-folder-style")}
          description={gt(
            "Cards tint each folder. Tab groups color the folder name and draw a line beside its threads.",
          )}
          resetAction={
            settings.sidebarThreadFolderStyle !==
            DEFAULT_UNIFIED_SETTINGS.sidebarThreadFolderStyle ? (
              <SettingResetButton
                ariaLabel={gt("Reset folder style to default")}
                onClick={() =>
                  void updateClientSettings({
                    sidebarThreadFolderStyle: DEFAULT_UNIFIED_SETTINGS.sidebarThreadFolderStyle,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sidebarThreadFolderStyle}
              onValueChange={(value) => {
                if (isSidebarThreadFolderStyle(value)) {
                  void updateClientSettings({ sidebarThreadFolderStyle: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-44" aria-label={gt("Folder style")}>
                <SelectValue>
                  {SIDEBAR_THREAD_FOLDER_STYLE_LABELS[settings.sidebarThreadFolderStyle]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {SidebarThreadFolderStyle.literals.map((style) => (
                  <SelectItem hideIndicator key={style} value={style}>
                    {SIDEBAR_THREAD_FOLDER_STYLE_LABELS[style]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
      <ScratchEnvironmentSettings environments={scratchEnvironments} />
      <AppScriptsSettingsSection />
    </>
  );
}

function AgentBehaviorSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedSessionBurnTau = useScopedSettingsMixed(["statusLineSessionBurnTauMinutes"]);
  const mixedWeeklyBurnTau = useScopedSettingsMixed(["statusLineWeeklyBurnTauMinutes"]);
  const mixedStatusLineCommand = useScopedSettingsMixed(["statusLineCommand"]);
  const mixedProjectName = useScopedSettingsMixed(["threadTitleIncludeProjectName"]);
  const mixedIdPrefix = useScopedSettingsMixed(["threadTitleIdPrefix"]);
  const depletionRatioDescription = gt(
    "Show the time until reset as a percentage of the time until quota is projected to run out.",
  );

  return (
    <>
      <BehaviorSettingsSection />
      <SettingsSection id="subagents" title={gt("Subagents")}>
        <SettingsRow
          serverScoped
          {...searchableSetting("prefer-native-subagents")}
          settingKeys={["preferNativeSubagents"]}
          description={gt(
            "Use provider-native subagents for same-provider work. Off routes every subagent through HomuCode. Applies next turn; providers that load instructions at startup need a thread restart.",
          )}
          control={
            <ScopedSwitch
              settingKeys={["preferNativeSubagents"]}
              checked={settings.preferNativeSubagents}
              onCheckedChange={(checked) =>
                updateSettings({ preferNativeSubagents: Boolean(checked) })
              }
              aria-label={gt("Prefer native subagents")}
            />
          }
        />
        <SettingsRow
          serverScoped
          {...searchableSetting("subagents-inherit-parent-pin")}
          settingKeys={["subagentsInheritParentPin"]}
          description={gt(
            "Pin new subagents on the devices where their parent is pinned. Applies to subagents on the same server.",
          )}
          control={
            <ScopedSwitch
              settingKeys={["subagentsInheritParentPin"]}
              checked={settings.subagentsInheritParentPin}
              onCheckedChange={(checked) =>
                updateSettings({ subagentsInheritParentPin: Boolean(checked) })
              }
              aria-label={gt("Subagents inherit parent pin")}
            />
          }
        />
      </SettingsSection>
      <SettingsSection id="claude-background-commands" title={gt("Claude background commands")}>
        <SettingsRow
          serverScoped
          {...searchableSetting("claude-hold-background-commands")}
          settingKeys={["claudeHoldBackgroundCommands"]}
          description={gt(
            "Keep Claude threads in Working until new background commands finish or the agent releases them. Applies without restarting. Claude monitors always keep threads working.",
          )}
          control={
            <ScopedSwitch
              settingKeys={["claudeHoldBackgroundCommands"]}
              checked={settings.claudeHoldBackgroundCommands}
              onCheckedChange={(checked) =>
                updateSettings({ claudeHoldBackgroundCommands: Boolean(checked) })
              }
              aria-label={gt("Keep Claude threads working while background commands run")}
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="autoreview" title={gt("Autoreviewers")}>
        <SettingsRow
          serverScoped
          {...searchableSetting("autoreviewers")}
          description={gt(
            "Not recommended: reviewers lag behind the thread, so findings are often stale. Lets agents attach reviewer subagents to a thread. Turning this off pauses attached reviewers.",
          )}
          settingKeys={["autoreviewEnabled"]}
          control={
            <ScopedSwitch
              settingKeys={["autoreviewEnabled"]}
              checked={settings.autoreviewEnabled}
              onCheckedChange={(checked) => updateSettings({ autoreviewEnabled: Boolean(checked) })}
              aria-label={gt("Autoreviewers (not recommended)")}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={gt("New threads")}>
        <QuickModelRow />
        <LocalThreadsUseDefaultBranchRow />
      </SettingsSection>
      <SettingsSection title={gt("Thread titles")}>
        <SettingsRow
          serverScoped
          settingKeys={["threadTitleIncludeProjectName"]}
          mixed={mixedProjectName}
          {...searchableSetting("thread-title-project-name")}
          description={gt(
            "Show the titler the project name, so titles can leave out what it already says.",
          )}
          resetAction={
            mixedProjectName || !settings.threadTitleIncludeProjectName ? (
              <SettingResetButton
                ariaLabel={gt("Reset project name for titles to default")}
                onClick={() => updateSettings({ threadTitleIncludeProjectName: true })}
              />
            ) : null
          }
          control={
            <Switch
              aria-label={gt("Show the project name to the titler")}
              mixed={mixedProjectName}
              checked={mixedProjectName ? false : settings.threadTitleIncludeProjectName}
              onCheckedChange={(enabled) =>
                updateSettings({ threadTitleIncludeProjectName: enabled })
              }
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["threadTitleIdPrefix"]}
          mixed={mixedIdPrefix}
          {...searchableSetting("thread-title-id-prefix")}
          description={gt(
            "Show a short ID before each generated title: its first letter, plus a number when another active thread has it (F, F1, F2). Settled threads add a letter (F1a).",
          )}
          resetAction={
            mixedIdPrefix || settings.threadTitleIdPrefix ? (
              <SettingResetButton
                ariaLabel={gt("Reset title IDs to default")}
                onClick={() => updateSettings({ threadTitleIdPrefix: false })}
              />
            ) : null
          }
          control={
            <Switch
              aria-label={gt("Prefix thread titles with an ID")}
              mixed={mixedIdPrefix}
              checked={mixedIdPrefix ? false : settings.threadTitleIdPrefix}
              onCheckedChange={(enabled) => updateSettings({ threadTitleIdPrefix: enabled })}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title={gt("Status line")}>
        <SettingsRow
          serverScoped
          settingKeys={["statusLineEnabled"]}
          {...searchableSetting("status-line")}
          description={gt("Show context, usage limits, and thread cost in the top bar.")}
          resetAction={
            settings.statusLineEnabled !== DEFAULT_UNIFIED_SETTINGS.statusLineEnabled ? (
              <SettingResetButton
                ariaLabel={gt("Reset status line to default")}
                onClick={() =>
                  updateSettings({ statusLineEnabled: DEFAULT_UNIFIED_SETTINGS.statusLineEnabled })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["statusLineEnabled"]}
              checked={settings.statusLineEnabled}
              onCheckedChange={(checked) => updateSettings({ statusLineEnabled: Boolean(checked) })}
              aria-label={gt("Show the status line")}
            />
          }
        />
        {(
          [
            [
              "statusLineHideSessionLimit",
              "status-line-hide-session-limit",
              gt("Hide 5-hour limit"),
              gt("When off, show the 5-hour limit when it is available."),
            ],
            [
              "statusLineShowSessionDepletionRatio",
              "status-line-session-depletion-ratio",
              gt("5-hour depletion ratio"),
              depletionRatioDescription,
            ],
            [
              "statusLineShowWeeklyDepletionRatio",
              "status-line-weekly-depletion-ratio",
              gt("Weekly depletion ratio"),
              depletionRatioDescription,
            ],
          ] as const
        ).map(([setting, searchId, label, description]) => (
          <SettingsRow
            key={setting}
            serverScoped
            settingKeys={[setting]}
            {...searchableSetting(searchId)}
            description={description}
            control={
              <ScopedSwitch
                settingKeys={[setting]}
                checked={settings[setting]}
                onCheckedChange={(checked) => updateSettings({ [setting]: Boolean(checked) })}
                aria-label={label}
              />
            }
          />
        ))}
        <SettingsRow
          serverScoped
          settingKeys={["statusLineUseApiPrice"]}
          {...searchableSetting("status-line-use-api-price")}
          description={gt("Use API list prices instead of estimating the subscription cost.")}
          control={
            <ScopedSwitch
              settingKeys={["statusLineUseApiPrice"]}
              checked={settings.statusLineUseApiPrice}
              onCheckedChange={(checked) =>
                updateSettings({ statusLineUseApiPrice: Boolean(checked) })
              }
              aria-label={gt("Use API prices for thread cost")}
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["statusLineSessionBurnTauMinutes"]}
          {...searchableSetting("status-line-session-burn-rate")}
          description={gt(
            "A longer duration makes countdown colors less sensitive to recent usage.",
          )}
          control={
            <StatusLineBurnTauControl
              setting="statusLineSessionBurnTauMinutes"
              value={mixedSessionBurnTau ? null : settings.statusLineSessionBurnTauMinutes}
              onChange={(value) => updateSettings({ statusLineSessionBurnTauMinutes: value })}
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["statusLineWeeklyBurnTauMinutes"]}
          {...searchableSetting("status-line-weekly-burn-rate")}
          control={
            <StatusLineBurnTauControl
              setting="statusLineWeeklyBurnTauMinutes"
              value={mixedWeeklyBurnTau ? null : settings.statusLineWeeklyBurnTauMinutes}
              onChange={(value) => updateSettings({ statusLineWeeklyBurnTauMinutes: value })}
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["statusLineCommand"]}
          {...searchableSetting("status-line-command")}
          description={gt(
            "A command that reads Claude Code's status line JSON on stdin and prints a line of text, shown in place of the dials. Leave empty for the built-in status line.",
          )}
          resetAction={
            settings.statusLineCommand !== DEFAULT_UNIFIED_SETTINGS.statusLineCommand ? (
              <SettingResetButton
                ariaLabel={gt("Reset status line command to default")}
                onClick={() =>
                  updateSettings({ statusLineCommand: DEFAULT_UNIFIED_SETTINGS.statusLineCommand })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              value={mixedStatusLineCommand ? "" : settings.statusLineCommand}
              onCommit={(next) => updateSettings({ statusLineCommand: next.trim() })}
              placeholder={mixedStatusLineCommand ? gt("Mixed") : gt("Built-in")}
              spellCheck={false}
              aria-label={gt("Status line command")}
            />
          }
        />
      </SettingsSection>
      <AgentMemorySettings />
    </>
  );
}

function BuildingHomuSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentScope = scope.kind === "all" || scope.kind === "environment";
  const buildEnvironment =
    connectedEnvironments.length === 1 ? connectedEnvironments[0] : undefined;
  const primaryEnvironment = environments.find(
    (entry) => entry.environmentId === primaryEnvironmentId,
  );
  const showStagedBuild =
    environmentScope &&
    (scope.kind === "all" || buildEnvironment?.environmentId === primaryEnvironmentId) &&
    typeof window !== "undefined" &&
    Boolean(window.desktopBridge) &&
    !primaryEnvironment?.serverConfig?.settings.buildToolsSettingsVisible;

  return (
    <>
      <SettingsSection id="building-t3" title={gt("Building Homu")}>
        <SettingsRow
          {...searchableSetting("show-building-t3")}
          description={gt("Configure cloud builds, Android APK builds, and loading AppImages.")}
          serverScoped
          settingKeys={["buildToolsSettingsVisible"]}
          control={
            <Switch
              checked={settings.buildToolsSettingsVisible}
              aria-label={gt("Show Building Homu settings")}
              onCheckedChange={(value) =>
                updateSettings({ buildToolsSettingsVisible: Boolean(value) })
              }
            />
          }
        />
        {showStagedBuild ? (
          <StagedBuildSettingsRow
            {...(primaryEnvironmentId ? { environmentId: primaryEnvironmentId } : {})}
          />
        ) : null}
      </SettingsSection>
      {environmentScope && buildEnvironment?.serverConfig?.settings.buildToolsSettingsVisible ? (
        <BuildToolsSetup
          key={buildEnvironment.environmentId}
          environmentId={buildEnvironment.environmentId}
        />
      ) : environmentScope &&
        connectedEnvironments.some(
          (environment) => environment.serverConfig?.settings.buildToolsSettingsVisible,
        ) ? (
        <p className="text-sm text-muted-foreground">
          <T>Select one environment to configure Building Homu.</T>
        </p>
      ) : null}
    </>
  );
}
