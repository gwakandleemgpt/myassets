const SOURCE_HOLDINGS = "data/portfolio-clean.csv";
const SOURCE_CATALOG = "data/catalog.json";

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
const unitNumberFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 0,
});

const state = {
  baseHoldings: [],
  holdings: [],
  plans: [],
  dates: [],
  viewDate: "",
  charts: {},
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  configureChartDefaults();
  wireTabs();
  wireDashboardControls();
  wirePlanControls();
  await loadInitialData();
  renderIcons();
}

async function loadInitialData() {
  setStatus("Loading source CSV...");

  try {
    const [catalogText, holdingsText] = await Promise.all([
      fetchText(SOURCE_CATALOG),
      fetchText(SOURCE_HOLDINGS),
    ]);
    applyCatalog(JSON.parse(catalogText));
    populatePlanAssetTypes();
    state.baseHoldings = normalizeCsvText(holdingsText, { defaultPlan: "No" }).holdings;
    state.holdings = [...state.baseHoldings];

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

  byId("metricTotal").textContent = formatCurrency(total);
  byId("metricInvestment").innerHTML = `${formatCurrency(investmentTotal)} <span class="metric-percent">(${investmentPercent}%)</span>`;

  renderDoughnut({
    chartId: "assetDistributionChart",
    centerId: "assetDistributionCenter",
    metaId: "assetDistributionMeta",
    rows,
    key: "Asset Type",
    colorKind: "asset",
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

function renderDoughnut({ chartId, centerId, metaId, rows, key, colorKind, animationMode = "scale" }) {
  const grouped = groupSum(rows, key);
  const entries = [...grouped.entries()].sort((a, b) => b[1] - a[1]);
  const labels = entries.map(([label]) => label);
  const values = entries.map(([, value]) => value);
  const total = values.reduce((sum, value) => sum + value, 0);

  byId(centerId).innerHTML = `<strong>${formatCurrency(total)}</strong><span>${formatDateLabel(state.viewDate)}</span>`;
  byId(metaId).textContent = `${labels.length} groups`;

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

  const timeline = buildTimeline(state.holdings.map((row) => row.Date));
  const allPoints = pointsFromRows(state.holdings);
  const investmentPoints = pointsFromRows(state.holdings.filter((row) => row.Ticker));

  replaceChart("assetTrendChart", lineChartConfig(timeline, [buildLineDataset("Total assets", allPoints, "#c7b8ff")], { showLegend: false }));
  replaceChart(
    "investmentTrendChart",
    lineChartConfig(timeline, [buildLineDataset("Ticker holdings", investmentPoints, "#8fdda0")], { showLegend: false }),
  );

  const tickerGroups = groupRows(state.holdings.filter((row) => row.Ticker), "Ticker");
  const tickerDatasets = [...tickerGroups.entries()]
    .sort((a, b) => sumRows(b[1]) - sumRows(a[1]))
    .map(([ticker, tickerRows], index) => {
      const color = colorFor("ticker", ticker, index);
      return buildLineDataset(ticker, pointsFromRows(tickerRows), color);
    });

  replaceChart("valueTrendChart", lineChartConfig(timeline, tickerDatasets, { legendClickMode: "hideThenIsolate" }));
}

function lineChartConfig(timeline, datasets, { legendClickMode = "default", showLegend = true } = {}) {
  const legendOptions = showLegend
    ? {
        position: "bottom",
        labels: { boxWidth: 10, boxHeight: 10, color: "#d5dce7", usePointStyle: true },
      }
    : {
        display: false,
        onClick: null,
        labels: { generateLabels: () => [] },
      };

  if (showLegend && legendClickMode === "hideThenIsolate") {
    legendOptions.onClick = hideThenIsolateLegendClick;
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
          duration: LINE_POINT_ANIMATION_DURATION,
          from: lineYAxisBaseline,
          delay: linePointAnimationDelay,
        },
      },
      plugins: {
        legend: legendOptions,
        tooltip: {
          backgroundColor: "rgba(24, 29, 24, 0.94)",
          borderColor: "rgba(218, 225, 236, 0.18)",
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
          border: { color: "rgba(218, 225, 236, 0.24)" },
          grid: {
            color: "rgba(218, 225, 236, 0.2)",
            lineWidth: 1,
            tickLength: 8,
          },
          ticks: {
            autoSkip: false,
            color: "#adb7c5",
            maxRotation: 0,
            padding: 8,
            callback: (value) => monthLabelForDay(timeline, value),
          },
        },
        y: {
          beginAtZero: false,
          border: { color: "rgba(218, 225, 236, 0.24)" },
          grid: { color: "rgba(218, 225, 236, 0.11)" },
          ticks: {
            color: "#adb7c5",
            callback: (value) => formatCurrency(value),
          },
        },
      },
    },
  };
}

function lineYAxisBaseline(context) {
  if (context.type !== "data") {
    return undefined;
  }
  if (context.chart?.chartArea) {
    return context.chart.chartArea.bottom;
  }
  const scale = context.chart?.scales?.y;
  return scale ? scale.getPixelForValue(scale.min) : undefined;
}

function linePointAnimationDelay(context) {
  if (context.type !== "data" || context.yStarted) {
    return 0;
  }
  context.yStarted = true;
  const pointIndex = Number(context.dataIndex ?? context.index ?? 0);
  return Math.min(pointIndex * LINE_POINT_STAGGER_MS, LINE_POINT_MAX_DELAY_MS);
}

function buildLineDataset(label, points, color) {
  return {
    label,
    data: points.map((point) => ({ x: dateToDay(point.date), y: point.value, date: point.date })),
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2.5,
    cubicInterpolationMode: "monotone",
    tension: 0.42,
    spanGaps: true,
    pointRadius: 3,
    pointHoverRadius: 6,
    pointHitRadius: 8,
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

  chart.update();
}

function renderPlanWorkspace({ doughnutAnimation = "scale" } = {}) {
  const grouped = groupSum(state.plans, "Asset Type");
  const entries = [...grouped.entries()].sort((a, b) => b[1] - a[1]);
  const labels = entries.map(([label]) => label);
  const values = entries.map(([, value]) => value);
  const total = values.reduce((sum, value) => sum + value, 0);

  byId("planCenter").innerHTML = `<strong>${formatCurrency(total)}</strong><span>Working plan</span>`;
  byId("planChartMeta").textContent = `${labels.length} groups`;
  byId("planTableMeta").textContent = `${state.plans.length} rows from ${formatDateLabel(latestDataDate())}`;

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
      return `
        <tr>
          <td>${escapeHtml(row["Asset Type"])}</td>
          <td>${escapeHtml(row.Ticker || "-")}</td>
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

function replaceChart(chartId, config) {
  const canvas = byId(chartId);
  if (state.charts[chartId]) {
    state.charts[chartId].destroy();
  }
  state.charts[chartId] = new Chart(canvas, config);
}

function doughnutOptions(total, animationMode = "scale") {
  return {
    responsive: true,
    maintainAspectRatio: false,
    cutout: "66%",
    animation: doughnutAnimationOptions(animationMode),
    plugins: {
      legend: {
        position: "bottom",
        labels: { boxWidth: 10, boxHeight: 10, color: "#d5dce7", usePointStyle: true },
      },
      tooltip: {
        backgroundColor: "rgba(24, 29, 24, 0.94)",
        borderColor: "rgba(218, 225, 236, 0.18)",
        borderWidth: 1,
        titleColor: "#f3f6fb",
        bodyColor: "#dce3ee",
        callbacks: {
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

  Chart.defaults.color = "#d5dce7";
  Chart.defaults.borderColor = "rgba(218, 225, 236, 0.12)";
  Chart.defaults.font.family =
    "'Nanum Gothic', 'NanumGothic', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
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

function formatDateLabel(isoDate) {
  if (!isoDate) {
    return "-";
  }
  const date = new Date(`${isoDate}T00:00:00Z`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
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
  return `${state.holdings.length} rows · ${state.dates.length} snapshots · source CSV`;
}

function renderIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function byId(id) {
  return document.getElementById(id);
}
