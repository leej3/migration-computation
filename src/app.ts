import { Chart, registerables } from "chart.js";
import {
  closeMonthSensitivity,
  compareStrategies,
  simulateStrategy,
} from "./lib/finance";
import { DEFAULT_SOURCE_LINKS, defaultPlanningData, HORIZON_LIMIT } from "./lib/defaults";
import { clamp, toCurrency, toMonthLabel, toNumber, toPercent } from "./lib/format";
import { fetchLiveFx } from "./lib/market";
import {
  createBlankProfile,
  exportState,
  importState,
  loadState,
  saveState,
} from "./lib/storage";
import type {
  ComparisonRow,
  Currency,
  LiveMarketSnapshot,
  PersistedAppState,
  PlanningProfileData,
  ScenarioId,
  StoredProfile,
  StrategyId,
  TabId,
  TransferStrategy,
} from "./lib/types";

Chart.register(...registerables);

const chartRegistry = new Map<string, Chart>();

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const getActiveProfile = (state: PersistedAppState): StoredProfile =>
  state.profiles.find((profile) => profile.id === state.activeProfileId) ?? state.profiles[0];

const getStrategy = (data: PlanningProfileData, strategyId: StrategyId): TransferStrategy =>
  data.strategies.find((strategy) => strategy.id === strategyId) ?? data.strategies[0];

const setByPath = (target: Record<string, any>, path: string, value: unknown): void => {
  const segments = path.split(".");
  let cursor: Record<string, any> = target;

  for (let index = 0; index < segments.length - 1; index += 1) {
    cursor = cursor[segments[index]];
  }

  cursor[segments[segments.length - 1]] = value;
};

const monthOptions = (data: PlanningProfileData): string =>
  Array.from({ length: data.horizonMonths }, (_, monthIndex) => {
    const label = toMonthLabel(
      new Date(
        new Date(data.startDate).getFullYear(),
        new Date(data.startDate).getMonth() + monthIndex,
        1,
      ).toISOString(),
    );
    return `<option value="${monthIndex}">${label}</option>`;
  }).join("");

const recommendationCopy = (winner: ComparisonRow, runnerUp?: ComparisonRow): string => {
  const delta = winner.activeScenario.totalTransferFeesUsd + winner.activeScenario.totalUsdDebtInterestUsd;
  const runnerNet = runnerUp ? runnerUp.activeScenario.endingNetPositionUsd : winner.activeScenario.endingNetPositionUsd;
  const netLift = winner.activeScenario.endingNetPositionUsd - runnerNet;

  if (winner.strategy.id === "hybrid") {
    return `Hybrid currently ranks first because it cuts debt service early without fully giving up later FX optionality. The model sees ${toCurrency(
      delta,
      "USD",
    )} of transfer-plus-debt drag over the six-month horizon, while keeping downside flexibility better than a single all-at-once conversion.`;
  }

  if (winner.strategy.id === "direct") {
    return `A direct bank conversion currently wins because the financing drag from waiting is larger than the FX upside built into your scenarios. The expected net position is about ${toCurrency(
      netLift,
      "USD",
    )} better than the next-best option under the current weights.`;
  }

  if (winner.strategy.id === "dca") {
    return `The DCA plan currently wins because downside protection and liquidity matter more than immediate debt reduction in the active setup. It leaves more room to react month by month if the euro path improves.`;
  }

  return `The custom schedule ranks first because your hand-built conversion pattern balances debt paydown, liquidity, and FX timing better than the canned options.`;
};

const delayInsight = (
  profile: StoredProfile,
  strategy: TransferStrategy,
  scenarioId: ScenarioId,
): { title: string; body: string } => {
  const points = closeMonthSensitivity(profile.data, strategy, profile.data.scenarios[scenarioId]);
  const closeMonth = profile.data.property.expectedCloseMonth;
  const prior = points[Math.max(closeMonth - 1, 0)];
  const current = points[closeMonth];

  if (!prior || !current || closeMonth === 0) {
    return {
      title: "Delay penalty",
      body: "Move the close-month selector to see how one more month of delay changes debt carry, mortgage drag, and FX risk together.",
    };
  }

  const netPenalty = prior.endingNetPositionUsd - current.endingNetPositionUsd;
  const liquidityShift = current.liquidityGapUsd - prior.liquidityGapUsd;

  return {
    title: `Another month costs about ${toCurrency(netPenalty, "USD")}`,
    body: `Moving the close from ${prior.label} to ${current.label} reduces projected end position by roughly ${toCurrency(
      netPenalty,
      "USD",
    )} and changes liquidity pressure by ${toCurrency(liquidityShift, "USD")}.`,
  };
};

const renderScenarioButtons = (activeScenarioId: ScenarioId, data: PlanningProfileData): string =>
  (Object.keys(data.scenarios) as ScenarioId[])
    .map((scenarioId) => {
      const scenario = data.scenarios[scenarioId];
      return `
        <button
          class="chip ${scenarioId === activeScenarioId ? "is-active" : ""}"
          data-action="select-scenario"
          data-scenario-id="${scenarioId}"
        >
          <span>${escapeHtml(scenario.shortLabel)}</span>
        </button>
      `;
    })
    .join("");

const renderStrategyButtons = (activeStrategyId: StrategyId, data: PlanningProfileData): string =>
  data.strategies
    .filter((strategy) => strategy.enabled)
    .map(
      (strategy) => `
        <button
          class="chip ${strategy.id === activeStrategyId ? "is-active" : ""}"
          data-action="select-strategy"
          data-strategy-id="${strategy.id}"
        >
          <span>${escapeHtml(strategy.label)}</span>
        </button>
      `,
    )
    .join("");

const renderComparisonRows = (rows: ComparisonRow[]): string =>
  rows
    .map(
      (row, index) => `
        <tr class="${index === 0 ? "is-leading-row" : ""}">
          <td>
            <strong>${escapeHtml(row.strategy.label)}</strong>
            <p class="muted tiny">${escapeHtml(row.strategy.description)}</p>
          </td>
          <td>${toCurrency(row.activeScenario.endingNetPositionUsd, "USD")}</td>
          <td>${toCurrency(
            row.activeScenario.totalTransferFeesUsd + row.activeScenario.totalUsdDebtInterestUsd,
            "USD",
          )}</td>
          <td>${toCurrency(row.activeScenario.worstLiquidityGapUsd, "USD")}</td>
          <td>${toCurrency(row.downsideScenario.endingNetPositionUsd, "USD")}</td>
          <td>${toNumber(row.score * 100, 0)}</td>
        </tr>
      `,
    )
    .join("");

const renderRecurringRows = (profile: StoredProfile): string =>
  profile.data.recurringItems
    .map(
      (item) => `
        <tr>
          <td><input type="text" value="${escapeHtml(item.name)}" data-item-collection="recurringItems" data-item-id="${item.id}" data-field="name" /></td>
          <td><input type="text" value="${escapeHtml(item.category)}" data-item-collection="recurringItems" data-item-id="${item.id}" data-field="category" /></td>
          <td>
            <select data-item-collection="recurringItems" data-item-id="${item.id}" data-field="currency">
              <option value="EUR" ${item.currency === "EUR" ? "selected" : ""}>EUR</option>
              <option value="USD" ${item.currency === "USD" ? "selected" : ""}>USD</option>
            </select>
          </td>
          <td><input type="number" step="0.01" value="${item.amount}" data-item-collection="recurringItems" data-item-id="${item.id}" data-field="amount" /></td>
          <td>
            <select data-item-collection="recurringItems" data-item-id="${item.id}" data-field="timingMode">
              <option value="always" ${item.timingMode === "always" ? "selected" : ""}>Always</option>
              <option value="until-close" ${item.timingMode === "until-close" ? "selected" : ""}>Until close</option>
              <option value="from-close" ${item.timingMode === "from-close" ? "selected" : ""}>From close</option>
            </select>
          </td>
          <td><input type="number" step="1" value="${item.startMonth}" data-item-collection="recurringItems" data-item-id="${item.id}" data-field="startMonth" /></td>
          <td><input type="number" step="1" value="${item.endMonth ?? ""}" placeholder="-" data-item-collection="recurringItems" data-item-id="${item.id}" data-field="endMonth" /></td>
          <td><input type="checkbox" ${item.enabled ? "checked" : ""} data-item-collection="recurringItems" data-item-id="${item.id}" data-field="enabled" /></td>
          <td><button class="ghost-button" data-action="delete-item" data-item-collection="recurringItems" data-item-id="${item.id}">Remove</button></td>
        </tr>
      `,
    )
    .join("");

const renderOneTimeRows = (profile: StoredProfile): string =>
  profile.data.oneTimeItems
    .map(
      (item) => `
        <tr>
          <td><input type="text" value="${escapeHtml(item.name)}" data-item-collection="oneTimeItems" data-item-id="${item.id}" data-field="name" /></td>
          <td><input type="text" value="${escapeHtml(item.category)}" data-item-collection="oneTimeItems" data-item-id="${item.id}" data-field="category" /></td>
          <td>
            <select data-item-collection="oneTimeItems" data-item-id="${item.id}" data-field="currency">
              <option value="EUR" ${item.currency === "EUR" ? "selected" : ""}>EUR</option>
              <option value="USD" ${item.currency === "USD" ? "selected" : ""}>USD</option>
            </select>
          </td>
          <td><input type="number" step="0.01" value="${item.amount}" data-item-collection="oneTimeItems" data-item-id="${item.id}" data-field="amount" /></td>
          <td>
            <select data-item-collection="oneTimeItems" data-item-id="${item.id}" data-field="timingMode">
              <option value="absolute" ${item.timingMode === "absolute" ? "selected" : ""}>Absolute month</option>
              <option value="at-close" ${item.timingMode === "at-close" ? "selected" : ""}>At close</option>
              <option value="after-close" ${item.timingMode === "after-close" ? "selected" : ""}>After close</option>
            </select>
          </td>
          <td><input type="number" step="1" value="${item.monthOffset}" data-item-collection="oneTimeItems" data-item-id="${item.id}" data-field="monthOffset" /></td>
          <td><input type="checkbox" ${item.enabled ? "checked" : ""} data-item-collection="oneTimeItems" data-item-id="${item.id}" data-field="enabled" /></td>
          <td><button class="ghost-button" data-action="delete-item" data-item-collection="oneTimeItems" data-item-id="${item.id}">Remove</button></td>
        </tr>
      `,
    )
    .join("");

const renderStrategyInputs = (profile: StoredProfile): string =>
  profile.data.strategies
    .map((strategy) => {
      const scheduleFields =
        strategy.id === "custom"
          ? strategy.customSchedulePct
              .map(
                (value, index) => `
                  <label class="mini-field">
                    <span>M${index + 1}</span>
                    <input
                      type="number"
                      step="0.01"
                      value="${value}"
                      data-action="set-custom-schedule"
                      data-strategy-id="${strategy.id}"
                      data-schedule-index="${index}"
                    />
                  </label>
                `,
              )
              .join("")
          : "";

      return `
        <div class="strategy-editor">
          <div class="strategy-editor-head">
            <div>
              <strong>${escapeHtml(strategy.label)}</strong>
              <p class="muted tiny">${escapeHtml(strategy.description)}</p>
            </div>
            <label class="toggle-pill">
              <span>Enabled</span>
              <input type="checkbox" ${strategy.enabled ? "checked" : ""} data-action="toggle-strategy" data-strategy-id="${strategy.id}" />
            </label>
          </div>
          <div class="field-grid three-up">
            <label class="field">
              <span>Provider</span>
              <select data-action="set-strategy-field" data-strategy-id="${strategy.id}" data-field="provider">
                <option value="bank" ${strategy.provider === "bank" ? "selected" : ""}>Bank</option>
                <option value="wise" ${strategy.provider === "wise" ? "selected" : ""}>Wise</option>
              </select>
            </label>
            <label class="field">
              <span>Upfront %</span>
              <input type="number" step="0.01" value="${strategy.upfrontPct}" data-action="set-strategy-field" data-strategy-id="${strategy.id}" data-field="upfrontPct" />
            </label>
            <label class="field">
              <span>DCA months</span>
              <input type="number" step="1" value="${strategy.dcaMonths}" data-action="set-strategy-field" data-strategy-id="${strategy.id}" data-field="dcaMonths" />
            </label>
          </div>
          <div class="field-grid three-up">
            <label class="field">
              <span>First DCA offset</span>
              <input type="number" step="1" value="${strategy.dcaStartOffset}" data-action="set-strategy-field" data-strategy-id="${strategy.id}" data-field="dcaStartOffset" />
            </label>
            <div class="field helper-card">
              <span>Schedule sum</span>
              <strong>${toPercent(strategy.customSchedulePct.reduce((sum, value) => sum + value, 0), 0)}</strong>
            </div>
            <button class="ghost-button align-self-end" data-action="normalize-custom-schedule" data-strategy-id="${strategy.id}">
              Normalize to 100%
            </button>
          </div>
          ${
            strategy.id === "custom"
              ? `<div class="mini-grid">${scheduleFields}</div>`
              : ""
          }
        </div>
      `;
    })
    .join("");

const renderTabContent = (
  profile: StoredProfile,
  state: PersistedAppState,
  comparisons: ComparisonRow[],
  liveMarket: LiveMarketSnapshot | null,
  marketError: string | null,
): string => {
  const activeScenarioId = state.ui.activeScenarioId;
  const activeStrategy = getStrategy(profile.data, state.ui.activeStrategyId);
  const activeResult =
    comparisons.find((row) => row.strategy.id === activeStrategy.id)?.activeScenario ??
    simulateStrategy(profile.data, activeStrategy, profile.data.scenarios[activeScenarioId]);
  const winner = comparisons[0];
  const insight = delayInsight(profile, activeStrategy, activeScenarioId);
  const liquidityPeak = [...activeResult.monthlySnapshots].sort(
    (left, right) => right.liquidityGapUsd - left.liquidityGapUsd,
  )[0];

  if (state.ui.activeTab === "overview") {
    return `
      <section class="hero-grid">
        <article class="hero-card hero-card-primary">
          <p class="eyebrow">Recommendation</p>
          <h1>${escapeHtml(winner.strategy.label)}</h1>
          <p>${escapeHtml(recommendationCopy(winner, comparisons[1]))}</p>
          <div class="chip-row">${renderScenarioButtons(activeScenarioId, profile.data)}</div>
        </article>
        <article class="hero-card">
          <p class="eyebrow">${escapeHtml(insight.title)}</p>
          <p>${escapeHtml(insight.body)}</p>
          <label class="field">
            <span>Expected close month</span>
            <select data-path="property.expectedCloseMonth">
              ${monthOptions(profile.data).replace(
                `value="${profile.data.property.expectedCloseMonth}"`,
                `value="${profile.data.property.expectedCloseMonth}" selected`,
              )}
            </select>
          </label>
        </article>
        <article class="hero-card">
          <p class="eyebrow">Live FX context</p>
          ${
            liveMarket
              ? `<h2>${toNumber(liveMarket.fxRateUsdPerEur, 4)} USD/EUR</h2>
                 <p>${escapeHtml(liveMarket.source)} as of ${escapeHtml(liveMarket.observedAt)}.</p>
                 <button class="ghost-button" data-action="apply-live-fx">Apply to all scenarios</button>`
              : `<p>${escapeHtml(marketError ?? "Fetching live FX reference...")}</p>`
          }
        </article>
      </section>

      <section class="metrics-grid">
        <article class="metric-card">
          <span class="metric-label">Projected end position</span>
          <strong>${toCurrency(activeResult.endingNetPositionUsd, "USD")}</strong>
          <p>Selected strategy in the ${escapeHtml(profile.data.scenarios[activeScenarioId].label.toLowerCase())} scenario.</p>
        </article>
        <article class="metric-card">
          <span class="metric-label">Worst liquidity gap</span>
          <strong>${toCurrency(activeResult.worstLiquidityGapUsd, "USD")}</strong>
          <p>Largest combined EUR/USD buffer shortfall over the six-month run.</p>
        </article>
        <article class="metric-card">
          <span class="metric-label">Transfer + debt drag</span>
          <strong>${toCurrency(
            activeResult.totalTransferFeesUsd + activeResult.totalUsdDebtInterestUsd,
            "USD",
          )}</strong>
          <p>What waiting and converting costs before the model even considers regular living expenses.</p>
        </article>
        <article class="metric-card">
          <span class="metric-label">Peak stress month</span>
          <strong>${escapeHtml(liquidityPeak?.label ?? "N/A")}</strong>
          <p>That is when the model sees the tightest buffer.</p>
        </article>
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Strategy board</p>
            <h2>Compare transfer approaches at once</h2>
          </div>
          <div class="chip-row">${renderStrategyButtons(state.ui.activeStrategyId, profile.data)}</div>
        </div>
        <div class="chart-card">
          <canvas id="strategy-chart"></canvas>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Strategy</th>
                <th>End position</th>
                <th>Transfer + debt drag</th>
                <th>Worst buffer gap</th>
                <th>Downside end position</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>${renderComparisonRows(comparisons)}</tbody>
          </table>
        </div>
      </section>

      <section class="double-grid">
        <article class="section-card">
          <div class="section-head">
            <div>
              <p class="eyebrow">Close timing</p>
              <h2>How rushed should the sale be?</h2>
            </div>
          </div>
          <div class="chart-card">
            <canvas id="sensitivity-chart"></canvas>
          </div>
        </article>
        <article class="section-card">
          <div class="section-head">
            <div>
              <p class="eyebrow">Cross-Atlantic cashflow</p>
              <h2>Cash and debt over time</h2>
            </div>
          </div>
          <div class="chart-card">
            <canvas id="cashflow-chart"></canvas>
          </div>
        </article>
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Month-by-month</p>
            <h2>What to keep in mind each month</h2>
          </div>
        </div>
        <div class="table-wrap wide">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>FX</th>
                <th>EUR cash</th>
                <th>USD cash</th>
                <th>Transfer</th>
                <th>USD debt</th>
                <th>Mortgage interest</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              ${activeResult.monthlySnapshots
                .map(
                  (snapshot) => `
                    <tr>
                      <td>${escapeHtml(snapshot.label)}</td>
                      <td>${toNumber(snapshot.fxRateUsdPerEur, 4)}</td>
                      <td>${toCurrency(snapshot.eurCash + snapshot.salePoolEur, "EUR")}</td>
                      <td>${toCurrency(snapshot.usdCash, "USD")}</td>
                      <td>${toCurrency(snapshot.transferUsd, "USD")}</td>
                      <td>${toCurrency(snapshot.usdDebtBalance, "USD")}</td>
                      <td>${toCurrency(snapshot.mortgageInterestEur, "EUR")}</td>
                      <td class="notes-cell">${escapeHtml(snapshot.notes.join(" "))}</td>
                    </tr>
                  `,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  if (state.ui.activeTab === "inputs") {
    return `
      <section class="section-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Profile setup</p>
            <h2>Core planning levers</h2>
          </div>
        </div>

        <div class="field-grid four-up">
          <label class="field">
            <span>Start date</span>
            <input type="date" value="${profile.data.startDate}" data-path="startDate" />
          </label>
          <label class="field">
            <span>Horizon months</span>
            <input type="number" step="1" min="1" max="${HORIZON_LIMIT}" value="${profile.data.horizonMonths}" data-path="horizonMonths" />
          </label>
          <label class="field">
            <span>Starting USD cash</span>
            <input type="number" step="0.01" value="${profile.data.liquidity.startingUsdCash}" data-path="liquidity.startingUsdCash" />
          </label>
          <label class="field">
            <span>Starting EUR cash</span>
            <input type="number" step="0.01" value="${profile.data.liquidity.startingEurCash}" data-path="liquidity.startingEurCash" />
          </label>
        </div>

        <div class="field-grid three-up">
          <label class="field">
            <span>USD liquidity buffer</span>
            <input type="number" step="0.01" value="${profile.data.liquidity.targetUsdBuffer}" data-path="liquidity.targetUsdBuffer" />
          </label>
          <label class="field">
            <span>EUR liquidity buffer</span>
            <input type="number" step="0.01" value="${profile.data.liquidity.targetEurBuffer}" data-path="liquidity.targetEurBuffer" />
          </label>
          <label class="field">
            <span>Close month</span>
            <input type="number" step="1" min="0" max="${profile.data.horizonMonths - 1}" value="${profile.data.property.expectedCloseMonth}" data-path="property.expectedCloseMonth" />
          </label>
        </div>
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Sale and debt</p>
            <h2>Property, mortgage, and US-side debt</h2>
          </div>
        </div>
        <div class="field-grid four-up">
          <label class="field">
            <span>Expected sale price (EUR)</span>
            <input type="number" step="0.01" value="${profile.data.property.expectedSalePriceEur}" data-path="property.expectedSalePriceEur" />
          </label>
          <label class="field">
            <span>Estate agent fee %</span>
            <input type="number" step="0.01" value="${profile.data.property.estateAgentFeePct}" data-path="property.estateAgentFeePct" />
          </label>
          <label class="field">
            <span>Legal fees (EUR)</span>
            <input type="number" step="0.01" value="${profile.data.property.legalFeesEur}" data-path="property.legalFeesEur" />
          </label>
          <label class="field">
            <span>Repairs and staging (EUR)</span>
            <input type="number" step="0.01" value="${profile.data.property.repairsAndStagingEur}" data-path="property.repairsAndStagingEur" />
          </label>
        </div>
        <div class="field-grid four-up">
          <label class="field">
            <span>Taxes and other (EUR)</span>
            <input type="number" step="0.01" value="${profile.data.property.taxesAndOtherEur}" data-path="property.taxesAndOtherEur" />
          </label>
          <label class="field">
            <span>Mortgage mode</span>
            <select data-path="property.mortgage.mode">
              <option value="amortized" ${profile.data.property.mortgage.mode === "amortized" ? "selected" : ""}>Amortized</option>
              <option value="flat" ${profile.data.property.mortgage.mode === "flat" ? "selected" : ""}>Flat payment</option>
            </select>
          </label>
          <label class="field">
            <span>Mortgage balance (EUR)</span>
            <input type="number" step="0.01" value="${profile.data.property.mortgage.outstandingBalanceEur}" data-path="property.mortgage.outstandingBalanceEur" />
          </label>
          <label class="field">
            <span>Mortgage APR %</span>
            <input type="number" step="0.01" value="${profile.data.property.mortgage.annualRatePct}" data-path="property.mortgage.annualRatePct" />
          </label>
        </div>
        <div class="field-grid four-up">
          <label class="field">
            <span>Mortgage payment (EUR)</span>
            <input type="number" step="0.01" value="${profile.data.property.mortgage.monthlyPaymentEur}" data-path="property.mortgage.monthlyPaymentEur" />
          </label>
          <label class="field">
            <span>Mortgage term remaining (months)</span>
            <input type="number" step="1" value="${profile.data.property.mortgage.remainingTermMonths}" data-path="property.mortgage.remainingTermMonths" />
          </label>
          <label class="field">
            <span>US debt balance (USD)</span>
            <input type="number" step="0.01" value="${profile.data.usDebt.initialBalanceUsd}" data-path="usDebt.initialBalanceUsd" />
          </label>
          <label class="field">
            <span>US debt APR %</span>
            <input type="number" step="0.01" value="${profile.data.usDebt.annualRatePct}" data-path="usDebt.annualRatePct" />
          </label>
        </div>
        <div class="field-grid three-up">
          <label class="field">
            <span>Minimum payment (USD)</span>
            <input type="number" step="0.01" value="${profile.data.usDebt.minimumMonthlyPaymentUsd}" data-path="usDebt.minimumMonthlyPaymentUsd" />
          </label>
          <label class="field">
            <span>Auto paydown %</span>
            <input type="range" min="0" max="100" value="${profile.data.usDebt.autoPaydownPct}" data-path="usDebt.autoPaydownPct" />
            <strong class="range-value">${toPercent(profile.data.usDebt.autoPaydownPct, 0)}</strong>
          </label>
        </div>
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">FX and transfer assumptions</p>
            <h2>Bank rails, Wise, and holding yield</h2>
          </div>
        </div>
        <div class="field-grid four-up">
          <label class="field">
            <span>Bank FX spread %</span>
            <input type="number" step="0.01" value="${profile.data.transferCosts.bankFxSpreadPct}" data-path="transferCosts.bankFxSpreadPct" />
          </label>
          <label class="field">
            <span>Bank outgoing fee (EUR)</span>
            <input type="number" step="0.01" value="${profile.data.transferCosts.bankOutgoingFeeEur}" data-path="transferCosts.bankOutgoingFeeEur" />
          </label>
          <label class="field">
            <span>Bank SWIFT fee (EUR)</span>
            <input type="number" step="0.01" value="${profile.data.transferCosts.bankSwiftFeeEur}" data-path="transferCosts.bankSwiftFeeEur" />
          </label>
          <label class="field">
            <span>Receiving bank fee (USD)</span>
            <input type="number" step="0.01" value="${profile.data.transferCosts.bankReceivingFeeUsd}" data-path="transferCosts.bankReceivingFeeUsd" />
          </label>
        </div>
        <div class="field-grid four-up">
          <label class="field">
            <span>Wise variable fee %</span>
            <input type="number" step="0.01" value="${profile.data.transferCosts.wiseVariableFeePct}" data-path="transferCosts.wiseVariableFeePct" />
          </label>
          <label class="field">
            <span>Wise fixed fee (EUR)</span>
            <input type="number" step="0.01" value="${profile.data.transferCosts.wiseFixedFeeEur}" data-path="transferCosts.wiseFixedFeeEur" />
          </label>
          <label class="field">
            <span>Wise receiving fee (USD)</span>
            <input type="number" step="0.01" value="${profile.data.transferCosts.wiseReceivingFeeUsd}" data-path="transferCosts.wiseReceivingFeeUsd" />
          </label>
          <label class="field">
            <span>EUR holding yield %</span>
            <input type="number" step="0.01" value="${profile.data.transferCosts.eurYieldPct}" data-path="transferCosts.eurYieldPct" />
          </label>
        </div>
        ${renderStrategyInputs(profile)}
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Priorities and scenarios</p>
            <h2>Weight the recommendation engine</h2>
          </div>
        </div>
        <div class="field-grid three-up">
          <label class="field">
            <span>Downside protection</span>
            <input type="range" min="0" max="100" value="${profile.data.priorities.downsideProtection}" data-path="priorities.downsideProtection" />
            <strong class="range-value">${toPercent(profile.data.priorities.downsideProtection, 0)}</strong>
          </label>
          <label class="field">
            <span>Liquidity preservation</span>
            <input type="range" min="0" max="100" value="${profile.data.priorities.liquidityPreservation}" data-path="priorities.liquidityPreservation" />
            <strong class="range-value">${toPercent(profile.data.priorities.liquidityPreservation, 0)}</strong>
          </label>
          <label class="field">
            <span>Total cost</span>
            <input type="range" min="0" max="100" value="${profile.data.priorities.totalCost}" data-path="priorities.totalCost" />
            <strong class="range-value">${toPercent(profile.data.priorities.totalCost, 0)}</strong>
          </label>
        </div>

        ${(Object.keys(profile.data.scenarios) as ScenarioId[])
          .map((scenarioId) => {
            const scenario = profile.data.scenarios[scenarioId];
            return `
              <div class="scenario-editor">
                <div>
                  <strong>${escapeHtml(scenario.label)}</strong>
                  <p class="muted tiny">${escapeHtml(scenario.description)}</p>
                </div>
                <div class="field-grid four-up">
                  <label class="field">
                    <span>Start FX (USD/EUR)</span>
                    <input type="number" step="0.0001" value="${scenario.fxStartUsdPerEur}" data-path="scenarios.${scenarioId}.fxStartUsdPerEur" />
                  </label>
                  <label class="field">
                    <span>FX monthly change %</span>
                    <input type="number" step="0.01" value="${scenario.fxMonthlyChangePct}" data-path="scenarios.${scenarioId}.fxMonthlyChangePct" />
                  </label>
                  <label class="field">
                    <span>Sale price monthly change %</span>
                    <input type="number" step="0.01" value="${scenario.salePriceMonthlyChangePct}" data-path="scenarios.${scenarioId}.salePriceMonthlyChangePct" />
                  </label>
                  <label class="field">
                    <span>Debt APR shift %</span>
                    <input type="number" step="0.01" value="${scenario.usdDebtAprShiftPct}" data-path="scenarios.${scenarioId}.usdDebtAprShiftPct" />
                  </label>
                </div>
                <div class="field-grid two-up">
                  <label class="field">
                    <span>Extra liquidity stress (USD)</span>
                    <input type="number" step="0.01" value="${scenario.liquidityStressUsd}" data-path="scenarios.${scenarioId}.liquidityStressUsd" />
                  </label>
                  <label class="field">
                    <span>Description</span>
                    <input type="text" value="${escapeHtml(scenario.description)}" data-path="scenarios.${scenarioId}.description" />
                  </label>
                </div>
              </div>
            `;
          })
          .join("")}
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Recurring costs</p>
            <h2>Everything that burns each month</h2>
          </div>
          <button class="ghost-button" data-action="add-item" data-item-collection="recurringItems">Add recurring item</button>
        </div>
        <div class="table-wrap wide">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Currency</th>
                <th>Amount</th>
                <th>Timing</th>
                <th>Start</th>
                <th>End</th>
                <th>Enabled</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${renderRecurringRows(profile)}</tbody>
          </table>
        </div>
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">One-time costs</p>
            <h2>Big-ticket moments</h2>
          </div>
          <button class="ghost-button" data-action="add-item" data-item-collection="oneTimeItems">Add one-time item</button>
        </div>
        <div class="table-wrap wide">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Currency</th>
                <th>Amount</th>
                <th>Timing</th>
                <th>Offset</th>
                <th>Enabled</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${renderOneTimeRows(profile)}</tbody>
          </table>
        </div>
      </section>
    `;
  }

  return `
    <section class="section-card assumptions-grid">
      <article class="assumption-card">
        <p class="eyebrow">How the model works</p>
        <h2>Assumptions and formulas</h2>
        <ul class="assumption-list">
          <li>Sale timing changes three things together: mortgage carry, sale-price drift, and when EUR proceeds become available.</li>
          <li>USD debt accrues monthly interest, requires the minimum payment, and then optionally uses any cash above the USD buffer for extra paydown.</li>
          <li>Unconverted EUR sale proceeds can earn a user-set holding yield before they are transferred.</li>
          <li>Direct bank transfers use the bank spread and bank fees. Wise-based strategies use the Wise fee model and user-entered schedule.</li>
          <li>The recommendation score blends downside protection, liquidity, and total-cost drag using your weight sliders.</li>
        </ul>
      </article>
      <article class="assumption-card">
        <p class="eyebrow">Storage</p>
        <h2>Privacy and persistence</h2>
        <p>This app stores profiles only in your browser local storage. Nothing is sent to a backend. Export JSON if you want a backup or to move profiles to another machine.</p>
      </article>
      <article class="assumption-card">
        <p class="eyebrow">Reference links</p>
        <h2>Demo defaults</h2>
        <ul class="assumption-list">
          <li><a href="${DEFAULT_SOURCE_LINKS.aibFees}" target="_blank" rel="noreferrer">AIB personal current-account fees</a></li>
          <li><a href="${DEFAULT_SOURCE_LINKS.truistFees}" target="_blank" rel="noreferrer">Truist personal deposit fee schedule</a></li>
          <li><a href="${DEFAULT_SOURCE_LINKS.wisePricing}" target="_blank" rel="noreferrer">Wise pricing reference</a></li>
          <li><a href="${DEFAULT_SOURCE_LINKS.fxSource}" target="_blank" rel="noreferrer">Frankfurter API</a> for optional live ECB-based FX context</li>
        </ul>
      </article>
      <article class="assumption-card">
        <p class="eyebrow">Disclaimer</p>
        <h2>Planning aid only</h2>
        <p>This is a personal decision-support tool, not financial advice. The outputs are only as good as the scenario assumptions you feed it.</p>
      </article>
    </section>
  `;
};

const buildMarkup = (
  state: PersistedAppState,
  liveMarket: LiveMarketSnapshot | null,
  marketError: string | null,
): string => {
  const profile = getActiveProfile(state);
  const comparisons = compareStrategies(profile.data, state.ui.activeScenarioId, profile.data.property.expectedCloseMonth);

  return `
    <main class="app-shell">
      <header class="app-header">
        <div>
          <p class="eyebrow">Migration Computation</p>
          <h1>Guide the move with scenarios, cashflow, and conversion strategy</h1>
          <p class="lead">
            A static browser-only dashboard for sale timing, EUR-to-USD transfer decisions, debt carry, and cross-Atlantic liquidity.
          </p>
        </div>
        <div class="header-controls">
          <label class="field slim">
            <span>Profile</span>
            <select data-action="select-profile">
              ${state.profiles
                .map(
                  (profileOption) => `
                    <option value="${profileOption.id}" ${profileOption.id === profile.id ? "selected" : ""}>
                      ${escapeHtml(profileOption.name)}
                    </option>
                  `,
                )
                .join("")}
            </select>
          </label>
          <label class="field slim">
            <span>Name</span>
            <input type="text" value="${escapeHtml(profile.name)}" data-action="rename-profile" />
          </label>
          <div class="button-row">
            <button class="ghost-button" data-action="new-profile">New profile</button>
            <button class="ghost-button" data-action="duplicate-profile">Duplicate</button>
            <button class="ghost-button" data-action="reset-profile">Reset to demo</button>
            <button class="ghost-button" data-action="delete-profile" ${state.profiles.length === 1 ? "disabled" : ""}>Delete</button>
          </div>
          <div class="button-row">
            <button class="ghost-button" data-action="export">Export JSON</button>
            <label class="ghost-button button-file">
              Import JSON
              <input type="file" accept="application/json" data-action="import" />
            </label>
            <button class="ghost-button" data-action="refresh-market">Refresh FX</button>
          </div>
          <p class="tiny muted">Stored only in this browser. Public deployment is static. No backend. No server-side data retention.</p>
        </div>
      </header>

      <nav class="tab-strip">
        ${(["overview", "inputs", "assumptions"] as TabId[])
          .map(
            (tabId) => `
              <button class="tab ${state.ui.activeTab === tabId ? "is-active" : ""}" data-action="select-tab" data-tab-id="${tabId}">
                ${tabId}
              </button>
            `,
          )
          .join("")}
      </nav>

      ${renderTabContent(profile, state, comparisons, liveMarket, marketError)}
    </main>
  `;
};

const destroyCharts = (): void => {
  for (const chart of chartRegistry.values()) {
    chart.destroy();
  }
  chartRegistry.clear();
};

const mountCharts = (state: PersistedAppState): void => {
  if (state.ui.activeTab !== "overview") {
    destroyCharts();
    return;
  }

  destroyCharts();

  const profile = getActiveProfile(state);
  const comparisons = compareStrategies(profile.data, state.ui.activeScenarioId, profile.data.property.expectedCloseMonth);
  const activeStrategy = getStrategy(profile.data, state.ui.activeStrategyId);
  const activeResult =
    comparisons.find((row) => row.strategy.id === activeStrategy.id)?.activeScenario ??
    simulateStrategy(profile.data, activeStrategy, profile.data.scenarios[state.ui.activeScenarioId]);
  const sensitivity = closeMonthSensitivity(
    profile.data,
    activeStrategy,
    profile.data.scenarios[state.ui.activeScenarioId],
  );
  const downsideSensitivity = closeMonthSensitivity(profile.data, activeStrategy, profile.data.scenarios.downside);

  const strategyCanvas = document.querySelector<HTMLCanvasElement>("#strategy-chart");
  if (strategyCanvas) {
    const chart = new Chart(strategyCanvas, {
      type: "bar",
      data: {
        labels: comparisons.map((row) => row.strategy.label),
        datasets: [
          {
            label: "End position (USD)",
            data: comparisons.map((row) => row.activeScenario.endingNetPositionUsd),
            backgroundColor: "#0f766e",
          },
          {
            label: "Transfer + debt drag (USD)",
            data: comparisons.map(
              (row) => row.activeScenario.totalTransferFeesUsd + row.activeScenario.totalUsdDebtInterestUsd,
            ),
            backgroundColor: "#e07a2a",
          },
          {
            label: "Worst buffer gap (USD)",
            data: comparisons.map((row) => row.activeScenario.worstLiquidityGapUsd),
            backgroundColor: "#7c4dff",
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: {
            position: "bottom",
          },
        },
      },
    });
    chartRegistry.set("strategy", chart);
  }

  const sensitivityCanvas = document.querySelector<HTMLCanvasElement>("#sensitivity-chart");
  if (sensitivityCanvas) {
    const chart = new Chart(sensitivityCanvas, {
      type: "line",
      data: {
        labels: sensitivity.map((point) => point.label),
        datasets: [
          {
            label: "Active scenario end position",
            data: sensitivity.map((point) => point.endingNetPositionUsd),
            borderColor: "#0f766e",
            backgroundColor: "rgba(15, 118, 110, 0.15)",
            fill: true,
            tension: 0.25,
          },
          {
            label: "Downside end position",
            data: downsideSensitivity.map((point) => point.endingNetPositionUsd),
            borderColor: "#7c2d12",
            backgroundColor: "rgba(124, 45, 18, 0.08)",
            fill: true,
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: {
            position: "bottom",
          },
        },
      },
    });
    chartRegistry.set("sensitivity", chart);
  }

  const cashflowCanvas = document.querySelector<HTMLCanvasElement>("#cashflow-chart");
  if (cashflowCanvas) {
    const chart = new Chart(cashflowCanvas, {
      data: {
        labels: activeResult.monthlySnapshots.map((snapshot) => snapshot.label),
        datasets: [
          {
            type: "line",
            label: "USD cash",
            data: activeResult.monthlySnapshots.map((snapshot) => snapshot.usdCash),
            borderColor: "#0c4a6e",
            yAxisID: "usd",
            tension: 0.3,
          },
          {
            type: "line",
            label: "EUR cash + reserve",
            data: activeResult.monthlySnapshots.map((snapshot) => snapshot.eurCash + snapshot.salePoolEur),
            borderColor: "#9a3412",
            yAxisID: "eur",
            tension: 0.3,
          },
          {
            type: "bar",
            label: "USD transfer arrivals",
            data: activeResult.monthlySnapshots.map((snapshot) => snapshot.transferUsd),
            backgroundColor: "rgba(224, 122, 42, 0.45)",
            yAxisID: "usd",
          },
          {
            type: "line",
            label: "USD debt balance",
            data: activeResult.monthlySnapshots.map((snapshot) => snapshot.usdDebtBalance),
            borderColor: "#5b21b6",
            yAxisID: "usd",
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: {
            position: "bottom",
          },
        },
        scales: {
          usd: {
            type: "linear",
            position: "left",
          },
          eur: {
            type: "linear",
            position: "right",
            grid: {
              drawOnChartArea: false,
            },
          },
        },
      },
    });
    chartRegistry.set("cashflow", chart);
  }
};

const parseValue = (input: HTMLInputElement | HTMLSelectElement): string | number | boolean | null => {
  if (input instanceof HTMLInputElement && input.type === "checkbox") {
    return input.checked;
  }

  if (input instanceof HTMLInputElement && input.type === "number") {
    return input.value === "" ? null : Number(input.value);
  }

  if (input instanceof HTMLInputElement && input.type === "range") {
    return Number(input.value);
  }

  return input.value;
};

const createItem = (collection: "recurringItems" | "oneTimeItems") => {
  const id = `${collection}-${Math.random().toString(36).slice(2, 8)}`;

  if (collection === "recurringItems") {
    return {
      id,
      name: "New recurring item",
      category: "Custom",
      currency: "USD" as Currency,
      amount: 0,
      enabled: true,
      timingMode: "always",
      startMonth: 0,
      endMonth: null,
    };
  }

  return {
    id,
    name: "New one-time item",
    category: "Custom",
    currency: "USD" as Currency,
    amount: 0,
    enabled: true,
    timingMode: "absolute",
    monthOffset: 0,
  };
};

export const createApp = (root: HTMLElement): void => {
  let state = loadState();
  let liveMarket: LiveMarketSnapshot | null = null;
  let marketError: string | null = null;

  const render = () => {
    root.innerHTML = buildMarkup(state, liveMarket, marketError);
    attachListeners();
    mountCharts(state);
  };

  const persist = () => {
    saveState(state);
    render();
  };

  const updateProfile = (mutate: (profile: StoredProfile) => void) => {
    const profile = getActiveProfile(state);
    mutate(profile);
    profile.updatedAt = new Date().toISOString();
    persist();
  };

  const refreshMarket = async () => {
    marketError = null;
    render();

    try {
      liveMarket = await fetchLiveFx();
    } catch (error) {
      marketError = error instanceof Error ? error.message : "Live FX fetch failed";
    }

    render();
  };

  const attachListeners = () => {
    root.querySelectorAll<HTMLElement>("[data-action]").forEach((element) => {
      if (element.dataset.bound === "true") {
        return;
      }
      element.dataset.bound = "true";

      const action = element.dataset.action;

      if (action === "select-tab") {
        element.addEventListener("mousedown", (event) => {
          event.preventDefault();
          state.ui.activeTab = element.dataset.tabId as TabId;
          persist();
        });
      }

      if (action === "select-scenario") {
        element.addEventListener("mousedown", (event) => {
          event.preventDefault();
          state.ui.activeScenarioId = element.dataset.scenarioId as ScenarioId;
          persist();
        });
      }

      if (action === "select-strategy") {
        element.addEventListener("mousedown", (event) => {
          event.preventDefault();
          state.ui.activeStrategyId = element.dataset.strategyId as StrategyId;
          persist();
        });
      }

      if (action === "select-profile") {
        element.addEventListener("change", (event) => {
          const target = event.currentTarget as HTMLSelectElement;
          state.activeProfileId = target.value;
          persist();
        });
      }

      if (action === "rename-profile") {
        element.addEventListener("change", (event) => {
          const target = event.currentTarget as HTMLInputElement;
          updateProfile((profile) => {
            profile.name = target.value.trim() || profile.name;
          });
        });
      }

      if (action === "new-profile") {
        element.addEventListener("click", () => {
          const profile = createBlankProfile(`Scenario ${state.profiles.length + 1}`);
          state.profiles.push(profile);
          state.activeProfileId = profile.id;
          persist();
        });
      }

      if (action === "duplicate-profile") {
        element.addEventListener("click", () => {
          const current = getActiveProfile(state);
          const duplicate = structuredClone(current);
          duplicate.id = `${current.id}-${Math.random().toString(36).slice(2, 6)}`;
          duplicate.name = `${current.name} copy`;
          duplicate.updatedAt = new Date().toISOString();
          state.profiles.push(duplicate);
          state.activeProfileId = duplicate.id;
          persist();
        });
      }

      if (action === "reset-profile") {
        element.addEventListener("click", () => {
          updateProfile((profile) => {
            profile.data = defaultPlanningData();
          });
        });
      }

      if (action === "delete-profile") {
        element.addEventListener("click", () => {
          if (state.profiles.length === 1) {
            return;
          }
          state.profiles = state.profiles.filter((profile) => profile.id !== state.activeProfileId);
          state.activeProfileId = state.profiles[0].id;
          persist();
        });
      }

      if (action === "export") {
        element.addEventListener("click", () => {
          const blob = exportState(state);
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = "migration-computation-profiles.json";
          anchor.click();
          URL.revokeObjectURL(url);
        });
      }

      if (action === "import" && element instanceof HTMLInputElement) {
        element.addEventListener("change", async () => {
          const file = element.files?.[0];
          if (!file) {
            return;
          }
          state = await importState(file);
          persist();
        });
      }

      if (action === "refresh-market") {
        element.addEventListener("click", () => {
          void refreshMarket();
        });
      }

      if (action === "apply-live-fx") {
        element.addEventListener("click", () => {
          if (!liveMarket) {
            return;
          }
          updateProfile((profile) => {
            (Object.keys(profile.data.scenarios) as ScenarioId[]).forEach((scenarioId) => {
              profile.data.scenarios[scenarioId].fxStartUsdPerEur = liveMarket!.fxRateUsdPerEur;
            });
          });
        });
      }

      if (action === "toggle-strategy") {
        element.addEventListener("change", (event) => {
          const target = event.currentTarget as HTMLInputElement;
          updateProfile((profile) => {
            const strategy = getStrategy(profile.data, element.dataset.strategyId as StrategyId);
            strategy.enabled = target.checked;
          });
        });
      }

      if (action === "set-strategy-field") {
        element.addEventListener("change", (event) => {
          const target = event.currentTarget as HTMLInputElement | HTMLSelectElement;
          const value = parseValue(target);
          updateProfile((profile) => {
            const strategy = getStrategy(profile.data, element.dataset.strategyId as StrategyId);
            (strategy as Record<string, any>)[element.dataset.field!] = value;
          });
        });
      }

      if (action === "normalize-custom-schedule") {
        element.addEventListener("click", () => {
          updateProfile((profile) => {
            const strategy = getStrategy(profile.data, element.dataset.strategyId as StrategyId);
            const total = strategy.customSchedulePct.reduce((sum, value) => sum + value, 0);
            if (!total) {
              return;
            }
            strategy.customSchedulePct = strategy.customSchedulePct.map((value) => (value / total) * 100);
          });
        });
      }

      if (action === "set-custom-schedule") {
        element.addEventListener("change", (event) => {
          const target = event.currentTarget as HTMLInputElement;
          const scheduleIndex = Number(element.dataset.scheduleIndex);
          updateProfile((profile) => {
            const strategy = getStrategy(profile.data, element.dataset.strategyId as StrategyId);
            strategy.customSchedulePct[scheduleIndex] = Number(target.value);
          });
        });
      }

      if (action === "add-item") {
        element.addEventListener("click", () => {
          updateProfile((profile) => {
            const collection = element.dataset.itemCollection as "recurringItems" | "oneTimeItems";
            (profile.data[collection] as Array<any>).push(createItem(collection));
          });
        });
      }

      if (action === "delete-item") {
        element.addEventListener("click", () => {
          updateProfile((profile) => {
            const collection = element.dataset.itemCollection as "recurringItems" | "oneTimeItems";
            profile.data[collection] = profile.data[collection].filter((item) => item.id !== element.dataset.itemId) as
              | any
              | never;
          });
        });
      }
    });

    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-path]").forEach((input) => {
      if (input.dataset.bound === "true") {
        return;
      }
      input.dataset.bound = "true";
      const syncValue = () => {
        const value = parseValue(input);
        updateProfile((profile) => {
          const normalizedValue =
            input instanceof HTMLInputElement && input.type === "number"
              ? value ?? 0
              : input instanceof HTMLInputElement && input.type === "range"
                ? Number(value)
                : value;
          setByPath(profile.data as Record<string, any>, input.dataset.path!, normalizedValue);
          profile.data.horizonMonths = clamp(Math.round(profile.data.horizonMonths), 1, HORIZON_LIMIT);
          profile.data.property.expectedCloseMonth = clamp(
            Math.round(profile.data.property.expectedCloseMonth),
            0,
            profile.data.horizonMonths - 1,
          );
          profile.data.strategies.forEach((strategy) => {
            strategy.dcaMonths = clamp(Math.round(strategy.dcaMonths), 1, profile.data.horizonMonths);
            strategy.dcaStartOffset = clamp(Math.round(strategy.dcaStartOffset), 0, profile.data.horizonMonths - 1);
            strategy.customSchedulePct = strategy.customSchedulePct.slice(0, profile.data.horizonMonths);
            while (strategy.customSchedulePct.length < profile.data.horizonMonths) {
              strategy.customSchedulePct.push(0);
            }
          });
        });
      };

      if (input instanceof HTMLInputElement && (input.type === "number" || input.type === "range")) {
        input.addEventListener("input", syncValue);
      }

      input.addEventListener("change", syncValue);
    });

    root
      .querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-item-collection][data-item-id][data-field]")
      .forEach((input) => {
        if (input.dataset.bound === "true") {
          return;
        }
        input.dataset.bound = "true";
        const syncItemValue = () => {
          const collection = input.dataset.itemCollection as "recurringItems" | "oneTimeItems";
          const itemId = input.dataset.itemId!;
          const field = input.dataset.field!;
          const value = parseValue(input);

          updateProfile((profile) => {
            const item = profile.data[collection].find((entry) => entry.id === itemId) as Record<string, any>;
            item[field] = field === "endMonth" && value === null ? null : value;
          });
        };

        if (input instanceof HTMLInputElement && input.type === "number") {
          input.addEventListener("input", syncItemValue);
        }

        input.addEventListener("change", syncItemValue);
      });
  };

  render();
  void refreshMarket();
};
