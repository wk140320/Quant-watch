import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const PROFILES = Object.freeze({
  light: Object.freeze({
    id: "light",
    label: "轻量",
    description: "电脑正在使用时运行；单任务、单线程树模型，优先保持页面流畅。",
    jobs: { maxConcurrent: 1, maxHeavyConcurrent: 1 },
    training: { incrementalSymbols: 60, weeklySymbols: 120, fullSymbols: 180, foldCount: 5, testDates: 120 },
    models: { treeMaxRows: 25_000, treeIterations: 56, treeThreads: 1, baselineMaxRows: 5_000, quantileMaxRows: 5_000 },
    factor: { lightSymbols: 18, heavySymbols: 80, generations: 3, population: 20, lightIntervalHours: 168, heavyIntervalHours: 720 },
    minute: { symbolLimit: 2, minimumNewRows: 300 },
    data: { historyBatch: 20, pitBatch: 10, officialPitBatch: 5, delistedBatch: 4 },
  }),
  balanced: Object.freeze({
    id: "balanced",
    label: "均衡",
    description: "日常推荐；前端优先，后台保持一条重型训练链并持续积累证据。",
    jobs: { maxConcurrent: 2, maxHeavyConcurrent: 1 },
    training: { incrementalSymbols: 120, weeklySymbols: 250, fullSymbols: 400, foldCount: 6, testDates: 120 },
    models: { treeMaxRows: 40_000, treeIterations: 72, treeThreads: 2, baselineMaxRows: 6_000, quantileMaxRows: 6_000 },
    factor: { lightSymbols: 36, heavySymbols: 120, generations: 6, population: 36, lightIntervalHours: 72, heavyIntervalHours: 336 },
    minute: { symbolLimit: 3, minimumNewRows: 200 },
    data: { historyBatch: 60, pitBatch: 30, officialPitBatch: 15, delistedBatch: 10 },
  }),
  deep: Object.freeze({
    id: "deep",
    label: "深度",
    description: "电脑空闲时运行；扩大横截面、折数和树模型拟合深度，耗时与发热明显增加。",
    jobs: { maxConcurrent: 3, maxHeavyConcurrent: 1 },
    training: { incrementalSymbols: 200, weeklySymbols: 450, fullSymbols: 650, foldCount: 7, testDates: 180 },
    models: { treeMaxRows: 80_000, treeIterations: 120, treeThreads: 4, baselineMaxRows: 12_000, quantileMaxRows: 12_000 },
    factor: { lightSymbols: 80, heavySymbols: 180, generations: 10, population: 64, lightIntervalHours: 24, heavyIntervalHours: 168 },
    minute: { symbolLimit: 4, minimumNewRows: 100 },
    data: { historyBatch: 120, pitBatch: 60, officialPitBatch: 30, delistedBatch: 20 },
  }),
});

function profileId(value) {
  const key = String(value || "balanced").trim().toLowerCase();
  return Object.hasOwn(PROFILES, key) ? key : "balanced";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createTrainingResourceService({ configPath, applyPolicy } = {}) {
  if (!configPath) throw new Error("Training resource service requires a config path.");
  let selected = profileId(process.env.TRAINING_RESOURCE_PROFILE || "balanced");
  let updatedAt = null;
  let source = "default";

  function snapshot() {
    return {
      selected,
      updatedAt,
      source,
      profile: clone(PROFILES[selected]),
      profiles: Object.values(PROFILES).map(clone),
      note: "资源档位只改变训练吞吐与样本上限，不降低 OOF、PIT、校准或晋级门槛。正在运行的任务不会被强制中断。",
    };
  }

  function apply() {
    if (typeof applyPolicy === "function") applyPolicy(clone(PROFILES[selected]));
  }

  const ready = (async () => {
    try {
      const payload = JSON.parse(await readFile(configPath, "utf8"));
      selected = profileId(payload.selected);
      updatedAt = payload.updatedAt || null;
      source = "local-config";
    } catch {
      source = "default";
    }
    apply();
    return snapshot();
  })();

  async function get() {
    await ready;
    return snapshot();
  }

  function current() {
    return snapshot();
  }

  async function set(value) {
    await ready;
    selected = profileId(value);
    updatedAt = new Date().toISOString();
    source = "user";
    apply();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ selected, updatedAt }, null, 2), "utf8");
    return snapshot();
  }

  function trainingPlan(mode = "weekly", plan = {}) {
    const profile = PROFILES[selected];
    const key = String(mode || "weekly").toLowerCase();
    const symbolCap = key === "full"
      ? profile.training.fullSymbols
      : key === "incremental"
        ? profile.training.incrementalSymbols
        : profile.training.weeklySymbols;
    return {
      ...plan,
      resourceProfile: selected,
      limit: Math.max(10, Math.min(symbolCap, Math.max(symbolCap, Number(plan.limit || 0)))),
      foldCount: profile.training.foldCount,
      testDates: Math.max(120, Math.min(profile.training.testDates, Number(plan.testDates || profile.training.testDates))),
      treeMaxRows: profile.models.treeMaxRows,
      treeIterations: profile.models.treeIterations,
      treeThreads: profile.models.treeThreads,
      baselineMaxRows: profile.models.baselineMaxRows,
      quantileMaxRows: profile.models.quantileMaxRows,
    };
  }

  return { current, get, ready, set, trainingPlan };
}

export { PROFILES, createTrainingResourceService, profileId };
