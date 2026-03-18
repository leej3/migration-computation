import { addMonths, format, parseISO } from "date-fns";
import { clamp } from "./format";
import type {
  ComparisonRow,
  LineItem,
  MacroScenario,
  MonthlySnapshot,
  OneTimeItem,
  PlanningProfileData,
  ScenarioId,
  SimulationResult,
  TransferStrategy,
} from "./types";

const monthlyRate = (annualRatePct: number): number => annualRatePct / 100 / 12;

const monthLabel = (startDate: string, monthIndex: number): string =>
  format(addMonths(parseISO(startDate), monthIndex), "MMM yyyy");

const normalizeWeights = (weights: PlanningProfileData["priorities"]): PlanningProfileData["priorities"] => {
  const total = weights.downsideProtection + weights.liquidityPreservation + weights.totalCost;
  if (!total) {
    return {
      downsideProtection: 1 / 3,
      liquidityPreservation: 1 / 3,
      totalCost: 1 / 3,
    };
  }

  return {
    downsideProtection: weights.downsideProtection / total,
    liquidityPreservation: weights.liquidityPreservation / total,
    totalCost: weights.totalCost / total,
  };
};

const scheduleForStrategy = (strategy: TransferStrategy, horizonMonths: number): number[] => {
  if (strategy.id === "direct") {
    return [100, ...Array.from({ length: Math.max(0, horizonMonths - 1) }, () => 0)];
  }

  if (strategy.id === "hybrid") {
    const schedule = Array.from({ length: horizonMonths }, () => 0);
    const remainder = Math.max(0, 100 - strategy.upfrontPct);
    schedule[0] = strategy.upfrontPct;

    const spreadMonths = Math.max(1, Math.min(strategy.dcaMonths, horizonMonths - strategy.dcaStartOffset));
    const perMonth = remainder / spreadMonths;

    for (let month = strategy.dcaStartOffset; month < strategy.dcaStartOffset + spreadMonths; month += 1) {
      if (schedule[month] === undefined) {
        continue;
      }
      schedule[month] += perMonth;
    }

    return schedule;
  }

  if (strategy.id === "dca") {
    const schedule = Array.from({ length: horizonMonths }, () => 0);
    const spreadMonths = Math.max(1, Math.min(strategy.dcaMonths, horizonMonths));
    const perMonth = 100 / spreadMonths;

    for (let month = 0; month < spreadMonths; month += 1) {
      schedule[month] = perMonth;
    }

    return schedule;
  }

  const custom = strategy.customSchedulePct.slice(0, horizonMonths);
  while (custom.length < horizonMonths) {
    custom.push(0);
  }
  return custom;
};

const lineItemApplies = (item: LineItem, monthIndex: number, closeMonth: number): boolean => {
  if (!item.enabled) {
    return false;
  }

  if (item.timingMode === "always") {
    const afterStart = monthIndex >= item.startMonth;
    const beforeEnd = item.endMonth === null || monthIndex <= item.endMonth;
    return afterStart && beforeEnd;
  }

  if (item.timingMode === "until-close") {
    const afterStart = monthIndex >= item.startMonth;
    return afterStart && monthIndex <= closeMonth;
  }

  const relativeMonth = monthIndex - closeMonth;
  if (relativeMonth < item.startMonth) {
    return false;
  }
  return item.endMonth === null || relativeMonth <= item.endMonth;
};

const oneTimeApplies = (item: OneTimeItem, monthIndex: number, closeMonth: number): boolean => {
  if (!item.enabled) {
    return false;
  }

  if (item.timingMode === "absolute") {
    return monthIndex === item.monthOffset;
  }

  if (item.timingMode === "at-close") {
    return monthIndex === closeMonth + item.monthOffset;
  }

  return monthIndex === closeMonth + item.monthOffset;
};

const spendEur = (
  amount: number,
  state: { eurCash: number; salePoolEur: number },
): { eurCash: number; salePoolEur: number } => {
  if (amount <= 0) {
    return {
      eurCash: state.eurCash - amount,
      salePoolEur: state.salePoolEur,
    };
  }

  if (state.eurCash >= amount) {
    return {
      eurCash: state.eurCash - amount,
      salePoolEur: state.salePoolEur,
    };
  }

  const fromCash = Math.max(state.eurCash, 0);
  const remainder = amount - fromCash;
  const nextPool = state.salePoolEur - remainder;

  return {
    eurCash: nextPool < 0 ? nextPool : 0,
    salePoolEur: Math.max(nextPool, 0),
  };
};

const toUsdEquivalent = (amount: number, currency: "EUR" | "USD", fxRateUsdPerEur: number): number =>
  currency === "USD" ? amount : amount * fxRateUsdPerEur;

const providerFees = (
  strategy: TransferStrategy,
  transferEur: number,
  fxRateUsdPerEur: number,
  data: PlanningProfileData,
): { fixedFeeEur: number; netUsd: number; feeUsd: number } => {
  if (transferEur <= 0) {
    return {
      fixedFeeEur: 0,
      netUsd: 0,
      feeUsd: 0,
    };
  }

  const grossUsd = transferEur * fxRateUsdPerEur;

  if (strategy.provider === "bank") {
    const percentFeeUsd = grossUsd * (data.transferCosts.bankFxSpreadPct / 100);
    const fixedFeeUsd =
      (data.transferCosts.bankOutgoingFeeEur + data.transferCosts.bankSwiftFeeEur) * fxRateUsdPerEur +
      data.transferCosts.bankReceivingFeeUsd;
    const netUsd = Math.max(grossUsd - percentFeeUsd - fixedFeeUsd, 0);

    return {
      fixedFeeEur: data.transferCosts.bankOutgoingFeeEur + data.transferCosts.bankSwiftFeeEur,
      netUsd,
      feeUsd: percentFeeUsd + fixedFeeUsd,
    };
  }

  const percentFeeUsd = grossUsd * (data.transferCosts.wiseVariableFeePct / 100);
  const fixedFeeUsd = data.transferCosts.wiseFixedFeeEur * fxRateUsdPerEur + data.transferCosts.wiseReceivingFeeUsd;
  const netUsd = Math.max(grossUsd - percentFeeUsd - fixedFeeUsd, 0);

  return {
    fixedFeeEur: data.transferCosts.wiseFixedFeeEur,
    netUsd,
    feeUsd: percentFeeUsd + fixedFeeUsd,
  };
};

const createMortgageState = (data: PlanningProfileData) => ({
  balance: data.property.mortgage.outstandingBalanceEur,
});

export const simulateStrategy = (
  data: PlanningProfileData,
  strategy: TransferStrategy,
  scenario: MacroScenario,
  closeMonth = data.property.expectedCloseMonth,
): SimulationResult => {
  const monthlySnapshots: MonthlySnapshot[] = [];
  const schedule = scheduleForStrategy(strategy, data.horizonMonths);
  const salePriceEur =
    data.property.expectedSalePriceEur * (1 + scenario.salePriceMonthlyChangePct / 100) ** closeMonth;

  let eurCash = data.liquidity.startingEurCash;
  let salePoolEur = 0;
  let usdCash = data.liquidity.startingUsdCash;
  let usdDebtBalance = data.usDebt.initialBalanceUsd;
  let totalTransferFeesUsd = 0;
  let totalUsdDebtInterestUsd = 0;
  let totalMortgageInterestUsd = 0;
  let totalKnownCostsUsd = 0;
  let worstLiquidityGapUsd = 0;
  let totalSaleProceedsEur = 0;
  const mortgage = createMortgageState(data);
  const adjustedDebtApr = Math.max(0, data.usDebt.annualRatePct + scenario.usdDebtAprShiftPct);
  const debtMonthlyRate = monthlyRate(adjustedDebtApr);
  const euroYieldMonthlyRate = monthlyRate(data.transferCosts.eurYieldPct);

  for (let monthIndex = 0; monthIndex < data.horizonMonths; monthIndex += 1) {
    const fxRateUsdPerEur = scenario.fxStartUsdPerEur * (1 + scenario.fxMonthlyChangePct / 100) ** monthIndex;
    const notes: string[] = [];
    let recurringEur = 0;
    let recurringUsd = 0;
    let oneTimeEur = 0;
    let oneTimeUsd = 0;
    let transferEur = 0;
    let transferUsd = 0;
    let transferFeesUsd = 0;
    let mortgageInterestEur = 0;
    let mortgagePrincipalEur = 0;
    let mortgagePaymentEur = 0;
    let usdMinimumPayment = 0;
    let usdExtraPayment = 0;

    if (salePoolEur > 0) {
      const yieldEarned = salePoolEur * euroYieldMonthlyRate;
      salePoolEur += yieldEarned;
      if (yieldEarned > 0.01) {
        notes.push(`EUR reserve earns ${yieldEarned.toFixed(0)} in holding yield.`);
      }
    }

    const debtInterest = usdDebtBalance * debtMonthlyRate;
    usdDebtBalance += debtInterest;
    totalUsdDebtInterestUsd += debtInterest;

    if (monthIndex <= closeMonth) {
      const mortgageRate = monthlyRate(data.property.mortgage.annualRatePct);
      mortgageInterestEur = mortgage.balance * mortgageRate;

      if (data.property.mortgage.mode === "amortized") {
        mortgagePaymentEur = Math.min(
          data.property.mortgage.monthlyPaymentEur,
          mortgage.balance + mortgageInterestEur,
        );
        mortgagePrincipalEur = Math.max(mortgagePaymentEur - mortgageInterestEur, 0);
        mortgage.balance = Math.max(mortgage.balance - mortgagePrincipalEur, 0);
      } else {
        mortgagePaymentEur = data.property.mortgage.monthlyPaymentEur;
        mortgagePrincipalEur = Math.max(mortgagePaymentEur - mortgageInterestEur, 0);
      }

      const spent = spendEur(mortgagePaymentEur, { eurCash, salePoolEur });
      eurCash = spent.eurCash;
      salePoolEur = spent.salePoolEur;

      totalMortgageInterestUsd += mortgageInterestEur * fxRateUsdPerEur;
      recurringEur += mortgagePaymentEur;
      totalKnownCostsUsd += mortgagePaymentEur * fxRateUsdPerEur;
    }

    for (const item of data.recurringItems) {
      if (!lineItemApplies(item, monthIndex, closeMonth)) {
        continue;
      }

      if (item.currency === "EUR") {
        const spent = spendEur(item.amount, { eurCash, salePoolEur });
        eurCash = spent.eurCash;
        salePoolEur = spent.salePoolEur;
        recurringEur += item.amount;
      } else {
        usdCash -= item.amount;
        recurringUsd += item.amount;
      }
      totalKnownCostsUsd += toUsdEquivalent(item.amount, item.currency, fxRateUsdPerEur);
    }

    for (const item of data.oneTimeItems) {
      if (!oneTimeApplies(item, monthIndex, closeMonth)) {
        continue;
      }

      if (item.currency === "EUR") {
        const spent = spendEur(item.amount, { eurCash, salePoolEur });
        eurCash = spent.eurCash;
        salePoolEur = spent.salePoolEur;
        oneTimeEur += item.amount;
      } else {
        usdCash -= item.amount;
        oneTimeUsd += item.amount;
      }
      totalKnownCostsUsd += toUsdEquivalent(item.amount, item.currency, fxRateUsdPerEur);
      notes.push(`${item.name} hits this month.`);
    }

    if (monthIndex === closeMonth) {
      const saleCostsEur =
        salePriceEur * (data.property.estateAgentFeePct / 100) +
        data.property.legalFeesEur +
        data.property.repairsAndStagingEur +
        data.property.taxesAndOtherEur;
      totalSaleProceedsEur = Math.max(salePriceEur - saleCostsEur - mortgage.balance, 0);
      salePoolEur += totalSaleProceedsEur;
      totalKnownCostsUsd += saleCostsEur * fxRateUsdPerEur;
      notes.push("House sale proceeds land.");
    }

    const relativeTransferMonth = monthIndex - closeMonth;
    if (relativeTransferMonth >= 0) {
      const scheduledShare = schedule[relativeTransferMonth] ?? 0;
      const plannedTransferEur = totalSaleProceedsEur * (scheduledShare / 100);
      transferEur = Math.max(Math.min(plannedTransferEur, salePoolEur), 0);

      if (transferEur > 0) {
        const fees = providerFees(strategy, transferEur, fxRateUsdPerEur, data);
        salePoolEur = Math.max(salePoolEur - transferEur - fees.fixedFeeEur, 0);
        transferUsd = fees.netUsd;
        transferFeesUsd = fees.feeUsd;
        totalTransferFeesUsd += fees.feeUsd;
        usdCash += transferUsd;
        notes.push(`Converted ${transferEur.toFixed(0)} EUR via ${strategy.provider}.`);
      }
    }

    usdMinimumPayment = Math.min(data.usDebt.minimumMonthlyPaymentUsd, usdDebtBalance);
    const actualMinimumPayment = Math.min(Math.max(usdCash, 0), usdMinimumPayment);
    usdCash -= actualMinimumPayment;
    usdDebtBalance = Math.max(usdDebtBalance - actualMinimumPayment, 0);

    if (actualMinimumPayment < usdMinimumPayment) {
      notes.push("USD cash does not fully cover the minimum debt service.");
    }

    const effectiveUsdBuffer = data.liquidity.targetUsdBuffer + scenario.liquidityStressUsd;
    const availableForExtraPaydown = Math.max(usdCash - effectiveUsdBuffer, 0);
    usdExtraPayment = Math.min(
      usdDebtBalance,
      availableForExtraPaydown * clamp(data.usDebt.autoPaydownPct / 100, 0, 1),
    );
    usdCash -= usdExtraPayment;
    usdDebtBalance = Math.max(usdDebtBalance - usdExtraPayment, 0);

    const eurTotal = eurCash + salePoolEur;
    const eurLiquidityGapUsd = Math.max(data.liquidity.targetEurBuffer - eurTotal, 0) * fxRateUsdPerEur;
    const usdLiquidityGapUsd = Math.max(effectiveUsdBuffer - usdCash, 0);
    const liquidityGapUsd = Math.max(usdLiquidityGapUsd + eurLiquidityGapUsd, 0);
    worstLiquidityGapUsd = Math.max(worstLiquidityGapUsd, liquidityGapUsd);

    const endingNetPositionUsd = usdCash + eurTotal * fxRateUsdPerEur - usdDebtBalance;

    monthlySnapshots.push({
      monthIndex,
      label: monthLabel(data.startDate, monthIndex),
      fxRateUsdPerEur,
      eurCash,
      salePoolEur,
      usdCash,
      usdDebtBalance,
      usdDebtInterest: debtInterest,
      usdMinimumPayment: actualMinimumPayment,
      usdExtraPayment,
      mortgageBalanceEur: mortgage.balance,
      mortgageInterestEur,
      mortgagePrincipalEur,
      mortgagePaymentEur,
      recurringEur,
      recurringUsd,
      oneTimeEur,
      oneTimeUsd,
      transferEur,
      transferUsd,
      transferFeesUsd,
      endingNetPositionUsd,
      liquidityGapUsd,
      notes,
    });
  }

  const endingSnapshot = monthlySnapshots[monthlySnapshots.length - 1];
  const endingEurEquivalentUsd = (endingSnapshot.eurCash + endingSnapshot.salePoolEur) * endingSnapshot.fxRateUsdPerEur;

  return {
    strategyId: strategy.id,
    scenarioId: scenario.id,
    endingNetPositionUsd: endingSnapshot.endingNetPositionUsd,
    endingEurEquivalentUsd,
    totalTransferFeesUsd,
    totalUsdDebtInterestUsd,
    totalMortgageInterestUsd,
    totalKnownCostsUsd,
    worstLiquidityGapUsd,
    saleProceedsEur: totalSaleProceedsEur,
    salePriceEur,
    score: 0,
    scoreBreakdown: {
      downside: 0,
      liquidity: 0,
      cost: 0,
    },
    monthlySnapshots,
  };
};

export const compareStrategies = (
  data: PlanningProfileData,
  activeScenarioId: ScenarioId,
  closeMonth = data.property.expectedCloseMonth,
): ComparisonRow[] => {
  const weights = normalizeWeights(data.priorities);
  const activeScenario = data.scenarios[activeScenarioId];
  const activeResults = data.strategies
    .filter((strategy) => strategy.enabled)
    .map((strategy) => ({
      strategy,
      activeScenario: simulateStrategy(data, strategy, activeScenario, closeMonth),
      downsideScenario: simulateStrategy(data, strategy, data.scenarios.downside, closeMonth),
    }));

  const costValues = activeResults.map((row) => row.activeScenario.totalTransferFeesUsd + row.activeScenario.totalUsdDebtInterestUsd);
  const liquidityValues = activeResults.map((row) => row.activeScenario.worstLiquidityGapUsd);
  const downsideValues = activeResults.map((row) => row.downsideScenario.endingNetPositionUsd);
  const costRange = Math.max(...costValues) - Math.min(...costValues) || 1;
  const liquidityRange = Math.max(...liquidityValues) - Math.min(...liquidityValues) || 1;
  const downsideRange = Math.max(...downsideValues) - Math.min(...downsideValues) || 1;

  return activeResults
    .map((row) => {
      const costScore = 1 - (row.activeScenario.totalTransferFeesUsd + row.activeScenario.totalUsdDebtInterestUsd - Math.min(...costValues)) / costRange;
      const liquidityScore = 1 - (row.activeScenario.worstLiquidityGapUsd - Math.min(...liquidityValues)) / liquidityRange;
      const downsideScore = (row.downsideScenario.endingNetPositionUsd - Math.min(...downsideValues)) / downsideRange;
      const score =
        costScore * weights.totalCost +
        liquidityScore * weights.liquidityPreservation +
        downsideScore * weights.downsideProtection;

      row.activeScenario.score = score;
      row.activeScenario.scoreBreakdown = {
        downside: downsideScore,
        liquidity: liquidityScore,
        cost: costScore,
      };

      return {
        ...row,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);
};

export const closeMonthSensitivity = (
  data: PlanningProfileData,
  strategy: TransferStrategy,
  scenario: MacroScenario,
): Array<{ closeMonth: number; label: string; endingNetPositionUsd: number; liquidityGapUsd: number }> =>
  Array.from({ length: data.horizonMonths }, (_, closeMonth) => {
    const result = simulateStrategy(data, strategy, scenario, closeMonth);

    return {
      closeMonth,
      label: monthLabel(data.startDate, closeMonth),
      endingNetPositionUsd: result.endingNetPositionUsd,
      liquidityGapUsd: result.worstLiquidityGapUsd,
    };
  });
