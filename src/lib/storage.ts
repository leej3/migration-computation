import { defaultAppState, defaultPlanningData, STORAGE_KEY, STORAGE_VERSION } from "./defaults";
import { slugify } from "./format";
import type {
  LineItem,
  OneTimeItem,
  PersistedAppState,
  PlanningProfileData,
  StoredProfile,
  TransferStrategy,
} from "./types";

const mergeById = <T extends { id: string }>(defaults: T[], incoming: T[]): T[] => {
  const incomingMap = new Map(incoming.map((item) => [item.id, item]));
  const mergedDefaults = defaults.map((item) => ({ ...item, ...incomingMap.get(item.id) }));
  const extraItems = incoming.filter((item) => !defaults.some((base) => base.id === item.id));
  return [...mergedDefaults, ...extraItems];
};

const mergePlanningData = (incoming?: Partial<PlanningProfileData>): PlanningProfileData => {
  const defaults = defaultPlanningData();
  if (!incoming) {
    return defaults;
  }

  const mergedStrategies = mergeById(defaults.strategies, incoming.strategies ?? []);
  const mergedRecurring = mergeById(defaults.recurringItems, incoming.recurringItems ?? []);
  const mergedOneTime = mergeById(defaults.oneTimeItems, incoming.oneTimeItems ?? []);

  return {
    ...defaults,
    ...incoming,
    property: {
      ...defaults.property,
      ...incoming.property,
      mortgage: {
        ...defaults.property.mortgage,
        ...incoming.property?.mortgage,
      },
    },
    usDebt: {
      ...defaults.usDebt,
      ...incoming.usDebt,
    },
    liquidity: {
      ...defaults.liquidity,
      ...incoming.liquidity,
    },
    transferCosts: {
      ...defaults.transferCosts,
      ...incoming.transferCosts,
    },
    priorities: {
      ...defaults.priorities,
      ...incoming.priorities,
    },
    scenarios: {
      base: { ...defaults.scenarios.base, ...incoming.scenarios?.base },
      downside: { ...defaults.scenarios.downside, ...incoming.scenarios?.downside },
      upside: { ...defaults.scenarios.upside, ...incoming.scenarios?.upside },
    },
    strategies: mergedStrategies as TransferStrategy[],
    recurringItems: mergedRecurring as LineItem[],
    oneTimeItems: mergedOneTime as OneTimeItem[],
  };
};

const mergeProfile = (incoming: Partial<StoredProfile>): StoredProfile => {
  const defaultProfile = defaultAppState().profiles[0];

  return {
    ...defaultProfile,
    ...incoming,
    id: incoming.id ?? defaultProfile.id,
    name: incoming.name ?? defaultProfile.name,
    updatedAt: incoming.updatedAt ?? new Date().toISOString(),
    data: mergePlanningData(incoming.data),
  };
};

export const loadState = (): PersistedAppState => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultAppState();
    }

    const parsed = JSON.parse(raw) as Partial<PersistedAppState>;
    const defaults = defaultAppState();
    const mergedProfiles = (parsed.profiles ?? defaults.profiles).map((profile) => mergeProfile(profile));
    const activeProfileId =
      mergedProfiles.find((profile) => profile.id === parsed.activeProfileId)?.id ?? mergedProfiles[0]?.id;

    return {
      version: STORAGE_VERSION,
      activeProfileId: activeProfileId ?? defaults.activeProfileId,
      profiles: mergedProfiles,
      ui: {
        ...defaults.ui,
        ...parsed.ui,
      },
    };
  } catch {
    return defaultAppState();
  }
};

export const saveState = (state: PersistedAppState): void => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ...state,
      version: STORAGE_VERSION,
    }),
  );
};

export const createBlankProfile = (name: string): StoredProfile => ({
  id: `${slugify(name)}-${Math.random().toString(36).slice(2, 8)}`,
  name,
  updatedAt: new Date().toISOString(),
  data: defaultPlanningData(),
});

export const exportState = (state: PersistedAppState): Blob =>
  new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });

export const importState = async (file: File): Promise<PersistedAppState> => {
  const text = await file.text();
  const parsed = JSON.parse(text) as Partial<PersistedAppState>;
  const defaults = defaultAppState();

  return {
    version: STORAGE_VERSION,
    activeProfileId: parsed.activeProfileId ?? defaults.activeProfileId,
    profiles: (parsed.profiles ?? defaults.profiles).map((profile) => mergeProfile(profile)),
    ui: {
      ...defaults.ui,
      ...parsed.ui,
    },
  };
};
