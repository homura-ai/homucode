import { parseStatusLineTargetRate } from "@t3tools/client-runtime/status-line";
import { ProviderInstanceId, type StatusLineCustomBar } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";

import { Input } from "../ui/input";

export type GroupedBarSource = Extract<StatusLineCustomBar["source"], { type: "usage" }>;
type GroupScope = GroupedBarSource["scope"];
type UsageWindow = GroupedBarSource["window"];
type Choice = { readonly id: string; readonly label: string };

export function StatusLineGroupedBarFields(props: {
  readonly initial: GroupedBarSource | undefined;
  readonly providers: readonly Choice[];
  readonly models: readonly Choice[];
  readonly accounts: readonly Choice[];
  readonly onChange: (source: GroupedBarSource | undefined) => void;
}) {
  const gt = useGT();
  const initialScope = props.initial?.scope;
  const initialWindow = props.initial?.window;
  const [draft, setDraft] = useState({
    scope: initialScope?.kind ?? "provider",
    provider: initialScope?.kind === "provider" ? initialScope.providerInstanceId : "",
    models: initialScope?.kind === "models" ? initialScope.models : [],
    accounts: initialScope?.kind === "accounts" ? initialScope.accountIds : [],
    window: initialWindow?.kind ?? "ema",
    minutes: initialWindow?.kind === "sliding" ? String(initialWindow.minutes) : "1440",
    resetAccount: initialWindow?.kind === "reset" ? initialWindow.accountId : "",
    command: initialWindow?.kind === "command" ? initialWindow.command : "",
    basis: props.initial?.basis ?? "percentages",
  });
  const update = (patch: Partial<typeof draft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    const scope = usageScope(next);
    const window = usageWindow(next);
    props.onChange(
      scope && window ? { type: "usage", scope, window, basis: next.basis } : undefined,
    );
  };
  const optionClass = "min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-sm";
  const options = (items: readonly Choice[]) =>
    items.map(({ id, label }) => (
      <option key={id} value={id}>
        {label}
      </option>
    ));
  return (
    <>
      <select
        className={optionClass}
        aria-label={gt("Usage scope")}
        value={draft.scope}
        onChange={(event) => {
          const value = event.currentTarget.value;
          update({ scope: value === "models" || value === "accounts" ? value : "provider" });
        }}
      >
        <option value="provider">{gt("Provider instance")}</option>
        <option value="models">{gt("Models")}</option>
        <option value="accounts">{gt("Quota accounts")}</option>
      </select>
      {draft.scope === "provider" ? (
        <select
          className={optionClass}
          aria-label={gt("Provider")}
          value={draft.provider}
          onChange={(event) => update({ provider: event.currentTarget.value })}
        >
          <option value="">{gt("Choose provider")}</option>
          {options(props.providers)}
        </select>
      ) : (
        <select
          multiple
          className={optionClass}
          aria-label={draft.scope === "models" ? gt("Models") : gt("Quota accounts")}
          value={draft.scope === "models" ? draft.models : draft.accounts}
          onChange={(event) => {
            const values = Array.from(
              event.currentTarget.selectedOptions,
              (option) => option.value,
            );
            update(draft.scope === "models" ? { models: values } : { accounts: values });
          }}
        >
          {options(draft.scope === "models" ? props.models : props.accounts)}
        </select>
      )}
      <select
        className={optionClass}
        aria-label={gt("Usage window")}
        value={draft.window}
        onChange={(event) => {
          const value = event.currentTarget.value;
          update({
            window: value === "sliding" || value === "reset" || value === "command" ? value : "ema",
          });
        }}
      >
        <option value="ema">{gt("Exponential moving average")}</option>
        <option value="sliding">{gt("Sliding window")}</option>
        <option value="reset">{gt("Since last reset")}</option>
        <option value="command">{gt("From command output")}</option>
      </select>
      {draft.window === "sliding" ? (
        <Input
          size="sm"
          inputMode="decimal"
          value={draft.minutes}
          aria-label={gt("Sliding window (minutes)")}
          onValueChange={(minutes) => update({ minutes })}
        />
      ) : draft.window === "reset" ? (
        <select
          className={optionClass}
          aria-label={gt("Reset account")}
          value={draft.resetAccount}
          onChange={(event) => update({ resetAccount: event.currentTarget.value })}
        >
          <option value="">{gt("Choose quota account")}</option>
          {options(props.accounts)}
        </select>
      ) : draft.window === "command" ? (
        <Input
          size="sm"
          value={draft.command}
          aria-label={gt("Start time command")}
          placeholder={gt("Runs on the server and prints the start time as an ISO timestamp.")}
          onValueChange={(command) => update({ command })}
        />
      ) : null}
      <select
        className={optionClass}
        aria-label={gt("Usage basis")}
        value={draft.basis}
        onChange={(event) =>
          update({ basis: event.currentTarget.value === "homucode" ? "homucode" : "percentages" })
        }
      >
        <option value="percentages">{gt("Quota percentages")}</option>
        <option value="homucode">{gt("HomuCode usage only")}</option>
      </select>
    </>
  );
}

function usageScope(input: {
  readonly scope: GroupScope["kind"];
  readonly provider: string;
  readonly models: readonly string[];
  readonly accounts: readonly string[];
}): GroupScope | undefined {
  switch (input.scope) {
    case "provider":
      return input.provider
        ? { kind: "provider", providerInstanceId: ProviderInstanceId.make(input.provider) }
        : undefined;
    case "models":
      return input.models.length ? { kind: "models", models: input.models } : undefined;
    case "accounts":
      return input.accounts.length ? { kind: "accounts", accountIds: input.accounts } : undefined;
  }
}

function usageWindow(input: {
  readonly window: UsageWindow["kind"];
  readonly minutes: string;
  readonly resetAccount: string;
  readonly command: string;
}): UsageWindow | undefined {
  switch (input.window) {
    case "ema":
      return { kind: "ema" };
    case "sliding": {
      const minutes = parseStatusLineTargetRate(input.minutes);
      return minutes == null ? undefined : { kind: "sliding", minutes };
    }
    case "reset":
      return input.resetAccount ? { kind: "reset", accountId: input.resetAccount } : undefined;
    case "command":
      return input.command.trim() ? { kind: "command", command: input.command.trim() } : undefined;
  }
}
