import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { catalogPath, normalizeCatalog, readCatalog, writeCatalog } from "./catalog-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

main().catch((error) => {
  console.error(`Catalog UI failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const server = http.createServer((request, response) => {
    routeRequest(request, response, options).catch((error) => {
      sendJson(response, 500, { ok: false, message: error.message });
    });
  });

  const port = await listenOnAvailablePort(server, options.port, options.host);
  const url = `http://${options.host}:${port}/`;
  console.log(`Catalog editor: ${url}`);
  console.log("Save writes data/catalog.json, commits it, and pushes by default.");
  console.log("Press Ctrl+C in this window to stop the server.");

  if (options.open) {
    openUrl(url);
  }
}

function parseArgs(argv) {
  const options = {
    commit: true,
    help: false,
    host: "127.0.0.1",
    open: true,
    port: 8781,
    push: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-open") {
      options.open = false;
    } else if (arg === "--no-commit") {
      options.commit = false;
      options.push = false;
    } else if (arg === "--no-push") {
      options.push = false;
    } else if (arg === "--host") {
      options.host = requireValue(argv, (index += 1), arg);
    } else if (arg === "--port") {
      options.port = Number(requireValue(argv, (index += 1), arg));
      if (!Number.isInteger(options.port) || options.port <= 0) {
        throw new Error("--port requires a positive integer.");
      }
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
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

async function routeRequest(request, response, options) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, buildPage());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/catalog") {
    sendJson(response, 200, {
      ok: true,
      catalog: readCatalog(repoRoot),
      usage: buildCatalogUsage(),
      commitDefault: options.commit,
      pushDefault: options.push,
      branch: currentBranch(),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/catalog") {
    const body = await readJsonBody(request);
    const result = saveCatalog(body.catalog, {
      commit: body.commit !== false && options.commit,
      push: body.push !== false && options.push,
    });
    sendJson(response, 200, result);
    return;
  }

  sendJson(response, 404, { ok: false, message: "Not found" });
}

function saveCatalog(rawCatalog, options) {
  const normalized = normalizeCatalog(rawCatalog);
  const nextText = `${JSON.stringify(normalized, null, 2)}\n`;
  const currentText = `${JSON.stringify(readCatalog(repoRoot), null, 2)}\n`;

  if (nextText === currentText) {
    return { ok: true, message: "No catalog changes to save.", changed: false, logs: [] };
  }

  writeCatalog(repoRoot, normalized);
  const logs = [`Wrote ${path.relative(repoRoot, catalogPath(repoRoot))}.`];

  if (!options.commit) {
    logs.push("Commit skipped.");
    return { ok: true, message: "Saved catalog without commit.", changed: true, logs };
  }

  logs.push(runGit(["add", "--", "data/catalog.json"]));
  logs.push(runGit(["commit", "-m", "Update portfolio catalog", "--", "data/catalog.json"]));

  if (!options.push) {
    logs.push("Push skipped.");
    return { ok: true, message: "Saved and committed catalog.", changed: true, logs: logs.filter(Boolean) };
  }

  const branch = currentBranch();
  if (!branch) {
    throw new Error("Could not determine current git branch for push.");
  }
  logs.push(runGit(["push", "origin", branch]));

  return { ok: true, message: "Saved, committed, and pushed catalog.", changed: true, logs: logs.filter(Boolean) };
}

function currentBranch() {
  try {
    return gitOutput(["branch", "--show-current"]).trim();
  } catch {
    return "";
  }
}

function runGit(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  }
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
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

function buildCatalogUsage() {
  const usage = {
    assetTypes: {},
    firms: {},
    tickers: {},
    rowCount: 0,
  };

  for (const fileName of ["portfolio-clean.csv", "portfolio-plans.csv"]) {
    const filePath = path.join(repoRoot, "data", fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    for (const row of parseCsv(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""))) {
      usage.rowCount += 1;
      increment(usage.assetTypes, row["Asset Type"]);
      increment(usage.firms, row["Securities Firm"]);
      increment(usage.tickers, row.Ticker);
    }
  }

  return usage;
}

function increment(record, key) {
  const normalized = String(key ?? "").trim();
  if (normalized) {
    record[normalized] = (record[normalized] || 0) + 1;
  }
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

  const [headers, ...dataRows] = rows.filter((entry) => entry.some((value) => String(value ?? "").trim()));
  if (!headers) {
    return [];
  }

  const normalizedHeaders = headers.map((header) => String(header ?? "").trim().replace(/^\uFEFF/, ""));
  return dataRows.map((entry) => Object.fromEntries(normalizedHeaders.map((header, index) => [header, entry[index] ?? ""])));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    request.on("error", reject);
  });
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function listenOnAvailablePort(server, preferredPort, host) {
  return new Promise((resolve, reject) => {
    const tryPort = (port, attemptsLeft) => {
      const onError = (error) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
          tryPort(port + 1, attemptsLeft - 1);
        } else {
          reject(error);
        }
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    };

    tryPort(preferredPort, 20);
  });
}

function openUrl(url) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function buildPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Portfolio Catalog</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f1013;
      --panel: #17191f;
      --panel-2: #20232a;
      --line: rgba(228, 231, 238, 0.13);
      --text: #f3f5f8;
      --muted: #a8afba;
      --accent: #8fb7ff;
      --danger: #f38a8a;
      --input: #101217;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    header {
      position: sticky;
      top: 0;
      z-index: 5;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 14px;
      background: rgba(15, 16, 19, 0.96);
      border-bottom: 1px solid var(--line);
    }

    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 760;
    }

    main {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 12px;
      max-width: 1480px;
      margin: 0 auto;
      padding: 12px 14px;
    }

    section {
      min-width: 0;
      padding: 10px;
      background: transparent;
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    section:nth-of-type(1) { grid-column: span 3; }
    section:nth-of-type(2) { grid-column: span 4; }
    section:nth-of-type(3) { grid-column: span 5; }

    #status,
    #log {
      grid-column: 1 / -1;
    }

    .top-actions,
    .section-head,
    .row,
    .row-actions,
    .status-line {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .top-actions {
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .section-head {
      justify-content: space-between;
      margin-bottom: 6px;
    }

    h2 {
      margin: 0;
      font-size: 14px;
      font-weight: 720;
    }

    .grid {
      display: grid;
      gap: 5px;
    }

    .row {
      min-height: 38px;
      padding: 4px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
    }

    .row > * { min-width: 0; }

    .row.asset { grid-template-columns: minmax(110px, 1fr) 34px 86px 30px; }
    .row.firm { grid-template-columns: minmax(120px, 1fr) 34px 86px 82px 30px; }
    .row.ticker { grid-template-columns: minmax(76px, 0.8fr) minmax(116px, 1fr) 34px 86px 30px; }

    input,
    select {
      width: 100%;
      height: 28px;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: var(--input);
      color: var(--text);
      padding: 0 7px;
      font: inherit;
      font-size: 12px;
    }

    input[type="color"] {
      padding: 2px;
      cursor: pointer;
    }

    label.check {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 28px;
      padding: 0 7px;
      border: 1px solid var(--line);
      border-radius: 5px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    input[type="checkbox"] {
      width: 15px;
      height: 15px;
      accent-color: var(--accent);
    }

    button {
      height: 28px;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: var(--panel-2);
      color: var(--text);
      padding: 0 10px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }

    button:hover { border-color: rgba(228, 231, 238, 0.34); }
    button.primary { background: #22304c; border-color: rgba(143, 183, 255, 0.38); }
    button.danger { color: #ffd7d7; }
    button.caution { color: #ffd89a; border-color: rgba(255, 216, 154, 0.34); }
    button.icon { width: 28px; padding: 0; }

    .status-line {
      min-height: 20px;
      color: var(--muted);
      font-size: 12px;
    }

    .status-line.good { color: var(--accent); }
    .status-line.bad { color: var(--danger); }

    .log {
      display: none;
      white-space: pre-wrap;
      max-height: 96px;
      overflow: auto;
      padding: 8px;
      margin: 0;
      background: #0b0c0f;
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
    }

    .log:not(:empty) { display: block; }

    @media (max-width: 760px) {
      header {
        position: static;
        align-items: stretch;
        flex-direction: column;
      }

      main {
        grid-template-columns: 1fr;
        padding: 10px;
      }

      section,
      section:nth-of-type(1),
      section:nth-of-type(2),
      section:nth-of-type(3) {
        grid-column: 1;
      }
      .row,
      .row.asset,
      .row.firm,
      .row.ticker {
        grid-template-columns: 1fr 48px;
      }

      .row select,
      .row .hex,
      .row label.check {
        grid-column: 1 / -1;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>Portfolio Catalog</h1>
    <div class="top-actions">
      <label class="check"><input id="commitPush" type="checkbox" checked /> Commit and push</label>
      <button id="reloadBtn" type="button">Reload</button>
      <button id="saveBtn" class="primary" type="button">Save</button>
    </div>
  </header>

  <main>
    <div id="status" class="status-line">Loading catalog...</div>
    <pre id="log" class="log"></pre>

    <section>
      <div class="section-head">
        <h2>Asset Types</h2>
        <button id="addAssetBtn" type="button">Add</button>
      </div>
      <div id="assetRows" class="grid"></div>
    </section>

    <section>
      <div class="section-head">
        <h2>Securities Firms</h2>
        <button id="addFirmBtn" type="button">Add</button>
      </div>
      <div id="firmRows" class="grid"></div>
    </section>

    <section>
      <div class="section-head">
        <h2>Tickers</h2>
        <button id="addTickerBtn" type="button">Add</button>
      </div>
      <div id="tickerRows" class="grid"></div>
    </section>
  </main>

  <script>
    const state = {
      catalog: null,
      usage: { assetTypes: {}, firms: {}, tickers: {}, rowCount: 0 },
      branch: "",
      commitDefault: true,
      pushDefault: true,
    };

    const fallbackPalette = ["#f89a9a", "#8fdda0", "#f4d66d", "#bea7ff", "#91e4d1", "#f5a363", "#8fb7ff", "#f5a3b7", "#c8de7f", "#d0a7ff"];

    document.getElementById("reloadBtn").addEventListener("click", loadCatalog);
    document.getElementById("saveBtn").addEventListener("click", saveCatalog);
    document.getElementById("addAssetBtn").addEventListener("click", () => addAssetRow());
    document.getElementById("addFirmBtn").addEventListener("click", () => addFirmRow());
    document.getElementById("addTickerBtn").addEventListener("click", () => addTickerRow());

    loadCatalog();

    async function loadCatalog() {
      setStatus("Loading catalog...");
      const response = await fetch("/api/catalog", { cache: "no-store" });
      const payload = await response.json();
      if (!payload.ok) throw new Error(payload.message || "Could not load catalog.");
      state.catalog = normalizeCatalog(payload.catalog);
      state.usage = payload.usage || { assetTypes: {}, firms: {}, tickers: {}, rowCount: 0 };
      state.branch = payload.branch || "";
      state.commitDefault = payload.commitDefault !== false;
      state.pushDefault = payload.pushDefault !== false;
      document.getElementById("commitPush").checked = state.commitDefault && state.pushDefault;
      renderAll();
      setStatus(state.branch ? "Branch: " + state.branch : "Catalog loaded.", "good");
    }

    function renderAll() {
      renderAssets();
      renderFirms();
      renderTickers();
    }

    function renderAssets() {
      const container = document.getElementById("assetRows");
      container.innerHTML = "";
      state.catalog.assetTypes.forEach((name, index) => {
        container.append(rowShell("asset", [
          textInput(name, (value) => renameAsset(index, value)),
          colorInput(colorFor("asset", name), (value) => setAssetColor(index, value)),
          hexInput(colorFor("asset", name), (value) => setAssetColor(index, value)),
          removeButton("asset type", name, () => removeAsset(index)),
        ]));
      });
    }

    function renderFirms() {
      const container = document.getElementById("firmRows");
      container.innerHTML = "";
      Object.entries(state.catalog.colors.firm).forEach(([name, color]) => {
        container.append(rowShell("firm", [
          textInput(name, (value) => renameRecordKey(state.catalog.colors.firm, name, value, renderAll)),
          colorInput(color, (value) => setFirmColor(name, value)),
          hexInput(color, (value) => setFirmColor(name, value)),
          cashCheckbox(state.catalog.bankLikeFirms.includes(name), (checked) => setFirmCashLike(name, checked)),
          removeButton("firm", name, () => removeFirm(name)),
        ]));
      });
    }

    function renderTickers() {
      const container = document.getElementById("tickerRows");
      container.innerHTML = "";
      Object.entries(state.catalog.tickerAssetTypes).forEach(([ticker, assetType]) => {
        container.append(rowShell("ticker", [
          textInput(ticker, (value) => renameTicker(ticker, value)),
          assetSelect(assetType, (value) => {
            state.catalog.tickerAssetTypes[ticker] = value;
            renderAll();
          }),
          colorInput(colorFor("ticker", ticker), (value) => setTickerColor(ticker, value)),
          hexInput(colorFor("ticker", ticker), (value) => setTickerColor(ticker, value)),
          removeButton("ticker", ticker, () => removeTicker(ticker)),
        ]));
      });
    }

    function rowShell(kind, children) {
      const row = document.createElement("div");
      row.className = "row " + kind;
      children.forEach((child) => row.append(child));
      return row;
    }

    function textInput(value, onChange) {
      const input = document.createElement("input");
      input.type = "text";
      input.value = value;
      input.addEventListener("change", () => onChange(input.value.trim()));
      return input;
    }

    function colorInput(value, onChange) {
      const input = document.createElement("input");
      input.type = "color";
      input.value = validColor(value) ? value : "#a8b3bf";
      input.addEventListener("input", () => onChange(input.value));
      return input;
    }

    function hexInput(value, onChange) {
      const input = document.createElement("input");
      input.className = "hex";
      input.type = "text";
      input.value = value;
      input.addEventListener("change", () => {
        if (validColor(input.value)) {
          onChange(input.value.toLowerCase());
        } else {
          setStatus("Use a hex color like #8fb7ff.", "bad");
          renderAll();
        }
      });
      return input;
    }

    function assetSelect(value, onChange) {
      const select = document.createElement("select");
      state.catalog.assetTypes.forEach((assetType) => {
        const option = document.createElement("option");
        option.value = assetType;
        option.textContent = assetType;
        option.selected = assetType === value;
        select.append(option);
      });
      select.addEventListener("change", () => onChange(select.value));
      return select;
    }

    function cashCheckbox(checked, onChange) {
      const label = document.createElement("label");
      label.className = "check";
      label.title = "Treat this firm as 예금 and leave Ticker empty when importing.";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = checked;
      input.addEventListener("change", () => onChange(input.checked));
      label.append(input, "예금");
      return label;
    }

    function removeButton(kind, name, onClick) {
      const button = document.createElement("button");
      const usage = removalUsage(kind, name);
      button.className = "icon " + (usage.dataRows ? "caution" : "danger");
      button.type = "button";
      button.textContent = "X";
      button.title = removalTitle(kind, name, usage);
      button.addEventListener("click", () => {
        if (confirmRemoval(kind, name, usage)) {
          onClick();
        }
      });
      return button;
    }

    function removalUsage(kind, name) {
      if (kind === "asset type") {
        return {
          dataRows: Number(state.usage.assetTypes[name] || 0),
          mappedTickers: Object.values(state.catalog.tickerAssetTypes).filter((assetType) => assetType === name).length,
        };
      }
      if (kind === "firm") {
        return {
          dataRows: Number(state.usage.firms[name] || 0),
          cashLike: state.catalog.bankLikeFirms.includes(name),
        };
      }
      return {
        dataRows: Number(state.usage.tickers[name] || 0),
      };
    }

    function removalTitle(kind, name, usage) {
      const details = removalDetails(kind, usage);
      return details.length ? "Remove " + name + ". " + details.join(" ") : "Remove " + name + ".";
    }

    function confirmRemoval(kind, name, usage) {
      const details = removalDetails(kind, usage);
      const message = [
        "Remove " + kind + " " + JSON.stringify(name) + " from the catalog?",
        "",
        ...details,
        "",
        "Existing CSV rows will not be deleted, but their color/default mapping may fall back after you save.",
      ].join("\\n");
      return window.confirm(message);
    }

    function removalDetails(kind, usage) {
      const details = [];
      if (usage.dataRows) {
        details.push("Used by " + usage.dataRows + " existing data row" + (usage.dataRows === 1 ? "." : "s."));
      }
      if (usage.mappedTickers) {
        details.push(String(usage.mappedTickers) + " ticker mapping" + (usage.mappedTickers === 1 ? " uses" : "s use") + " this asset type.");
      }
      if (usage.cashLike) {
        details.push("Currently marked as 예금 during import.");
      }
      return details;
    }

    function renameAsset(index, nextName) {
      const previousName = state.catalog.assetTypes[index];
      if (!nextName || previousName === nextName) {
        renderAll();
        return;
      }
      state.catalog.assetTypes[index] = nextName;
      renameRecordKey(state.catalog.colors.asset, previousName, nextName);
      Object.entries(state.catalog.tickerAssetTypes).forEach(([ticker, assetType]) => {
        if (assetType === previousName) state.catalog.tickerAssetTypes[ticker] = nextName;
      });
      renderAll();
    }

    function setAssetColor(index, color) {
      const name = state.catalog.assetTypes[index];
      state.catalog.colors.asset[name] = color;
      renderAll();
    }

    function removeAsset(index) {
      const name = state.catalog.assetTypes[index];
      if ([state.catalog.cashAssetType, state.catalog.unclassifiedAssetType].includes(name)) {
        setStatus("That asset type is required.", "bad");
        return;
      }
      state.catalog.assetTypes.splice(index, 1);
      delete state.catalog.colors.asset[name];
      Object.entries(state.catalog.tickerAssetTypes).forEach(([ticker, assetType]) => {
        if (assetType === name) state.catalog.tickerAssetTypes[ticker] = state.catalog.unclassifiedAssetType;
      });
      renderAll();
    }

    function setFirmColor(name, color) {
      state.catalog.colors.firm[name] = color;
      renderAll();
    }

    function setFirmCashLike(name, checked) {
      state.catalog.bankLikeFirms = checked
        ? unique([...state.catalog.bankLikeFirms, name])
        : state.catalog.bankLikeFirms.filter((firm) => firm !== name);
      renderAll();
    }

    function removeFirm(name) {
      delete state.catalog.colors.firm[name];
      state.catalog.bankLikeFirms = state.catalog.bankLikeFirms.filter((firm) => firm !== name);
      renderAll();
    }

    function renameTicker(previousTicker, nextTicker) {
      nextTicker = nextTicker.toUpperCase();
      if (!nextTicker || previousTicker === nextTicker) {
        renderAll();
        return;
      }
      state.catalog.tickerAssetTypes[nextTicker] = state.catalog.tickerAssetTypes[previousTicker];
      delete state.catalog.tickerAssetTypes[previousTicker];
      renameRecordKey(state.catalog.colors.ticker, previousTicker, nextTicker);
      renderAll();
    }

    function setTickerColor(ticker, color) {
      state.catalog.colors.ticker[ticker] = color;
      renderAll();
    }

    function removeTicker(ticker) {
      delete state.catalog.tickerAssetTypes[ticker];
      delete state.catalog.colors.ticker[ticker];
      renderAll();
    }

    function renameRecordKey(record, previousKey, nextKey, after) {
      nextKey = nextKey.trim();
      if (!nextKey || previousKey === nextKey) {
        if (after) after();
        return;
      }
      record[nextKey] = record[previousKey];
      delete record[previousKey];
      if (state.catalog.bankLikeFirms.includes(previousKey)) {
        state.catalog.bankLikeFirms = state.catalog.bankLikeFirms.map((firm) => (firm === previousKey ? nextKey : firm));
      }
      if (after) after();
    }

    function addAssetRow() {
      const name = uniqueName("New Asset Type", state.catalog.assetTypes);
      state.catalog.assetTypes.push(name);
      state.catalog.colors.asset[name] = nextColor();
      renderAll();
    }

    function addFirmRow() {
      const name = uniqueName("New Firm", Object.keys(state.catalog.colors.firm));
      state.catalog.colors.firm[name] = nextColor();
      renderAll();
    }

    function addTickerRow() {
      const ticker = uniqueName("TICKER", Object.keys(state.catalog.tickerAssetTypes));
      state.catalog.tickerAssetTypes[ticker] = state.catalog.assetTypes[0] || state.catalog.unclassifiedAssetType;
      state.catalog.colors.ticker[ticker] = nextColor();
      renderAll();
    }

    async function saveCatalog() {
      setStatus("Saving...");
      document.getElementById("log").textContent = "";
      const commitPush = document.getElementById("commitPush").checked;
      const response = await fetch("/api/catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalog: state.catalog, commit: commitPush, push: commitPush }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        setStatus(payload.message || "Save failed.", "bad");
        document.getElementById("log").textContent = (payload.logs || []).join("\\n");
        return;
      }
      state.catalog = normalizeCatalog(state.catalog);
      setStatus(payload.message, "good");
      document.getElementById("log").textContent = (payload.logs || []).join("\\n");
      renderAll();
    }

    function normalizeCatalog(raw) {
      const colors = raw.colors || {};
      return {
        schemaVersion: Number(raw.schemaVersion) || 1,
        assetTypes: unique(raw.assetTypes || []),
        cashAssetType: raw.cashAssetType || "예금",
        unclassifiedAssetType: raw.unclassifiedAssetType || "미분류",
        balanceNamePrefix: raw.balanceNamePrefix || "잔고",
        cashLabels: unique(raw.cashLabels || []),
        bankLikeFirms: unique(raw.bankLikeFirms || []),
        tickerAssetTypes: { ...(raw.tickerAssetTypes || {}) },
        colors: {
          asset: { ...(colors.asset || {}) },
          ticker: { ...(colors.ticker || {}) },
          firm: { ...(colors.firm || {}) },
          fallback: unique(colors.fallback || fallbackPalette),
        },
      };
    }

    function colorFor(kind, name) {
      return state.catalog.colors[kind][name] || nextColor();
    }

    function nextColor() {
      const used = new Set([
        ...Object.values(state.catalog.colors.asset),
        ...Object.values(state.catalog.colors.firm),
        ...Object.values(state.catalog.colors.ticker),
      ]);
      return (state.catalog.colors.fallback || fallbackPalette).find((color) => !used.has(color)) || "#a8b3bf";
    }

    function uniqueName(base, values) {
      const taken = new Set(values);
      if (!taken.has(base)) return base;
      let index = 2;
      while (taken.has(base + " " + index)) index += 1;
      return base + " " + index;
    }

    function unique(values) {
      return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
    }

    function validColor(value) {
      return /^#[0-9a-f]{6}$/i.test(String(value || "").trim());
    }

    function setStatus(message, kind) {
      const status = document.getElementById("status");
      status.className = "status-line" + (kind ? " " + kind : "");
      status.textContent = message;
    }
  </script>
</body>
</html>`;
}

function printHelp() {
  console.log(`Usage:
  node tools/catalog-ui.mjs
  node tools/catalog-ui.mjs --no-push
  node tools/catalog-ui.mjs --no-commit
  node tools/catalog-ui.mjs --no-open

Options:
  --port PORT   Start on this port, or the next available port.
  --host HOST   Bind host. Defaults to 127.0.0.1.
  --no-open     Print the URL without opening a browser.
  --no-commit   Save data/catalog.json without committing or pushing.
  --no-push     Save and commit data/catalog.json without pushing.
`);
}
