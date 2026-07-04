import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const inputFile = process.argv[2];

if (!inputFile) {
  throw new Error("Pass a source CSV path as the first argument.");
}

const inputPath = path.resolve(root, inputFile);
const outputDir = path.resolve(root, "data");
const holdingsPath = path.join(outputDir, "portfolio-clean.csv");
const plansPath = path.join(outputDir, "portfolio-plans.csv");

const explicitAssetTypeByTicker = new Map([
  ["AMD3", "공격형 투자"],
  ["AMDL", "공격형 투자"],
  ["GGLL", "공격형 투자"],
]);

const fallbackAssetTypeByTicker = new Map([
  ["ADBE", "일반 투자"],
  ["AMD", "일반 투자"],
  ["GOOGL", "일반 투자"],
  ["IONQ", "미래기술 투자"],
  ["KO", "배당주"],
  ["META", "일반 투자"],
  ["NPCE", "미래기술 투자"],
  ["QQQ", "일반 투자"],
  ["RGTI", "미래기술 투자"],
  ["SCHD", "배당주"],
  ["STKH", "미래기술 투자"],
  ["인베니아", "일반 투자"],
]);

const bankLikeFirms = new Set(["카카오뱅크", "키움저축은행", "우리은행"]);
const outputColumns = ["Date", "Asset Type", "Securities Firm", "Ticker", "Volume"];

const sourceText = fs.readFileSync(inputPath, "utf8").replace(/^\uFEFF/, "");
const sourceRows = parseCsv(sourceText);
const knownTickers = collectKnownTickers(sourceRows);
const majorityAssetTypeByTicker = inferMajorityAssetTypes(sourceRows);

const holdings = [];
const plans = [];

for (const row of sourceRows) {
  const volume = parseVolume(row.Volume);
  const isPlan = normalizePlan(row["Plans?"]) === "Yes";
  const isBalanceCash = isBalanceName(row.Name);

  if (volume === null) {
    continue;
  }

  const inferredTicker = isBalanceCash ? "" : normalizeTicker(row.Ticker) || inferTicker(row.Name, knownTickers);
  const assetType = normalizeAssetType(row, inferredTicker, majorityAssetTypeByTicker, isBalanceCash);
  const normalized = {
    Date: parseDate(row.Date),
    "Asset Type": assetType,
    "Securities Firm": normalizeText(row["Securities Firm"]),
    Ticker: inferredTicker,
    Volume: String(volume),
  };

  if (isPlan) {
    plans.push(normalized);
  } else {
    holdings.push(normalized);
  }
}

holdings.sort(compareRows);
plans.sort(compareRows);

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(holdingsPath, toCsv(holdings, outputColumns), "utf8");
fs.writeFileSync(plansPath, toCsv(plans, outputColumns), "utf8");

console.log(`Source: ${path.basename(inputPath)}`);
console.log(`Holdings rows: ${holdings.length}`);
console.log(`Plan rows: ${plans.length}`);
console.log(`Wrote: ${path.relative(root, holdingsPath)}`);
console.log(`Wrote: ${path.relative(root, plansPath)}`);

function normalizeAssetType(row, ticker, majorityMap, isBalanceCash) {
  if (isBalanceCash) {
    return "예금";
  }

  if (explicitAssetTypeByTicker.has(ticker)) {
    return explicitAssetTypeByTicker.get(ticker);
  }

  const current = normalizeText(row["Asset Type"]);
  if (current) {
    return current;
  }

  if (majorityMap.has(ticker)) {
    return majorityMap.get(ticker);
  }

  if (fallbackAssetTypeByTicker.has(ticker)) {
    return fallbackAssetTypeByTicker.get(ticker);
  }

  const firm = normalizeText(row["Securities Firm"]);
  if (!ticker && bankLikeFirms.has(firm)) {
    return "예금";
  }

  return "미분류";
}

function inferMajorityAssetTypes(rows) {
  const counts = new Map();

  for (const row of rows) {
    const ticker = normalizeTicker(row.Ticker);
    const assetType = normalizeText(row["Asset Type"]);
    if (!ticker || !assetType || normalizePlan(row["Plans?"]) === "Yes") {
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

function collectKnownTickers(rows) {
  const tickers = new Set([...explicitAssetTypeByTicker.keys(), ...fallbackAssetTypeByTicker.keys()]);

  for (const row of rows) {
    const ticker = normalizeTicker(row.Ticker);
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
    const pattern = new RegExp(`(^|[^A-Z0-9가-힣])${escapeRegex(ticker)}([^A-Z0-9가-힣]|$)`, "u");
    return pattern.test(normalizedName);
  });

  return matches.length === 1 ? matches[0] : "";
}

function parseVolume(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const numeric = Number(normalized.replace(/[^\d.-]/g, ""));
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function parseDate(value) {
  const normalized = normalizeText(value).replace(/\s*\(GMT[+-]\d+\)\s*/i, "");
  const shortMatch = normalized.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  if (shortMatch) {
    const [, day, mon, rawYear] = shortMatch;
    const year = rawYear.length === 2 ? Number(`20${rawYear}`) : Number(rawYear);
    const month = monthIndex(mon);
    return toIsoDate(year, month, Number(day));
  }

  const longMatch = normalized.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (longMatch) {
    const [, mon, day, year] = longMatch;
    return toIsoDate(Number(year), monthIndex(mon), Number(day));
  }

  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return normalized;
  }

  throw new Error(`Unsupported date format: ${value}`);
}

function monthIndex(name) {
  const key = name.slice(0, 3).toLowerCase();
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const index = months.indexOf(key);
  if (index === -1) {
    throw new Error(`Unsupported month: ${name}`);
  }
  return index + 1;
}

function toIsoDate(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeTicker(value) {
  return normalizeText(value).toUpperCase();
}

function normalizePlan(value) {
  return normalizeText(value).toLowerCase() === "yes" ? "Yes" : "No";
}

function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function isBalanceName(value) {
  return normalizeText(value).startsWith("잔고");
}

function compareRows(a, b) {
  return (
    a.Date.localeCompare(b.Date) ||
    a["Asset Type"].localeCompare(b["Asset Type"]) ||
    a["Securities Firm"].localeCompare(b["Securities Firm"]) ||
    a.Ticker.localeCompare(b.Ticker)
  );
}

function toCsv(rows, columns) {
  return [columns.join(","), ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(","))].join("\n") + "\n";
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [headers, ...dataRows] = rows.filter((entry) => entry.some((value) => value.trim()));
  return dataRows.map((entry) => Object.fromEntries(headers.map((header, index) => [header, entry[index] ?? ""])));
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
