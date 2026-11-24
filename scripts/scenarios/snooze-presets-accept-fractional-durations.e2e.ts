/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";

import { rpcClient, runPromise, test, WEB } from "./t3.ts";

test(
  "Snooze settings persist fractional durations and more than sixteen presets",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("demo");
    await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
        yield* client["server.updateSettings"]({
          patch: {
            featureOffersSeen: [
              "madohomu",
              "quick-model",
              "settings-sync",
              "status-line",
              "subagents",
              "bare-stop-wait",
              "claude-steer-recovery",
              "reask-after-restart",
              "apply-model-change-now",
              "faster-phone-launch",
              "sent-from",
              "project-in-title",
              "title-id-prefix",
              "thread-only-stop",
              "background-git",
              "auto-update-when-idle",
              "building-t3",
              "connect-long-sessions",
              "claude-hold-background-commands",
            ],
          },
        });
      }).pipe(Effect.scoped),
    );
    const settings = "/settings/threads#snooze";
    await t3.open(settings);

    const editAmount = async (label: string, value: string) => {
      await screen.getByRole("textbox", label, { exact: true }).first().waitFor();
      await browser.evaluate(
        ({ label, value }) => {
          const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
          if (!input) throw new Error(`Missing number field: ${label}`);
          const setValue = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )?.set;
          if (!setValue) throw new Error("Missing native input value setter");
          input.focus();
          setValue.call(input, value);
          input.dispatchEvent(new InputEvent("input", { bubbles: true }));
          return null;
        },
        { label, value },
      );
      await browser.evaluate(() => {
        if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
        return null;
      });
    };
    await editAmount("Amount", "1.25");
    await expect(screen.getByText("In 75 minutes", { exact: true })).toBeVisible();

    for (let row = 6; row <= 17; row++) {
      await browser.evaluate(() => {
        const add = [...document.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Add option",
        );
        if (!add) throw new Error("Missing add option button");
        add.click();
        return null;
      });
      await screen.getByRole("group", `Snooze option ${row}`, { exact: true }).waitFor();
    }
    const last = screen.getByRole("group", "Snooze option 17");
    await browser.evaluate(() => {
      const when = document.querySelector<HTMLElement>(
        '[aria-label="Snooze option 17"] [role="combobox"][aria-label="When"]',
      );
      if (!when) throw new Error("Missing snooze schedule selector");
      when.focus();
      when.click();
      return null;
    });
    await screen.getByRole("option", "Days ahead").waitFor();
    await browser.evaluate(() => {
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (item) => item.textContent?.trim() === "Days ahead",
      );
      if (!option) throw new Error("Missing Days ahead option");
      option.click();
      return null;
    });
    await editAmount("Days", "40.5");
    await expect(screen.getByText("In 40.5 days", { exact: true })).toBeVisible();
    await app.open(settings);
    await expect(last).toBeVisible();
    await expect(screen.getByText("In 75 minutes", { exact: true })).toBeVisible();
    await expect(screen.getByText("In 40.5 days", { exact: true })).toBeVisible();
    await app.screenshot("snooze-presets");
  },
);
