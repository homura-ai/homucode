import { describe, expect, it } from "vite-plus/test";

import { fitMobileStatusDials, mobileStatusLineModelLabels } from "./thread-status-dial-layout";

describe("mobile status line model labels", () => {
  it.each([
    ["Astra 6.2", ["Astra 6.2", "Astra6.2", "Ast6.2", "A6.2"]],
    ["Fable 5.2", ["Fable 5.2", "Fable5.2", "Fab5.2", "F5.2"]],
    ["Haiku 5.5", ["Haiku 5.5", "Haiku5.5", "Hai5.5", "H5.5"]],
    ["Luna 6", ["Luna 6", "Luna6", "L6"]],
    ["Gemini Neon 4", ["Gemini Neon 4", "Neon4", "Ne4", "N4"]],
    ["Opus 5.5", ["Opus 5.5", "Opus5.5", "Op5.5", "O5.5"]],
    ["Sol 6.2", ["Sol 6.2", "Sol6.2"]],
    ["Sonnet 5.5", ["Sonnet 5.5", "Sonnet5.5", "Snt5.5"]],
    ["Terra 6.1", ["Terra 6.1", "Terra6.1", "T6.1"]],
  ] as const)("keeps the version of %s in each spelling", (model, labels) => {
    expect(mobileStatusLineModelLabels(model)).toEqual({ labels, truncate: false });
  });

  it("preserves the original spelling for other models", () => {
    expect(mobileStatusLineModelLabels("Gemini Pro 3.1")).toEqual({
      labels: ["Gemini Pro 3.1"],
      truncate: true,
    });
  });
});

describe("mobile status line priority", () => {
  it("wraps instead of clipping when context and the shortest model cannot share a line", () => {
    const layout = fitMobileStatusDials({
      availableWidth: 248,
      context: { full: 190, compact: 180 },
      modelNames: [{ name: "N4", width: 85 }],
      effortWidth: 30,
      weekly: [],
      fiveHour: null,
      extras: [{ id: "cost", full: 40 }],
    });
    expect(layout).toMatchObject({ modelName: "N4", effort: false, wrapCore: true });
    expect(layout.visible.size).toBe(0);
  });

  it("keeps the weekly account dial that fits ahead of the five-hour dial", () => {
    const account = {
      full: { width: 90, ratioWidth: null },
      compact: { width: 86, ratioWidth: null },
    };
    const layout = fitMobileStatusDials({
      availableWidth: 360,
      context: { full: 150, compact: 148 },
      modelNames: [{ name: "O5.5", width: 50 }],
      effortWidth: null,
      weekly: [account, account],
      fiveHour: { width: 80, ratioWidth: null },
      extras: [],
    });
    expect(layout).toMatchObject({ weeklyCount: 1, fiveHour: false });
  });

  it("keeps a weekly depletion ratio when it takes no extra room", () => {
    const width = { width: 55, ratioWidth: 0 };
    const layout = fitMobileStatusDials({
      availableWidth: 150,
      context: { full: 90, compact: 90 },
      modelNames: [],
      effortWidth: null,
      weekly: [{ full: width, compact: width }],
      fiveHour: null,
      extras: [],
    });
    expect(layout).toMatchObject({ weeklyCount: 1, weeklyRatio: true });
  });

  it.each([
    [146, "A6.2", false, false, false, false, false],
    [206, "A6.2", true, true, false, false, false],
    [216, "A6.2", true, true, true, false, false],
    [236, "A6.2", true, true, true, true, false],
    [265, "Astra6.2", true, true, true, true, false],
    [280, "Astra 6.2", true, true, true, true, false],
    [321, "Astra 6.2", true, true, true, true, true],
  ] as const)(
    "preserves the next highest priority at width %s",
    (availableWidth, modelName, fiveHour, weeklyRatio, fiveHourRatio, effort, cost) => {
      const layout = fitMobileStatusDials({
        availableWidth,
        context: { full: 80, compact: 70 },
        modelNames: [
          { name: "Astra 6.2", width: 70 },
          { name: "Astra6.2", width: 55 },
          { name: "A6.2", width: 26 },
        ],
        effortWidth: 20,
        weekly: [
          {
            full: { width: 55, ratioWidth: 10 },
            compact: { width: 50, ratioWidth: 10 },
          },
        ],
        fiveHour: { width: 50, ratioWidth: 10 },
        extras: [{ id: "cost", full: 26 }],
      });
      expect(layout).toMatchObject({
        modelName,
        weeklyCount: 1,
        fiveHour,
        weeklyRatio,
        fiveHourRatio,
        effort,
      });
      expect(layout.visible.has("cost")).toBe(cost);
    },
  );
});
