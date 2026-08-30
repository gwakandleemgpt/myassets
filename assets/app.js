const SOURCE_HOLDINGS = "data/portfolio-clean.csv";
const SOURCE_CATALOG = "data/catalog.json";
const SOURCE_CAPITAL_BASELINE = "data/capital-baseline.csv";
const SOURCE_INVESTMENT_RETURNS = "data/investment-returns.csv";
const SOURCE_ANALYSIS_REPORTS = "data/analysis-reports.json";

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
const LINE_ZOOM_MIN_WINDOW_DAYS = 45;
const LINE_ZOOM_WHEEL_SPEED = 0.0015;
const HOLDING_TRAJECTORY_MIN_VALUE = 1000000;
const HOLDING_TRAJECTORY_MIN_OBSERVATIONS = 4;
const HOLDING_TRAJECTORY_MAJOR_COUNT = 6;
const unitNumberFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 0,
});

const state = {
  baseHoldings: [],
  holdings: [],
  capitalBaseline: [],
  investmentReturns: [],
  analysisReports: [],
  selectedAnalysisId: "",
  plans: [],
  dates: [],
  viewDate: "",
  charts: {},
  holdingFocusTicker: "",
  holdingLegendExpanded: false,
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
  wireHoldingLegendControls();
  wirePlanControls();
  wireAnalysisControls();
  const loaded = await loadInitialData();
  if (loaded) {
    renderIcons();
    await hideInitialLoadingScreen();
  }
}

async function loadInitialData() {
  setStatus("Loading source CSV...");

  try {
    const [catalogText, holdingsText, baselineText, investmentReturnsText, analysisReportsText] = await Promise.all([
      fetchText(SOURCE_CATALOG),
      fetchText(SOURCE_HOLDINGS),
      fetchText(SOURCE_CAPITAL_BASELINE),
      fetchText(SOURCE_INVESTMENT_RETURNS),
      fetchText(SOURCE_ANALYSIS_REPORTS),
    ]);
    setInitialLoadingMessage("Building charts and portfolio views…");
    applyCatalog(JSON.parse(catalogText));
    populatePlanAssetTypes();
    state.baseHoldings = normalizeCsvText(holdingsText, { defaultPlan: "No" }).holdings;
    state.holdings = [...state.baseHoldings];
    state.capitalBaseline = normalizeCapitalBaselineCsv(baselineText);
    state.investmentReturns = normalizeInvestmentReturnsCsv(investmentReturnsText);
    state.analysisReports = normalizeAnalysisReports(analysisReportsText);
    state.selectedAnalysisId = state.analysisReports[0]?.id || "";

    refreshDataViews({ resetViewDate: true });
    return true;
  } catch (error) {
    setStatus(`Could not load CSV: ${error.message}`);
    showInitialLoadingError(error);
    return false;
  }
}

function setInitialLoadingMessage(message) {
  const messageNode = byId("initialLoadingMessage");
  if (messageNode) {
    messageNode.textContent = message;
  }
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function hideInitialLoadingScreen() {
  const screen = byId("initialLoadingScreen");
  if (!screen) {
    return;
  }

  setInitialLoadingMessage("Portfolio ready");
  await nextPaint();
  await nextPaint();
  screen.classList.add("is-complete");
  screen.setAttribute("aria-hidden", "true");
  document.body.classList.remove("is-loading");
  screen.addEventListener("transitionend", () => screen.remove(), { once: true });
}

function showInitialLoadingError(error) {
  const screen = byId("initialLoadingScreen");
  const retryButton = byId("initialLoadingRetry");
  if (!screen) {
    return;
  }

  screen.classList.add("is-error");
  screen.setAttribute("role", "alert");
  setInitialLoadingMessage(`We couldn't load your portfolio. ${error.message}`);
  if (retryButton) {
    retryButton.hidden = false;
    retryButton.addEventListener("click", () => window.location.reload(), { once: true });
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
        const isActive = item.dataset.tab === tabId;
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
        } else if (tabId === "analysis") {
          renderAnalysisArchive({ renderCharts: true });
        }
      });
    });
  });
}

function wireAnalysisControls() {
  byId("analysisArchiveList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-analysis-id]");
    if (button) {
      selectAnalysisReport(button.dataset.analysisId);
    }
  });

  byId("analysisReportSelect").addEventListener("change", (event) => {
    selectAnalysisReport(event.target.value);
  });
}

function selectAnalysisReport(reportId) {
  if (!state.analysisReports.some((report) => report.id === reportId)) {
    return;
  }
  state.selectedAnalysisId = reportId;
  renderAnalysisArchive({ renderCharts: activeTabId() === "analysis" });
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
  byId("snapshotYearSelect").addEventListener("change", (event) => {
    const yearDates = state.dates.filter((date) => date.startsWith(`${event.target.value}-`));
    const activeMonth = state.viewDate.slice(5, 7);
    const sameMonthDates = yearDates.filter((date) => date.slice(5, 7) === activeMonth);
    selectDashboardSnapshot(sameMonthDates[sameMonthDates.length - 1] || yearDates[yearDates.length - 1]);
  });

  byId("snapshotMonthSelect").addEventListener("change", (event) => {
    selectDashboardSnapshot(event.target.value);
  });

  byId("previousSnapshotBtn").addEventListener("click", () => stepSnapshot(-1));
  byId("nextSnapshotBtn").addEventListener("click", () => stepSnapshot(1));
  byId("latestSnapshotBtn").addEventListener("click", () => selectDashboardSnapshot(latestDataDate()));

  function stepSnapshot(direction) {
    const currentIndex = Math.max(state.dates.indexOf(state.viewDate), 0);
    const targetIndex = Math.min(Math.max(currentIndex + direction, 0), Math.max(state.dates.length - 1, 0));
    selectDashboardSnapshot(state.dates[targetIndex]);
  }

}

function selectDashboardSnapshot(date) {
  if (!date || date === state.viewDate || !state.dates.includes(date)) {
    return false;
  }
  state.viewDate = date;
  syncDateControls();
  renderDashboard({ updateLines: false, doughnutAnimation: "morph" });
  ["assetTrendChart", "investmentReturnChart"].forEach((chartId) => {
    state.charts[chartId]?.update("none");
  });
  const holdingChart = state.charts.valueTrendChart;
  if (holdingChart) {
    renderHoldingLegend(holdingChart.data.datasets);
  }
  return true;
}

function wireHoldingLegendControls() {
  const browser = byId("holdingLegendBrowser");
  const drawer = byId("holdingLegendDrawer");
  const toggle = byId("holdingLegendToggle");
  const search = byId("holdingLegendSearch");

  toggle.addEventListener("click", () => {
    state.holdingLegendExpanded = !state.holdingLegendExpanded;
    drawer.hidden = !state.holdingLegendExpanded;
    toggle.setAttribute("aria-expanded", String(state.holdingLegendExpanded));
    toggle.classList.toggle("is-expanded", state.holdingLegendExpanded);
    if (state.holdingLegendExpanded) {
      requestAnimationFrame(() => search.focus());
    }
  });

  search.addEventListener("input", syncHoldingLegendSearch);
  byId("holdingLegendClear").addEventListener("click", () => setHoldingFocus(""));

  browser.addEventListener("click", (event) => {
    const item = event.target.closest("[data-holding-ticker]");
    if (item) {
      setHoldingFocus(item.dataset.holdingTicker);
    }
  });

  browser.addEventListener("mouseover", (event) => {
    const item = event.target.closest("[data-holding-ticker]");
    if (!item || state.holdingFocusTicker) {
      return;
    }
    const chart = state.charts.valueTrendChart;
    const datasetIndex = chart?.data.datasets.findIndex((dataset) => dataset.label === item.dataset.holdingTicker) ?? -1;
    if (chart && datasetIndex >= 0) {
      semiIsolateLineLegendHover(null, { datasetIndex }, { chart });
    }
  });

  browser.addEventListener("mouseout", (event) => {
    const item = event.target.closest("[data-holding-ticker]");
    if (!item || item.contains(event.relatedTarget) || state.holdingFocusTicker) {
      return;
    }
    const chart = state.charts.valueTrendChart;
    if (chart) {
      semiIsolateLineLegendLeave(null, null, { chart });
    }
  });
}

function renderHoldingLegend(datasets) {
  const records = holdingLegendRecords(datasets);
  const relevantTickers = new Set(records.map((record) => record.ticker));
  const chart = state.charts.valueTrendChart;

  if (state.holdingFocusTicker && !relevantTickers.has(state.holdingFocusTicker)) {
    state.holdingFocusTicker = "";
  }

  byId("holdingLegendCaption").textContent = `Major + ${formatShortDateLabel(state.viewDate)}`;
  byId("holdingLegendFeatured").innerHTML = records
    .map((record) => holdingLegendItemMarkup(record, true))
    .join("");
  byId("holdingLegendList").innerHTML = records
    .map((record) => holdingLegendItemMarkup(record, false))
    .join("");
  byId("holdingLegendSearch").value = "";
  syncHoldingLegendSearch();
  if (chart) {
    chart.data.datasets.forEach((dataset, index) => {
      const isVisible = state.holdingFocusTicker
        ? dataset.label === state.holdingFocusTicker
        : true;
      chart.setDatasetVisibility(index, isVisible);
    });
    chart.$holdingLegendCount = records.length;
    chart.update("none");
  }
  syncHoldingLegendControls(records.length);
}

function holdingLegendRecords(datasets) {
  const records = datasets.map((dataset) => {
    const selectedPoint = (dataset.data || []).find((point) => point.date === state.viewDate);
    return {
      ticker: dataset.label,
      color: dataset.baseColor || dataset.borderColor,
      isMajor: Boolean(dataset.isMajorHolding),
      peakValue: Number(dataset.trajectoryPeakValue || 0),
      selectedValue: Number(selectedPoint?.y || 0),
    };
  });
  const major = records
    .filter((record) => record.isMajor)
    .sort((a, b) => b.peakValue - a.peakValue || a.ticker.localeCompare(b.ticker));
  const selected = records
    .filter((record) => record.selectedValue >= HOLDING_TRAJECTORY_MIN_VALUE)
    .sort((a, b) => b.selectedValue - a.selectedValue || a.ticker.localeCompare(b.ticker));
  const combined = [...major];
  const seen = new Set(major.map((record) => record.ticker));
  selected.forEach((record) => {
    if (!seen.has(record.ticker)) {
      combined.push(record);
      seen.add(record.ticker);
    }
  });
  return combined;
}

function holdingLegendItemMarkup(record, featured) {
  const valueLabel = record.selectedValue
    ? `${formatShortDateLabel(state.viewDate)} ${formatCurrency(record.selectedValue)}`
    : `Peak ${formatCurrency(record.peakValue)}`;
  return `<button class="holding-legend-item${featured ? " is-featured" : ""}" type="button" data-holding-ticker="${escapeHtml(record.ticker)}" style="--holding-color: ${escapeHtml(record.color)}" title="${escapeHtml(`${record.ticker} · ${valueLabel}`)}">
    <span class="holding-legend-swatch" aria-hidden="true"></span>
    <span>${escapeHtml(record.ticker)}</span>
  </button>`;
}

function setHoldingFocus(ticker, { force = false } = {}) {
  const chart = state.charts.valueTrendChart;
  if (!chart) {
    return;
  }

  semiIsolateLineLegendLeave(null, null, { chart });
  const nextTicker = !force && ticker && state.holdingFocusTicker === ticker ? "" : ticker;
  state.holdingFocusTicker = nextTicker;
  const relevantTickers = new Set(holdingLegendRecords(chart.data.datasets).map((record) => record.ticker));
  chart.data.datasets.forEach((dataset, index) => {
    chart.setDatasetVisibility(index, nextTicker ? dataset.label === nextTicker : true);
  });
  chart.update("none");
  syncHoldingLegendControls(relevantTickers.size);
}

function syncHoldingLegendControls(total = state.charts.valueTrendChart?.$holdingLegendCount || 0) {
  document.querySelectorAll("[data-holding-ticker]").forEach((item) => {
    item.classList.toggle("is-active", Boolean(state.holdingFocusTicker) && item.dataset.holdingTicker === state.holdingFocusTicker);
    item.classList.toggle("is-muted", Boolean(state.holdingFocusTicker) && item.dataset.holdingTicker !== state.holdingFocusTicker);
  });
  byId("holdingLegendToggleLabel").textContent = state.holdingFocusTicker
    ? `Focused · ${state.holdingFocusTicker}`
    : `${total} holdings`;
  byId("holdingLegendClear").disabled = !state.holdingFocusTicker;
}

function syncHoldingLegendSearch() {
  const query = normalizeText(byId("holdingLegendSearch").value).toUpperCase();
  let visibleCount = 0;
  byId("holdingLegendList").querySelectorAll("[data-holding-ticker]").forEach((item) => {
    const isVisible = !query || item.dataset.holdingTicker.includes(query);
    item.hidden = !isVisible;
    visibleCount += Number(isVisible);
  });
  byId("holdingLegendEmpty").hidden = visibleCount > 0;
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
  } else if (activeTabId() === "analysis") {
    renderAnalysisArchive({ renderCharts: true });
  } else {
    renderAnalysisArchive();
  }
  setStatus(statusText());
  renderIcons();
}

function activeTabId() {
  return document.querySelector(".tab-panel.is-active")?.id || "dashboard";
}

function renderAnalysisArchive({ renderCharts = false } = {}) {
  const reports = [...state.analysisReports].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const selected = reports.find((report) => report.id === state.selectedAnalysisId) || reports[0];
  byId("analysisArchiveCount").textContent = `${reports.length} ${reports.length === 1 ? "report" : "reports"}`;

  byId("analysisArchiveList").innerHTML = reports
    .map((report) => {
      const isActive = report.id === selected?.id;
      return `<button class="analysis-archive-item${isActive ? " is-active" : ""}" type="button" data-analysis-id="${escapeHtml(report.id)}" aria-pressed="${String(isActive)}">
        <span>${escapeHtml(formatDateLabel(report.publishedAt))}</span>
        <strong>${escapeHtml(report.title)}</strong>
        <small>${escapeHtml(report.type || "Portfolio analysis")} · 기준 ${escapeHtml(formatShortDateLabel(report.asOf))}</small>
      </button>`;
    })
    .join("");

  const select = byId("analysisReportSelect");
  select.innerHTML = reports
    .map((report) => `<option value="${escapeHtml(report.id)}">${escapeHtml(`${report.publishedAt} · ${report.title}`)}</option>`)
    .join("");
  select.value = selected?.id || "";

  if (!selected) {
    byId("analysisReportTitle").textContent = "아직 저장된 분석이 없습니다.";
    return;
  }

  state.selectedAnalysisId = selected.id;
  renderAnalysisReport(selected);
  if (renderCharts) {
    afterNextPaint(() => renderAnalysisCharts(selected));
  }
}

function renderAnalysisReport(report) {
  byId("analysisReportDate").textContent = `발행 ${formatDateLabel(report.publishedAt)}`;
  byId("analysisReportAsOf").textContent = `데이터 기준 ${formatDateLabel(report.asOf)}`;
  byId("analysisReportTitle").textContent = report.title;
  byId("analysisReportSubtitle").textContent = report.subtitle;
  byId("analysisReportTags").innerHTML = (report.tags || [])
    .map((tag) => `<span>${escapeHtml(tag)}</span>`)
    .join("");
  byId("analysisVerdictTitle").textContent = report.verdict?.title || "—";
  byId("analysisVerdictCopy").textContent = report.verdict?.copy || "";

  byId("analysisMetricStrip").innerHTML = (report.metrics || [])
    .map((metric) => `<article class="analysis-metric ${analysisToneClass(metric.tone)}">
      <span>${escapeHtml(metric.label)}</span>
      <strong>${escapeHtml(formatAnalysisMetric(metric))}</strong>
      <small>${escapeHtml(metric.note || "")}</small>
    </article>`)
    .join("");

  byId("analysisPhaseTimeline").innerHTML = (report.phases || [])
    .map((phase, index) => `<article class="analysis-phase ${analysisToneClass(phase.tone)}">
      <div class="analysis-phase-index">${String(index + 1).padStart(2, "0")}</div>
      <div class="analysis-phase-copy">
        <span>${escapeHtml(phase.period)}</span>
        <h3>${escapeHtml(phase.title)}</h3>
        <p>${escapeHtml(phase.copy)}</p>
      </div>
      <strong>${escapeHtml(phase.return)}</strong>
    </article>`)
    .join("");

  const allocationTotal = (report.allocation || []).reduce((sum, row) => sum + Number(row.value || 0), 0);
  byId("analysisAllocationMeta").textContent = `${formatCurrency(allocationTotal)} · ${formatDateLabel(report.asOf)}`;
  byId("analysisAllocationList").innerHTML = (report.allocation || [])
    .map((row) => `<div class="analysis-allocation-row">
      <div class="analysis-allocation-label">
        <span class="analysis-allocation-swatch" style="--analysis-color:${escapeHtml(row.color)}"></span>
        <strong>${escapeHtml(row.label)}</strong>
        <small>${escapeHtml(formatCurrency(row.value))}</small>
      </div>
      <div class="analysis-allocation-track" aria-label="${escapeHtml(`${row.label} ${row.share}%`)}">
        <span style="--analysis-width:${Math.max(0, Math.min(Number(row.share || 0), 100))}%;--analysis-color:${escapeHtml(row.color)}"></span>
      </div>
      <b>${Number(row.share || 0).toFixed(1)}%</b>
    </div>`)
    .join("");
  byId("analysisConcentrationNote").innerHTML = `<strong>${escapeHtml(report.concentration?.headline || "")}</strong><p>${escapeHtml(report.concentration?.copy || "")}</p>`;

  byId("analysisReturnShape").innerHTML = (report.returnShape || [])
    .map((row) => `<article class="analysis-return-shape-row ${analysisToneClass(row.tone)}">
      <span>${escapeHtml(row.label)}</span>
      <strong>${escapeHtml(row.value)}</strong>
      <small>${escapeHtml(row.note || "")}</small>
    </article>`)
    .join("");

  renderAnalysisList("analysisStrengths", report.strengths);
  renderAnalysisList("analysisRisks", report.risks);

  const data = report.data || {};
  byId("analysisDataStatus").textContent = data.status || "—";
  byId("analysisDataSummary").textContent = data.summary || "";
  byId("analysisCoverageList").innerHTML = renderAnalysisCoverage(data.coverage || [], data.coverageStart, report.publishedAt);
  byId("analysisRequestList").innerHTML = (data.requests || [])
    .map((request) => `<article class="analysis-request-row">
      <span>${escapeHtml(request.priority)}</span>
      <div><strong>${escapeHtml(request.title)}</strong><p>${escapeHtml(request.copy)}</p></div>
    </article>`)
    .join("");
  byId("analysisPrivacyNote").innerHTML = `<i data-lucide="shield-check"></i><p>${escapeHtml(data.privacy || "")}</p>`;

  byId("analysisNextActions").innerHTML = (report.nextActions || [])
    .map((action) => `<li><span>${escapeHtml(action)}</span></li>`)
    .join("");
  renderIcons();
}

function renderAnalysisList(id, items = []) {
  byId(id).innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderAnalysisCoverage(rows, rangeStart, rangeEnd) {
  const startTime = Date.parse(`${rangeStart || rangeEnd}T00:00:00Z`);
  const endTime = Date.parse(`${rangeEnd}T00:00:00Z`);
  const duration = Math.max(endTime - startTime, 1);
  return rows
    .map((row) => {
      const fromTime = Math.max(Date.parse(`${row.from}T00:00:00Z`), startTime);
      const toTime = Math.min(Date.parse(`${row.to}T00:00:00Z`), endTime);
      const left = Math.max(0, Math.min(((fromTime - startTime) / duration) * 100, 100));
      const width = Math.max(2, Math.min(((toTime - fromTime) / duration) * 100, 100 - left));
      return `<div class="analysis-coverage-row ${analysisToneClass(row.tone)}">
        <div class="analysis-coverage-copy"><strong>${escapeHtml(row.account)}</strong><span>${escapeHtml(row.status)}</span></div>
        <div class="analysis-coverage-track"><span style="--coverage-left:${left.toFixed(2)}%;--coverage-width:${width.toFixed(2)}%"></span></div>
        <small>${escapeHtml(row.from)} → ${escapeHtml(row.to)}</small>
      </div>`;
    })
    .join("");
}

function analysisToneClass(tone) {
  return ["accent", "positive", "negative", "complete", "partial", "gap"].includes(tone) ? `is-${tone}` : "";
}

function formatAnalysisMetric(metric) {
  if (metric.format === "currency") {
    return formatCurrency(metric.value);
  }
  if (metric.format === "percent") {
    return formatSignedPercent(Number(metric.value));
  }
  return String(metric.value ?? "—");
}

function renderAnalysisCharts(report) {
  renderAnalysisAnnualReturnChart(report);
  renderAnalysisAllocationHistoryChart(report);
}

function renderAnalysisAnnualReturnChart(report) {
  const rows = state.investmentReturns.filter((row) => row.periodEnd <= report.asOf);
  const grouped = new Map();
  rows.forEach((row) => {
    const year = row.periodStart.slice(0, 4);
    if (!grouped.has(year)) {
      grouped.set(year, []);
    }
    grouped.get(year).push(row.monthlyReturn);
  });
  const annual = [...grouped.entries()].map(([year, returns]) => ({
    year,
    months: returns.length,
    value: (returns.reduce((factor, value) => factor * (1 + value), 1) - 1) * 100,
  }));
  byId("analysisReturnMeta").textContent = annual.length
    ? `${annual[0].year}–${annual.at(-1).year} · 첫해와 마지막해는 부분기간`
    : "수익 데이터 없음";

  replaceChart("analysisAnnualReturnChart", {
    type: "bar",
    data: {
      labels: annual.map((row) => row.year),
      datasets: [{
        label: "연간 수익률",
        data: annual.map((row) => row.value),
        backgroundColor: annual.map((row) => row.value >= 0 ? "rgba(143, 221, 160, 0.78)" : "rgba(248, 154, 154, 0.76)"),
        borderColor: annual.map((row) => row.value >= 0 ? "#8fdda0" : "#f89a9a"),
        borderWidth: 1,
        borderRadius: 5,
        maxBarThickness: 46,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 420, easing: "easeOutCubic" },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `${annual[items[0].dataIndex].year}년 · ${annual[items[0].dataIndex].months}개월`,
            label: (item) => `순수 투자수익 ${formatSignedPercent(Number(item.raw))}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#b3bdc9", font: { size: 13, weight: 600 } } },
        y: {
          grace: "8%",
          grid: { color: (context) => Number(context.tick.value) === 0 ? "rgba(218, 230, 224, 0.28)" : "rgba(218, 230, 224, 0.07)" },
          ticks: { color: "#b3bdc9", font: { size: 12, weight: 600 }, callback: (value) => `${value}%` },
        },
      },
    },
  });
}

function renderAnalysisAllocationHistoryChart(report) {
  const eligible = state.holdings.filter((row) => row.Date <= report.asOf);
  const latestDateByYear = new Map();
  eligible.forEach((row) => {
    const year = row.Date.slice(0, 4);
    if (!latestDateByYear.has(year) || row.Date > latestDateByYear.get(year)) {
      latestDateByYear.set(year, row.Date);
    }
  });
  const snapshots = [...latestDateByYear.entries()].map(([year, date]) => {
    const rows = eligible.filter((row) => row.Date === date);
    const total = sumRows(rows) || 1;
    const groups = { cash: 0, dividend: 0, general: 0, speculative: 0, other: 0 };
    rows.forEach((row) => {
      const assetType = row["Asset Type"];
      if ([CASH_ASSET_TYPE, "비상금", "소비"].includes(assetType)) {
        groups.cash += Number(row.Volume || 0);
      } else if (assetType === "배당주") {
        groups.dividend += Number(row.Volume || 0);
      } else if (assetType === "일반 투자") {
        groups.general += Number(row.Volume || 0);
      } else if (["공격형 투자", "미래기술 투자"].includes(assetType)) {
        groups.speculative += Number(row.Volume || 0);
      } else {
        groups.other += Number(row.Volume || 0);
      }
    });
    Object.keys(groups).forEach((key) => { groups[key] = (groups[key] / total) * 100; });
    return { year, date, groups };
  });
  const buckets = [
    ["cash", "현금성", "#8fb7ff"],
    ["dividend", "배당주", "#8fdda0"],
    ["general", "일반 투자", "#bea7ff"],
    ["speculative", "고위험·미래기술", "#f89a9a"],
    ["other", "기타", "#f4d66d"],
  ];

  replaceChart("analysisAllocationHistoryChart", {
    type: "bar",
    data: {
      labels: snapshots.map((row) => row.year),
      datasets: buckets.map(([key, label, color]) => ({
        label,
        data: snapshots.map((row) => row.groups[key]),
        backgroundColor: color,
        borderColor: "rgba(9, 11, 16, 0.72)",
        borderWidth: 1,
        borderRadius: 2,
        barPercentage: 0.72,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 420, easing: "easeOutCubic" },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "bottom",
          labels: { boxWidth: 9, boxHeight: 9, color: "#d0d7e0", usePointStyle: true, padding: 14, font: { size: 13, weight: 650 } },
        },
        tooltip: {
          callbacks: {
            title: (items) => `${snapshots[items[0].dataIndex].year}년 · ${formatShortDateLabel(snapshots[items[0].dataIndex].date)}`,
            label: (item) => `${item.dataset.label}: ${Number(item.raw).toFixed(1)}%`,
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: "#b3bdc9", font: { size: 13, weight: 600 } } },
        y: { stacked: true, min: 0, max: 100, grid: { color: "rgba(218, 230, 224, 0.07)" }, ticks: { color: "#b3bdc9", font: { size: 12, weight: 600 }, callback: (value) => `${value}%` } },
      },
    },
  });
}

function afterNextPaint(callback) {
  requestAnimationFrame(() => {
    requestAnimationFrame(callback);
  });
}

function syncDateControls() {
  const currentIndex = Math.max(state.dates.indexOf(state.viewDate), 0);
  const activeYear = state.viewDate.slice(0, 4);
  const years = unique(state.dates.map((date) => date.slice(0, 4)));
  const datesInYear = state.dates.filter((date) => date.startsWith(`${activeYear}-`));

  byId("timelinePosition").textContent = state.dates.length
    ? `Snapshot ${currentIndex + 1} of ${state.dates.length}`
    : "No snapshots available";
  byId("activeSnapshotLabel").textContent = state.viewDate ? formatDateLabel(state.viewDate) : "No snapshot";
  byId("previousSnapshotBtn").disabled = !state.dates.length || currentIndex === 0;
  byId("nextSnapshotBtn").disabled = !state.dates.length || currentIndex === state.dates.length - 1;
  byId("latestSnapshotBtn").disabled = !state.dates.length || currentIndex === state.dates.length - 1;

  const yearSelect = byId("snapshotYearSelect");
  yearSelect.innerHTML = years.map((year) => `<option value="${year}">${year}</option>`).join("");
  yearSelect.value = activeYear;
  yearSelect.disabled = years.length <= 1;

  const monthSelect = byId("snapshotMonthSelect");
  monthSelect.innerHTML = datesInYear.map((date) => `<option value="${date}">${snapshotOptionLabel(date)}</option>`).join("");
  monthSelect.value = state.viewDate;
  monthSelect.disabled = datesInYear.length <= 1;
}

function snapshotOptionLabel(date) {
  const parsedDate = new Date(`${date}T00:00:00Z`);
  const month = parsedDate.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const day = String(parsedDate.getUTCDate()).padStart(2, "0");
  return `${month} ${day}`;
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
  byId("investedCapitalReadout").textContent = formatCurrency(investmentTotal);
  byId("investedShareMeta").textContent = `${investmentPercent}% of net worth`;
  byId("metricCash").textContent = formatCurrency(cashTotal);
  byId("metricCashPercent").textContent = `${cashPercent}% available outside tickers`;
  byId("metricChangeLabel").textContent = previousDate ? `Since ${formatShortDateLabel(previousDate)}` : "Since prior snapshot";
  byId("metricChange").textContent = previousDate ? formatSignedCurrency(totalChange) : "—";
  byId("metricChangePercent").textContent = previousDate ? `${formatSignedPercent(totalChangePercent)} portfolio change` : "First available snapshot";
  byId("metricChange").classList.toggle("is-positive", totalChange > 0);
  byId("metricChange").classList.toggle("is-negative", totalChange < 0);

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
  const currentDetailsByKey = new Map(details.map((detail) => [assetDistributionDetailKey(detail), detail]));
  const chartDetails = buildAssetDistributionSegments(state.holdings).details
    .sort((a, b) => a.parentIndex - b.parentIndex || a.firstDate.localeCompare(b.firstDate) || a.label.localeCompare(b.label))
    .map((domainDetail) => {
      const currentDetail = currentDetailsByKey.get(assetDistributionDetailKey(domainDetail));
      return currentDetail
        ? { ...currentDetail, color: domainDetail.color, borderColor: domainDetail.borderColor, firstDate: domainDetail.firstDate }
        : { ...domainDetail, value: 0 };
    });
  const labels = chartDetails.map((detail) => detail.label);

  byId(centerId).innerHTML = `<strong>${formatCurrency(total)}</strong><span>Total portfolio</span>`;
  byId(metaId).textContent = `${parents.length} classes · ${details.length} positions`;

  updateDoughnutChart(chartId, {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          label: "Asset detail",
          data: chartDetails.map((detail) => detail.value),
          backgroundColor: chartDetails.map((detail) => detail.color),
          borderColor: chartDetails.map((detail) => detail.borderColor),
          borderWidth: 1.5,
          hoverOffset: 8,
          assetDistributionKind: "detail",
          assetDistributionRecords: chartDetails,
          doughnutKeys: chartDetails.map(assetDistributionDetailKey),
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
          firstDate: detailRows.reduce((firstDate, row) => (!firstDate || row.Date < firstDate ? row.Date : firstDate), ""),
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

function assetDistributionDetailKey(detail) {
  return JSON.stringify([detail.parentLabel, detail.kind, detail.label]);
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
  return (chart) =>
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
      assetDistributionDetailIndexes: (chart.data.datasets[0].assetDistributionRecords || [])
        .map((detail, detailIndex) =>
          detail?.parentLabel === parent.label && Number(chart.data.datasets[0].data[detailIndex]) > 0 ? detailIndex : -1
        )
        .filter((detailIndex) => detailIndex >= 0),
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

  updateDoughnutChart(chartId, {
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
          doughnutKeys: labels,
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
  const actualAssetDataset = buildLineDataset("Net worth", allPoints, "#c7b8ff", { areaFill: true, borderWidth: 2.1 });
  const investmentDataset = buildLineDataset("Invested capital", investmentPoints, "#8fdda0", { areaFill: true, borderWidth: 2 });
  const capitalBaselineDataset = buildLineDataset("Capital baseline", capitalBaseline.points, "#8f9bab", { borderWidth: 1.5 });
  actualAssetDataset.snapshotSelectable = true;
  investmentDataset.snapshotSelectable = true;
  capitalBaselineDataset.borderDash = [7, 6];
  capitalBaselineDataset.pointRadius = 0;
  capitalBaselineDataset.pointHoverRadius = 4;
  capitalBaselineDataset.pointBorderWidth = 0;

  replaceChart(
    "assetTrendChart",
    lineChartConfig(timeline, capitalBaseline.points.length
      ? [actualAssetDataset, investmentDataset, capitalBaselineDataset]
      : [actualAssetDataset, investmentDataset], {
      interactionMode: "nearest",
      legendClickMode: "visibilityOnly",
      snapshotNavigation: true,
      snapshotPointDatasetLabel: "Net worth",
      zoomPan: true,
    }),
  );

  const tickerGroups = groupRows(state.holdings.filter((row) => row.Ticker), "Ticker");
  const trajectoryCandidates = [...tickerGroups.entries()]
    .map(([ticker, tickerRows]) => {
      const points = pointsFromRows(tickerRows);
      return {
        ticker,
        points,
        qualifyingPointCount: points.filter((point) => point.value >= HOLDING_TRAJECTORY_MIN_VALUE).length,
        peakValue: points.reduce((peak, point) => Math.max(peak, point.value), 0),
      };
    })
    .filter((record) => record.points.length)
    .sort((a, b) => b.peakValue - a.peakValue || a.ticker.localeCompare(b.ticker));
  const majorTickers = new Set(
    trajectoryCandidates
      .filter((record) => record.qualifyingPointCount >= HOLDING_TRAJECTORY_MIN_OBSERVATIONS)
      .slice(0, HOLDING_TRAJECTORY_MAJOR_COUNT)
      .map((record) => record.ticker),
  );
  const validRangeDates = trajectoryCandidates.flatMap((record) => record.points.map((point) => point.date));
  const holdingTimeline = buildTimeline(validRangeDates.length ? validRangeDates : state.dates);
  const tickerDatasets = trajectoryCandidates.map((record, index) => {
    const color = colorFor("ticker", record.ticker, index);
    const isMeaningfulSeries = record.qualifyingPointCount >= HOLDING_TRAJECTORY_MIN_OBSERVATIONS;
    const normalPointRadius = window.innerWidth < 720 ? 2 : 2.5;
    const showPointMarker = (context) => isMeaningfulSeries
      && Number(context.raw?.y) >= HOLDING_TRAJECTORY_MIN_VALUE;
    const dataset = buildLineDataset(record.ticker, record.points, color, {
      pointRadius: (context) => showPointMarker(context) ? normalPointRadius : 0,
      pointHoverRadius: (context) => showPointMarker(context) ? 5 : 0,
      pointHitRadius: 7,
    });
    dataset.preservePointFiltering = true;
    dataset.isMajorHolding = majorTickers.has(record.ticker);
    dataset.trajectoryPeakValue = record.peakValue;
    dataset.trajectoryObservationCount = record.points.length;
    return dataset;
  });

  replaceChart(
    "valueTrendChart",
    lineChartConfig(holdingTimeline, tickerDatasets, { showLegend: false, snapshotNavigation: true, zoomPan: true }),
  );
  renderHoldingLegend(tickerDatasets);
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
  const cumulativeNode = byId("cumulativeReturn");

  cumulativeNode.textContent = formatSignedPercent(cumulativePercent);
  cumulativeNode.classList.toggle("is-positive", cumulativePercent > 0);
  cumulativeNode.classList.toggle("is-negative", cumulativePercent < 0);
  byId("annualizedReturn").textContent = `${formatSignedPercent(annualizedPercent)} annualized · since ${formatShortDateLabel(rows[0].periodStart)}`;
  const returnXScale = (dateKey) => ({
    grid: { display: false },
    ticks: {
      color: "#82909f",
      autoSkip: true,
      maxTicksLimit: window.innerWidth < 720 ? 6 : 12,
      maxRotation: 0,
      padding: 8,
      font: { size: window.innerWidth < 720 ? 9 : 10, weight: 600 },
      callback: (value, index) => monthYearAxisLabel(rows[Number(value)]?.[dateKey] || rows[index]?.[dateKey]),
    },
  });

  const config = {
    type: "bar",
    data: {
      labels: rows.map((row) => row.periodEnd),
      datasets: [
        {
          label: "Monthly return",
          order: 2,
          yAxisID: "yMonthly",
          data: rows.map((row) => row.monthlyReturn * 100),
          backgroundColor: rows.map((row) =>
            row.monthlyReturn >= 0 ? "rgba(143, 221, 160, 0.68)" : "rgba(248, 154, 154, 0.68)"
          ),
          borderWidth: 0,
          borderRadius: 2,
          barPercentage: 0.82,
          categoryPercentage: 0.88,
          maxBarThickness: 18,
        },
        {
          type: "line",
          label: "Cumulative return",
          order: 1,
          yAxisID: "yCumulative",
          data: rows.map((row) => row.cumulativeReturn * 100),
          borderColor: "#c7b8ff",
          backgroundColor: "#c7b8ff",
          pointRadius: 0,
          pointHoverRadius: 4,
          pointBackgroundColor: "#c7b8ff",
          borderWidth: 2.3,
          fill: false,
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
        legend: {
          position: "bottom",
          labels: {
            boxWidth: 8,
            boxHeight: 8,
            color: "#b9c3d0",
            usePointStyle: true,
            padding: 16,
            font: { size: window.innerWidth < 720 ? 11 : 12, weight: 600 },
          },
        },
        tooltip: {
          backgroundColor: "rgba(10, 13, 18, 0.96)",
          borderColor: "rgba(218, 230, 224, 0.16)",
          borderWidth: 1,
          callbacks: {
            title: (items) => formatDateLabel(rows[items[0].dataIndex].periodEnd),
            label: (item) => `${item.dataset.label}: ${formatSignedPercent(Number(item.raw))}`,
          },
        },
      },
      scales: {
        x: returnXScale("periodEnd"),
        yCumulative: {
          position: "right",
          grace: "6%",
          grid: {
            color: (context) => (Number(context.tick.value) === 0 ? "rgba(199, 184, 255, 0.42)" : "rgba(218, 230, 224, 0.07)"),
            lineWidth: (context) => (Number(context.tick.value) === 0 ? 1.5 : 1),
          },
          title: { display: true, text: "Cumulative", color: "#9f94d1", font: { size: 10, weight: 700 } },
          ticks: { color: "#9f94d1", font: { size: window.innerWidth < 720 ? 9 : 10, weight: 600 }, callback: (value) => `${value}%` },
        },
        yMonthly: {
          position: "left",
          grace: "8%",
          grid: {
            drawOnChartArea: true,
            color: (context) => (Number(context.tick.value) === 0 ? "rgba(143, 221, 160, 0.32)" : "rgba(0, 0, 0, 0)"),
            lineWidth: (context) => (Number(context.tick.value) === 0 ? 1.4 : 0),
          },
          title: { display: true, text: "Monthly", color: "#79b987", font: { size: 10, weight: 700 } },
          ticks: { color: "#79b987", font: { size: window.innerWidth < 720 ? 9 : 10, weight: 600 }, callback: (value) => `${value}%` },
        },
      },
    },
  };
  applySnapshotNavigation(config, { scaleMode: "category" });
  replaceChart("investmentReturnChart", config);
}

function lineChartConfig(timeline, datasets, {
  interactionMode = "nearest",
  legendClickMode = "default",
  legendHoverMode = "default",
  lockYAxisToAllData = false,
  showLegend = true,
  snapshotNavigation = false,
  snapshotPointDatasetLabel = "",
  zoomPan = false,
} = {}) {
  const compactChart = window.innerWidth < 720;
  const lockedYAxisBounds = lockYAxisToAllData ? lineChartYAxisBounds(datasets) : null;
  const legendOptions = showLegend
    ? {
        position: "bottom",
        labels: {
          boxWidth: 8,
          boxHeight: 8,
          color: "#b9c3d0",
          usePointStyle: true,
          padding: compactChart ? 8 : 12,
          font: { size: compactChart ? 11 : 12, weight: 600 },
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

  if (showLegend && legendClickMode === "visibilityOnly") {
    legendOptions.onClick = visibilityOnlyLegendClick;
  }

  if (showLegend && legendHoverMode === "semiIsolate") {
    legendOptions.onHover = semiIsolateLineLegendHover;
    legendOptions.onLeave = semiIsolateLineLegendLeave;
  }

  const config = {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: interactionMode, axis: "x", intersect: false },
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
            scale.ticks = timeline.months
              .filter((month) => month.day >= scale.min && month.day <= scale.max)
              .map((month) => ({ value: month.day }));
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
          ...(lockedYAxisBounds || {}),
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

  if (snapshotNavigation) {
    applySnapshotNavigation(config, { pointDatasetLabel: snapshotPointDatasetLabel });
  }
  if (zoomPan) {
    applyLineZoomPan(config, { fullMin: timeline.min, fullMax: timeline.max });
  }

  return config;
}

function applySnapshotNavigation(config, { scaleMode = "linear", pointDatasetLabel = "" } = {}) {
  config.plugins = [...(config.plugins || []), snapshotScrubberPlugin, snapshotCursorPlugin];
  config.options.plugins.snapshotCursor = { enabled: true, scaleMode, pointDatasetLabel };
  config.options.plugins.snapshotScrubber = { enabled: true, scaleMode };
  config.options.layout = {
    ...(config.options.layout || {}),
    padding: { ...(config.options.layout?.padding || {}), top: 30 },
  };
  config.options.onClick = (event, _elements, chart) => {
    if (!chartEventInsideChartArea(chart, event)) {
      return;
    }
    const date = snapshotDateForPixel(chart, Number(event.x), scaleMode);
    if (date) {
      selectDashboardSnapshot(date);
    }
  };
  config.options.onHover = (event, _elements, chart) => {
    if (chart.$snapshotScrubber?.active || chart.$lineZoomPan?.active) {
      return;
    }
    const canPanAxis = lineZoomIsActive(chart) && chartEventInsideXAxis(chart, event);
    chart.canvas.style.cursor = canPanAxis || chartEventInsideChartArea(chart, event) ? "grab" : "default";
  };
  return config;
}

function applyLineZoomPan(config, { fullMin, fullMax }) {
  config.plugins = [...(config.plugins || []), lineZoomPanPlugin];
  config.options.plugins.lineZoomPan = { enabled: true, fullMin, fullMax };
  return config;
}

function chartEventInsideChartArea(chart, event) {
  const pointerX = Number(event.x);
  const pointerY = Number(event.y);
  if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) {
    return false;
  }

  const { chartArea } = chart;
  return Boolean(
    chartArea &&
      pointerX >= chartArea.left &&
      pointerX <= chartArea.right &&
      pointerY >= chartArea.top &&
      pointerY <= chartArea.bottom
  );
}

function chartEventInsideXAxis(chart, event) {
  const pointerX = Number(event.x);
  const pointerY = Number(event.y);
  return pointInsideXAxis(chart, { x: pointerX, y: pointerY });
}

const lineZoomPanPlugin = {
  id: "lineZoomPan",
  afterInit(chart, _args, options) {
    if (!options?.enabled) {
      return;
    }

    const fullMin = Number(options.fullMin);
    const fullMax = Number(options.fullMax);
    if (!Number.isFinite(fullMin) || !Number.isFinite(fullMax) || fullMax <= fullMin) {
      return;
    }

    const zoom = {
      active: false,
      fullMin,
      fullMax,
      pointerId: null,
      startX: 0,
      startMin: fullMin,
      startMax: fullMax,
    };

    const handleWheel = (event) => {
      const point = chartPointerPosition(chart, event);
      if (!pointInsideZoomSurface(chart, point) || !chart.scales.x || !event.deltaY) {
        return;
      }

      event.preventDefault();
      const currentMin = Number(chart.scales.x.min);
      const currentMax = Number(chart.scales.x.max);
      const currentSpan = currentMax - currentMin;
      const fullSpan = zoom.fullMax - zoom.fullMin;
      if (!Number.isFinite(currentSpan) || currentSpan <= 0) {
        return;
      }

      const deltaUnit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? chart.height : 1;
      const zoomFactor = Math.min(Math.max(Math.exp(event.deltaY * deltaUnit * LINE_ZOOM_WHEEL_SPEED), 0.72), 1.38);
      const minimumSpan = Math.min(fullSpan, Math.max(LINE_ZOOM_MIN_WINDOW_DAYS, fullSpan / 48));
      const nextSpan = Math.min(fullSpan, Math.max(minimumSpan, currentSpan * zoomFactor));
      const anchor = Number(chart.scales.x.getValueForPixel(point.x));
      const anchorRatio = Number.isFinite(anchor) ? (anchor - currentMin) / currentSpan : 0.5;
      const nextMin = (Number.isFinite(anchor) ? anchor : (currentMin + currentMax) / 2) - nextSpan * anchorRatio;
      setLineZoomWindow(chart, zoom, nextMin, nextMin + nextSpan);
    };

    const handlePointerDown = (event) => {
      if ((event.pointerType === "mouse" && event.button !== 0) || !lineZoomIsActive(chart)) {
        return;
      }
      const point = chartPointerPosition(chart, event);
      if (!pointInsideXAxis(chart, point)) {
        return;
      }

      zoom.active = true;
      zoom.pointerId = event.pointerId;
      zoom.startX = point.x;
      zoom.startMin = Number(chart.scales.x.min);
      zoom.startMax = Number(chart.scales.x.max);
      chart.canvas.style.cursor = "grabbing";
      chart.canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };

    const handlePointerMove = (event) => {
      if (!zoom.active || event.pointerId !== zoom.pointerId) {
        return;
      }
      const point = chartPointerPosition(chart, event);
      const plotWidth = Math.max(chart.chartArea?.right - chart.chartArea?.left, 1);
      const span = zoom.startMax - zoom.startMin;
      const shift = -((point.x - zoom.startX) / plotWidth) * span;
      setLineZoomWindow(chart, zoom, zoom.startMin + shift, zoom.startMax + shift);
      event.preventDefault();
    };

    const finishPan = (event) => {
      if (!zoom.active || event.pointerId !== zoom.pointerId) {
        return;
      }
      zoom.active = false;
      zoom.pointerId = null;
      if (chart.canvas.hasPointerCapture?.(event.pointerId)) {
        chart.canvas.releasePointerCapture(event.pointerId);
      }
      const point = chartPointerPosition(chart, event);
      chart.canvas.style.cursor = lineZoomIsActive(chart) && pointInsideXAxis(chart, point) ? "grab" : "default";
      event.preventDefault();
    };

    zoom.handlers = { handleWheel, handlePointerDown, handlePointerMove, finishPan };
    chart.$lineZoomPan = zoom;
    chart.canvas.addEventListener("wheel", handleWheel, { passive: false });
    chart.canvas.addEventListener("pointerdown", handlePointerDown);
    chart.canvas.addEventListener("pointermove", handlePointerMove);
    chart.canvas.addEventListener("pointerup", finishPan);
    chart.canvas.addEventListener("pointercancel", finishPan);
  },
  beforeUpdate(chart, _args, options) {
    if (!options?.enabled || !chart.$lineZoomPan) {
      return;
    }
    const min = Number(chart.options.scales.x.min ?? chart.$lineZoomPan.fullMin);
    const max = Number(chart.options.scales.x.max ?? chart.$lineZoomPan.fullMax);
    const bounds = visibleLineYAxisBounds(chart, min, max);
    if (bounds) {
      chart.options.scales.y.min = bounds.min;
      chart.options.scales.y.max = bounds.max;
    }
  },
  beforeDestroy(chart) {
    const zoom = chart.$lineZoomPan;
    if (!zoom) {
      return;
    }
    chart.canvas.removeEventListener("wheel", zoom.handlers.handleWheel);
    chart.canvas.removeEventListener("pointerdown", zoom.handlers.handlePointerDown);
    chart.canvas.removeEventListener("pointermove", zoom.handlers.handlePointerMove);
    chart.canvas.removeEventListener("pointerup", zoom.handlers.finishPan);
    chart.canvas.removeEventListener("pointercancel", zoom.handlers.finishPan);
    delete chart.$lineZoomPan;
  },
};

function setLineZoomWindow(chart, zoom, rawMin, rawMax) {
  const fullSpan = zoom.fullMax - zoom.fullMin;
  let span = Math.min(Math.max(rawMax - rawMin, 1), fullSpan);
  let min = rawMin;
  if (span >= fullSpan - 0.5) {
    min = zoom.fullMin;
    span = fullSpan;
  } else {
    min = Math.min(Math.max(min, zoom.fullMin), zoom.fullMax - span);
  }
  chart.options.scales.x.min = min;
  chart.options.scales.x.max = min + span;
  chart.update("none");
}

function lineZoomIsActive(chart) {
  const zoom = chart.$lineZoomPan;
  if (!zoom || !chart.scales.x) {
    return false;
  }
  return Number(chart.scales.x.max) - Number(chart.scales.x.min) < zoom.fullMax - zoom.fullMin - 0.5;
}

function pointInsideZoomSurface(chart, point) {
  const { chartArea } = chart;
  const xScale = chart.scales.x;
  return Boolean(
    chartArea &&
      xScale &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x >= chartArea.left &&
      point.x <= chartArea.right &&
      point.y >= chartArea.top &&
      point.y <= xScale.bottom
  );
}

function pointInsideXAxis(chart, point) {
  const { chartArea } = chart;
  const xScale = chart.scales.x;
  return Boolean(
    chartArea &&
      xScale &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x >= chartArea.left &&
      point.x <= chartArea.right &&
      point.y >= xScale.top &&
      point.y <= xScale.bottom
  );
}

const snapshotScrubberPlugin = {
  id: "snapshotScrubber",
  afterInit(chart, _args, options) {
    if (!options?.enabled) {
      return;
    }

    const scrubber = {
      active: false,
      frame: 0,
      pendingDate: "",
      pointerId: null,
    };

    const selectPendingDate = () => {
      scrubber.frame = 0;
      if (scrubber.pendingDate) {
        const date = scrubber.pendingDate;
        scrubber.pendingDate = "";
        selectDashboardSnapshot(date);
      }
    };

    const queuePointerDate = (event) => {
      scrubber.pendingDate = snapshotDateForPointer(chart, event, options.scaleMode);
      if (scrubber.pendingDate && !scrubber.frame) {
        scrubber.frame = requestAnimationFrame(selectPendingDate);
      }
    };

    const handlePointerDown = (event) => {
      if ((event.pointerType === "mouse" && event.button !== 0) || !pointerInsideChartArea(chart, event)) {
        return;
      }
      scrubber.active = true;
      scrubber.pointerId = event.pointerId;
      chart.canvas.style.cursor = "grabbing";
      chart.canvas.setPointerCapture?.(event.pointerId);
      queuePointerDate(event);
      event.preventDefault();
    };

    const handlePointerMove = (event) => {
      if (!scrubber.active || event.pointerId !== scrubber.pointerId) {
        return;
      }
      queuePointerDate(event);
      event.preventDefault();
    };

    const finishScrub = (event) => {
      if (!scrubber.active || event.pointerId !== scrubber.pointerId) {
        return;
      }
      queuePointerDate(event);
      cancelAnimationFrame(scrubber.frame);
      scrubber.frame = 0;
      selectPendingDate();
      scrubber.active = false;
      scrubber.pointerId = null;
      chart.canvas.style.cursor = pointerInsideChartArea(chart, event) ? "grab" : "default";
      if (chart.canvas.hasPointerCapture?.(event.pointerId)) {
        chart.canvas.releasePointerCapture(event.pointerId);
      }
    };

    scrubber.handlers = { handlePointerDown, handlePointerMove, finishScrub };
    chart.$snapshotScrubber = scrubber;
    chart.canvas.addEventListener("pointerdown", handlePointerDown);
    chart.canvas.addEventListener("pointermove", handlePointerMove);
    chart.canvas.addEventListener("pointerup", finishScrub);
    chart.canvas.addEventListener("pointercancel", finishScrub);
  },
  beforeDestroy(chart) {
    const scrubber = chart.$snapshotScrubber;
    if (!scrubber) {
      return;
    }
    cancelAnimationFrame(scrubber.frame);
    chart.canvas.removeEventListener("pointerdown", scrubber.handlers.handlePointerDown);
    chart.canvas.removeEventListener("pointermove", scrubber.handlers.handlePointerMove);
    chart.canvas.removeEventListener("pointerup", scrubber.handlers.finishScrub);
    chart.canvas.removeEventListener("pointercancel", scrubber.handlers.finishScrub);
    delete chart.$snapshotScrubber;
  },
};

function pointerInsideChartArea(chart, event) {
  const point = chartPointerPosition(chart, event);
  const { chartArea } = chart;
  return Boolean(
    chartArea &&
      point.x >= chartArea.left &&
      point.x <= chartArea.right &&
      point.y >= chartArea.top &&
      point.y <= chartArea.bottom
  );
}

function snapshotDateForPointer(chart, event, scaleMode = "linear") {
  if (!state.dates.length || !chart.chartArea) {
    return "";
  }
  const point = chartPointerPosition(chart, event);
  return snapshotDateForPixel(chart, point.x, scaleMode);
}

function snapshotDateForPixel(chart, pointerX, scaleMode = "linear") {
  if (!state.dates.length || !chart.chartArea || !Number.isFinite(pointerX)) {
    return "";
  }
  const pixelX = Math.min(Math.max(pointerX, chart.chartArea.left), chart.chartArea.right);
  let targetDay = Number(chart.scales.x.getValueForPixel(pixelX));
  if (scaleMode === "category") {
    const labels = chart.data.labels || [];
    const index = Math.min(Math.max(Math.round(targetDay), 0), Math.max(labels.length - 1, 0));
    targetDay = dateToDay(labels[index]);
  }
  if (!Number.isFinite(targetDay)) {
    return "";
  }
  return state.dates.reduce((nearestDate, date) =>
    Math.abs(dateToDay(date) - targetDay) < Math.abs(dateToDay(nearestDate) - targetDay) ? date : nearestDate
  );
}

function chartPointerPosition(chart, event) {
  const bounds = chart.canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * chart.width,
    y: ((event.clientY - bounds.top) / bounds.height) * chart.height,
  };
}

const snapshotCursorPlugin = {
  id: "snapshotCursor",
  afterDatasetsDraw(chart, _args, options) {
    if (!options?.enabled || !state.viewDate) {
      return;
    }

    const position = snapshotCursorPosition(chart, options);
    if (!position) {
      return;
    }

    const { ctx, chartArea } = chart;
    const { x: pointX, y: pointY, datasetIndex } = position;
    const label = formatDateLabel(state.viewDate);
    ctx.save();
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = "rgba(183, 237, 120, 0.38)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pointX, chartArea.top);
    ctx.lineTo(pointX, chartArea.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    if (datasetIndex >= 0 && Number.isFinite(pointY) && chart.isDatasetVisible(datasetIndex)) {
      ctx.fillStyle = "#b7ed78";
      ctx.strokeStyle = "#11151c";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(pointX, pointY, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.font = "700 10px Inter, ui-sans-serif, system-ui, sans-serif";
    const labelWidth = Math.ceil(ctx.measureText(label).width) + 16;
    const labelHeight = 24;
    const labelX = Math.min(Math.max(pointX - labelWidth / 2, chartArea.left), chartArea.right - labelWidth);
    const labelY = chartArea.top - labelHeight - 4;
    ctx.fillStyle = "rgba(15, 20, 20, 0.96)";
    ctx.strokeStyle = "rgba(183, 237, 120, 0.58)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(labelX, labelY, labelWidth, labelHeight, 7);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#d2ff9d";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, labelX + labelWidth / 2, labelY + labelHeight / 2);
    ctx.restore();
  },
};

function snapshotCursorPosition(chart, options) {
  const { chartArea } = chart;
  if (!chartArea) {
    return null;
  }

  if (options.scaleMode === "category") {
    const labels = chart.data.labels || [];
    if (!labels.length) {
      return null;
    }
    const targetDay = dateToDay(state.viewDate);
    const index = labels.reduce((nearestIndex, label, labelIndex) =>
      Math.abs(dateToDay(label) - targetDay) < Math.abs(dateToDay(labels[nearestIndex]) - targetDay)
        ? labelIndex
        : nearestIndex
    , 0);
    const x = chart.scales.x.getPixelForValue(index);
    return Number.isFinite(x) && x >= chartArea.left && x <= chartArea.right
      ? { x, y: null, datasetIndex: -1 }
      : null;
  }

  const datasetIndex = options.pointDatasetLabel
    ? chart.data.datasets.findIndex((dataset) => dataset.label === options.pointDatasetLabel)
    : -1;
  const dataset = chart.data.datasets[datasetIndex];
  const selectedPoint = dataset?.data?.find((point) => point.date === state.viewDate);
  const xValue = selectedPoint?.x ?? dateToDay(state.viewDate);
  const x = chart.scales.x.getPixelForValue(xValue);
  if (!Number.isFinite(x) || x < chartArea.left || x > chartArea.right) {
    return null;
  }
  return {
    x,
    y: selectedPoint ? chart.scales.y.getPixelForValue(selectedPoint.y) : null,
    datasetIndex: selectedPoint ? datasetIndex : -1,
  };
}

function lineChartYAxisBounds(datasets) {
  const values = datasets.flatMap((dataset) => dataset.data || []).map((point) => Number(point?.y)).filter(Number.isFinite);
  return lineYAxisBoundsFromValues(values);
}

function visibleLineYAxisBounds(chart, minX, maxX) {
  const values = [];
  chart.data.datasets.forEach((dataset, datasetIndex) => {
    if (!chart.isDatasetVisible(datasetIndex)) {
      return;
    }
    const points = (dataset.data || []).filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)));
    points.forEach((point) => {
      if (point.x >= minX && point.x <= maxX) {
        values.push(Number(point.y));
      }
    });
    [minX, maxX].forEach((boundary) => {
      const value = interpolatedLineValue(points, boundary);
      if (Number.isFinite(value)) {
        values.push(value);
      }
    });
  });
  return lineYAxisBoundsFromValues(values);
}

function interpolatedLineValue(points, targetX) {
  if (!points.length || targetX < points[0].x || targetX > points.at(-1).x) {
    return null;
  }
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    if (current.x === targetX || index === 0 && current.x > targetX) {
      return Number(current.y);
    }
    if (current.x > targetX) {
      const previous = points[index - 1];
      const width = current.x - previous.x;
      const ratio = width ? (targetX - previous.x) / width : 0;
      return Number(previous.y) + (Number(current.y) - Number(previous.y)) * ratio;
    }
  }
  return Number(points.at(-1).y);
}

function lineYAxisBoundsFromValues(values) {
  if (!values.length) {
    return null;
  }

  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const span = Math.max(dataMax - dataMin, Math.abs(dataMax) * 0.08, 1);
  const padding = span * 0.08;
  const min = dataMin >= 0 ? Math.max(0, dataMin - padding) : dataMin - padding;
  return { min, max: dataMax + padding };
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

function buildLineDataset(label, points, color, {
  areaFill = false,
  borderWidth = LINE_BASE_BORDER_WIDTH,
  pointRadius = window.innerWidth < 720 ? 2 : 2.5,
  pointHoverRadius = 5,
  pointHitRadius = 8,
} = {}) {
  return {
    label,
    data: points.map((point) => ({ x: dateToDay(point.date), y: point.value, date: point.date })),
    baseColor: color,
    baseBorderWidth: borderWidth,
    basePointRadius: pointRadius,
    basePointHoverRadius: pointHoverRadius,
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
    pointRadius,
    pointHoverRadius,
    pointHitRadius,
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

function visibilityOnlyLegendClick(_event, legendItem, legend) {
  const chart = legend.chart;
  const datasetIndex = legendItem.datasetIndex;
  chart.setDatasetVisibility(datasetIndex, !chart.isDatasetVisible(datasetIndex));
  chart.update("none");
}

function semiIsolateLineLegendHover(_event, legendItem, legend) {
  const chart = legend.chart;
  const hoveredIndex = legendItem.datasetIndex;

  chart.data.datasets.forEach((dataset, index) => {
    const baseColor = dataset.baseColor || dataset.borderColor;
    const preservesPointFiltering = Boolean(dataset.preservePointFiltering);
    const basePointRadius = dataset.basePointRadius ?? 3;
    const basePointHoverRadius = dataset.basePointHoverRadius ?? 6;
    if (index === hoveredIndex) {
      dataset.borderColor = baseColor;
      dataset.backgroundColor = baseColor;
      dataset.pointBackgroundColor = baseColor;
      dataset.pointBorderColor = baseColor;
      dataset.borderWidth = LINE_HOVER_BORDER_WIDTH;
      dataset.pointRadius = preservesPointFiltering ? basePointRadius : Math.max(Number(basePointRadius), 3.5);
      dataset.pointHoverRadius = preservesPointFiltering ? basePointHoverRadius : Math.max(Number(basePointHoverRadius), 6);
      return;
    }

    dataset.borderColor = colorWithAlpha(baseColor, 0.16);
    dataset.backgroundColor = colorWithAlpha(baseColor, 0.16);
    dataset.pointBackgroundColor = colorWithAlpha(baseColor, 0.18);
    dataset.pointBorderColor = colorWithAlpha(baseColor, 0.18);
    dataset.borderWidth = LINE_DIM_BORDER_WIDTH;
    dataset.pointRadius = preservesPointFiltering ? basePointRadius : Math.min(Number(basePointRadius), 1);
    dataset.pointHoverRadius = preservesPointFiltering ? basePointHoverRadius : Math.min(Number(basePointHoverRadius), 4);
  });

  chart.update("none");
  chart.data.datasets.forEach((dataset, index) => {
    const baseColor = dataset.baseColor || dataset.borderColor;
    const pointColor = index === hoveredIndex ? baseColor : colorWithAlpha(baseColor, 0.18);
    const preservesPointFiltering = Boolean(dataset.preservePointFiltering);
    const basePointRadius = Number(dataset.basePointRadius ?? 3);
    const basePointHoverRadius = Number(dataset.basePointHoverRadius ?? 6);
    applyLinePointElementStyle(chart, index, {
      color: pointColor,
      radius: preservesPointFiltering ? null : (index === hoveredIndex ? Math.max(basePointRadius, 3.5) : Math.min(basePointRadius, 1)),
      hoverRadius: preservesPointFiltering ? null : (index === hoveredIndex ? Math.max(basePointHoverRadius, 6) : Math.min(basePointHoverRadius, 4)),
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
    const basePointRadius = dataset.basePointRadius ?? 3;
    const basePointHoverRadius = dataset.basePointHoverRadius ?? 6;
    dataset.borderColor = baseColor;
    dataset.backgroundColor = baseColor;
    dataset.pointBackgroundColor = baseColor;
    dataset.pointBorderColor = baseColor;
    dataset.borderWidth = baseBorderWidth;
    dataset.pointRadius = basePointRadius;
    dataset.pointHoverRadius = basePointHoverRadius;
  });
  chart.update("none");
  chart.data.datasets.forEach((dataset, index) => {
    const baseColor = dataset.baseColor || dataset.borderColor;
    const preservesPointFiltering = Boolean(dataset.preservePointFiltering);
    const basePointRadius = Number(dataset.basePointRadius ?? 3);
    const basePointHoverRadius = Number(dataset.basePointHoverRadius ?? 6);
    applyLinePointElementStyle(chart, index, {
      color: baseColor,
      radius: preservesPointFiltering ? null : basePointRadius,
      hoverRadius: preservesPointFiltering ? null : basePointHoverRadius,
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
    if (Number.isFinite(radius)) {
      point.options.radius = radius;
    }
    if (Number.isFinite(hoverRadius)) {
      point.options.hoverRadius = hoverRadius;
    }
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

  updateDoughnutChart("planChart", {
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
          doughnutKeys: labels,
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

function updateDoughnutChart(chartId, config) {
  const chart = state.charts[chartId];
  const incomingDataset = config.data.datasets[0];
  const incomingKeys = incomingDataset.doughnutKeys || config.data.labels;

  if (!chart || chart.config.type !== "doughnut") {
    replaceChart(chartId, config);
    state.charts[chartId].$doughnutKeys = [...incomingKeys];
    return;
  }

  const currentDataset = chart.data.datasets[0];
  const currentKeys = chart.$doughnutKeys || chart.data.labels;
  const currentIndexByKey = new Map(currentKeys.map((key, index) => [key, index]));
  const incomingIndexByKey = new Map(incomingKeys.map((key, index) => [key, index]));
  const mergedKeys = [...currentKeys, ...incomingKeys.filter((key) => !currentIndexByKey.has(key))];
  const keyedProperties = ["data", "backgroundColor", "borderColor", "assetDistributionRecords"];
  const previousLabels = [...chart.data.labels];
  const incomingLabels = config.data.labels;

  chart.$legendHoverRecord = null;
  chart.setActiveElements([]);
  chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
  chart.$doughnutKeys = mergedKeys;
  chart.data.labels = mergedKeys.map((key) => {
    const incomingIndex = incomingIndexByKey.get(key);
    return incomingIndex === undefined ? previousLabels[currentIndexByKey.get(key)] : incomingLabels[incomingIndex];
  });

  Object.entries(incomingDataset).forEach(([property, value]) => {
    if (!keyedProperties.includes(property) && property !== "doughnutKeys") {
      currentDataset[property] = value;
    }
  });

  if (mergedKeys.length > currentKeys.length) {
    keyedProperties.forEach((property) => {
      if (!incomingDataset[property] && !currentDataset[property]) {
        return;
      }
      const currentValues = currentDataset[property] || [];
      currentDataset[property] = mergedKeys.map((key) => {
        const currentIndex = currentIndexByKey.get(key);
        if (currentIndex !== undefined) {
          return currentValues[currentIndex];
        }
        if (property === "data") {
          return 0;
        }
        return incomingDataset[property]?.[incomingIndexByKey.get(key)];
      });
    });
    chart.update("none");
  }

  keyedProperties.forEach((property) => {
    if (!incomingDataset[property] && !currentDataset[property]) {
      return;
    }
    const currentValues = currentDataset[property] || [];
    currentDataset[property] = mergedKeys.map((key, mergedIndex) => {
      const incomingIndex = incomingIndexByKey.get(key);
      if (incomingIndex !== undefined) {
        return incomingDataset[property]?.[incomingIndex];
      }
      return property === "data" ? 0 : currentValues[mergedIndex];
    });
  });

  chart.options.cutout = config.options.cutout;
  chart.options.animation = doughnutAnimationOptions("morph");
  chart.options.plugins.legend.labels.generateLabels = config.options.plugins.legend.labels.generateLabels;
  chart.options.plugins.tooltip.callbacks = config.options.plugins.tooltip.callbacks;
  chart.update();
  renderExternalDoughnutLegend(chart);
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
  const items = generateLabels(chart).filter((item) => {
    if (item.assetDistributionRecord) {
      return true;
    }
    const datasetIndex = Number.isInteger(item.datasetIndex) ? item.datasetIndex : 0;
    return Number(chart.data.datasets[datasetIndex]?.data?.[item.index] || 0) > 0;
  });
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

  if (animationMode === "morph") {
    return {
      animateRotate: false,
      animateScale: false,
      duration: DOUGHNUT_SCALE_ANIMATION_DURATION,
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

function normalizeAnalysisReports(text) {
  const parsed = JSON.parse(text);
  const reports = Array.isArray(parsed?.reports) ? parsed.reports : [];
  const normalized = reports
    .filter((report) => report && typeof report === "object")
    .map((report) => ({
      ...report,
      id: normalizeText(report.id),
      publishedAt: parseDate(report.publishedAt),
      asOf: parseDate(report.asOf),
      title: normalizeText(report.title),
    }))
    .filter((report) => report.id && report.publishedAt && report.asOf && report.title)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (!normalized.length) {
    throw new Error("analysis report JSON has no usable reports");
  }
  return normalized;
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
      year: date.getUTCFullYear(),
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
  return month ? [month.label, String(month.year)] : "";
}

function monthYearAxisLabel(isoDate) {
  if (!isoDate) {
    return "";
  }
  const date = new Date(`${isoDate}T00:00:00Z`);
  return [
    date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
    String(date.getUTCFullYear()),
  ];
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
  const mappedColor = map?.get(label);
  if (mappedColor) {
    return mappedColor;
  }

  const stableKey = `${kind}:${normalizeText(label)}`;
  let hash = 0;
  for (const character of stableKey) {
    hash = (Math.imul(hash, 31) + character.codePointAt(0)) | 0;
  }
  return FALLBACK_COLORS[(hash >>> 0) % FALLBACK_COLORS.length] || FALLBACK_COLORS[index % FALLBACK_COLORS.length];
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
