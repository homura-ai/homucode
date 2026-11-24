import { parseStatusLineBurnTau } from "@t3tools/client-runtime/status-line";
import type { ProviderInstanceId, ServerConfig, StatusLineCustomBar } from "@t3tools/contracts";
import { statusLineAccountKey } from "@t3tools/shared/usageLimits";
import { useGT } from "gt-react-native";
import { TextInput } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import {
  STATUS_LINE_INPUT_CLASS,
  StatusLineChoiceMenu,
  StatusLineSlidingMinutesInput,
  type StatusLineChoice,
} from "./StatusLineRateEstimatorControl";

export type UsageSource = Extract<StatusLineCustomBar["source"], { type: "usage" }>;

export interface StatusLineUsageDraft {
  readonly scopeKind: UsageSource["scope"]["kind"];
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly models: readonly string[];
  readonly accountIds: readonly string[];
  readonly windowKind: UsageSource["window"]["kind"];
  readonly minutes: string;
  readonly resetAccountId: string;
  readonly command: string;
  readonly basis: UsageSource["basis"];
}

export function statusLineUsageDraft(source: UsageSource | undefined): StatusLineUsageDraft {
  return {
    scopeKind: source?.scope.kind ?? "provider",
    providerInstanceId: source?.scope.kind === "provider" ? source.scope.providerInstanceId : null,
    models: source?.scope.kind === "models" ? source.scope.models : [],
    accountIds: source?.scope.kind === "accounts" ? source.scope.accountIds : [],
    windowKind: source?.window.kind ?? "ema",
    minutes: source?.window.kind === "sliding" ? String(source.window.minutes) : "1440",
    resetAccountId: source?.window.kind === "reset" ? source.window.accountId : "",
    command: source?.window.kind === "command" ? source.window.command : "",
    basis: source?.basis ?? "percentages",
  };
}

export function parseStatusLineUsageDraft(draft: StatusLineUsageDraft): UsageSource | null {
  let scope: UsageSource["scope"];
  switch (draft.scopeKind) {
    case "provider":
      if (draft.providerInstanceId === null) return null;
      scope = { kind: "provider", providerInstanceId: draft.providerInstanceId };
      break;
    case "models":
      if (draft.models.length === 0) return null;
      scope = { kind: "models", models: draft.models };
      break;
    case "accounts":
      if (draft.accountIds.length === 0) return null;
      scope = { kind: "accounts", accountIds: draft.accountIds };
      break;
  }

  let window: UsageSource["window"];
  switch (draft.windowKind) {
    case "ema":
      window = { kind: "ema" };
      break;
    case "sliding": {
      const minutes = parseStatusLineBurnTau(draft.minutes);
      if (minutes === null) return null;
      window = { kind: "sliding", minutes };
      break;
    }
    case "reset":
      if (!draft.resetAccountId) return null;
      window = { kind: "reset", accountId: draft.resetAccountId };
      break;
    case "command": {
      const command = draft.command.trim();
      if (!command) return null;
      window = { kind: "command", command };
      break;
    }
  }
  return { type: "usage", scope, window, basis: draft.basis };
}

export function statusLineUsageOptions(
  config: Pick<ServerConfig, "providers" | "usageLimitSources">,
  names: Readonly<Record<string, string>>,
) {
  const providers = config.providers.map((provider) => ({
    id: provider.instanceId,
    title: provider.displayName ?? provider.instanceId,
  }));
  const modelIds = new Set(
    config.providers.flatMap((provider) => provider.models.map((model) => model.slug)),
  );
  const accounts = (config.usageLimitSources ?? []).flatMap((source) =>
    source.accounts.map((account) => {
      for (const window of account.usageLimits.windows) {
        for (const modelId of window.modelIds ?? []) modelIds.add(modelId);
      }
      const id = statusLineAccountKey(source.id, account.id);
      return { id, title: `${names[id] ?? account.email ?? account.id} · ${source.label}` };
    }),
  );
  return { providers, models: [...modelIds].sort().map((id) => ({ id, title: id })), accounts };
}

function withSelected<T extends string>(
  options: readonly StatusLineChoice<T>[],
  selected: readonly T[],
) {
  return [
    ...options,
    ...selected
      .filter((id) => !options.some((option) => option.id === id))
      .map((id) => ({ id, title: id })),
  ];
}

function toggleSelection(selected: readonly string[], id: string) {
  return selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
}

export function StatusLineUsageEditor(props: {
  readonly options: ReturnType<typeof statusLineUsageOptions>;
  readonly draft: StatusLineUsageDraft;
  readonly disabled: boolean;
  readonly onChange: (draft: StatusLineUsageDraft) => void;
}) {
  const gt = useGT();
  const { draft, onChange, options, disabled } = props;
  const selectedProvider = draft.providerInstanceId === null ? [] : [draft.providerInstanceId];
  const selectedResetAccount = draft.resetAccountId === "" ? [] : [draft.resetAccountId];
  const commandLabel = gt("Start time command");
  return (
    <>
      <StatusLineChoiceMenu<UsageSource["scope"]["kind"]>
        label={gt("Usage scope")}
        placeholder=""
        choices={[
          { id: "provider", title: gt("Provider instance") },
          { id: "models", title: gt("Models") },
          { id: "accounts", title: gt("Quota accounts") },
        ]}
        selected={[draft.scopeKind]}
        disabled={disabled}
        onSelect={(scopeKind) => onChange({ ...draft, scopeKind })}
      />
      {draft.scopeKind === "provider" ? (
        <StatusLineChoiceMenu
          label={gt("Provider instance")}
          placeholder={gt("Choose provider")}
          choices={withSelected(options.providers, selectedProvider)}
          selected={selectedProvider}
          disabled={disabled}
          onSelect={(providerInstanceId) => onChange({ ...draft, providerInstanceId })}
        />
      ) : draft.scopeKind === "models" ? (
        <StatusLineChoiceMenu
          label={gt("Models")}
          placeholder={gt("Choose models")}
          choices={withSelected(options.models, draft.models)}
          selected={draft.models}
          disabled={disabled}
          onSelect={(id) => onChange({ ...draft, models: toggleSelection(draft.models, id) })}
        />
      ) : (
        <StatusLineChoiceMenu
          label={gt("Quota accounts")}
          placeholder={gt("Choose quota accounts")}
          choices={withSelected(options.accounts, draft.accountIds)}
          selected={draft.accountIds}
          disabled={disabled}
          onSelect={(id) =>
            onChange({ ...draft, accountIds: toggleSelection(draft.accountIds, id) })
          }
        />
      )}
      <StatusLineChoiceMenu<UsageSource["window"]["kind"]>
        label={gt("Usage window")}
        placeholder=""
        choices={[
          { id: "ema", title: gt("Exponential moving average") },
          { id: "sliding", title: gt("Sliding window") },
          { id: "reset", title: gt("Since last reset") },
          { id: "command", title: gt("From command output") },
        ]}
        selected={[draft.windowKind]}
        disabled={disabled}
        onSelect={(windowKind) => onChange({ ...draft, windowKind })}
      />
      {draft.windowKind === "sliding" ? (
        <StatusLineSlidingMinutesInput
          value={draft.minutes}
          disabled={disabled}
          onChangeText={(minutes) => onChange({ ...draft, minutes })}
        />
      ) : null}
      {draft.windowKind === "reset" ? (
        <StatusLineChoiceMenu
          label={gt("Reset account")}
          placeholder={gt("Choose quota account")}
          choices={withSelected(options.accounts, selectedResetAccount)}
          selected={selectedResetAccount}
          disabled={disabled}
          onSelect={(resetAccountId) => onChange({ ...draft, resetAccountId })}
        />
      ) : null}
      {draft.windowKind === "command" ? (
        <>
          <Text className="text-sm">{commandLabel}</Text>
          <TextInput
            accessibilityLabel={commandLabel}
            className={STATUS_LINE_INPUT_CLASS}
            editable={!disabled}
            autoCapitalize="none"
            autoCorrect={false}
            value={draft.command}
            onChangeText={(command) => onChange({ ...draft, command })}
          />
          <Text className="text-xs text-foreground-muted">
            {gt("Runs on the server and prints the start time as an ISO timestamp.")}
          </Text>
        </>
      ) : null}
      <StatusLineChoiceMenu<UsageSource["basis"]>
        label={gt("Usage basis")}
        placeholder=""
        choices={[
          { id: "percentages", title: gt("Quota percentages") },
          { id: "homucode", title: gt("HomuCode usage only") },
        ]}
        selected={[draft.basis]}
        disabled={disabled}
        onSelect={(basis) => onChange({ ...draft, basis })}
      />
    </>
  );
}
