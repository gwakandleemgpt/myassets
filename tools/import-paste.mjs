import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const dataDir = path.join(repoRoot, "data");
const holdingsPath = path.join(dataDir, "portfolio-clean.csv");
const plansPath = path.join(dataDir, "portfolio-plans.csv");

const OUTPUT_COLUMNS = ["Date", "Asset Type", "Securities Firm", "Ticker", "Volume"];
const CASH_ASSET_TYPE = "예금";
const UNCLASSIFIED_ASSET_TYPE = "미분류";
const BALANCE_PREFIX = "잔고";

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

  const holdingsMerge = mergeHoldings(existingHoldings, incoming.holdings);
  const nextHoldingsText = toCsv(holdingsMerge.rows, OUTPUT_COLUMNS);
  const nextPlansText = toCsv(existingPlans, OUTPUT_COLUMNS);
  const holdingsChanged = normalizeFileText(holdingsPath) !== nextHoldingsText;
  const plansChanged = normalizeFileText(plansPath) !== nextPlansText;
  const hasChanges = holdingsChanged || plansChanged;

  printSummary(incoming, holdingsMerge.stats, { holdingsChanged, plansChanged });

  if (options.dryRun) {
    console.log("Dry run only. No files were written.");
    return;
  }

  if (!hasChanges) {
    console.log("No CSV changes to write. Commit and push skipped.");
    return;
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(holdingsPath, nextHoldingsText, "utf8");
  fs.writeFileSync(plansPath, nextPlansText, "utf8");
  console.log("Wrote data/portfolio-clean.csv and data/portfolio-plans.csv.");

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
  return canonical.includes("date") && canonical.includes("volume");
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

function buildNormalizationContext(existingRows, rawInputRows) {
  return {
    assetTypeByTicker: inferMajorityAssetTypes(existingRows),
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
        "Asset Type": normalizeAssetType(row, ticker, context.assetTypeByTicker, isBalanceCash),
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

function normalizeAssetType(row, ticker, assetTypeByTicker, isBalanceCash) {
  if (isBalanceCash) {
    return CASH_ASSET_TYPE;
  }

  const current = normalizeText(getField(row, ["Asset Type", "AssetType", "Type", "Category"]));
  if (current) {
    return current;
  }

  if (ticker && assetTypeByTicker.has(ticker)) {
    return assetTypeByTicker.get(ticker);
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
  const tickers = new Set();
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
  const relativePaths = ["data/portfolio-clean.csv", "data/portfolio-plans.csv"];
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

function printSummary(incoming, holdingStats, changes) {
  console.log(`Parsed ${incoming.holdings.length} holding rows.`);
  console.log(
    `Holdings merge: ${holdingStats.added} added, ${holdingStats.updated} updated, ${holdingStats.unchanged} unchanged.`,
  );
  console.log(
    `CSV changes: holdings ${changes.holdingsChanged ? "yes" : "no"}, plans ${changes.plansChanged ? "yes" : "no"}.`,
  );
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
  const assetTypes = sortedUnique([...rows.map((row) => row["Asset Type"]), CASH_ASSET_TYPE, UNCLASSIFIED_ASSET_TYPE]);
  const firms = sortedUnique(rows.map((row) => row["Securities Firm"]));
  const tickerGroups = groupTickersByAssetType(holdings);
  const tickerLines = tickerGroups.length
    ? tickerGroups.map(([assetType, tickers]) => `- ${assetType}: ${tickers.join(", ")}`).join("\n")
    : "- No known tickers yet.";

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

예금 classification rules:
- 키움저축은행 rows are always Asset Type = 예금 and Ticker empty.
- 우리은행 rows are always Asset Type = 예금 and Ticker empty.
- 예수금 rows are always Asset Type = 예금 and Ticker empty.

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
  return normalizeText(value).startsWith(BALANCE_PREFIX);
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
  --prompt-only      Copy and print the LLM system prompt, then exit.
  -m, --message MSG  Override the git commit message.
`);
}
