import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { catalogToMaps, readCatalog } from "./catalog-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const dataDir = path.join(repoRoot, "data");
const privateDir = path.join(repoRoot, "private", "monthly");
const holdingsPath = path.join(dataDir, "portfolio-clean.csv");
const plansPath = path.join(dataDir, "portfolio-plans.csv");
const flowsPath = path.join(privateDir, "portfolio-flows.csv");
const capitalBaselinePath = path.join(dataDir, "capital-baseline.csv");
const investmentReturnsPath = path.join(dataDir, "investment-returns.csv");
const catalog = readCatalog(repoRoot);
const catalogMaps = catalogToMaps(catalog);

const OUTPUT_COLUMNS = ["Date", "Asset Type", "Securities Firm", "Ticker", "Volume"];
const FLOW_COLUMNS = ["Date", "Flow Type", "Securities Firm", "Category", "Note", "Volume"];
const BASELINE_COLUMNS = ["Date", "Volume"];
const RETURN_COLUMNS = ["Period Start", "Period End", "Monthly Return", "Cumulative Return", "Confidence"];
const CASH_ASSET_TYPE = catalog.cashAssetType;
const UNCLASSIFIED_ASSET_TYPE = catalog.unclassifiedAssetType;
const BALANCE_PREFIX = catalog.balanceNamePrefix;
const BANK_LIKE_FIRMS = catalogMaps.bankLikeFirms;

main().catch((error) => {
  console.error(`Import failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.promptOnly) {
    printSystemPrompt();
    return;
  }

  const existingHoldings = normalizeStoredRows(readCsvFile(holdingsPath));
  const existingPlans = normalizeStoredRows(readCsvFile(plansPath));
  const existingFlows = normalizeStoredFlows(readCsvFile(flowsPath));
  const existingCapitalBaseline = normalizeCapitalBaselineRows(readCsvFile(capitalBaselinePath));
  const existingInvestmentReturns = normalizeInvestmentReturnRows(readCsvFile(investmentReturnsPath));
  const inputText = await readInput(options);
  const rawInputRows = parseInputRows(inputText);
  if (!rawInputRows.length) {
    throw new Error("No CSV rows were pasted.");
  }

  const context = buildNormalizationContext(existingHoldings, rawInputRows);
  const incoming = normalizeIncomingRows(rawInputRows, options, context);

  if (!incoming.holdings.length) {
    throw new Error("No usable holding rows found.");
  }

  const incomingFlows = options.noFlows || options.inputFile || !process.stdin.isTTY
    ? []
    : await readInteractiveFlows(existingHoldings, incoming.latestDate);
  const holdingsMerge = mergeHoldings(existingHoldings, incoming.holdings);
  const flowsMerge = mergeFlows(existingFlows, incomingFlows);
  const nextCapitalBaseline = rebuildCapitalBaseline(existingCapitalBaseline, flowsMerge.rows, holdingsMerge.rows);
  const nextInvestmentReturns = extendInvestmentReturns(existingInvestmentReturns, flowsMerge.rows, holdingsMerge.rows);
  const nextHoldingsText = toCsv(holdingsMerge.rows, OUTPUT_COLUMNS);
  const nextPlansText = toCsv(existingPlans, OUTPUT_COLUMNS);
  const nextFlowsText = toCsv(flowsMerge.rows, FLOW_COLUMNS);
  const nextCapitalBaselineText = toCsv(nextCapitalBaseline, BASELINE_COLUMNS);
  const nextInvestmentReturnsText = toCsv(nextInvestmentReturns, RETURN_COLUMNS);
  const holdingsChanged = normalizeFileText(holdingsPath) !== nextHoldingsText;
  const plansChanged = normalizeFileText(plansPath) !== nextPlansText;
  const flowsChanged = normalizeFileText(flowsPath) !== nextFlowsText;
  const capitalBaselineChanged = normalizeFileText(capitalBaselinePath) !== nextCapitalBaselineText;
  const investmentReturnsChanged = normalizeFileText(investmentReturnsPath) !== nextInvestmentReturnsText;
  const hasChanges = holdingsChanged || plansChanged || flowsChanged || capitalBaselineChanged || investmentReturnsChanged;

  printSummary(
    incoming,
    holdingsMerge.stats,
    flowsMerge.stats,
    {
      holdingsChanged,
      plansChanged,
      flowsChanged,
      capitalBaselineChanged,
      investmentReturnsChanged,
    },
    nextCapitalBaseline,
    nextInvestmentReturns,
  );

  if (options.dryRun) {
    console.log("Dry run only. No files were written.");
    return;
  }

  if (!hasChanges) {
    console.log("No CSV changes to write. Commit and push skipped.");
    return;
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true });
  fs.writeFileSync(holdingsPath, nextHoldingsText, "utf8");
  fs.writeFileSync(plansPath, nextPlansText, "utf8");
  fs.writeFileSync(flowsPath, nextFlowsText, "utf8");
  fs.writeFileSync(capitalBaselinePath, nextCapitalBaselineText, "utf8");
  fs.writeFileSync(investmentReturnsPath, nextInvestmentReturnsText, "utf8");
  console.log("Wrote portfolio snapshots and monthly cash-flow records.");

  if (!options.commit) {
    console.log("Commit skipped because --no-commit was provided.");
    return;
  }

  commitAndMaybePush(options, incoming.latestDate);
}

function parseArgs(argv) {
  const options = {
    commit: true,
    date: "",
    dryRun: false,
    help: false,
    inputFile: "",
    message: "",
    noFlows: false,
    promptOnly: false,
    push: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      options.commit = false;
      options.push = false;
    } else if (arg === "--no-commit") {
      options.commit = false;
      options.push = false;
    } else if (arg === "--no-push") {
      options.push = false;
    } else if (arg === "--no-flows") {
      options.noFlows = true;
    } else if (arg === "--date") {
      options.date = requireValue(argv, (index += 1), arg);
    } else if (arg === "--message" || arg === "-m") {
      options.message = requireValue(argv, (index += 1), arg);
    } else if (arg === "--prompt-only") {
      options.promptOnly = true;
      options.commit = false;
      options.push = false;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.inputFile) {
      options.inputFile = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

async function readInput(options) {
  if (options.inputFile) {
    return fs.readFileSync(path.resolve(process.cwd(), options.inputFile), "utf8");
  }

  if (!process.stdin.isTTY) {
    return readAllStdin();
  }

  return readInteractiveInput();
}

async function readInteractiveInput() {
  printSystemPrompt();
  console.log("");
  console.log("Paste the clipboard prompt into the LLM chat, then keep pasting LLM data rows below.");
  console.log("Commands: DONE = import all pasted rows, PROMPT = copy/show prompt again, ABORT = quit.");
  console.log("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const lines = [];
  for await (const line of rl) {
    const command = line.trim().toUpperCase();
    if (command === "PROMPT") {
      printSystemPrompt();
      console.log("");
      continue;
    }
    if (command === "ABORT") {
      rl.close();
      throw new Error("Interactive import aborted.");
    }
    if (command === "DONE") {
      rl.close();
      break;
    }
    if (command === "END") {
      console.log("END is no longer needed. Keep pasting data rows, then type DONE once when finished.");
      console.log("");
      continue;
    }
    lines.push(line);
  }

  return lines.join("\n");
}

async function readAllStdin() {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}

async function readInteractiveFlows(existingHoldings, latestDate) {
  const defaultDate = defaultFlowDate(existingHoldings, latestDate);
  const rows = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  console.log("");
  console.log("이제 지난 기록 이후의 현금흐름을 입력합니다.");
  console.log("일상 소비와 은행끼리/증권사끼리 옮긴 돈은 입력하지 않아도 됩니다.");
  console.log("외부 돈이 증권계좌로 바로 들어왔다면 외부 유입과 투자 입금 양쪽에 각각 입력하세요.");
  console.log("");

  try {
    while (true) {
      const amountText = (await askLine(
        rl,
        "외부 현금흐름 금액 (+유입, -세금·증여 등 / 없으면 Enter): ",
      )).trim();
      if (!amountText) {
        break;
      }

      const amount = parseVolume(amountText);
      if (!amount) {
        console.log("0이 아닌 원화 금액을 입력해 주세요.");
        continue;
      }

      const flowType = amount > 0 ? "외부유입" : "외부유출";
      const defaultCategory = amount > 0 ? "월급" : "세금";
      const category = (await askLine(rl, `종류 [${defaultCategory}]: `)).trim() || defaultCategory;
      const date = await askDate(rl, defaultDate);
      const note = (await askLine(rl, "메모 (선택 / Enter): ")).trim();
      rows.push({
        Date: date,
        "Flow Type": flowType,
        "Securities Firm": "",
        Category: category,
        Note: note,
        Volume: String(Math.abs(amount)),
      });
      console.log("외부 현금흐름을 추가했습니다. 더 있으면 계속 입력하세요.");
    }

    console.log("");
    console.log("은행↔증권 이동은 순수 투자수익률 계산에 필요합니다.");
    while (true) {
      const direction = normalizeText(await askLine(
        rl,
        "이동 방향 [1=은행→증권, 2=증권→은행 / 없으면 Enter]: ",
      ));
      if (!direction) {
        break;
      }

      const flowType = parseInvestmentDirection(direction);
      if (!flowType) {
        console.log("1 또는 2를 입력해 주세요.");
        continue;
      }

      const amountText = (await askLine(rl, "이동 금액: ")).trim();
      const amount = parseVolume(amountText);
      if (!amount || amount < 0) {
        console.log("0보다 큰 원화 금액을 입력해 주세요.");
        continue;
      }

      const firm = (await askLine(rl, "증권사 (선택 / Enter): ")).trim();
      const date = await askDate(rl, defaultDate);
      const note = (await askLine(rl, "메모 (선택 / Enter): ")).trim();
      rows.push({
        Date: date,
        "Flow Type": flowType,
        "Securities Firm": firm,
        Category: "",
        Note: note,
        Volume: String(amount),
      });
      console.log("투자계좌 이동을 추가했습니다. 더 있으면 계속 입력하세요.");
    }
  } finally {
    rl.close();
  }

  console.log(`현금흐름 ${rows.length}건을 이번 기록에 포함합니다.`);
  return rows.sort(compareFlows);
}

function askLine(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function askDate(rl, defaultDate) {
  while (true) {
    const value = (await askLine(rl, `날짜 [${defaultDate}]: `)).trim() || defaultDate;
    try {
      return parseDate(value);
    } catch (error) {
      console.log(error.message);
    }
  }
}

function parseInvestmentDirection(value) {
  const normalized = normalizeText(value).replace(/\s/g, "");
  if (["1", "입금", "은행→증권", "은행->증권"].includes(normalized)) {
    return "투자입금";
  }
  if (["2", "출금", "증권→은행", "증권->은행"].includes(normalized)) {
    return "투자출금";
  }
  return "";
}

function defaultFlowDate(existingHoldings, latestDate) {
  const previousDate = existingHoldings
    .map((row) => row.Date)
    .filter((date) => date && date < latestDate)
    .sort()
    .at(-1);
  if (!previousDate) {
    return latestDate;
  }

  const start = Date.parse(`${previousDate}T00:00:00Z`);
  const end = Date.parse(`${latestDate}T00:00:00Z`);
  const midpoint = new Date(start + Math.floor((end - start) / 2));
  return midpoint.toISOString().slice(0, 10);
}

function parseInputRows(inputText) {
  return extractCsvTexts(inputText).flatMap((csvText) => parseCsv(csvText));
}

function extractCsvTexts(inputText) {
  const text = String(inputText ?? "").replace(/^\uFEFF/, "").trim();
  if (!text) {
    return [];
  }

  const fenced = [...text.matchAll(/```(?:csv)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim()).filter(Boolean);
  if (fenced.length) {
    return fenced;
  }

  const csvText = extractCsvText(text);
  return csvText.trim() ? [csvText] : [];
}

function extractCsvText(inputText) {
  const text = String(inputText ?? "").replace(/^\uFEFF/, "").trim();
  const fenced = text.match(/```(?:csv)?\s*([\s\S]*?)```/i);
  if (fenced) {
    return fenced[1].trim();
  }

  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex(isCsvHeaderLine);
  if (headerIndex === -1) {
    return text;
  }

  const csvLines = [];
  for (let index = headerIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      continue;
    }
    if (index > headerIndex && line.trim() && !line.includes(",")) {
      break;
    }
    if (line.trim() || csvLines.length === 0) {
      csvLines.push(line);
    }
  }
  return csvLines.join("\n").trim();
}

function isCsvHeaderLine(line) {
  const canonical = canonicalHeader(line);
  return line.includes(",") && canonical.includes("date") && canonical.includes("volume");
}

function isCsvHeaderRow(row) {
  const canonical = row.map(canonicalHeader);
  return (
    (canonical.includes("date") && canonical.includes("volume")) ||
    (canonical.includes("periodstart") && canonical.includes("periodend") && canonical.includes("monthlyreturn"))
  );
}

function readCsvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return parseCsv(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function normalizeStoredRows(rows) {
  return rows
    .map((row) => {
      const normalized = {};
      for (const column of OUTPUT_COLUMNS) {
        normalized[column] = normalizeText(row[column]);
      }
      return normalized;
    })
    .filter((row) => row.Date && row.Volume);
}

function normalizeStoredFlows(rows) {
  const allowedTypes = new Set(["외부유입", "외부유출", "투자입금", "투자출금"]);
  return rows
    .map((row) => ({
      Date: normalizeText(row.Date),
      "Flow Type": normalizeText(row["Flow Type"]),
      "Securities Firm": normalizeText(row["Securities Firm"]),
      Category: normalizeText(row.Category),
      Note: normalizeText(row.Note),
      Volume: String(parseVolume(row.Volume) || ""),
    }))
    .filter((row) => row.Date && allowedTypes.has(row["Flow Type"]) && Number(row.Volume) > 0)
    .sort(compareFlows);
}

function normalizeCapitalBaselineRows(rows) {
  return rows
    .map((row) => ({
      Date: normalizeText(row.Date),
      Volume: String(parseVolume(row.Volume) || ""),
    }))
    .filter((row) => row.Date && Number(row.Volume) >= 0)
    .sort((a, b) => a.Date.localeCompare(b.Date));
}

function normalizeInvestmentReturnRows(rows) {
  return rows
    .map((row) => ({
      "Period Start": normalizeText(row["Period Start"]),
      "Period End": normalizeText(row["Period End"]),
      "Monthly Return": normalizeDecimal(row["Monthly Return"]),
      "Cumulative Return": normalizeDecimal(row["Cumulative Return"]),
      Confidence: normalizeText(row.Confidence) || "estimated",
    }))
    .filter((row) => row["Period Start"] && row["Period End"] && row["Monthly Return"] !== "")
    .sort((a, b) => a["Period Start"].localeCompare(b["Period Start"]));
}

function normalizeDecimal(value) {
  const number = Number(normalizeText(value));
  return Number.isFinite(number) ? number.toFixed(10) : "";
}

function rebuildCapitalBaseline(existingRows, flowRows, holdingRows) {
  if (!existingRows.length) {
    return [];
  }

  const externalFlows = flowRows
    .filter((row) => row["Flow Type"] === "외부유입" || row["Flow Type"] === "외부유출")
    .sort(compareFlows);
  const latestExisting = existingRows.at(-1);
  const firstFlowDate = externalFlows[0]?.Date || "";
  const anchor = firstFlowDate
    ? existingRows.filter((row) => row.Date < firstFlowDate).at(-1) || latestExisting
    : latestExisting;
  const futureDates = new Set([
    ...existingRows.filter((row) => row.Date > anchor.Date).map((row) => row.Date),
    ...holdingRows.filter((row) => row.Date > anchor.Date).map((row) => row.Date),
  ]);
  const anchorValue = Number(anchor.Volume);
  const rebuilt = [...existingRows.filter((row) => row.Date <= anchor.Date)];

  for (const date of [...futureDates].sort()) {
    const externalDelta = externalFlows
      .filter((row) => row.Date > anchor.Date && row.Date <= date)
      .reduce((sum, row) => sum + (row["Flow Type"] === "외부유입" ? 1 : -1) * Number(row.Volume), 0);
    rebuilt.push({ Date: date, Volume: String(Math.max(0, Math.round(anchorValue + externalDelta))) });
  }

  return rebuilt;
}

function extendInvestmentReturns(existingRows, flowRows, holdingRows) {
  if (!existingRows.length) {
    return [];
  }

  const historicalRows = existingRows.filter((row) => row.Confidence !== "recorded");
  const anchorRow = historicalRows.at(-1) || existingRows.at(-1);
  const anchorDate = anchorRow["Period End"];
  const snapshotDates = [...new Set(holdingRows.map((row) => row.Date).filter((date) => date >= anchorDate))].sort();
  const result = [...historicalRows];
  let cumulativeFactor = 1 + Number(anchorRow["Cumulative Return"]);

  for (const [periodStart, periodEnd] of adjacentPairs(snapshotDates)) {
    if (periodStart < anchorDate) {
      continue;
    }
    const monthlyReturn = calculateRecordedInvestmentReturn(periodStart, periodEnd, holdingRows, flowRows);
    if (monthlyReturn === null) {
      continue;
    }
    cumulativeFactor *= 1 + monthlyReturn;
    result.push({
      "Period Start": periodStart,
      "Period End": periodEnd,
      "Monthly Return": monthlyReturn.toFixed(10),
      "Cumulative Return": (cumulativeFactor - 1).toFixed(10),
      Confidence: "recorded",
    });
  }
  return result;
}

function adjacentPairs(values) {
  return values.slice(0, -1).map((value, index) => [value, values[index + 1]]);
}

function calculateRecordedInvestmentReturn(periodStart, periodEnd, holdingRows, flowRows) {
  const startValue = investmentValueAt(periodStart, holdingRows);
  const endValue = investmentValueAt(periodEnd, holdingRows);
  const startDay = Date.parse(`${periodStart}T00:00:00Z`);
  const endDay = Date.parse(`${periodEnd}T00:00:00Z`);
  const periodDays = Math.round((endDay - startDay) / 86400000);
  if (!periodDays || startValue <= 0) {
    return null;
  }

  const investmentFlows = flowRows
    .filter((row) => ["투자입금", "투자출금"].includes(row["Flow Type"]))
    .filter((row) => row.Date > periodStart && row.Date <= periodEnd)
    .map((row) => ({
      ...row,
      signedAmount: (row["Flow Type"] === "투자입금" ? 1 : -1) * Number(row.Volume),
    }));
  const netFlow = investmentFlows.reduce((sum, row) => sum + row.signedAmount, 0);
  const weightedFlow = investmentFlows.reduce((sum, row) => {
    const flowDay = Date.parse(`${row.Date}T00:00:00Z`);
    const remainingDays = Math.round((endDay - flowDay) / 86400000);
    return sum + (remainingDays / periodDays) * row.signedAmount;
  }, 0);
  const denominator = startValue + weightedFlow;
  return denominator > 1000 ? (endValue - startValue - netFlow) / denominator : null;
}

function investmentValueAt(date, holdingRows) {
  return holdingRows
    .filter((row) => row.Date === date)
    .filter((row) => row["Securities Firm"] && !BANK_LIKE_FIRMS.has(row["Securities Firm"]))
    .reduce((sum, row) => sum + Number(row.Volume || 0), 0);
}

function buildNormalizationContext(existingRows, rawInputRows) {
  return {
    majorityAssetTypeByTicker: inferMajorityAssetTypes(existingRows),
    knownTickers: collectKnownTickers(existingRows, rawInputRows),
  };
}

function normalizeIncomingRows(rawRows, options, context) {
  const holdings = [];
  const errors = [];

  rawRows.forEach((row, index) => {
    if (Object.values(row).every((value) => !normalizeText(value))) {
      return;
    }

    try {
      const volume = parseVolume(getField(row, ["Volume", "Amount", "Value"]));
      if (volume === null) {
        throw new Error("missing volume");
      }

      const name = getField(row, ["Name", "Holding"]);
      const isBalanceCash = isBalanceName(name);
      const ticker = isBalanceCash
        ? ""
        : normalizeTicker(getField(row, ["Ticker", "Symbol"])) || inferTicker(name, context.knownTickers);
      const normalized = {
        Date: parseDate(getField(row, ["Date", "Snapshot Date"]) || options.date),
        "Asset Type": normalizeAssetType(row, ticker, context.majorityAssetTypeByTicker, isBalanceCash),
        "Securities Firm": normalizeText(getField(row, ["Securities Firm", "Firm", "Broker"])),
        Ticker: ticker,
        Volume: String(volume),
      };

      holdings.push(normalized);
    } catch (error) {
      errors.push(`Row ${index + 2}: ${error.message}`);
    }
  });

  if (errors.length) {
    throw new Error(errors.slice(0, 6).join("\n"));
  }

  return {
    holdings: holdings.sort(compareRows),
    latestDate: holdings.map((row) => row.Date).sort().at(-1) || "",
  };
}

function normalizeAssetType(row, ticker, majorityAssetTypeByTicker, isBalanceCash) {
  if (isBalanceCash) {
    return CASH_ASSET_TYPE;
  }

  if (ticker && catalogMaps.tickerAssetTypeByTicker.has(ticker)) {
    return catalogMaps.tickerAssetTypeByTicker.get(ticker);
  }

  const current = normalizeText(getField(row, ["Asset Type", "AssetType", "Type", "Category"]));
  if (current) {
    return current;
  }

  if (ticker && majorityAssetTypeByTicker.has(ticker)) {
    return majorityAssetTypeByTicker.get(ticker);
  }

  return UNCLASSIFIED_ASSET_TYPE;
}

function inferMajorityAssetTypes(rows) {
  const counts = new Map();

  for (const row of rows) {
    const ticker = normalizeTicker(row.Ticker);
    const assetType = normalizeText(row["Asset Type"]);
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
  for (const [ticker, tickerCounts] of counts.entries()) {
    const [assetType] = [...tickerCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    result.set(ticker, assetType);
  }
  return result;
}

function collectKnownTickers(existingRows, rawInputRows) {
  const tickers = new Set(catalogMaps.tickerAssetTypeByTicker.keys());
  for (const row of existingRows) {
    const ticker = normalizeTicker(row.Ticker);
    if (ticker) {
      tickers.add(ticker);
    }
  }
  for (const row of rawInputRows) {
    const ticker = normalizeTicker(getField(row, ["Ticker", "Symbol"]));
    if (ticker) {
      tickers.add(ticker);
    }
  }
  return [...tickers].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function inferTicker(name, knownTickers) {
  const normalizedName = normalizeTicker(name);
  if (!normalizedName) {
    return "";
  }

  const matches = knownTickers.filter((ticker) => {
    const pattern = new RegExp(`(^|[^A-Z0-9\\uAC00-\\uD7A3])${escapeRegex(ticker)}([^A-Z0-9\\uAC00-\\uD7A3]|$)`, "u");
    return pattern.test(normalizedName);
  });

  return matches.length === 1 ? matches[0] : "";
}

function mergeHoldings(existingRows, incomingRows) {
  const rows = existingRows.map(cloneRow);
  const indexByKey = new Map();
  const stats = { added: 0, updated: 0, unchanged: 0 };

  rows.forEach((row, index) => {
    indexByKey.set(holdingMergeKey(row), index);
  });

  for (const row of incomingRows) {
    const key = holdingMergeKey(row);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, rows.length);
      rows.push(cloneRow(row));
      stats.added += 1;
      continue;
    }

    if (fullRowKey(rows[existingIndex]) === fullRowKey(row)) {
      stats.unchanged += 1;
    } else {
      rows[existingIndex] = cloneRow(row);
      stats.updated += 1;
    }
  }

  return { rows: rows.sort(compareRows), stats };
}

function mergeFlows(existingRows, incomingRows) {
  const rows = existingRows.map((row) => ({ ...row }));
  const existingKeys = new Set(rows.map(flowKey));
  const stats = { added: 0, unchanged: 0 };

  for (const row of incomingRows) {
    const key = flowKey(row);
    if (existingKeys.has(key)) {
      stats.unchanged += 1;
      continue;
    }
    rows.push({ ...row });
    existingKeys.add(key);
    stats.added += 1;
  }

  return { rows: rows.sort(compareFlows), stats };
}

function flowKey(row) {
  return FLOW_COLUMNS.map((column) => row[column] || "").join("|");
}

function holdingMergeKey(row) {
  return [row.Date, row["Securities Firm"], row.Ticker, row["Asset Type"]].join("|");
}

function fullRowKey(row) {
  return OUTPUT_COLUMNS.map((column) => row[column] || "").join("|");
}

function cloneRow(row) {
  return Object.fromEntries(OUTPUT_COLUMNS.map((column) => [column, row[column] || ""]));
}

function commitAndMaybePush(options, latestDate) {
  const relativePaths = [
    "data/portfolio-clean.csv",
    "data/portfolio-plans.csv",
    "data/capital-baseline.csv",
    "data/investment-returns.csv",
  ];
  const message = options.message || `Update portfolio data${latestDate ? ` ${latestDate}` : ""}`;

  runGit(["add", "--", ...relativePaths]);
  runGit(["commit", "-m", message, "--", ...relativePaths]);

  if (!options.push) {
    console.log("Push skipped because --no-push was provided.");
    return;
  }

  const branch = gitOutput(["branch", "--show-current"]).trim();
  if (!branch) {
    throw new Error("Could not determine current git branch for push.");
  }
  runGit(["push", "origin", branch]);
}

function runGit(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, stdio: "inherit", windowsHide: true });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
}

function gitOutput(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || `git ${args.join(" ")} failed`).trim());
  }
  return result.stdout;
}

function normalizeFileText(filePath) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

function printSummary(incoming, holdingStats, flowStats, changes, capitalBaseline, investmentReturns) {
  console.log(`Parsed ${incoming.holdings.length} holding rows.`);
  console.log(
    `Holdings merge: ${holdingStats.added} added, ${holdingStats.updated} updated, ${holdingStats.unchanged} unchanged.`,
  );
  console.log(
    `Cash flows: ${flowStats.added} added, ${flowStats.unchanged} already recorded.`,
  );
  console.log(
    `CSV changes: holdings ${changes.holdingsChanged ? "yes" : "no"}, plans ${changes.plansChanged ? "yes" : "no"}, private flows ${changes.flowsChanged ? "yes" : "no"}, baseline ${changes.capitalBaselineChanged ? "yes" : "no"}, returns ${changes.investmentReturnsChanged ? "yes" : "no"}.`,
  );
  const latestBaseline = capitalBaseline.at(-1);
  if (latestBaseline) {
    console.log(`Capital baseline at ${latestBaseline.Date}: ${Number(latestBaseline.Volume).toLocaleString("ko-KR")} KRW.`);
  }
  const latestReturn = investmentReturns.at(-1);
  if (latestReturn) {
    console.log(
      `Pure investment return through ${latestReturn["Period End"]}: ${(Number(latestReturn["Cumulative Return"]) * 100).toFixed(1)}%.`,
    );
  }
}

function printSystemPrompt() {
  const prompt = buildSystemPrompt();
  const clipboard = copyTextToClipboard(prompt);
  if (clipboard.ok) {
    console.log(`Copied the LLM system prompt to your clipboard via ${clipboard.method}.`);
  } else {
    console.log(`Could not copy the LLM system prompt to your clipboard: ${clipboard.message}`);
  }
  console.log("========== LLM SYSTEM PROMPT ==========");
  console.log(prompt);
  console.log("========== END SYSTEM PROMPT ==========");
}

function copyTextToClipboard(text) {
  const failures = [];
  for (const command of clipboardCommands()) {
    const result = spawnSync(command.file, command.args, {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    if (!result.error && result.status === 0) {
      return { ok: true, method: command.name };
    }

    failures.push(formatClipboardFailure(command, result));
  }

  return { ok: false, message: failures[0] || "no clipboard command is available" };
}

function clipboardCommands() {
  if (process.platform === "win32") {
    const script = [
      "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "$text = [Console]::In.ReadToEnd()",
      "Set-Clipboard -Value $text",
    ].join("; ");
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");
    return [
      {
        name: "PowerShell Set-Clipboard",
        file: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript],
      },
      { name: "clip.exe", file: "clip.exe", args: [] },
    ];
  }

  if (process.platform === "darwin") {
    return [{ name: "pbcopy", file: "pbcopy", args: [] }];
  }

  return [
    { name: "wl-copy", file: "wl-copy", args: [] },
    { name: "xclip", file: "xclip", args: ["-selection", "clipboard"] },
    { name: "xsel", file: "xsel", args: ["--clipboard", "--input"] },
  ];
}

function formatClipboardFailure(command, result) {
  if (result.error) {
    return `${command.name}: ${result.error.message}`;
  }
  const stderr = String(result.stderr || "").trim();
  return `${command.name}: exit ${result.status}${stderr ? ` (${stderr})` : ""}`;
}

function buildSystemPrompt() {
  const holdings = normalizeStoredRows(readCsvFile(holdingsPath));
  const rows = [...holdings, ...normalizeStoredRows(readCsvFile(plansPath))];
  const assetTypes = sortedUnique([...catalog.assetTypes, ...rows.map((row) => row["Asset Type"]), CASH_ASSET_TYPE, UNCLASSIFIED_ASSET_TYPE]);
  const firms = sortedUnique([...Object.keys(catalog.colors.firm), ...catalog.bankLikeFirms, ...rows.map((row) => row["Securities Firm"])]);
  const tickerGroups = groupTickersByAssetType(holdings);
  const tickerLines = tickerGroups.length
    ? tickerGroups.map(([assetType, tickers]) => `- ${assetType}: ${tickers.join(", ")}`).join("\n")
    : "- No known tickers yet.";
  const bankRules = catalog.bankLikeFirms.map((firm) => `- ${firm} rows are always Asset Type = ${CASH_ASSET_TYPE} and Ticker empty.`);
  const cashLabelRules = catalog.cashLabels.map((label) => `- ${label} rows are always Asset Type = ${CASH_ASSET_TYPE} and Ticker empty.`);
  const cashRules = [...bankRules, ...cashLabelRules].join("\n");

  return `You are a strict portfolio screenshot data extraction engine.

Your job:
- Read one asset-app screenshot at a time.
- Output ONLY plain CSV data rows for that screenshot.
- Do not output a CSV header.
- Do not wrap the rows in a markdown code fence.
- Do not include explanations, notes, markdown, or guessed values.

Column order for every row, exactly:
Date,Asset Type,Securities Firm,Ticker,Volume

Date rules:
- Use YYYY-MM-DD.
- If the user provides a snapshot date, use that date for every row.
- If no date is visible and the user did not provide one, ask for the date instead of producing CSV.

Screenshot scope:
- Extract only actual/current holdings.
- Do not output future plans, target plans, or a Plans? column.

Allowed Asset Type values:
${assetTypes.map((assetType) => `- ${assetType}`).join("\n")}

Known ticker mapping:
${tickerLines}

Known securities firms/banks:
${firms.map((firm) => `- ${firm}`).join("\n")}

${CASH_ASSET_TYPE} classification rules:
${cashRules || `- Cash/deposit rows are always Asset Type = ${CASH_ASSET_TYPE} and Ticker empty.`}

Ticker rules:
- Use uppercase ticker symbols.
- For cash, deposits, bank balance, emergency fund, or consumption rows, leave Ticker empty.
- If a ticker is clearly visible but not listed above, output it exactly and use Asset Type = ${UNCLASSIFIED_ASSET_TYPE} unless the screenshot clearly implies another asset type.
- Do not invent tickers.

Volume rules:
- Volume must be an integer KRW amount.
- Remove currency symbols and spaces.
- If using commas inside a number, quote the field, e.g. "1,234,567".
- Do not output percentages, shares, prices, purchase price, profit/loss, or daily change unless the screenshot clearly labels them as total current value/asset value.

Output format:
2026-07-04,일반 투자,키움증권,AMD,1234567
2026-07-04,예금,카카오뱅크,,20000000
2026-07-04,배당주,삼성증권,SCHD,5000000`;
}

function groupTickersByAssetType(rows) {
  const groups = new Map();
  for (const [ticker, assetType] of catalogMaps.tickerAssetTypeByTicker.entries()) {
    if (!groups.has(assetType)) {
      groups.set(assetType, new Set());
    }
    groups.get(assetType).add(ticker);
  }

  for (const row of rows) {
    const ticker = normalizeTicker(row.Ticker);
    const assetType = normalizeText(row["Asset Type"]);
    if (!ticker || !assetType) {
      continue;
    }
    if (!groups.has(assetType)) {
      groups.set(assetType, new Set());
    }
    groups.get(assetType).add(ticker);
  }

  return [...groups.entries()]
    .map(([assetType, tickers]) => [assetType, [...tickers].sort((a, b) => a.localeCompare(b, "ko"))])
    .sort((a, b) => a[0].localeCompare(b[0], "ko"));
}

function sortedUnique(values) {
  return [...new Set(values.map(normalizeText).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
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

function toIsoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`invalid date ${year}-${month}-${day}`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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

function parseVolume(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const numericText = normalized.replace(/[^\d.-]/g, "");
  if (!numericText || numericText === "-" || numericText === ".") {
    return null;
  }

  const numeric = Number(numericText);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function normalizeTicker(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function isBalanceName(value) {
  const text = normalizeText(value);
  return text.startsWith(BALANCE_PREFIX) || catalog.cashLabels.some((label) => text.includes(label));
}

function compareRows(a, b) {
  return (
    a.Date.localeCompare(b.Date) ||
    a["Asset Type"].localeCompare(b["Asset Type"]) ||
    a["Securities Firm"].localeCompare(b["Securities Firm"]) ||
    a.Ticker.localeCompare(b.Ticker) ||
    Number(a.Volume || 0) - Number(b.Volume || 0)
  );
}

function compareFlows(a, b) {
  return (
    a.Date.localeCompare(b.Date) ||
    a["Flow Type"].localeCompare(b["Flow Type"], "ko") ||
    a["Securities Firm"].localeCompare(b["Securities Firm"], "ko") ||
    a.Category.localeCompare(b.Category, "ko") ||
    a.Note.localeCompare(b.Note, "ko") ||
    Number(a.Volume || 0) - Number(b.Volume || 0)
  );
}

function getField(row, names) {
  const keys = Object.keys(row);
  const wanted = names.map(canonicalHeader);
  const key = keys.find((candidate) => wanted.includes(canonicalHeader(candidate)));
  return key ? row[key] : "";
}

function canonicalHeader(header) {
  return String(header).toLowerCase().replace(/[\s_?.-]/g, "");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (inQuotes) {
    throw new Error("CSV has an unclosed quoted field.");
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const nonEmptyRows = rows.filter((entry) => entry.some((value) => normalizeText(value)));
  if (!nonEmptyRows.length) {
    return [];
  }

  const hasHeader = isCsvHeaderRow(nonEmptyRows[0]);
  const normalizedHeaders = hasHeader
    ? nonEmptyRows[0].map((header) => normalizeText(header).replace(/^\uFEFF/, ""))
    : OUTPUT_COLUMNS;
  const dataRows = hasHeader ? nonEmptyRows.slice(1) : nonEmptyRows;
  return dataRows.map((entry) => Object.fromEntries(normalizedHeaders.map((header, index) => [header, entry[index] ?? ""])));
}

function toCsv(rows, columns) {
  return [columns.join(","), ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(","))].join("\n") + "\n";
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printHelp() {
  console.log(`Usage:
  node tools/import-paste.mjs
  node tools/import-paste.mjs --dry-run
  node tools/import-paste.mjs --prompt-only
  node tools/import-paste.mjs snapshot.csv --no-push

Interactive input:
  The tool copies the LLM system prompt to your clipboard first, then prints it as a fallback.
  Paste each image's LLM data rows into the terminal.
  Keep pasting rows from more screenshots as you go.
  Type DONE on its own line once, after the final pasted rows, to import.
  Type PROMPT on its own line to copy and show the system prompt again.

Expected LLM output:
2026-07-04,일반 투자,키움증권,AMD,1234567
2026-07-04,예금,카카오뱅크,,20000000

Options:
  --date YYYY-MM-DD  Use this date when a pasted row omits Date.
  --dry-run          Parse and merge, but do not write, commit, or push.
  --no-commit        Write CSV files, but do not commit or push.
  --no-push          Commit CSV files, but do not push.
  --no-flows         Skip the monthly cash-flow questions.
  --prompt-only      Copy and print the LLM system prompt, then exit.
  -m, --message MSG  Override the git commit message.
`);
}
