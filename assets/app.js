const SOURCE_HOLDINGS = "data/portfolio-clean.csv";
const SOURCE_CATALOG = "data/catalog.json";
const SOURCE_CAPITAL_BASELINE = "data/capital-baseline.csv";
const SOURCE_INVESTMENT_RETURNS = "data/investment-returns.csv";

const OUTPUT_COLUMNS = ["Date", "Asset Type", "Securities Firm", "Ticker", "Volume"];
let ASSET_TYPES = [];
let TICKER_ASSET_TYPE_BY_TICKER = new Map();
let BANK_LIKE_FIRMS = new Set();
let COLOR_MAPS = { asset: new Map(), ticker: new Map(), firm: new Map() };
let CASH_ASSET_TYPE = "예금";
let UNCLASSIFIED_ASSET_TYPE = "미분류";
let BALANCE_PREFIX = "잔고";
let FALLBACK_COLORS = [
  "#f89a9a",
  "#8fdda0",
  "#f4d66d",
  "#bea7ff",
  "#91e4d1",
  "#f5a363",
  "#8fb7ff",
  "#f5a3b7",
  "#c8de7f",
  "#d0a7ff",
];

const KRW_PER_MAN = 10000;
const MAN_PER_EOK = 10000;
const DOUGHNUT_SCALE_ANIMATION_DURATION = 420;
const DOUGHNUT_ROTATE_ANIMATION_DURATION = 520;
const LINE_POINT_ANIMATION_DURATION = 620;
const LINE_POINT_STAGGER_MS = 45;
const LINE_POINT_MAX_DELAY_MS = 720;
const LINE_BASE_BORDER_WIDTH = 1.8;
const LINE_HOVER_BORDER_WIDTH = 2.8;
const LINE_DIM_BORDER_WIDTH = 0.9;
const LINE_POINT_BORDER_WIDTH = 1.8;
const unitNumberFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 0,
});

const state = {
  baseHoldings: [],
  holdings: [],
  capitalBaseline: [],
  investmentReturns: [],
  plans: [],
  dates: [],
  viewDate: "",
  charts: {},
  suppressLineAnimations: false,
  lineAnimationGraceUntil: 0,
  resizeAnimationTimer: 0,
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  configureChartDefaults();
  wireResizeAnimationGuard();
  wireTabs();
  wireDashboardControls();
  wirePlanControls();
  await loadInitialData();
  renderIcons();
}

async function loadInitialData() {
  setStatus("Loading source CSV...");

  try {
    const [catalogText, holdingsText, baselineText, investmentReturnsText] = await Promise.all([
      fetchText(SOURCE_CATALOG),
      fetchText(SOURCE_HOLDINGS),
      fetchText(SOURCE_CAPITAL_BASELINE),
      fetchText(SOURCE_INVESTMENT_RETURNS),
    ]);
    applyCatalog(JSON.parse(catalogText));
    populatePlanAssetTypes();
    state.baseHoldings = normalizeCsvText(holdingsText, { defaultPlan: "No" }).holdings;
    state.holdings = [...state.baseHoldings];
    state.capitalBaseline = normalizeCapitalBaselineCsv(baselineText);
    state.investmentReturns = normalizeInvestmentReturnsCsv(investmentReturnsText);

    refreshDataViews({ resetViewDate: true });
  } catch (error) {
    setStatus(`Could not load CSV: ${error.message}`);
  }
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.text();
}

function applyCatalog(rawCatalog) {
  const catalog = normalizeCatalog(rawCatalog);
  ASSET_TYPES = catalog.assetTypes;
  TICKER_ASSET_TYPE_BY_TICKER = objectToMap(catalog.tickerAssetTypes, normalizeTicker, normalizeText);
  BANK_LIKE_FIRMS = new Set(catalog.bankLikeFirms);
  COLOR_MAPS = {
    asset: objectToMap(catalog.colors.asset, normalizeText, normalizeText),
    ticker: objectToMap(catalog.colors.ticker, normalizeTicker, normalizeText),
    firm: objectToMap(catalog.colors.firm, normalizeText, normalizeText),
  };
  FALLBACK_COLORS = catalog.colors.fallback;
  CASH_ASSET_TYPE = catalog.cashAssetType;
  UNCLASSIFIED_ASSET_TYPE = catalog.unclassifiedAssetType;
  BALANCE_PREFIX = catalog.balanceNamePrefix;
}

function normalizeCatalog(rawCatalog) {
  const raw = rawCatalog && typeof rawCatalog === "object" ? rawCatalog : {};
  const colors = raw.colors && typeof raw.colors === "object" ? raw.colors : {};
  const cashAssetType = normalizeText(raw.cashAssetType) || CASH_ASSET_TYPE;
  const unclassifiedAssetType = normalizeText(raw.unclassifiedAssetType) || UNCLASSIFIED_ASSET_TYPE;
  const fallbackColors = uniqueTextList(colors.fallback || FALLBACK_COLORS);
  return {
    assetTypes: uniqueTextList([...(Array.isArray(raw.assetTypes) ? raw.assetTypes : []), cashAssetType, unclassifiedAssetType]),
    cashAssetType,
    unclassifiedAssetType,
    balanceNamePrefix: normalizeText(raw.balanceNamePrefix) || BALANCE_PREFIX,
    bankLikeFirms: uniqueTextList(raw.bankLikeFirms || []),
    tickerAssetTypes: raw.tickerAssetTypes || {},
    colors: {
      asset: colors.asset || {},
      ticker: colors.ticker || {},
      firm: colors.firm || {},
      fallback: fallbackColors.length ? fallbackColors : FALLBACK_COLORS,
    },
  };
}

function objectToMap(record, keyFn, valueFn) {
  const map = new Map();
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return map;
  }
  Object.entries(record).forEach(([rawKey, rawValue]) => {
    const key = keyFn(rawKey);
    const value = valueFn(rawValue);
    if (key && value) {
      map.set(key, value);
    }
  });
  return map;
}

function uniqueTextList(values) {
  const result = [];
  const seen = new Set();
  values.forEach((value) => {
    const normalized = normalizeText(value);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  });
  return result;
}

function wireTabs() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      const tabId = button.dataset.tab;
      document.querySelectorAll(".tab-button").forEach((item) => {
        const isActive = item === button;
        item.classList.toggle("is-active", isActive);
        item.setAttribute("aria-selected", String(isActive));
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("is-active", panel.id === tabId);
      });
      afterNextPaint(() => {
        if (tabId === "dashboard") {
          renderDashboard({ updateLines: true, doughnutAnimation: "scale" });
        } else if (tabId === "plans") {
          renderPlanWorkspace({ doughnutAnimation: "scale" });
        }
      });
    });
  });
}

function wireResizeAnimationGuard() {
  window.addEventListener(
    "resize",
    () => suppressLineAnimationsForResize(),
    { passive: true },
  );
}

function suppressLineAnimationsForResize() {
  const lineCharts = Object.values(state.charts).filter((chart) => chart.config.type === "line");
  if (!lineCharts.length || performance.now() < state.lineAnimationGraceUntil) {
    return;
  }

  state.suppressLineAnimations = true;
  lineCharts.forEach((chart) => {
    chart.stop();
  });

  window.clearTimeout(state.resizeAnimationTimer);
  state.resizeAnimationTimer = window.setTimeout(() => {
    Object.values(state.charts).forEach((chart) => {
      if (chart.config.type === "line") {
        chart.stop();
        chart.update("none");
      }
    });
    state.suppressLineAnimations = false;
  }, 220);
}

function wireDashboardControls() {
  byId("dateSelect").addEventListener("change", (event) => {
    state.viewDate = event.target.value;
    syncDateControls();
    renderDashboard({ updateLines: false, doughnutAnimation: "rotate" });
  });

  byId("dateSlider").addEventListener("input", (event) => {
    state.viewDate = state.dates[Number(event.target.value)] || state.viewDate;
    syncDateControls();
    renderDashboard({ updateLines: false, doughnutAnimation: "rotate" });
  });

  byId("resetDataBtn").addEventListener("click", async () => {
    await loadInitialData();
  });

  byId("exportHoldingsBtn").addEventListener("click", () => {
    downloadCsv("portfolio-clean.csv", state.holdings);
  });
}

function wirePlanControls() {
  byId("planForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const plan = {
      Date: latestDataDate(),
      "Asset Type": byId("planAssetType").value,
      "Securities Firm": "",
      Ticker: normalizeTicker(byId("planTicker").value),
      Volume: String(Math.round(Number(byId("planVolume").value || 0))),
    };

    if (Number(plan.Volume) <= 0) {
      setPlanStatus("Add a volume");
      return;
    }

    state.plans = aggregatePlanRows([...state.plans, plan]).sort(compareRows);
    byId("planTicker").value = "";
    byId("planVolume").value = "";
    renderPlanWorkspace();
    setPlanStatus("Row added");
  });

  byId("exportPlansBtn").addEventListener("click", () => {
    downloadCsv("future-plan.csv", state.plans);
  });

  byId("resetPlansBtn").addEventListener("click", () => {
    resetPlansToLatestSnapshot();
    renderPlanWorkspace();
  });
}

function populatePlanAssetTypes() {
  byId("planAssetType").innerHTML = ASSET_TYPES.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("");
}

function resetPlansToLatestSnapshot() {
  const latestDate = latestDataDate();
  state.plans = aggregatePlanRows(state.holdings.filter((row) => row.Date === latestDate).map(planRowFromHolding)).sort(compareRows);
  setPlanStatus(latestDate ? `Started from ${formatDateLabel(latestDate)}` : "No source data");
}

function planRowFromHolding(row) {
  return {
    Date: row.Date,
    "Asset Type": row["Asset Type"],
    "Securities Firm": "",
    Ticker: row.Ticker,
    Volume: row.Volume,
  };
}

function aggregatePlanRows(rows) {
  const grouped = new Map();
  rows.forEach((row) => {
    const key = [row.Date, row["Asset Type"], row.Ticker].join("\u001F");
    if (!grouped.has(key)) {
      grouped.set(key, { ...row, "Securities Firm": "", Volume: "0" });
    }
    const current = grouped.get(key);
    current.Volume = String(Number(current.Volume || 0) + Number(row.Volume || 0));
  });
  return [...grouped.values()];
}

function latestDataDate() {
  return state.dates[state.dates.length - 1] || "";
}

function refreshDataViews({ resetViewDate = false } = {}) {
  state.holdings.sort(compareRows);
  state.dates = unique(state.holdings.map((row) => row.Date)).sort();

  if (resetViewDate || !state.dates.includes(state.viewDate)) {
    state.viewDate = state.dates[state.dates.length - 1] || "";
  }

  if (resetViewDate) {
    resetPlansToLatestSnapshot();
  }

  syncDateControls();
  renderDashboard();
  if (activeTabId() === "plans") {
    renderPlanWorkspace();
  }
  setStatus(statusText());
  renderIcons();
}

function activeTabId() {
  return document.querySelector(".tab-panel.is-active")?.id || "dashboard";
}

function afterNextPaint(callback) {
  requestAnimationFrame(() => {
    requestAnimationFrame(callback);
  });
}

function syncDateControls() {
  const select = byId("dateSelect");
  const slider = byId("dateSlider");

  select.innerHTML = state.dates.map((date) => `<option value="${date}">${formatDateLabel(date)}</option>`).join("");
  select.value = state.viewDate;
  slider.max = String(Math.max(state.dates.length - 1, 0));
  slider.value = String(Math.max(state.dates.indexOf(state.viewDate), 0));
  slider.disabled = state.dates.length <= 1;
}

function renderDashboard({ updateLines = true, doughnutAnimation = "scale" } = {}) {
  const rows = rowsAtViewDate();
  const tickerRows = rows.filter((row) => row.Ticker);
  const total = sumRows(rows);
  const investmentTotal = sumRows(tickerRows);
  const investmentPercent = total ? Math.round((investmentTotal / total) * 100) : 0;
  const cashTotal = Math.max(total - investmentTotal, 0);
  const cashPercent = total ? Math.round((cashTotal / total) * 100) : 0;
  const viewDateIndex = state.dates.indexOf(state.viewDate);
  const previousDate = viewDateIndex > 0 ? state.dates[viewDateIndex - 1] : "";
  const previousTotal = previousDate ? sumRows(state.holdings.filter((row) => row.Date === previousDate)) : 0;
  const totalChange = previousDate ? total - previousTotal : 0;
  const totalChangePercent = previousTotal ? (totalChange / previousTotal) * 100 : 0;

  byId("metricTotal").textContent = formatCurrency(total);
  byId("metricInvestment").textContent = formatCurrency(investmentTotal);
  byId("metricInvestmentPercent").textContent = `${investmentPercent}% of total portfolio`;
  byId("metricCash").textContent = formatCurrency(cashTotal);
  byId("metricCashPercent").textContent = `${cashPercent}% available outside tickers`;
  byId("viewDateLabel").textContent = formatDateLabel(state.viewDate);
  byId("metricChangeLabel").textContent = previousDate ? `Since ${formatShortDateLabel(previousDate)}` : "Since prior snapshot";
  byId("metricChange").textContent = previousDate ? formatSignedCurrency(totalChange) : "—";
  byId("metricChangePercent").textContent = previousDate ? `${formatSignedPercent(totalChangePercent)} portfolio change` : "First available snapshot";
  byId("metricChange").classList.toggle("is-positive", totalChange > 0);
  byId("metricChange").classList.toggle("is-negative", totalChange < 0);

  renderPortfolioSignals(rows, total);
  renderCapitalPerformance(total);

  renderAssetDistributionChart({
    chartId: "assetDistributionChart",
    centerId: "assetDistributionCenter",
    metaId: "assetDistributionMeta",
    rows,
    animationMode: doughnutAnimation,
  });

  renderDoughnut({
    chartId: "portfolioChart",
    centerId: "portfolioCenter",
    metaId: "portfolioMeta",
    rows: tickerRows,
    key: "Ticker",
    colorKind: "ticker",
    animationMode: doughnutAnimation,
  });

  renderDoughnut({
    chartId: "firmChart",
    centerId: "firmCenter",
    metaId: "firmMeta",
    rows,
    key: "Securities Firm",
    colorKind: "firm",
    animationMode: doughnutAnimation,
  });

  if (updateLines) {
    renderLineCharts();
  }
}

function renderPortfolioSignals(rows, total) {
  const tickerEntries = [...groupSum(rows.filter((row) => row.Ticker), "Ticker").entries()].sort((a, b) => b[1] - a[1]);
  const assetEntries = [...groupSum(rows, "Asset Type").entries()].sort((a, b) => b[1] - a[1]);
  const firmEntries = [...groupSum(rows, "Securities Firm").entries()].sort((a, b) => b[1] - a[1]);
  const [largestTicker = "—", largestTickerValue = 0] = tickerEntries[0] || [];
  const [largestAsset = "—", largestAssetValue = 0] = assetEntries[0] || [];
  const [largestFirm = "—", largestFirmValue = 0] = firmEntries[0] || [];

  byId("insightLargestPosition").textContent = largestTicker;
  byId("insightLargestPositionMeta").textContent = largestTickerValue
    ? `${formatCurrency(largestTickerValue)} · ${formatPercentOf(largestTickerValue, total)} of total`
    : "No ticker-linked positions";
  byId("insightLargestAllocation").textContent = largestAsset;
  byId("insightLargestAllocationMeta").textContent = largestAssetValue
    ? `${formatCurrency(largestAssetValue)} · ${formatPercentOf(largestAssetValue, total)} of total`
    : "No allocation data";
  byId("insightInstitutions").textContent = `${firmEntries.length} ${firmEntries.length === 1 ? "institution" : "institutions"}`;
  byId("insightInstitutionsMeta").textContent = largestFirmValue
    ? `${largestFirm} holds ${formatPercentOf(largestFirmValue, total)}`
    : "No institution data";
}

function renderCapitalPerformance(actualTotal) {
  const baseline = buildCapitalBaseline();
  const baselinePoint = baseline.points.find((point) => point.date === state.viewDate);
  const resultNode = byId("investmentResult");

  if (!baselinePoint) {
    resultNode.textContent = "—";
    resultNode.classList.remove("is-positive", "is-negative");
    byId("assetTrendMeta").textContent = baseline.anchorObservation
      ? `Available from ${formatShortDateLabel(baseline.anchorObservation.date)}`
      : "Waiting for an anchor snapshot";
  } else {
    const result = actualTotal - baselinePoint.value;
    const resultPercent = baselinePoint.value ? (result / baselinePoint.value) * 100 : 0;
    resultNode.textContent = formatSignedCurrency(result);
    resultNode.classList.toggle("is-positive", result > 0);
    resultNode.classList.toggle("is-negative", result < 0);
    byId("assetTrendMeta").textContent = `${formatSignedPercent(resultPercent)} vs capital baseline`;
  }

  byId("capitalBaselineNote").textContent = baseline.anchorObservation
    ? `Cash-only baseline starts with the actual ${formatDateLabel(baseline.anchorObservation.date)} pre-investment cash. It then saves identified family support, school and military income, bank interest, and tax net flows without applying investment returns. Internal transfers and travel reimbursements are excluded; ordinary consumption is not reconstructed.`
    : "Cash-only baseline will appear once the March 2020 pre-investment anchor is available.";
}

function buildCapitalBaseline() {
  const anchorObservation = state.capitalBaseline[0] || null;
  if (!anchorObservation) {
    return { anchorObservation: null, points: [] };
  }
  return { anchorObservation, points: state.capitalBaseline };
}

function renderAssetDistributionChart({ chartId, centerId, metaId, rows, animationMode = "scale" }) {
  const { parents, details, total } = buildAssetDistributionSegments(rows);
  const labels = details.map((detail) => detail.label);
  const largestParent = parents[0];

  byId(centerId).innerHTML = largestParent
    ? `<strong>${formatPercentOf(largestParent.value, total)}</strong><span>${escapeHtml(largestParent.label)} · leading</span>`
    : `<strong>—</strong><span>No allocation</span>`;
  byId(metaId).textContent = `${parents.length} classes · ${details.length} positions`;

  replaceChart(chartId, {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          label: "Asset detail",
          data: details.map((detail) => detail.value),
          backgroundColor: details.map((detail) => detail.color),
          borderColor: details.map((detail) => detail.borderColor),
          borderWidth: 1.5,
          hoverOffset: 8,
          assetDistributionKind: "detail",
          assetDistributionRecords: details,
        },
      ],
    },
    options: doughnutOptions(total, animationMode, {
      cutout: "66%",
      legendLabels: assetDistributionLegendLabels(parents),
      tooltipCallbacks: assetDistributionTooltipCallbacks(total),
    }),
  });
}

function buildAssetDistributionSegments(rows) {
  const parentEntries = [...groupRows(rows, "Asset Type").entries()]
    .map(([label, groupRowsForLabel], index) => {
      const color = colorFor("asset", label, index);
      return {
        label,
        value: sumRows(groupRowsForLabel),
        rows: groupRowsForLabel,
        color,
        borderColor: borderFor(color),
      };
    })
    .sort((a, b) => b.value - a.value);

  const details = parentEntries.flatMap((parent, parentIndex) => {
    const detailEntries = [...groupRowsBy(parent.rows, (row) => assetDistributionDetailLabel(row, parent.label)).entries()]
      .map(([label, detailRows], detailIndex) => {
        const kind = assetDistributionDetailKind(detailRows[0], parent.label);
        return {
          label,
          parentLabel: parent.label,
          value: sumRows(detailRows),
          kind,
          parentValue: parent.value,
          parentColor: parent.color,
          parentIndex,
          detailIndex,
        };
      })
      .sort((a, b) => b.value - a.value);

    return detailEntries.map((detail, detailIndex) => {
      return {
        ...detail,
        detailIndex,
        color: parent.color,
        borderColor: borderFor(parent.color),
      };
    });
  });

  return {
    parents: parentEntries.map(({ rows: _rows, ...parent }) => ({
      ...parent,
      detailIndexes: details.map((detail, index) => (detail.parentLabel === parent.label ? index : -1)).filter((index) => index >= 0),
    })),
    details,
    total: parentEntries.reduce((sum, parent) => sum + parent.value, 0),
  };
}

function assetDistributionDetailLabel(row, assetType) {
  if (row.Ticker) {
    return row.Ticker;
  }
  if (assetType === CASH_ASSET_TYPE) {
    return row["Securities Firm"] || CASH_ASSET_TYPE;
  }
  return assetType;
}

function assetDistributionDetailKind(row, assetType) {
  if (row.Ticker) {
    return "ticker";
  }
  if (assetType === CASH_ASSET_TYPE) {
    return "firm";
  }
  return "asset";
}

function assetDistributionLegendLabels(parents) {
  return () =>
    parents.map((parent, index) => ({
      text: parent.label,
      fillStyle: parent.color,
      fontColor: "#d5dce7",
      strokeStyle: parent.borderColor,
      lineWidth: 1.5,
      pointStyle: "circle",
      hidden: false,
      index,
      assetDistributionRecord: parent,
      assetDistributionDetailIndexes: parent.detailIndexes,
    }));
}

function assetDistributionTooltipCallbacks(total) {
  return {
    title: (items) => {
      const legendRecord = items[0]?.chart?.$legendHoverRecord;
      if (legendRecord) {
        return legendRecord.label;
      }
      const record = assetDistributionTooltipRecord(items[0]);
      if (!record) {
        return "";
      }
      return record.parentLabel ? `${record.parentLabel} / ${record.label}` : record.label;
    },
    label: (item) => {
      const legendRecord = item.chart?.$legendHoverRecord;
      if (legendRecord) {
        const percent = total ? `${((legendRecord.value / total) * 100).toFixed(1)}%` : "0.0%";
        return `${legendRecord.label}: ${formatCurrency(legendRecord.value)} (${percent})`;
      }
      const record = assetDistributionTooltipRecord(item);
      const value = Number(item.parsed || 0);
      const totalPercent = total ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";
      if (record?.parentLabel) {
        const parentPercent = record.parentValue ? `${((value / record.parentValue) * 100).toFixed(1)}%` : "0.0%";
        return `${record.label}: ${formatCurrency(value)} (${parentPercent} of ${record.parentLabel}, ${totalPercent} total)`;
      }
      return `${record?.label || item.label}: ${formatCurrency(value)} (${totalPercent})`;
    },
  };
}

function assetDistributionTooltipRecord(item) {
  return item?.dataset?.assetDistributionRecords?.[item.dataIndex] || null;
}

function renderDoughnut({ chartId, centerId, metaId, rows, key, colorKind, animationMode = "scale" }) {
  const grouped = groupSum(rows, key);
  const entries = [...grouped.entries()].sort((a, b) => b[1] - a[1]);
  const labels = entries.map(([label]) => label);
  const values = entries.map(([, value]) => value);
  const total = values.reduce((sum, value) => sum + value, 0);

  byId(centerId).innerHTML = labels.length
    ? `<strong>${formatPercentOf(values[0], total)}</strong><span>${escapeHtml(labels[0])} · largest</span>`
    : `<strong>—</strong><span>No data</span>`;
  byId(metaId).textContent = `${labels.length} ${labels.length === 1 ? "group" : "groups"}`;

  replaceChart(chartId, {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: labels.map((label, index) => colorFor(colorKind, label, index)),
          borderColor: labels.map((label) => borderFor(colorFor(colorKind, label, 0))),
          borderWidth: 1.5,
          hoverOffset: 8,
        },
      ],
    },
    options: doughnutOptions(total, animationMode),
  });
}

function renderLineCharts() {
  if (!state.holdings.length) {
    return;
  }

  state.lineAnimationGraceUntil = performance.now() + LINE_POINT_ANIMATION_DURATION + LINE_POINT_MAX_DELAY_MS + 250;

  const timeline = buildTimeline(state.holdings.map((row) => row.Date));
  const allPoints = pointsFromRows(state.holdings);
  const investmentPoints = pointsFromRows(state.holdings.filter((row) => row.Ticker));
  const capitalBaseline = buildCapitalBaseline();
  const actualAssetDataset = buildLineDataset("Actual portfolio", allPoints, "#c7b8ff", { areaFill: true, borderWidth: 2.1 });
  const capitalBaselineDataset = buildLineDataset("Capital baseline", capitalBaseline.points, "#8f9bab", { borderWidth: 1.5 });
  capitalBaselineDataset.borderDash = [7, 6];
  capitalBaselineDataset.pointRadius = 0;
  capitalBaselineDataset.pointHoverRadius = 4;
  capitalBaselineDataset.pointBorderWidth = 0;

  replaceChart(
    "assetTrendChart",
    lineChartConfig(timeline, capitalBaseline.points.length ? [actualAssetDataset, capitalBaselineDataset] : [actualAssetDataset]),
  );
  replaceChart(
    "investmentTrendChart",
    lineChartConfig(timeline, [buildLineDataset("Ticker holdings", investmentPoints, "#8fdda0", { areaFill: true, borderWidth: 1.8 })], {
      showLegend: false,
    }),
  );

  const tickerGroups = groupRows(state.holdings.filter((row) => row.Ticker), "Ticker");
  const tickerDatasets = [...tickerGroups.entries()]
    .sort((a, b) => sumRows(b[1]) - sumRows(a[1]))
    .map(([ticker, tickerRows], index) => {
      const color = colorFor("ticker", ticker, index);
      return buildLineDataset(ticker, pointsFromRows(tickerRows), color);
    });

  replaceChart(
    "valueTrendChart",
    lineChartConfig(timeline, tickerDatasets, { legendClickMode: "hideThenIsolate", legendHoverMode: "semiIsolate" }),
  );
  renderInvestmentReturnChart();
}

function renderInvestmentReturnChart() {
  const rows = state.investmentReturns;
  if (!rows.length) {
    return;
  }

  const latest = rows.at(-1);
  const cumulativePercent = latest.cumulativeReturn * 100;
  const elapsedDays = Math.max(
    1,
    Math.round((Date.parse(`${latest.periodEnd}T00:00:00Z`) - Date.parse(`${rows[0].periodStart}T00:00:00Z`)) / 86400000),
  );
  const annualizedPercent = (Math.pow(1 + latest.cumulativeReturn, 365 / elapsedDays) - 1) * 100;
  const best = rows.reduce((current, row) => (row.monthlyReturn > current.monthlyReturn ? row : current), rows[0]);
  const worst = rows.reduce((current, row) => (row.monthlyReturn < current.monthlyReturn ? row : current), rows[0]);
  const cumulativeNode = byId("cumulativeReturn");

  cumulativeNode.textContent = formatSignedPercent(cumulativePercent);
  cumulativeNode.classList.toggle("is-positive", cumulativePercent > 0);
  cumulativeNode.classList.toggle("is-negative", cumulativePercent < 0);
  byId("annualizedReturn").textContent = `${formatSignedPercent(annualizedPercent)} annualized · since ${formatShortDateLabel(rows[0].periodStart)}`;
  byId("investmentReturnNote").textContent =
    `Estimated Modified Dietz return for Namuh, Kiwoom, and Samsung brokerage accounts. Account deposits and withdrawals are removed; trades, dividends, fees, and FX remain inside performance. ` +
    `Best month ${formatShortDateLabel(best.periodStart)} ${formatSignedPercent(best.monthlyReturn * 100)} · worst ${formatShortDateLabel(worst.periodStart)} ${formatSignedPercent(worst.monthlyReturn * 100)}. ` +
    `KB and Daishin are excluded because transaction histories were not imported; reconstructed historical values are accepted as final.`;

  const returnXScale = (dateKey) => ({
    grid: { display: false },
    ticks: {
      color: "#82909f",
      autoSkip: true,
      maxTicksLimit: window.innerWidth < 720 ? 6 : 12,
      maxRotation: 0,
      callback: (_value, index) => formatShortDateLabel(rows[index][dateKey]),
    },
  });

  replaceChart("cumulativeReturnChart", {
    type: "line",
    data: {
      labels: rows.map((row) => row.periodEnd),
      datasets: [
        {
          label: "Cumulative return",
          data: rows.map((row) => row.cumulativeReturn * 100),
          borderColor: "#c7b8ff",
          backgroundColor: "rgba(199, 184, 255, 0.12)",
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
          fill: true,
          tension: 0.24,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      animation: { duration: 420, easing: "easeOutCubic" },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => formatDateLabel(rows[items[0].dataIndex].periodEnd),
            label: (item) => `Cumulative return: ${formatSignedPercent(Number(item.raw))}`,
          },
        },
      },
      scales: {
        x: returnXScale("periodEnd"),
        y: {
          grid: {
            color: (context) => (Number(context.tick.value) === 0 ? "rgba(199, 184, 255, 0.5)" : "rgba(218, 230, 224, 0.08)"),
            lineWidth: (context) => (Number(context.tick.value) === 0 ? 1.5 : 1),
          },
          ticks: { color: "#82909f", callback: (value) => `${value}%` },
        },
      },
    },
  });

  replaceChart("investmentReturnChart", {
    type: "bar",
    data: {
      labels: rows.map((row) => row.periodStart),
      datasets: [
        {
          label: "Monthly return",
          data: rows.map((row) => row.monthlyReturn * 100),
          backgroundColor: rows.map((row) =>
            row.monthlyReturn >= 0 ? "rgba(143, 221, 160, 0.68)" : "rgba(248, 154, 154, 0.68)"
          ),
          borderWidth: 0,
          borderRadius: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      animation: { duration: 420, easing: "easeOutCubic" },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => formatDateLabel(rows[items[0].dataIndex].periodStart),
            label: (item) => `Monthly return: ${formatSignedPercent(Number(item.raw))}`,
          },
        },
      },
      scales: {
        x: returnXScale("periodStart"),
        y: {
          grid: {
            color: (context) => (Number(context.tick.value) === 0 ? "rgba(218, 230, 224, 0.36)" : "rgba(218, 230, 224, 0.08)"),
            lineWidth: (context) => (Number(context.tick.value) === 0 ? 1.5 : 1),
          },
          ticks: { color: "#82909f", callback: (value) => `${value}%` },
        },
      },
    },
  });
}

function lineChartConfig(timeline, datasets, { legendClickMode = "default", legendHoverMode = "default", showLegend = true } = {}) {
  const compactChart = window.innerWidth < 720;
  const legendOptions = showLegend
    ? {
        position: "bottom",
        labels: {
          boxWidth: 8,
          boxHeight: 8,
          color: "#b9c3d0",
          usePointStyle: true,
          padding: compactChart ? 8 : 12,
          font: { size: compactChart ? 9 : 10, weight: 600 },
        },
      }
    : {
        display: false,
        onClick: null,
        labels: { generateLabels: () => [] },
      };

  if (showLegend && legendClickMode === "hideThenIsolate") {
    legendOptions.onClick = hideThenIsolateLegendClick;
  }

  if (showLegend && legendHoverMode === "semiIsolate") {
    legendOptions.onHover = semiIsolateLineLegendHover;
    legendOptions.onLeave = semiIsolateLineLegendLeave;
  }

  return {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      animation: {
        x: {
          type: "number",
          duration: 0,
        },
        y: {
          type: "number",
          easing: "easeOutCubic",
          duration: lineAnimationDuration,
          from: lineYAxisBaseline,
          delay: linePointAnimationDelay,
        },
      },
      plugins: {
        legend: legendOptions,
        tooltip: {
          backgroundColor: "rgba(10, 13, 18, 0.96)",
          borderColor: "rgba(218, 230, 224, 0.16)",
          borderWidth: 1,
          titleColor: "#f3f6fb",
          bodyColor: "#dce3ee",
          callbacks: {
            title: (items) => formatDateLabel(items[0].raw.date),
            label: (item) => `${item.dataset.label}: ${formatCurrency(item.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: timeline.min,
          max: timeline.max,
          afterBuildTicks: (scale) => {
            scale.ticks = timeline.months.map((month) => ({ value: month.day }));
          },
          border: { display: false },
          grid: {
            color: compactChart ? "rgba(218, 230, 224, 0.045)" : "rgba(218, 230, 224, 0.08)",
            lineWidth: 1,
            tickLength: 8,
          },
          ticks: {
            autoSkip: true,
            maxTicksLimit: compactChart ? 6 : 11,
            color: "#7f8a99",
            maxRotation: 0,
            padding: 8,
            font: { size: compactChart ? 9 : 10, weight: 600 },
            callback: (value) => monthLabelForDay(timeline, value),
          },
        },
        y: {
          beginAtZero: false,
          border: { display: false },
          grid: { color: "rgba(218, 230, 224, 0.065)" },
          ticks: {
            color: "#7f8a99",
            padding: 8,
            maxTicksLimit: compactChart ? 5 : 7,
            font: { size: compactChart ? 9 : 10, weight: 600 },
            callback: (value) => formatCurrency(value),
          },
        },
      },
    },
  };
}

function lineYAxisBaseline(context) {
  if (state.suppressLineAnimations) {
    return undefined;
  }
  if (context.type !== "data") {
    return undefined;
  }
  if (context.chart?.chartArea) {
    return context.chart.chartArea.bottom;
  }
  const scale = context.chart?.scales?.y;
  return scale ? scale.getPixelForValue(scale.min) : undefined;
}

function lineAnimationDuration() {
  return state.suppressLineAnimations ? 0 : LINE_POINT_ANIMATION_DURATION;
}

function linePointAnimationDelay(context) {
  if (state.suppressLineAnimations || context.type !== "data" || context.yStarted) {
    return 0;
  }
  context.yStarted = true;
  const pointIndex = Number(context.dataIndex ?? context.index ?? 0);
  return Math.min(pointIndex * LINE_POINT_STAGGER_MS, LINE_POINT_MAX_DELAY_MS);
}

function buildLineDataset(label, points, color, { areaFill = false, borderWidth = LINE_BASE_BORDER_WIDTH } = {}) {
  return {
    label,
    data: points.map((point) => ({ x: dateToDay(point.date), y: point.value, date: point.date })),
    baseColor: color,
    baseBorderWidth: borderWidth,
    borderColor: color,
    backgroundColor: areaFill ? lineAreaGradient(color) : color,
    borderWidth,
    pointBackgroundColor: color,
    pointBorderColor: color,
    pointBorderWidth: LINE_POINT_BORDER_WIDTH,
    cubicInterpolationMode: "monotone",
    fill: areaFill ? "start" : false,
    tension: 0.42,
    spanGaps: true,
    pointRadius: window.innerWidth < 720 ? 2 : 2.5,
    pointHoverRadius: 5,
    pointHitRadius: 8,
  };
}

function lineAreaGradient(color) {
  return (context) => {
    const { chart } = context;
    const area = chart.chartArea;
    if (!area) {
      return colorWithAlpha(color, 0.12);
    }

    const gradient = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    gradient.addColorStop(0, colorWithAlpha(color, 0.24));
    gradient.addColorStop(0.58, colorWithAlpha(color, 0.1));
    gradient.addColorStop(1, colorWithAlpha(color, 0.02));
    return gradient;
  };
}

function hideThenIsolateLegendClick(_event, legendItem, legend) {
  const chart = legend.chart;
  const datasetIndex = legendItem.datasetIndex;
  const visibleStates = chart.data.datasets.map((_dataset, index) => chart.isDatasetVisible(index));
  const onlyClickedVisible = visibleStates.every((isVisible, index) => (index === datasetIndex ? isVisible : !isVisible));

  if (onlyClickedVisible) {
    chart.data.datasets.forEach((_dataset, index) => {
      chart.setDatasetVisibility(index, true);
    });
  } else if (visibleStates[datasetIndex]) {
    chart.setDatasetVisibility(datasetIndex, false);
  } else {
    chart.data.datasets.forEach((_dataset, index) => {
      chart.setDatasetVisibility(index, index === datasetIndex);
    });
  }

  chart.update("none");
}

function semiIsolateLineLegendHover(_event, legendItem, legend) {
  const chart = legend.chart;
  const hoveredIndex = legendItem.datasetIndex;

  chart.data.datasets.forEach((dataset, index) => {
    const baseColor = dataset.baseColor || dataset.borderColor;
    if (index === hoveredIndex) {
      dataset.borderColor = baseColor;
      dataset.backgroundColor = baseColor;
      dataset.pointBackgroundColor = baseColor;
      dataset.pointBorderColor = baseColor;
      dataset.borderWidth = LINE_HOVER_BORDER_WIDTH;
      dataset.pointRadius = 4;
      dataset.pointHoverRadius = 7;
      return;
    }

    dataset.borderColor = colorWithAlpha(baseColor, 0.16);
    dataset.backgroundColor = colorWithAlpha(baseColor, 0.16);
    dataset.pointBackgroundColor = colorWithAlpha(baseColor, 0.18);
    dataset.pointBorderColor = colorWithAlpha(baseColor, 0.18);
    dataset.borderWidth = LINE_DIM_BORDER_WIDTH;
    dataset.pointRadius = 1.5;
    dataset.pointHoverRadius = 4;
  });

  chart.update("none");
  chart.data.datasets.forEach((dataset, index) => {
    const baseColor = dataset.baseColor || dataset.borderColor;
    const pointColor = index === hoveredIndex ? baseColor : colorWithAlpha(baseColor, 0.18);
    applyLinePointElementStyle(chart, index, {
      color: pointColor,
      radius: index === hoveredIndex ? 4 : 1.5,
      hoverRadius: index === hoveredIndex ? 7 : 4,
      borderWidth: index === hoveredIndex ? LINE_POINT_BORDER_WIDTH : 1,
    });
  });
  chart.draw();
}

function semiIsolateLineLegendLeave(_event, _legendItem, legend) {
  const chart = legend.chart;
  chart.data.datasets.forEach((dataset) => {
    const baseColor = dataset.baseColor || dataset.borderColor;
    const baseBorderWidth = dataset.baseBorderWidth || LINE_BASE_BORDER_WIDTH;
    dataset.borderColor = baseColor;
    dataset.backgroundColor = baseColor;
    dataset.pointBackgroundColor = baseColor;
    dataset.pointBorderColor = baseColor;
    dataset.borderWidth = baseBorderWidth;
    dataset.pointRadius = 3;
    dataset.pointHoverRadius = 6;
  });
  chart.update("none");
  chart.data.datasets.forEach((dataset, index) => {
    const baseColor = dataset.baseColor || dataset.borderColor;
    applyLinePointElementStyle(chart, index, {
      color: baseColor,
      radius: 3,
      hoverRadius: 6,
      borderWidth: LINE_POINT_BORDER_WIDTH,
    });
  });
  chart.draw();
}

function applyLinePointElementStyle(chart, datasetIndex, { color, radius, hoverRadius, borderWidth }) {
  chart.getDatasetMeta(datasetIndex).data.forEach((point) => {
    if (!point?.options) {
      return;
    }
    point.options.backgroundColor = color;
    point.options.borderColor = color;
    point.options.radius = radius;
    point.options.hoverRadius = hoverRadius;
    point.options.borderWidth = borderWidth;
  });
}

function colorWithAlpha(color, alpha) {
  const normalizedColor = String(color || "").trim();
  const hexMatch = normalizedColor.match(/^#([0-9a-f]{6})$/i);
  if (!hexMatch) {
    return normalizedColor;
  }

  const value = Number.parseInt(hexMatch[1], 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function renderPlanWorkspace({ doughnutAnimation = "scale" } = {}) {
  const grouped = groupSum(state.plans, "Asset Type");
  const entries = [...grouped.entries()].sort((a, b) => b[1] - a[1]);
  const labels = entries.map(([label]) => label);
  const values = entries.map(([, value]) => value);
  const total = values.reduce((sum, value) => sum + value, 0);
  const latestRows = state.holdings.filter((row) => row.Date === latestDataDate());
  const currentTotal = sumRows(latestRows);
  const planDelta = total - currentTotal;
  const planDeltaPercent = currentTotal ? (planDelta / currentTotal) * 100 : 0;
  const planInvestment = sumRows(state.plans.filter((row) => row.Ticker));
  const planInvestmentPercent = total ? Math.round((planInvestment / total) * 100) : 0;

  byId("planCenter").innerHTML = labels.length
    ? `<strong>${formatPercentOf(values[0], total)}</strong><span>${escapeHtml(labels[0])} · leading</span>`
    : `<strong>—</strong><span>No planned assets</span>`;
  byId("planChartMeta").textContent = `${labels.length} ${labels.length === 1 ? "class" : "classes"}`;
  byId("planTableMeta").textContent = `${state.plans.length} positions · based on ${formatDateLabel(latestDataDate())}`;
  byId("metricPlanTotal").textContent = formatCurrency(total);
  byId("metricPlanDelta").textContent = formatSignedCurrency(planDelta);
  byId("metricPlanDeltaPercent").textContent = `${formatSignedPercent(planDeltaPercent)} compared with latest`;
  byId("metricPlanInvestment").textContent = `${planInvestmentPercent}%`;
  byId("metricPlanClasses").textContent = String(labels.length);
  byId("metricPlanDelta").classList.toggle("is-positive", planDelta > 0);
  byId("metricPlanDelta").classList.toggle("is-negative", planDelta < 0);
  renderPlanAllocationDeltas(grouped, total, latestRows, currentTotal);

  replaceChart("planChart", {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: labels.map((label, index) => colorFor("asset", label, index)),
          borderColor: labels.map((label) => borderFor(colorFor("asset", label, 0))),
          borderWidth: 1.5,
          hoverOffset: 8,
        },
      ],
    },
    options: doughnutOptions(total, doughnutAnimation),
  });

  const sortedPlans = state.plans.map((row, originalIndex) => ({ row, originalIndex })).sort((a, b) => compareRows(a.row, b.row));

  byId("planTableBody").innerHTML = sortedPlans
    .map(({ row, originalIndex }, index) => {
      const currentVolume = sumRows(
        latestRows.filter((currentRow) => currentRow["Asset Type"] === row["Asset Type"] && currentRow.Ticker === row.Ticker),
      );
      const plannedVolume = Number(row.Volume || 0);
      const volumeChange = plannedVolume - currentVolume;
      const changeClass = volumeChange > 0 ? "change-positive" : volumeChange < 0 ? "change-negative" : "";
      return `
        <tr>
          <td>${escapeHtml(row["Asset Type"])}</td>
          <td>${escapeHtml(row.Ticker || "-")}</td>
          <td class="number-cell">${escapeHtml(formatCurrency(currentVolume))}</td>
          <td class="number-cell">
            <input
              class="volume-edit"
              type="number"
              min="0"
              step="1"
              value="${escapeHtml(row.Volume)}"
              data-plan-volume-index="${originalIndex}"
              aria-label="Edit volume for plan row ${index + 1}"
            />
          </td>
          <td class="number-cell ${changeClass}">${escapeHtml(formatSignedCurrency(volumeChange))}</td>
          <td class="action-cell">
            <button class="icon-button small" type="button" data-remove-plan-index="${originalIndex}" title="Remove plan ${index + 1}">
              <i data-lucide="x"></i>
            </button>
          </td>
        </tr>
      `;
    })
    .join("");

  document.querySelectorAll("[data-plan-volume-index]").forEach((input) => {
    input.addEventListener("change", () => {
      const rowIndex = Number(input.dataset.planVolumeIndex);
      const parsedVolume = Number(input.value || 0);
      const volume = Number.isFinite(parsedVolume) ? Math.max(0, Math.round(parsedVolume)) : 0;
      state.plans[rowIndex].Volume = String(volume);
      input.value = String(volume);
      renderPlanWorkspace();
      setPlanStatus("Volume updated");
    });
  });

  document.querySelectorAll("[data-remove-plan-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const removeIndex = Number(button.dataset.removePlanIndex);
      state.plans = state.plans.filter((_row, index) => index !== removeIndex);
      renderPlanWorkspace();
      setPlanStatus("Row removed");
      renderIcons();
    });
  });

  renderIcons();
}

function renderPlanAllocationDeltas(plannedGroups, plannedTotal, currentRows, currentTotal) {
  const currentGroups = groupSum(currentRows, "Asset Type");
  const labels = unique([...currentGroups.keys(), ...plannedGroups.keys()]);
  const rows = labels
    .map((label, index) => {
      const currentValue = currentGroups.get(label) || 0;
      const plannedValue = plannedGroups.get(label) || 0;
      return {
        label,
        delta: plannedValue - currentValue,
        currentPercent: currentTotal ? Math.round((currentValue / currentTotal) * 100) : 0,
        plannedPercent: plannedTotal ? Math.round((plannedValue / plannedTotal) * 100) : 0,
        color: colorFor("asset", label, index),
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  byId("planDeltaList").innerHTML = rows.length
    ? rows
        .map((row) => {
          const changeClass = row.delta > 0 ? "change-positive" : row.delta < 0 ? "change-negative" : "";
          return `
            <div class="allocation-delta-row">
              <div class="allocation-delta-copy">
                <span class="allocation-delta-label">
                  <span class="allocation-delta-swatch" style="--delta-color: ${escapeHtml(row.color)}"></span>
                  ${escapeHtml(row.label)}
                </span>
                <small>${row.currentPercent}% → ${row.plannedPercent}%</small>
              </div>
              <span class="allocation-delta-value ${changeClass}">${escapeHtml(formatSignedCurrency(row.delta))}</span>
            </div>
          `;
        })
        .join("")
    : `<p class="allocation-empty">Add a position to start shaping this scenario.</p>`;
}

function replaceChart(chartId, config) {
  const canvas = byId(chartId);
  if (state.charts[chartId]) {
    state.charts[chartId].destroy();
  }
  state.charts[chartId] = new Chart(canvas, config);
  renderExternalDoughnutLegend(state.charts[chartId]);
}

function doughnutOptions(total, animationMode = "scale", { cutout = "66%", legendLabels, tooltipCallbacks } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    cutout,
    animation: doughnutAnimationOptions(animationMode),
    plugins: {
      legend: {
        display: false,
        position: "bottom",
        onClick: null,
        onHover: handleDoughnutLegendHover,
        onLeave: handleDoughnutLegendLeave,
        labels: {
          boxWidth: 10,
          boxHeight: 10,
          color: "#d5dce7",
          usePointStyle: true,
          ...(legendLabels ? { generateLabels: legendLabels } : {}),
        },
      },
      tooltip: {
        backgroundColor: "rgba(10, 13, 18, 0.96)",
        borderColor: "rgba(218, 230, 224, 0.16)",
        borderWidth: 1,
        titleColor: "#f3f6fb",
        bodyColor: "#dce3ee",
        callbacks:
          tooltipCallbacks || {
            label: (item) => {
              const value = item.parsed;
              const percent = total ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";
              return `${item.label}: ${formatCurrency(value)} (${percent})`;
            },
          },
      },
    },
  };
}

function renderExternalDoughnutLegend(chart) {
  if (chart.config.type !== "doughnut") {
    return;
  }

  const frame = chart.canvas.closest(".pie-frame");
  if (!frame) {
    return;
  }

  let legend = frame.querySelector(".pie-legend");
  if (!legend) {
    legend = document.createElement("div");
    legend.className = "pie-legend";
    frame.append(legend);
  }

  const generateLabels =
    chart.options.plugins.legend.labels.generateLabels ||
    chart.config._config.options.plugins.legend.labels.generateLabels ||
    Chart.defaults.plugins.legend.labels.generateLabels;
  const items = generateLabels(chart);
  legend.innerHTML = "";

  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.title = item.text;
    button.addEventListener("click", (event) => event.preventDefault());
    button.addEventListener("mouseenter", (event) => handleDoughnutLegendHover(event, item, { chart }));
    button.addEventListener("mouseleave", (event) => handleDoughnutLegendLeave(event, item, { chart }));
    button.addEventListener("focus", (event) => handleDoughnutLegendHover(event, item, { chart }));
    button.addEventListener("blur", (event) => handleDoughnutLegendLeave(event, item, { chart }));

    const swatch = document.createElement("span");
    swatch.className = "pie-legend-swatch";
    swatch.style.setProperty("--legend-color", item.fillStyle || "#d5dce7");
    swatch.style.setProperty("--legend-border", item.strokeStyle || "rgba(18, 22, 18, 0.88)");

    const text = document.createElement("span");
    text.textContent = item.text;

    button.append(swatch, text);
    legend.append(button);
  });
}

function handleDoughnutLegendHover(event, legendItem, legend) {
  const chart = legend.chart;
  const activeElements = doughnutLegendActiveElements(legendItem);
  if (!activeElements.length) {
    return;
  }

  chart.$legendHoverRecord = legendItem.assetDistributionRecord || null;
  chart.canvas.style.cursor = "pointer";
  chart.setActiveElements(activeElements);
  chart.tooltip.setActiveElements([activeElements[0]], doughnutLegendTooltipPosition(chart, activeElements[0], event));
  chart.update();
}

function handleDoughnutLegendLeave(_event, _legendItem, legend) {
  const chart = legend.chart;
  chart.$legendHoverRecord = null;
  chart.canvas.style.cursor = "";
  chart.setActiveElements([]);
  chart.tooltip.setActiveElements([], { x: 0, y: 0 });
  chart.update();
}

function doughnutLegendActiveElements(legendItem) {
  if (Array.isArray(legendItem.assetDistributionDetailIndexes)) {
    return legendItem.assetDistributionDetailIndexes.map((index) => ({ datasetIndex: 0, index }));
  }

  if (Number.isInteger(legendItem.index)) {
    const datasetIndex = Number.isInteger(legendItem.datasetIndex) ? legendItem.datasetIndex : 0;
    return [{ datasetIndex, index: legendItem.index }];
  }

  return [];
}

function doughnutLegendTooltipPosition(chart, activeElement, event) {
  const element = chart.getDatasetMeta(activeElement.datasetIndex).data[activeElement.index];
  return element?.tooltipPosition() || { x: event?.x ?? chart.width / 2, y: event?.y ?? chart.height / 2 };
}

function doughnutAnimationOptions(animationMode) {
  if (animationMode === "rotate") {
    return {
      animateRotate: true,
      animateScale: false,
      duration: DOUGHNUT_ROTATE_ANIMATION_DURATION,
      easing: "easeOutCubic",
    };
  }

  return {
    animateRotate: false,
    animateScale: true,
    duration: DOUGHNUT_SCALE_ANIMATION_DURATION,
    easing: "easeOutCubic",
  };
}

function configureChartDefaults() {
  if (!window.Chart) {
    return;
  }

  Chart.defaults.color = "#b9c3d0";
  Chart.defaults.borderColor = "rgba(218, 230, 224, 0.09)";
  Chart.defaults.font.family =
    "Inter, Pretendard, 'Noto Sans KR', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  Chart.defaults.font.weight = 600;
}

function normalizeCsvText(text, { defaultPlan = "No" } = {}) {
  const parsed = Papa.parse(text.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  const rawRows = parsed.data.filter((row) => Object.values(row).some((value) => normalizeText(value)));
  const knownTickers = collectKnownTickers(rawRows);
  const majorityAssetTypes = defaultPlan === "Yes" ? new Map() : inferMajorityAssetTypes(rawRows);
  const holdings = [];
  const plans = [];
  const errors = [];

  rawRows.forEach((row, index) => {
    try {
      const volume = parseVolume(getField(row, ["Volume"]));
      if (volume === null) {
        return;
      }

      const name = getField(row, ["Name"]);
      const isBalanceCash = isBalanceName(name);
      const ticker = isBalanceCash ? "" : normalizeTicker(getField(row, ["Ticker"])) || inferTicker(name, knownTickers);
      const normalized = {
        Date: parseDate(getField(row, ["Date"])),
        "Asset Type": normalizeAssetType(row, ticker, majorityAssetTypes, isBalanceCash),
        "Securities Firm": normalizeText(getField(row, ["Securities Firm", "Firm", "Broker"])),
        Ticker: ticker,
        Volume: String(volume),
      };

      if (defaultPlan === "Yes") {
        plans.push(normalized);
      } else {
        holdings.push(normalized);
      }
    } catch (error) {
      errors.push(`Row ${index + 2}: ${error.message}`);
    }
  });

  return {
    holdings: holdings.sort(compareRows),
    plans: plans.sort(compareRows),
    errors,
  };
}

function normalizeCapitalBaselineCsv(text) {
  const parsed = Papa.parse(text.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });
  const points = parsed.data
    .map((row) => ({
      date: parseDate(getField(row, ["Date"])),
      value: parseVolume(getField(row, ["Volume"])),
    }))
    .filter((point) => point.value !== null && point.value >= 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!points.length) {
    throw new Error("capital baseline CSV has no usable rows");
  }
  return points;
}

function normalizeInvestmentReturnsCsv(text) {
  const parsed = Papa.parse(text.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });
  const rows = parsed.data
    .map((row) => ({
      periodStart: parseDate(getField(row, ["Period Start"])),
      periodEnd: parseDate(getField(row, ["Period End"])),
      monthlyReturn: Number(getField(row, ["Monthly Return"])),
      cumulativeReturn: Number(getField(row, ["Cumulative Return"])),
      confidence: normalizeText(getField(row, ["Confidence"])),
    }))
    .filter((row) => Number.isFinite(row.monthlyReturn) && Number.isFinite(row.cumulativeReturn))
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  if (!rows.length) {
    throw new Error("investment return CSV has no usable rows");
  }
  return rows;
}

function normalizeAssetType(row, ticker, majorityAssetTypes, isBalanceCash) {
  if (isBalanceCash) {
    return CASH_ASSET_TYPE;
  }

  if (ticker && TICKER_ASSET_TYPE_BY_TICKER.has(ticker)) {
    return TICKER_ASSET_TYPE_BY_TICKER.get(ticker);
  }

  const current = normalizeAssetTypeLabel(getField(row, ["Asset Type", "AssetType", "Type"]));
  if (current) {
    return current;
  }

  if (majorityAssetTypes.has(ticker)) {
    return majorityAssetTypes.get(ticker);
  }

  const firm = normalizeText(getField(row, ["Securities Firm", "Firm", "Broker"]));
  if (!ticker && BANK_LIKE_FIRMS.has(firm)) {
    return CASH_ASSET_TYPE;
  }

  return UNCLASSIFIED_ASSET_TYPE;
}

function inferMajorityAssetTypes(rawRows) {
  const counts = new Map();
  for (const row of rawRows) {
    const ticker = normalizeTicker(getField(row, ["Ticker"]));
    const assetType = normalizeAssetTypeLabel(getField(row, ["Asset Type", "AssetType", "Type"]));
    if (!ticker || !assetType) {
      continue;
    }

    if (!counts.has(ticker)) {
      counts.set(ticker, new Map());
    }
    const tickerCounts = counts.get(ticker);
    tickerCounts.set(assetType, (tickerCounts.get(assetType) || 0) + 1);
  }

  const result = new Map();
  counts.forEach((tickerCounts, ticker) => {
    const [assetType] = [...tickerCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    result.set(ticker, assetType);
  });
  return result;
}

function collectKnownTickers(rawRows) {
  const tickers = new Set(TICKER_ASSET_TYPE_BY_TICKER.keys());
  rawRows.forEach((row) => {
    const ticker = normalizeTicker(getField(row, ["Ticker"]));
    if (ticker) {
      tickers.add(ticker);
    }
  });
  return [...tickers].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function inferTicker(name, knownTickers) {
  const normalizedName = normalizeTicker(name);
  if (!normalizedName) {
    return "";
  }

  const matches = knownTickers.filter((ticker) => {
    const pattern = new RegExp(`(^|[^A-Z0-9가-힣])${escapeRegex(ticker)}([^A-Z0-9가-힣]|$)`, "u");
    return pattern.test(normalizedName);
  });

  return matches.length === 1 ? matches[0] : "";
}

function parseDate(value) {
  const normalized = normalizeText(value).replace(/\s*\(GMT[+-]\d+\)\s*/i, "");
  if (!normalized) {
    throw new Error("missing date");
  }

  const isoMatch = normalized.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (isoMatch) {
    return toIsoDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const shortMatch = normalized.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  if (shortMatch) {
    const year = shortMatch[3].length === 2 ? Number(`20${shortMatch[3]}`) : Number(shortMatch[3]);
    return toIsoDate(year, monthIndex(shortMatch[2]), Number(shortMatch[1]));
  }

  const longMatch = normalized.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (longMatch) {
    return toIsoDate(Number(longMatch[3]), monthIndex(longMatch[1]), Number(longMatch[2]));
  }

  throw new Error(`unsupported date "${value}"`);
}

function parseVolume(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const numeric = Number(normalized.replace(/[^\d.-]/g, ""));
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function normalizeTicker(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeAssetTypeLabel(value) {
  const label = normalizeText(value);
  if (label === "공격적 투자") {
    return "공격형 투자";
  }
  return label;
}

function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function isBalanceName(value) {
  return normalizeText(value).startsWith(BALANCE_PREFIX);
}

function monthIndex(name) {
  const key = name.slice(0, 3).toLowerCase();
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const index = months.indexOf(key);
  if (index === -1) {
    throw new Error(`unsupported month "${name}"`);
  }
  return index + 1;
}

function toIsoDate(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function rowsAtViewDate() {
  return state.holdings.filter((row) => row.Date === state.viewDate);
}

function groupSum(rows, key) {
  const groups = new Map();
  rows.forEach((row) => {
    const label = row[key] || UNCLASSIFIED_ASSET_TYPE;
    groups.set(label, (groups.get(label) || 0) + Number(row.Volume || 0));
  });
  return groups;
}

function groupRows(rows, key) {
  const groups = new Map();
  rows.forEach((row) => {
    const label = row[key] || UNCLASSIFIED_ASSET_TYPE;
    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label).push(row);
  });
  return groups;
}

function groupRowsBy(rows, getLabel) {
  const groups = new Map();
  rows.forEach((row) => {
    const label = getLabel(row) || UNCLASSIFIED_ASSET_TYPE;
    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label).push(row);
  });
  return groups;
}

function pointsFromRows(rows) {
  return [...groupSum(rows, "Date").entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildTimeline(dates) {
  const sorted = unique(dates).sort();
  const start = monthStartTime(sorted[0]);
  const end = monthEndTime(sorted[sorted.length - 1]);
  const months = [];

  for (let time = start; time <= end; time = nextMonthStart(time)) {
    const date = new Date(time);
    months.push({
      day: timeToDay(time),
      label: date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
    });
  }

  return {
    min: timeToDay(start),
    max: timeToDay(end),
    months,
  };
}

function monthLabelForDay(timeline, value) {
  const month = timeline.months.find((entry) => entry.day === Number(value));
  return month?.label || "";
}

function dateToDay(isoDate) {
  return timeToDay(new Date(`${isoDate}T00:00:00Z`).getTime());
}

function timeToDay(time) {
  return Math.round(time / 86400000);
}

function monthStartTime(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function monthEndTime(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
}

function nextMonthStart(time) {
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function sumRows(rows) {
  return rows.reduce((sum, row) => sum + Number(row.Volume || 0), 0);
}

function colorFor(kind, label, index) {
  const map = COLOR_MAPS[kind];
  return map?.get(label) || FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function borderFor(color) {
  return color.toLowerCase() === "#626b76" ? "rgba(232, 239, 230, 0.34)" : "rgba(18, 22, 18, 0.88)";
}

function formatCurrency(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) {
    return "0만원";
  }

  const sign = amount < 0 ? "-" : "";
  const roundedMan = Math.round(Math.abs(amount) / KRW_PER_MAN);
  const eok = Math.floor(roundedMan / MAN_PER_EOK);
  const man = roundedMan % MAN_PER_EOK;
  const parts = [];

  if (eok) {
    parts.push(`${unitNumberFormatter.format(eok)}억`);
  }
  if (man || !parts.length) {
    parts.push(`${unitNumberFormatter.format(man)}만원`);
  }

  return `${sign}${parts.join(" ")}`;
}

function formatSignedCurrency(value) {
  const amount = Number(value || 0);
  if (!amount) {
    return "0만원";
  }
  return `${amount > 0 ? "+" : ""}${formatCurrency(amount)}`;
}

function formatSignedPercent(value) {
  const amount = Number(value || 0);
  const sign = amount > 0 ? "+" : "";
  return `${sign}${amount.toFixed(1)}%`;
}

function formatPercentOf(value, total) {
  return total ? `${Math.round((Number(value || 0) / total) * 100)}%` : "0%";
}

function formatDateLabel(isoDate) {
  if (!isoDate) {
    return "-";
  }
  const date = new Date(`${isoDate}T00:00:00Z`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function formatShortDateLabel(isoDate) {
  if (!isoDate) {
    return "-";
  }
  const date = new Date(`${isoDate}T00:00:00Z`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function compareRows(a, b) {
  return (
    a.Date.localeCompare(b.Date) ||
    a["Asset Type"].localeCompare(b["Asset Type"]) ||
    a["Securities Firm"].localeCompare(b["Securities Firm"]) ||
    a.Ticker.localeCompare(b.Ticker)
  );
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getField(row, names) {
  const keys = Object.keys(row);
  const wanted = names.map(canonicalHeader);
  const key = keys.find((candidate) => wanted.includes(canonicalHeader(candidate)));
  return key ? row[key] : "";
}

function canonicalHeader(header) {
  return String(header).toLowerCase().replace(/[\s_?]/g, "");
}

function downloadCsv(filename, rows) {
  const csv = [OUTPUT_COLUMNS.join(","), ...rows.map((row) => OUTPUT_COLUMNS.map((column) => escapeCsv(row[column])).join(","))].join("\n");
  const blob = new Blob([`\uFEFF${csv}\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setStatus(text) {
  byId("dataStatus").textContent = text;
}

function setPlanStatus(text) {
  byId("planStatus").textContent = text;
}

function statusText() {
  const latestDate = latestDataDate();
  return latestDate ? `${state.dates.length} snapshots · latest ${formatShortDateLabel(latestDate)}` : "No portfolio data";
}

function renderIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function byId(id) {
  return document.getElementById(id);
}
