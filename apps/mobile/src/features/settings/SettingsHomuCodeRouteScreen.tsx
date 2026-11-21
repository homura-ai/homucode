import { useGT, useMessages } from "gt-react-native";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AuthSettingsWriteScope, type ServerSettingsPatch } from "@t3tools/contracts";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { useRef, useState } from "react";
import { AsyncResult } from "effect/reactivity";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import {
  mobilePreferencesAtom,
  mobileSettingsSyncEnabledAtom,
  updateMobilePreferencesAtom,
} from "../../state/preferences";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { MobileAgentMemorySettings } from "./MobileAgentMemorySettings";
import {
  MobileBuildVisibility,
  MobileExtraSettings,
  MobileThisDeviceName,
} from "./SetupBehaviorSettings";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  managedSettingReason,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

export function SettingsHomuCodeRouteScreen() {
  const gt = useGT();
  const menu = useSettingsEnvironmentMenu();
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const settingsSyncEnabled = useAtomValue(mobileSettingsSyncEnabledAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;

  return (
    <SettingsScreen title="HomuCode" menus={[menu]}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={gt("This phone")}>
          <MobileThisDeviceName />
          <ListToggleRow
            label={gt("Faster phone launch")}
            description={gt(
              "Connect using the last signed-in account before sign-in loads. Applies next launch.",
            )}
            value={
              AsyncResult.isSuccess(preferencesResult) &&
              preferencesResult.value.fasterPhoneLaunch === true
            }
            disabled={!preferencesReady}
            onValueChange={(fasterPhoneLaunch) => savePreferences({ fasterPhoneLaunch })}
          />
        </SettingsSection>
        <SettingsSection title={gt("Sent messages")}>
          <ListToggleRow
            label={gt("Show message sender labels")}
            description={gt("Show who sent each message above its bubble in chat.")}
            value={
              AsyncResult.isSuccess(preferencesResult) &&
              preferencesResult.value.showMessageSenderLabels === true
            }
            disabled={!preferencesReady}
            onValueChange={(showMessageSenderLabels) =>
              savePreferences({ showMessageSenderLabels })
            }
          />
        </SettingsSection>
        <SettingsSection title={gt("Settings sync")}>
          <ListToggleRow
            label={gt("Sync settings")}
            description={gt(
              "Keep theme, chat and other settings the same as your other devices, through connected servers.",
            )}
            value={settingsSyncEnabled}
            disabled={!preferencesReady}
            onValueChange={(settingsSyncEnabled) => savePreferences({ settingsSyncEnabled })}
          />
        </SettingsSection>
        <SettingsSection title="MadoHomu">
          <SettingsRow
            icon="bubble.left.and.bubble.right"
            label="MadoHomu"
            target="SettingsMadoHomu"
            disabled={selectedTargets.length === 0}
          />
        </SettingsSection>
        <SettingsSection title={gt("Building Homu")}>
          {selectedTargets.map((target) => (
            <MobileBuildVisibility
              key={target.environmentId}
              environmentId={target.environmentId}
            />
          ))}
          {selectedTargets.some(
            (target) => target.serverConfig.settings.buildToolsSettingsVisible,
          ) ? (
            <SettingsRow icon="hammer" label={gt("Building Homu")} target="SettingsBuildingT3" />
          ) : null}
        </SettingsSection>
        <HomuCodeServerSettings />
        {selectedProjectKey === null ? (
          <>
            {selectedTargets.map((target) => (
              <MobileExtraSettings
                key={target.environmentId}
                environmentId={target.environmentId}
                label={target.label}
              />
            ))}
            {selectedTargets
              .filter((target) => target.serverConfig.environment.platform.os === "linux")
              .map((target) => (
                <MobileAgentMemorySettings
                  key={target.environmentId}
                  environmentId={target.environmentId}
                  label={target.label}
                />
              ))}
          </>
        ) : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function HomuCodeServerSettings() {
  const gt = useGT();
  const resolve = useMessages();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const projectSelected = selectedProjectKey !== null;
  const targets = resolveMobileSettingsTargets(
    selectedTargets,
    projectSelected ? (selectedProject?.members.map((member) => member.project) ?? []) : null,
  );
  const autoreviewTargets = targets.filter((target) =>
    supportsSharedSettingsSync(target.environment),
  );
  const writable = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const writeSettings = useSettingsWriter();
  const writing = useRef(false);
  const [pending, setPending] = useState(false);
  const canWrite =
    !projectSelected && targets.every((target) => writable.has(target.environment.environmentId));

  const write = (
    key:
      | "statusLineEnabled"
      | "statusLineShowWeeklyDepletionRatio"
      | "autoreviewEnabled"
      | "subagentsInheritParentPin",
    enabled: boolean,
  ) => {
    if (
      writing.current ||
      !canWrite ||
      targets.some(
        (target) => !readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const patch: ServerSettingsPatch = { [key]: enabled };
    writing.current = true;
    setPending(true);
    void writeSettings(targets, planMobileScopedSettingsPatch(targets, false, patch)).finally(
      () => {
        writing.current = false;
        setPending(false);
      },
    );
  };

  if (targets.length === 0) return null;
  return (
    <>
      <SettingsSection title={gt("Status line")}>
        <SettingsSwitchRow
          icon="terminal"
          label={gt("Status line")}
          subtitle={gt(
            "Show the model, context, and usage limits under the composer. Set its command on desktop or web.",
          )}
          value={uniformMobileSetting(targets, "statusLineEnabled")}
          disabled={
            !canWrite ||
            pending ||
            managedSettingReason(targets, ["statusLineEnabled"], resolve) !== undefined
          }
          onValueChange={(enabled) => write("statusLineEnabled", enabled)}
        />
        <SettingsSwitchRow
          icon="timer"
          label={gt("Weekly depletion ratio")}
          subtitle={gt(
            "Show the time until the weekly reset as a percentage of the time until quota is projected to run out.",
          )}
          value={uniformMobileSetting(targets, "statusLineShowWeeklyDepletionRatio")}
          disabled={
            !canWrite ||
            pending ||
            managedSettingReason(targets, ["statusLineShowWeeklyDepletionRatio"], resolve) !==
              undefined
          }
          onValueChange={(enabled) => write("statusLineShowWeeklyDepletionRatio", enabled)}
        />
      </SettingsSection>
      {!projectSelected ? (
        <SettingsSection title={gt("Subagents")}>
          <SettingsSwitchRow
            icon="pin"
            label={gt("Subagents inherit parent pin")}
            subtitle={gt(
              "Pin new subagents on the devices where their parent is pinned. Applies to subagents on the same server.",
            )}
            value={uniformMobileSetting(targets, "subagentsInheritParentPin")}
            disabled={
              !canWrite ||
              pending ||
              managedSettingReason(targets, ["subagentsInheritParentPin"], resolve) !== undefined
            }
            onValueChange={(enabled) => write("subagentsInheritParentPin", enabled)}
          />
        </SettingsSection>
      ) : null}
      {!projectSelected && autoreviewTargets.length > 0 ? (
        <SettingsSection title={gt("Autoreviewers")}>
          <SettingsSwitchRow
            icon="checkmark.circle"
            label={gt("Autoreviewers (not recommended)")}
            subtitle={gt(
              "Lets agents attach reviewer subagents. Findings can lag behind the thread. Turning this off pauses attached reviewers.",
            )}
            value={uniformMobileSetting(autoreviewTargets, "autoreviewEnabled")}
            disabled={
              !canWrite ||
              pending ||
              managedSettingReason(targets, ["autoreviewEnabled"], resolve) !== undefined
            }
            onValueChange={(enabled) => write("autoreviewEnabled", enabled)}
          />
        </SettingsSection>
      ) : null}
    </>
  );
}
