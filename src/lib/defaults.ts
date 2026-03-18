import type {
  LineItem,
  MacroScenario,
  OneTimeItem,
  PersistedAppState,
  PlanningProfileData,
  ProviderId,
  ScenarioId,
  StoredProfile,
  StrategyId,
  TransferStrategy,
} from "./types";

export const STORAGE_KEY = "migration-computation:v1";
export const STORAGE_VERSION = 1;
export const HORIZON_LIMIT = 6;

const createRecurringItem = (
  id: string,
  name: string,
  category: string,
  currency: LineItem["currency"],
  amount: number,
  timingMode: LineItem["timingMode"],
  startMonth = 0,
  endMonth: number | null = null,
): LineItem => ({
  id,
  name,
  category,
  currency,
  amount,
  enabled: true,
  timingMode,
  startMonth,
  endMonth,
});

const createOneTimeItem = (
  id: string,
  name: string,
  category: string,
  currency: OneTimeItem["currency"],
  amount: number,
  timingMode: OneTimeItem["timingMode"],
  monthOffset: number,
): OneTimeItem => ({
  id,
  name,
  category,
  currency,
  amount,
  enabled: true,
  timingMode,
  monthOffset,
});

const createStrategy = (
  id: StrategyId,
  label: string,
  description: string,
  provider: ProviderId,
  upfrontPct: number,
  dcaMonths: number,
  dcaStartOffset: number,
  customSchedulePct: number[],
): TransferStrategy => ({
  id,
  label,
  description,
  provider,
  enabled: true,
  upfrontPct,
  dcaMonths,
  dcaStartOffset,
  customSchedulePct,
});

const createScenario = (
  id: ScenarioId,
  label: string,
  shortLabel: string,
  description: string,
  fxStartUsdPerEur: number,
  fxMonthlyChangePct: number,
  salePriceMonthlyChangePct: number,
  usdDebtAprShiftPct: number,
  liquidityStressUsd: number,
): MacroScenario => ({
  id,
  label,
  shortLabel,
  description,
  fxStartUsdPerEur,
  fxMonthlyChangePct,
  salePriceMonthlyChangePct,
  usdDebtAprShiftPct,
  liquidityStressUsd,
});

export const defaultPlanningData = (): PlanningProfileData => ({
  startDate: "2026-04-01",
  horizonMonths: 6,
  disclaimerAccepted: true,
  property: {
    expectedSalePriceEur: 650_000,
    expectedCloseMonth: 4,
    estateAgentFeePct: 1.5,
    legalFeesEur: 3_500,
    repairsAndStagingEur: 8_000,
    taxesAndOtherEur: 1_800,
    mortgage: {
      mode: "amortized",
      outstandingBalanceEur: 340_000,
      annualRatePct: 2.85,
      monthlyPaymentEur: 2_100,
      remainingTermMonths: 240,
    },
  },
  usDebt: {
    initialBalanceUsd: 375_000,
    annualRatePct: 6.25,
    minimumMonthlyPaymentUsd: 2_500,
    autoPaydownPct: 100,
  },
  liquidity: {
    startingEurCash: 15_000,
    startingUsdCash: 25_000,
    targetUsdBuffer: 45_000,
    targetEurBuffer: 4_000,
  },
  transferCosts: {
    bankFxSpreadPct: 1.25,
    bankOutgoingFeeEur: 15,
    bankSwiftFeeEur: 6.35,
    bankReceivingFeeUsd: 20,
    wiseVariableFeePct: 0.57,
    wiseFixedFeeEur: 1.5,
    wiseReceivingFeeUsd: 0,
    eurYieldPct: 2.1,
  },
  priorities: {
    downsideProtection: 40,
    liquidityPreservation: 35,
    totalCost: 25,
  },
  scenarios: {
    base: createScenario(
      "base",
      "Base case",
      "Base",
      "Modest sale slippage, rates broadly steady, euro roughly flat to slightly firmer.",
      1.08,
      0.2,
      -0.15,
      0,
      5_000,
    ),
    downside: createScenario(
      "downside",
      "Downside case",
      "Downside",
      "Longer financing stress, weaker buyer appetite, and softer euro conversion levels.",
      1.08,
      -1,
      -1.25,
      0.5,
      20_000,
    ),
    upside: createScenario(
      "upside",
      "Upside case",
      "Upside",
      "Cleaner close, firmer euro, and slightly easier debt servicing conditions.",
      1.08,
      1,
      0.45,
      -0.25,
      0,
    ),
  },
  strategies: [
    createStrategy(
      "direct",
      "Direct bank transfer",
      "Convert the entire sale pool at closing using bank rails.",
      "bank",
      100,
      1,
      0,
      [100, 0, 0, 0, 0, 0],
    ),
    createStrategy(
      "hybrid",
      "Hybrid release",
      "Move enough up front to cut debt quickly, then average the rest across later months.",
      "wise",
      45,
      4,
      1,
      [45, 20, 15, 10, 10, 0],
    ),
    createStrategy(
      "dca",
      "Wise DCA",
      "Move the proceeds in equal monthly tranches after closing.",
      "wise",
      0,
      6,
      0,
      [16.67, 16.67, 16.67, 16.67, 16.66, 16.66],
    ),
    createStrategy(
      "custom",
      "Custom schedule",
      "Hand-tuned conversion plan. Adjust each month directly in the Inputs tab.",
      "wise",
      20,
      6,
      0,
      [20, 20, 20, 15, 15, 10],
    ),
  ],
  recurringItems: [
    createRecurringItem("irish-home-running", "Irish home running costs", "Ireland", "EUR", 420, "until-close"),
    createRecurringItem("irish-insurance", "Irish insurance and utilities", "Ireland", "EUR", 220, "until-close"),
    createRecurringItem("us-property-tax", "US property tax reserve", "US", "USD", 450, "always"),
    createRecurringItem("us-home-insurance", "US home insurance", "US", "USD", 140, "always"),
    createRecurringItem("us-utilities", "US utilities", "US", "USD", 320, "always"),
    createRecurringItem("fuel-and-travel", "Atlantic travel / admin", "Transition", "USD", 275, "always"),
    createRecurringItem("post-close-furniture", "US setup and small purchases", "US", "USD", 450, "from-close", 1, 4),
  ],
  oneTimeItems: [
    createOneTimeItem("movers", "Movers", "Transition", "USD", 7_500, "at-close", 0),
    createOneTimeItem("flights", "Flights and hotels", "Transition", "USD", 1_800, "at-close", 0),
    createOneTimeItem("car", "Car purchase", "US", "USD", 18_000, "after-close", 1),
    createOneTimeItem("furniture", "Furniture and setup", "US", "USD", 5_500, "after-close", 1),
    createOneTimeItem("closing-admin", "US closing and admin", "US", "USD", 2_750, "absolute", 0),
  ],
});

export const defaultProfile = (): StoredProfile => ({
  id: "starter-plan",
  name: "Starter plan",
  updatedAt: new Date().toISOString(),
  data: defaultPlanningData(),
});

export const defaultAppState = (): PersistedAppState => {
  const profile = defaultProfile();

  return {
    version: STORAGE_VERSION,
    activeProfileId: profile.id,
    profiles: [profile],
    ui: {
      activeTab: "overview",
      activeScenarioId: "base",
      activeStrategyId: "hybrid",
    },
  };
};

export const DEFAULT_SOURCE_LINKS = {
  aibFees: "https://aib.ie/help-and-guidance/personal-current-account-fees-and-charges-information",
  truistFees:
    "https://www.truist.com/content/dam/truist-bank/us/en/documents/disclosures/personal-deposit-accounts-fee-schedule.pdf",
  wisePricing: "https://wise.com/gb/pricing/send-money?sourceAmount=50000&sourceCcy=EUR&targetCcy=USD",
  fxSource: "https://www.frankfurter.app/",
};
