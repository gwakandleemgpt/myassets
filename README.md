# Asset Monitor

Static GitHub Pages dashboard for monitoring personal asset trends from CSV snapshots.

## Run Locally

```powershell
node tools/clean-data.mjs
python -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/`.

## Repo Update Workflow

Use the browser dashboard for viewing committed CSV data. Use the interactive importer when you want to add a new screenshot-derived snapshot permanently:

1. Give an LLM a screenshot of the asset app.
2. Ask it to return only the CSV format below.
3. Run:

```powershell
node tools/import-paste.mjs
```

4. Paste the LLM output into the terminal.
5. Type `END` on its own line and press Enter.

The importer normalizes the pasted rows, merges holdings into `data/portfolio-clean.csv`, merges plan rows into `data/portfolio-plans.csv`, commits those two files, and pushes the current git branch to `origin`.

Useful checks:

```powershell
node tools/import-paste.mjs --dry-run
node tools/import-paste.mjs --no-push
node tools/import-paste.mjs snapshot.csv --no-commit
```

## LLM Output Format

Ask the LLM to return only one fenced CSV block:

```text
Return only a CSV code block. Use this exact header:
Date,Asset Type,Plans?,Securities Firm,Ticker,Volume

Rules:
- Use YYYY-MM-DD for Date on every row.
- Use one of these Asset Type values when possible: 공격형 투자, 일반 투자, 미래기술 투자, 배당주, 예금, 비상금, 소비, 미분류.
- Use Plans? = No for current holdings and Plans? = Yes for future-plan rows.
- Use an empty Ticker for cash/deposit rows.
- Use integer KRW Volume values. If commas are included, quote the value.
- Do not include commentary before or after the CSV block.
```

Example:

```csv
Date,Asset Type,Plans?,Securities Firm,Ticker,Volume
2026-07-04,일반 투자,No,키움증권,AMD,1234567
2026-07-04,예금,No,카카오뱅크,,20000000
2026-07-04,배당주,Yes,,SCHD,5000000
```

Notes:

- `Plans? = Yes` is stored in the Future Plan dataset.
- `Plans? = No` is stored as actual holding data.
- `Name` is optional for older exports; if present and starts with `잔고`, the row is treated as `예금`.
- If `Asset Type` is omitted for a known ticker, the importer reuses that ticker's existing asset type history.

## Data Cleaning

The full source CSV cleaner remains available:

```powershell
node tools/clean-data.mjs
```

It produces:

- `data/portfolio-clean.csv`: actual holdings used by the dashboard
- `data/portfolio-plans.csv`: historical `Plans? = Yes` rows used by the Future Plan tab

Cleaning rules:

- Drops `Name`
- Skips rows without `Volume`
- Splits `Plans? = Yes` rows into plan history
- Normalizes dates to `YYYY-MM-DD`
- Normalizes volumes to plain numbers
- Sets `AMDL`, `GGLL`, and `AMD3` to `공격형 투자`
- Treats `잔고...` rows as `예금`
- Uses existing ticker history/defaults to fill missing asset types where possible

## GitHub Pages

GitHub Pages is static, so the site itself does not write back into the repository. Permanent updates go through `tools/import-paste.mjs`, which waits for pasted input in the terminal, edits the repo CSVs, and pushes them with git.
