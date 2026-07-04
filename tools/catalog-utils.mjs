import fs from "node:fs";
import path from "node:path";

const DEFAULT_FALLBACK_COLORS = [
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

export function catalogPath(repoRoot) {
  return path.join(repoRoot, "data", "catalog.json");
}

export function readCatalog(repoRoot) {
  const filePath = catalogPath(repoRoot);
  if (!fs.existsSync(filePath)) {
    return normalizeCatalog({});
  }
  return normalizeCatalog(JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")));
}

export function writeCatalog(repoRoot, catalog) {
  const filePath = catalogPath(repoRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalizeCatalog(catalog), null, 2)}\n`, "utf8");
}

export function catalogToMaps(catalog) {
  const normalized = normalizeCatalog(catalog);
  return {
    tickerAssetTypeByTicker: new Map(Object.entries(normalized.tickerAssetTypes)),
    bankLikeFirms: new Set(normalized.bankLikeFirms),
    colors: {
      asset: new Map(Object.entries(normalized.colors.asset)),
      ticker: new Map(Object.entries(normalized.colors.ticker)),
      firm: new Map(Object.entries(normalized.colors.firm)),
    },
    fallbackColors: normalized.colors.fallback,
  };
}

export function normalizeCatalog(rawCatalog) {
  const raw = rawCatalog && typeof rawCatalog === "object" ? rawCatalog : {};
  const rawColors = raw.colors && typeof raw.colors === "object" ? raw.colors : {};
  const cashAssetType = normalizeText(raw.cashAssetType) || "예금";
  const unclassifiedAssetType = normalizeText(raw.unclassifiedAssetType) || "미분류";
  const fallbackColors = uniqueList(rawColors.fallback || DEFAULT_FALLBACK_COLORS).map(normalizeColor).filter(Boolean);

  return {
    schemaVersion: Number(raw.schemaVersion) || 1,
    assetTypes: uniqueList([...(Array.isArray(raw.assetTypes) ? raw.assetTypes : []), cashAssetType, unclassifiedAssetType]),
    cashAssetType,
    unclassifiedAssetType,
    balanceNamePrefix: normalizeText(raw.balanceNamePrefix) || "잔고",
    cashLabels: uniqueList(raw.cashLabels || []),
    bankLikeFirms: uniqueList(raw.bankLikeFirms || []).sort((a, b) => a.localeCompare(b, "ko")),
    tickerAssetTypes: sortRecord(normalizeRecord(raw.tickerAssetTypes, normalizeTicker, normalizeText)),
    colors: {
      asset: sortRecord(normalizeRecord(rawColors.asset, normalizeText, normalizeColor)),
      ticker: sortRecord(normalizeRecord(rawColors.ticker, normalizeTicker, normalizeColor)),
      firm: sortRecord(normalizeRecord(rawColors.firm, normalizeText, normalizeColor)),
      fallback: fallbackColors.length ? fallbackColors : DEFAULT_FALLBACK_COLORS,
    },
  };
}

export function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function normalizeTicker(value) {
  return normalizeText(value).toUpperCase();
}

export function normalizeColor(value) {
  const color = normalizeText(value);
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : color;
}

function normalizeRecord(record, keyFn, valueFn) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {};
  }

  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = keyFn(rawKey);
    const value = valueFn(rawValue);
    if (key && value) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function sortRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b, "ko")));
}

function uniqueList(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}
