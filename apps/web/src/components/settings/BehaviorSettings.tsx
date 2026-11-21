import { useGT, T, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import {
  managedCapabilityDenial,
  type EnvironmentId,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  FEATURE_OFFERS,
  getBuildToolsUnavailableReason,
} from "@t3tools/client-runtime/feature-offers";
import {
  updateClientSettings,
  useClientSettings,
  useEnvironmentSettings,
} from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { useManagedPolicy } from "../../state/managedPolicy";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { FEATURE_OFFER_SETTINGS, useSearchableSetting } from "./settingsSearch";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function WorkAssistancePicker({
  value,
  onChange,
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: ServerSettings["workAssistanceTarget"];
  readonly onChange: (value: ServerSettings["workAssistanceTarget"]) => void;
}) {
  const gt = useGT();
  const { environments: connected } = useEnvironments();
  const environments = connected.filter((entry) => entry.environmentId === environmentId);
  const projects = useProjects();
  const [chosenEnvironment, setChosenEnvironment] = useState(
    value?.environmentId ?? environments[0]?.environmentId ?? null,
  );
  return (
    <div className="grid gap-3">
      <Select
        value={chosenEnvironment}
        onValueChange={(id) => {
          const environment = environments.find((entry) => entry.environmentId === id);
          if (environment) {
            setChosenEnvironment(environment.environmentId);
            onChange(null);
          }
        }}
      >
        <SelectTrigger aria-label={gt("Work assistance environment")}>
          <SelectValue placeholder={gt("Choose an environment")}>
            {environments.find((entry) => entry.environmentId === chosenEnvironment)?.label}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {environments.map((environment) => (
            <SelectItem key={environment.environmentId} value={environment.environmentId}>
              {environment.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Select
        value={value?.projectId ?? null}
        onValueChange={(id) => {
          const project = projects.find(
            (entry) => entry.environmentId === chosenEnvironment && entry.id === id,
          );
          if (project) onChange({ environmentId: project.environmentId, projectId: project.id });
        }}
      >
        <SelectTrigger aria-label={gt("Work assistance project")}>
          <SelectValue placeholder={gt("Choose a project")}>
            {
              projects.find(
                (entry) =>
                  entry.environmentId === chosenEnvironment && entry.id === value?.projectId,
              )?.title
            }
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {projects
            .filter((project) => project.environmentId === chosenEnvironment)
            .map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.title}
              </SelectItem>
            ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

export function DeviceNamesSettings({
  environmentId,
  currentOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly currentOnly?: boolean;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(serverEnvironment.messageDevices({ environmentId, input: {} }));
  const settings = useEnvironmentSettings(environmentId);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const devices = [
    ...(query.data?.current ? [query.data.current] : []),
    ...(!currentOnly ? (query.data?.devices ?? []) : []),
    ...(!currentOnly ? (query.data?.rules ?? settings.deviceNames) : []),
  ].filter(
    (device, index, all) =>
      all.findIndex(
        (entry) =>
          JSON.stringify({ ...entry, name: undefined, deviceName: undefined }) ===
          JSON.stringify({ ...device, name: undefined, deviceName: undefined }),
      ) === index,
  );
  return (
    <div className="grid gap-3">
      {devices.map((device, index) => {
        const { deviceName: _deviceName, ...identity } = device as typeof device & {
          readonly deviceName?: string;
        };
        const { name: _name, ...match } = identity as typeof identity & { readonly name?: string };
        const current = settings.deviceNames.find((rule) =>
          Object.entries(match).every(([key, value]) => rule[key as keyof typeof rule] === value),
        );
        return (
          <label key={JSON.stringify(match)} className="grid gap-1 text-sm">
            <span>
              {[match.surface, match.os, match.deviceModel, match.browser]
                .filter(Boolean)
                .join(" · ") || gt("Device {number}", { number: index + 1 })}
            </span>
            <Input
              key={current?.name ?? ""}
              disabled={!canWrite}
              aria-label={gt("Device name")}
              maxLength={40}
              defaultValue={current?.name ?? _deviceName ?? _name ?? ""}
              placeholder={gt("Name this device")}
              onBlur={(event) => {
                const name = event.target.value.trim();
                const others = settings.deviceNames.filter((entry) => entry !== current);
                void update({
                  environmentId,
                  input: {
                    patch: { deviceNames: [{ ...match, name }, ...others] },
                  },
                });
              }}
            />
          </label>
        );
      })}
      {query.error ? (
        <p className="text-muted-foreground">
          {gt(
            "Couldn't load devices from this server. If it runs an older HomuCode, restart it to update.",
          )}
        </p>
      ) : null}
      {!devices.length ? (
        <p className="text-sm text-muted-foreground">
          <T>Devices appear after they connect to this server.</T>
        </p>
      ) : null}
    </div>
  );
}

export function ExtraFeaturesSettings({
  showServerOffers,
}: {
  readonly showServerOffers: boolean;
}) {
  const messages = useMessages();
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const showAllModels = useClientSettings((settings) => settings.statusLineShowAllModels);
  const showModelNames = useClientSettings((settings) => settings.statusLineShowModelNames);
  return (
    <SettingsSection title={gt("Extra features")}>
      <SettingsRow
        {...searchableSetting("apply-model-picker-on-close")}
        description={gt(
          "Apply the final model and effort to the running turn when you close the picker, rather than restarting for each choice. The picker's Apply instantly checkbox takes precedence.",
        )}
        control={
          <Checkbox
            aria-label={gt("Apply model and effort when closing the picker")}
            checked={settings.applyModelPickerOnClose}
            onCheckedChange={(checked) => update({ applyModelPickerOnClose: checked })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("status-line-all-models")}
        description={gt(
          "Show models and reported usage limits for this thread’s environment when you hover or focus the status line.",
        )}
        control={
          <Checkbox
            checked={showAllModels}
            aria-label={gt("Show all models in status line details")}
            onCheckedChange={(statusLineShowAllModels) =>
              void updateClientSettings({ statusLineShowAllModels })
            }
          />
        }
      />
      <SettingsRow
        {...searchableSetting("status-line-model-names")}
        description={gt(
          "List each provider’s model names in the All models section of the status line details.",
        )}
        control={
          <Checkbox
            checked={showModelNames}
            aria-label={gt("Show model names")}
            onCheckedChange={(statusLineShowModelNames) =>
              void updateClientSettings({ statusLineShowModelNames })
            }
          />
        }
      />
      {showServerOffers &&
        FEATURE_OFFERS.map((offer) => {
          const id = FEATURE_OFFER_SETTINGS[offer.id];
          const key = offer.setting;
          if (offer.page !== 2 || !key || key === "claudeHoldBackgroundCommands" || id !== offer.id)
            return null;
          return (
            <SettingsRow
              key={offer.id}
              {...searchableSetting(id)}
              description={messages(offer.description)}
              serverScoped
              settingKeys={[key]}
              control={
                <Checkbox
                  checked={settings[key] === (offer.enabledValue ?? true)}
                  aria-label={messages(offer.title)}
                  onCheckedChange={(checked) =>
                    update({
                      [key]: checked ? (offer.enabledValue ?? true) : !(offer.enabledValue ?? true),
                    })
                  }
                />
              }
            />
          );
        })}
    </SettingsSection>
  );
}

export function BehaviorSettingsSection() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const { targets, scope, connectedEnvironments } = useSettingsScope();
  const environmentId =
    targets.length === 1 && (scope.kind === "all" || scope.kind === "environment")
      ? targets[0]?.environmentId
      : undefined;
  return (
    <>
      {environmentId ? (
        <EnvironmentBehaviorSettings environmentId={environmentId} />
      ) : (
        <p className="text-sm text-muted-foreground">
          <T>Select one environment to configure work assistance.</T>
        </p>
      )}
      <SettingsSection
        title="T3 Connect"
        {...(!environmentId ? { id: "connect-device-long-sessions" } : {})}
      >
        {environmentId ? (
          <ConnectSessionSetting environmentId={environmentId} />
        ) : (
          <SettingsScopeNotice inline target="environment" targetId="connect-device-long-sessions">
            {gt("Choose an environment to change its T3 Connect session length.")}
          </SettingsScopeNotice>
        )}
      </SettingsSection>
      <SettingsSection {...searchableSetting("device-names")}>
        {environmentId ? (
          <DeviceNamesSettings environmentId={environmentId} />
        ) : (
          <SettingsScopeNotice
            inline
            target="environment"
            targetId="device-names"
            {...(scope.kind === "all"
              ? { eligibleEnvironmentIds: connectedEnvironments.map((env) => env.environmentId) }
              : {})}
          >
            {gt("Choose an environment to edit device names.")}
          </SettingsScopeNotice>
        )}
      </SettingsSection>
    </>
  );
}

function ConnectSessionSetting({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const { connectDeviceLongSessions } = useEnvironmentSettings(environmentId);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const canWrite = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId, {
      patch: { connectDeviceLongSessions: true },
    }),
  );
  const connectDenial = managedCapabilityDenial(useManagedPolicy(environmentId), "connect");
  return (
    <SettingsRow
      {...searchableSetting("connect-device-long-sessions")}
      settingKeys={["connectDeviceLongSessions"]}
      description={gt(
        "Let T3 Connect devices reconnect for 30 days without a cloud round trip. Revoke a device in Sharing & access to end its access.",
      )}
      managed={connectDenial}
      control={
        <Switch
          aria-label={gt("Stay signed in for 30 days")}
          checked={connectDeviceLongSessions}
          disabled={!canWrite}
          onCheckedChange={(enabled) =>
            void update({ environmentId, input: { patch: { connectDeviceLongSessions: enabled } } })
          }
        />
      }
    />
  );
}

function EnvironmentBehaviorSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const settings = useEnvironmentSettings(environmentId);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const environment = useEnvironment(environmentId);
  const reason = getBuildToolsUnavailableReason(environment?.serverConfig?.environment, canWrite);
  const query = useEnvironmentQuery(
    reason ? null : serverEnvironment.buildToolsState({ environmentId, input: {} }),
  );
  const [choosingWork, setChoosingWork] = useState(false);
  const backgroundGitStatus = query.data
    ? query.data.backgroundGitEnabled
      ? gt("Background Git is currently on.")
      : gt("Background Git is currently off.")
    : null;
  const backgroundGitDetail = query.data
    ? query.data.backgroundGitOverridden
      ? gt("T3CODE_BACKGROUND_GIT overrides the saved choice.")
      : query.data.backgroundGitEnabled !== settings.backgroundGitEnabled
        ? gt("Restart to apply your saved choice.")
        : gt("Restart to apply changes.")
    : null;
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {backgroundGitStatus
          ? gt("{status} {detail}", {
              status: backgroundGitStatus,
              detail: backgroundGitDetail ?? "",
            })
          : gt("Background Git status · {detail}", {
              detail: reason ?? query.error ?? gt("Loading…"),
            })}
      </p>
      <SettingsSection id={searchableSetting("work-assistance").id} title={gt("Work assistance")}>
        <SettingsRow
          title={gt("Enable work assistance (not recommended)")}
          description={gt(
            "Untested. Lets a signed-in local t3 client add a helper agent to a thread in this project that has worked nonstop for over 5 minutes. HomuCode never starts helpers by itself.",
          )}
          control={
            <Checkbox
              disabled={!canWrite}
              checked={choosingWork || settings.workAssistanceTarget !== null}
              onCheckedChange={(checked) => {
                setChoosingWork(Boolean(checked));
                if (!checked)
                  void update({ environmentId, input: { patch: { workAssistanceTarget: null } } });
              }}
            />
          }
        />
        {choosingWork || settings.workAssistanceTarget ? (
          <WorkAssistancePicker
            environmentId={environmentId}
            value={settings.workAssistanceTarget}
            onChange={(workAssistanceTarget) =>
              void update({ environmentId, input: { patch: { workAssistanceTarget } } })
            }
          />
        ) : null}
      </SettingsSection>
    </>
  );
}
