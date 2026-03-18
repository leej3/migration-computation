import type { LiveMarketSnapshot } from "./types";

export const fetchLiveFx = async (): Promise<LiveMarketSnapshot> => {
  const response = await fetch("https://api.frankfurter.app/latest?from=EUR&to=USD");
  if (!response.ok) {
    throw new Error("Failed to fetch live FX context");
  }

  const payload = (await response.json()) as { amount: number; base: string; date: string; rates: { USD: number } };

  return {
    source: "Frankfurter (ECB reference data)",
    fxRateUsdPerEur: payload.rates.USD,
    observedAt: payload.date,
    fetchedAt: new Date().toISOString(),
  };
};
