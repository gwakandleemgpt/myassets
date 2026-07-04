# Asset Monitor

Static GitHub Pages dashboard for monitoring personal asset trends from CSV snapshots.

## Run Locally

```powershell
node tools/clean-data.mjs
python -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/`.

## Data Workflow

The source CSV is cleaned into:

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

## Upload Format

For LLM-extracted screenshot data, paste CSV with these columns:

```csv
Date,Asset Type,Plans?,Securities Firm,Ticker,Volume
2026-07-04,일반 투자,No,키움증권,AMD,1234567
2026-07-04,배당주,Yes,,SCHD,5000000
```

Notes:

- Use `YYYY-MM-DD` dates.
- `Volume` can be numeric or formatted like `₩1,234,567`.
- `Plans? = Yes` is stored in the Future Plan tab.
- `Plans? = No` is stored as actual holding data.
- `Name` is optional on upload; if present and starts with `잔고`, the row is treated as `예금`.

## GitHub Pages

GitHub Pages is static, so the website cannot safely write back into the repository by itself without a GitHub API token or a separate backend. This dashboard stores uploaded data in browser `localStorage` and lets you export CSV.

For permanent updates, export from the site or run the cleaner locally, commit the updated `data/*.csv`, and push to the `github.io` repository.
