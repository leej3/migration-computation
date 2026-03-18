export type Currency = "EUR" | "USD";
export type TabId = "overview" | "inputs" | "assumptions";
export type ScenarioId = "base" | "downside" | "upside";
export type StrategyId = "direct" | "hybrid" | "dca" | "custom";
export type TimingMode = "always" | "until-close" | "from-close";
export type OneTimeTimingMode = "absolute" | "at-close" | "after-close";
export type MortgageMode = "amortized" | "flat";
export type ProviderId = "bank" | "wise";

export interface ProfileSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export interface LineItem {
  id: string;
  name: string;
  category: string;
  currency: Currency;
  amount: number;
  enabled: boolean;
  timingMode: TimingMode;
  startMonth: number;
  endMonth: number | null;
}

export interface OneTimeItem {
  id: string;
  name: string;
  category: string;
  currency: Currency;
  amount: number;
  enabled: boolean;
  timingMode: OneTimeTimingMode;
  monthOffset: number;
}

export interface MacroScenario {
  id: ScenarioId;
  label: string;
  shortLabel: string;
  description: string;
  fxStartUsdPerEur: number;
  fxMonthlyChangePct: number;
  salePriceMonthlyChangePct: number;
  usdDebtAprShiftPct: number;
  liquidityStressUsd: number;
}

export interface TransferStrategy {
  id: StrategyId;
  label: string;
  description: string;
  provider: ProviderId;
  enabled: boolean;
  upfrontPct: number;
  dcaMonths: number;
  dcaStartOffset: number;
  customSchedulePct: number[];
}

export interface MortgageProfile {
  mode: MortgageMode;
  outstandingBalanceEur: number;
  annualRatePct: number;
  monthlyPaymentEur: number;
  remainingTermMonths: number;
}

export interface PropertyProfile {
  expectedSalePriceEur: number;
  expectedCloseMonth: number;
  estateAgentFeePct: number;
  legalFeesEur: number;
  repairsAndStagingEur: number;
  taxesAndOtherEur: number;
  mortgage: MortgageProfile;
}

export interface UsDebtProfile {
  initialBalanceUsd: number;
  annualRatePct: number;
  minimumMonthlyPaymentUsd: number;
  autoPaydownPct: number;
}

export interface LiquidityProfile {
  startingEurCash: number;
  startingUsdCash: number;
  targetUsdBuffer: number;
  targetEurBuffer: number;
}

export interface TransferCostsProfile {
  bankFxSpreadPct: number;
  bankOutgoingFeeEur: number;
  bankSwiftFeeEur: number;
  bankReceivingFeeUsd: number;
  wiseVariableFeePct: number;
  wiseFixedFeeEur: number;
  wiseReceivingFeeUsd: number;
  eurYieldPct: number;
}

export interface PrioritiesProfile {
  downsideProtection: number;
  liquidityPreservation: number;
  totalCost: number;
}

export interface PlanningProfileData {
  startDate: string;
  horizonMonths: number;
  disclaimerAccepted: boolean;
  property: PropertyProfile;
  usDebt: UsDebtProfile;
  liquidity: LiquidityProfile;
  transferCosts: TransferCostsProfile;
  priorities: PrioritiesProfile;
  scenarios: Record<ScenarioId, MacroScenario>;
  strategies: TransferStrategy[];
  recurringItems: LineItem[];
  oneTimeItems: OneTimeItem[];
}

export interface StoredProfile {
  id: string;
  name: string;
  updatedAt: string;
  data: PlanningProfileData;
}

export interface UiState {
  activeTab: TabId;
  activeScenarioId: ScenarioId;
  activeStrategyId: StrategyId;
}

export interface PersistedAppState {
  version: number;
  activeProfileId: string;
  profiles: StoredProfile[];
  ui: UiState;
}

export interface MonthlySnapshot {
  monthIndex: number;
  label: string;
  fxRateUsdPerEur: number;
  eurCash: number;
  salePoolEur: number;
  usdCash: number;
  usdDebtBalance: number;
  usdDebtInterest: number;
  usdMinimumPayment: number;
  usdExtraPayment: number;
  mortgageBalanceEur: number;
  mortgageInterestEur: number;
  mortgagePrincipalEur: number;
  mortgagePaymentEur: number;
  recurringEur: number;
  recurringUsd: number;
  oneTimeEur: number;
  oneTimeUsd: number;
  transferEur: number;
  transferUsd: number;
  transferFeesUsd: number;
  endingNetPositionUsd: number;
  liquidityGapUsd: number;
  notes: string[];
}

export interface SimulationResult {
  strategyId: StrategyId;
  scenarioId: ScenarioId;
  endingNetPositionUsd: number;
  endingEurEquivalentUsd: number;
  totalTransferFeesUsd: number;
  totalUsdDebtInterestUsd: number;
  totalMortgageInterestUsd: number;
  totalKnownCostsUsd: number;
  worstLiquidityGapUsd: number;
  saleProceedsEur: number;
  salePriceEur: number;
  score: number;
  scoreBreakdown: {
    downside: number;
    liquidity: number;
    cost: number;
  };
  monthlySnapshots: MonthlySnapshot[];
}

export interface ComparisonRow {
  strategy: TransferStrategy;
  activeScenario: SimulationResult;
  downsideScenario: SimulationResult;
  score: number;
}

export interface LiveMarketSnapshot {
  source: string;
  fxRateUsdPerEur: number;
  observedAt: string;
  fetchedAt: string;
}
