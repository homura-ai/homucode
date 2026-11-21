import { fitStatusLineItems } from "@t3tools/client-runtime/status-line";

const MODEL_ABBREVIATIONS: Readonly<Partial<Record<string, readonly string[]>>> = {
  astra: ["Ast", "A"],
  fable: ["Fab", "F"],
  haiku: ["Hai", "H"],
  luna: ["L"],
  neon: ["Ne", "N"],
  opus: ["Op", "O"],
  sol: [],
  sonnet: ["Snt"],
  terra: ["T"],
};

export function mobileStatusLineModelLabels(modelName: string | null) {
  if (modelName === null) return { labels: [], truncate: false };
  const [, family = modelName, version = ""] = /^(.+?)(?: (\d.*))?$/.exec(modelName) ?? [];
  const familyKey = family.toLowerCase().replace(/^(?:google |gemini )+/, "");
  const abbreviations = Object.hasOwn(MODEL_ABBREVIATIONS, familyKey)
    ? MODEL_ABBREVIATIONS[familyKey]
    : undefined;
  if (abbreviations === undefined) return { labels: [modelName], truncate: true };
  const compactFamily = familyKey === "neon" ? "Neon" : family;
  return {
    labels: [
      ...new Set([
        modelName,
        compactFamily + version,
        ...abbreviations.map((name) => name + version),
      ]),
    ],
    truncate: false,
  };
}

interface LimitWidth {
  readonly width: number;
  readonly ratioWidth: number | null;
}

interface ModelWidth {
  readonly name: string;
  readonly width: number;
}

export function fitMobileStatusDials<Id extends string>(input: {
  readonly availableWidth: number;
  readonly context: { readonly full: number; readonly compact: number };
  readonly modelNames: readonly ModelWidth[];
  readonly effortWidth: number | null;
  readonly weekly: { readonly full: LimitWidth; readonly compact: LimitWidth } | null;
  readonly fiveHour: LimitWidth | null;
  readonly extras: readonly { readonly id: Id; readonly full: number }[];
}) {
  const totalLimitWidth = (limit: LimitWidth | null) =>
    limit === null ? 0 : limit.width + (limit.ratioWidth ?? 0);
  const fullWidth =
    input.context.full +
    (input.modelNames[0]?.width ?? 0) +
    (input.effortWidth ?? 0) +
    totalLimitWidth(input.weekly?.full ?? null) +
    totalLimitWidth(input.fiveHour) +
    input.extras.reduce((total, item) => total + item.full, 0);
  const compact = input.availableWidth < fullWidth;
  const minimumModel = input.modelNames.at(-1);
  let room =
    input.availableWidth -
    (compact ? input.context.compact : input.context.full) -
    (minimumModel?.width ?? 0);
  const wrapCore = room < 0;
  const reserve = (width: number | null) => {
    if (width === null || width > room) return false;
    room -= width;
    return true;
  };
  const weeklyLimit = (compact ? input.weekly?.compact : input.weekly?.full) ?? null;
  const weekly = reserve(weeklyLimit?.width ?? null);
  const fiveHour = reserve(input.fiveHour?.width ?? null);
  const weeklyRatio = weekly && reserve(weeklyLimit?.ratioWidth ?? null);
  const fiveHourRatio = fiveHour && reserve(input.fiveHour?.ratioWidth ?? null);
  const effort = reserve(input.effortWidth);
  const modelName =
    minimumModel === undefined
      ? null
      : (input.modelNames.find((model) => reserve(model.width - minimumModel.width))?.name ??
        minimumModel.name);
  const { visible } = fitStatusLineItems(room, { full: 0, compact: 0 }, input.extras);
  return {
    compact,
    modelName,
    effort,
    weekly,
    fiveHour,
    weeklyRatio,
    fiveHourRatio,
    visible,
    wrapCore,
  };
}
