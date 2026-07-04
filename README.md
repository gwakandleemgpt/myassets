# Asset Monitor

Static GitHub Pages dashboard for monitoring personal asset trends from CSV snapshots.

## Run Locally

```powershell
node tools/clean-data.mjs path\to\source-export.csv
python -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/`.

## Repo Update Workflow

Use the browser dashboard for viewing committed CSV data. Use the interactive importer when you want to add new screenshot-derived snapshots permanently:

1. Double-click `import-paste.bat`, or run:

```powershell
.\import-paste.bat
```

2. Paste the clipboard system prompt into the LLM chat webpage.
3. Give the LLM one asset-app screenshot.
4. Paste the LLM data rows into the terminal.
5. Repeat steps 3-4 for the next screenshots.
6. Type `DONE` on its own line after the final pasted rows.

The importer accumulates the pasted batches, normalizes the rows, merges holdings into `data/portfolio-clean.csv`, commits the CSV data files, and pushes the current git branch to `origin`.

Useful checks:

```powershell
node tools/import-paste.mjs --prompt-only
node tools/import-paste.mjs --dry-run
node tools/import-paste.mjs --no-push
node tools/import-paste.mjs snapshot.csv --no-commit
```

Interactive commands:

- `END`: optional legacy command; no longer needed.
- `DONE`: import all pasted rows.
- `PROMPT`: copy the LLM system prompt to your clipboard again and print it as a fallback.
- `ABORT`: quit without writing files.

## Catalog Management

Asset types, securities firms, ticker-to-asset-type mappings, and dashboard colors live in `data/catalog.json`.

To edit them with a visual color-picker tool, double-click `edit-catalog.bat`, or run:

```powershell
.\edit-catalog.bat
```

The editor can add or update:

- Asset types and their chart colors
- Securities firms/banks and their chart colors
- Whether a firm should be treated as `예금` with an empty ticker
- Tickers, their asset types, and their chart colors

The editor opens in your browser with color pickers, hex fields, and row previews. By default, Save writes `data/catalog.json`, commits that file, and pushes the current git branch to `origin`.

Useful checks:

```powershell
node tools/catalog-ui.mjs --no-push
node tools/catalog-ui.mjs --no-commit
```

## Future Plan

The Future Plan tab starts as an editable copy of the latest actual holdings snapshot. It does not load `data/portfolio-plans.csv` on startup. Brokerage/firm is ignored in the working plan, so rows are merged by asset type and ticker. Edit volumes directly in the table, remove rows with `X`, add new rows from the form, or use `Reset latest` to rebuild the working plan from the latest snapshot.

## LLM Output Format

The tool copies a complete system prompt to your clipboard at launch, then prints it as a fallback. Its core instruction is that the LLM should return only plain CSV data rows per screenshot:

```text
Return only CSV data rows. Do not include a header. Use this column order:
Date,Asset Type,Securities Firm,Ticker,Volume

Rules:
- Use YYYY-MM-DD for Date on every row.
- Use one of the Asset Type values listed in the copied system prompt.
- Extract only actual/current holdings. Do not output future plans, target plans, or a Plans? column.
- Treat `키움저축은행`, `우리은행`, and `예수금` rows as `예금` with an empty `Ticker`.
- Use an empty Ticker for cash/deposit rows.
- Use integer KRW Volume values. If commas are included, quote the value.
- Do not include commentary before or after the rows.
```

Example:

```csv
2026-07-04,일반 투자,키움증권,AMD,1234567
2026-07-04,예금,카카오뱅크,,20000000
2026-07-04,배당주,,SCHD,5000000
```

Notes:

- Pasted LLM rows are imported as actual holding data.
- `Name` is optional for older exports; if present and starts with `잔고`, the row is treated as `예금`.
- If `Asset Type` is omitted for a known ticker, the importer reuses that ticker's existing asset type history.

## Data Cleaning

The full source CSV cleaner remains available:

```powershell
node tools/clean-data.mjs path\to\source-export.csv
```

It produces:

- `data/portfolio-clean.csv`: actual holdings used by the dashboard
- `data/portfolio-plans.csv`: archived source rows that had `Plans? = Yes`

Cleaning rules:

- Drops `Name`
- Skips rows without `Volume`
- Splits source rows with `Plans? = Yes` into `data/portfolio-plans.csv` for archive/reference only
- Writes split output files without a `Plans?` column
- Normalizes dates to `YYYY-MM-DD`
- Normalizes volumes to plain numbers
- Uses `data/catalog.json` for ticker asset type defaults, securities firm deposit handling, and known colors
- Treats `잔고...` rows as `예금`
- Uses existing ticker history/defaults to fill missing asset types where possible

## GitHub Pages

GitHub Pages is static, so the site itself does not write back into the repository. Permanent data updates go through `tools/import-paste.mjs`; catalog updates go through `tools/catalog-ui.mjs`. Both tools can commit and push their repo changes with git.
