#!/usr/bin/env python3
"""Build public monthly pure-investment returns from the private reconstruction archive."""

from __future__ import annotations

import csv
from collections import defaultdict
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / "private"
OUTPUT = ROOT / "data" / "investment-returns.csv"
FIRMS = {"나무증권", "키움증권", "삼성증권"}
FIRST_COMPLETE_MONTH_START = "2020-04-01"

BROKER_TRANSACTION_FILES = [
    PRIVATE / "transactions" / "transactions.csv",
    PRIVATE / "transactions" / "kiwoom" / "transactions.csv",
    PRIVATE / "transactions" / "samsung" / "transactions.csv",
]
BANK_LEDGER_FILES = [
    PRIVATE / "transactions" / "wooribank" / "cash-ledger.csv",
    PRIVATE / "transactions" / "kiwoomsavings" / "cash-ledger.csv",
]

OUTPUT_COLUMNS = [
    "Period Start",
    "Period End",
    "Monthly Return",
    "Cumulative Return",
    "Confidence",
]


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def portfolio_values() -> dict[str, float]:
    totals: dict[str, float] = defaultdict(float)
    source = PRIVATE / "consolidated" / "portfolio-estimated.csv"
    for row in read_rows(source):
        if row["Securities Firm"] in FIRMS:
            totals[row["Date"]] += float(row["Volume"])
    return dict(totals)


def is_broker_external_transfer(row: dict[str, str]) -> bool:
    if row.get("currency") != "KRW":
        return False
    return (
        row.get("transaction_detail")
        in {"이체입금", "이체출금", "은행이체출금", "이체입금(지급결제)"}
        or row.get("transaction_type") in {"이체입금", "이체출금"}
    )


def broker_flows() -> list[dict[str, object]]:
    flows: list[dict[str, object]] = []
    for source in BROKER_TRANSACTION_FILES:
        for row in read_rows(source):
            if not is_broker_external_transfer(row):
                continue
            flows.append(
                {
                    "date": row["trade_date"],
                    "amount": float(row["net_cash_change_krw"]),
                    "firm": row["security_firm"],
                    "source": "broker",
                }
            )
    return flows


def mapped_broker(text: str) -> str:
    if any(token in text for token in ("NH임", "NH투 ", "NH투자증권", "나무증권")):
        return "나무증권"
    if any(token in text for token in ("키움임", "키움 임", "키움증권")):
        return "키움증권"
    if any(token in text for token in ("삼성 임", "삼성 정", "삼성증권")):
        return "삼성증권"
    return ""


def bank_side_broker_flows() -> list[dict[str, object]]:
    flows: list[dict[str, object]] = []
    for source in BANK_LEDGER_FILES:
        for row in read_rows(source):
            description = " ".join(
                row.get(column, "")
                for column in ("counterparty", "institution", "memo", "description")
            )
            firm = mapped_broker(description)
            signed_bank_amount = float(row.get("signed_amount_krw") or 0)
            if not firm or not signed_bank_amount:
                continue
            flows.append(
                {
                    "date": row["trade_date"],
                    "amount": -signed_bank_amount,
                    "firm": firm,
                    "source": "bank",
                }
            )
    return flows


def within_match_tolerance(left: dict[str, object], right: dict[str, object]) -> bool:
    if left["firm"] != right["firm"] or float(left["amount"]) * float(right["amount"]) <= 0:
        return False
    date_gap = abs((date.fromisoformat(str(left["date"])) - date.fromisoformat(str(right["date"]))).days)
    amount_gap = abs(abs(float(left["amount"])) - abs(float(right["amount"])))
    tolerance = max(2_000, abs(float(left["amount"])) * 0.005)
    return date_gap <= 1 and amount_gap <= tolerance


def supplement_missing_broker_flows(primary: list[dict[str, object]]) -> list[dict[str, object]]:
    used_primary_indexes: set[int] = set()
    supplements: list[dict[str, object]] = []
    for bank_flow in bank_side_broker_flows():
        matches = []
        for index, broker_flow in enumerate(primary):
            if index in used_primary_indexes or not within_match_tolerance(bank_flow, broker_flow):
                continue
            amount_gap = abs(abs(float(bank_flow["amount"])) - abs(float(broker_flow["amount"])))
            date_gap = abs(
                (date.fromisoformat(str(bank_flow["date"])) - date.fromisoformat(str(broker_flow["date"]))).days
            )
            matches.append((amount_gap, date_gap, index))
        if matches:
            used_primary_indexes.add(min(matches)[2])
        elif abs(float(bank_flow["amount"])) >= 10_000:
            supplements.append(bank_flow)
    return supplements


def confidence_for(_period_start: str, _monthly_return: float) -> str:
    return "confirmed"


def modified_dietz(
    period_start: str,
    period_end: str,
    start_value: float,
    end_value: float,
    flows: list[dict[str, object]],
) -> float | None:
    start_day = date.fromisoformat(period_start)
    end_day = date.fromisoformat(period_end)
    period_days = (end_day - start_day).days
    period_flows = [flow for flow in flows if period_start < str(flow["date"]) <= period_end]
    net_flow = sum(float(flow["amount"]) for flow in period_flows)
    weighted_flow = sum(
        ((end_day - date.fromisoformat(str(flow["date"]))).days / period_days) * float(flow["amount"])
        for flow in period_flows
    )
    denominator = start_value + weighted_flow
    if denominator <= 1_000:
        return None
    return (end_value - start_value - net_flow) / denominator


def build_rows() -> list[dict[str, str]]:
    values = portfolio_values()
    dates = sorted(day for day in values if day >= FIRST_COMPLETE_MONTH_START)
    flows = broker_flows()
    flows.extend(supplement_missing_broker_flows(flows))
    cumulative_factor = 1.0
    output: list[dict[str, str]] = []

    for period_start, period_end in zip(dates, dates[1:]):
        monthly_return = modified_dietz(
            period_start,
            period_end,
            values[period_start],
            values[period_end],
            flows,
        )
        if monthly_return is None:
            continue
        cumulative_factor *= 1 + monthly_return
        output.append(
            {
                "Period Start": period_start,
                "Period End": period_end,
                "Monthly Return": f"{monthly_return:.10f}",
                "Cumulative Return": f"{cumulative_factor - 1:.10f}",
                "Confidence": confidence_for(period_start, monthly_return),
            }
        )
    return output


def main() -> None:
    rows = build_rows()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=OUTPUT_COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

    latest = rows[-1]
    best = max(rows, key=lambda row: float(row["Monthly Return"]))
    worst = min(rows, key=lambda row: float(row["Monthly Return"]))
    print(f"Wrote {len(rows)} monthly return periods to {OUTPUT}")
    print(f"Cumulative return: {float(latest['Cumulative Return']) * 100:.1f}%")
    print(f"Best month: {best['Period Start']} ({float(best['Monthly Return']) * 100:+.1f}%)")
    print(f"Worst month: {worst['Period Start']} ({float(worst['Monthly Return']) * 100:+.1f}%)")


if __name__ == "__main__":
    main()
