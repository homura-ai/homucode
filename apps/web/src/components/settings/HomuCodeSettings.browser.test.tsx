import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/index.css";
import "./HomuCodeSettings";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { installFakeEnvironment, type FakeDriver } from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

it("keeps device preferences usable when the linked environment is unavailable", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({
      initialEntries: ["/settings/homucode?machine=removed#user-message-markdown"],
    }),
  );
  await router.load();
  // Exercise the real Settings route and scope boundary.
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const toggle = page.getByRole("switch", { name: "Format sent messages as Markdown" });
  expect(toggle.query()).not.toBeNull();
  await expect.element(toggle).toBeChecked();
  await userEvent.click(toggle);
  await expect.element(toggle).not.toBeChecked();

  const senderLabels = page.getByRole("switch", { name: "Show message sender labels" });
  await expect.element(senderLabels).not.toBeChecked();
  await userEvent.click(senderLabels);
  await expect.element(senderLabels).toBeChecked();
});

it("explains an unavailable environment on the agent behavior page", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: ["/settings/agent-behavior?machine=removed"] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText("This environment is no longer available.")).toBeVisible();
  const allModels = page.getByRole("checkbox", { name: "Show all models in status line details" });
  const modelNames = page.getByRole("checkbox", { name: "Show model names" });
  await expect.element(allModels).toBeChecked();
  await expect.element(modelNames).not.toBeChecked();
  await userEvent.click(modelNames);
  await expect.element(modelNames).toBeChecked();
  await expect.element(allModels).toBeChecked();
  await userEvent.click(allModels);
  await expect.element(allModels).not.toBeChecked();
  await expect.element(modelNames).toBeChecked();

  await expect
    .element(page.getByRole("switch", { name: "Show Building Homu settings" }))
    .not.toBeInTheDocument();
});

it("takes an offline MadoHomu settings search to the reconnect guidance", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({
      initialEntries: ["/settings/madohomu?machine=removed#madohomu-working-placement"],
    }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });

  await expect.element(page.getByText("Reconnect removed to configure MadoHomu.")).toBeVisible();
  await expect.poll(() => router.state.location.hash).toBe("");
});
