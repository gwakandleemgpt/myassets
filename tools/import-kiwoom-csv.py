#!/usr/bin/env python3
"""Import Kiwoom's three-row transaction CSV without duplicating older records."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from decimal import Decimal, InvalidOperation
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
KIWOOM_TRANSACTIONS = ROOT / "private" / "transactions" / "kiwoom" / "transactions.csv"
CONSOLIDATED_TRANSACTIONS = ROOT / "private" / "consolidated" / "transactions.csv"
CONSOLIDATED_ACCOUNTS = ROOT / "private" / "consolidated" / "accounts.csv"
CATALOG = ROOT / "data" / "catalog.json"


def read_text(path: Path) -> str:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "cp949", "euc-kr"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"Unsupported text encoding: {path}")


def number(value: str) -> Decimal:
    normalized = str(value or "").replace(",", "").strip()
    if not normalized:
        return Decimal(0)
    try:
        return Decimal(normalized)
    except InvalidOperation as error:
        raise ValueError(f"Invalid numeric value: {value!r}") from error


def decimal_text(value: Decimal) -> str:
    if value == value.to_integral():
        return str(int(value))
    return format(value.normalize(), "f")


def normalize_detail_row(row: list[str]) -> list[str]:
    if len(row) == 12 and row[1] in {"외화매수", "외화매도"}:
        return row[:2] + [f"{row[2]},{row[3]}"] + row[4:]
    if len(row) != 11:
        raise ValueError(f"Expected 11 columns in detail row, found {len(row)}: {row}")
    return row


def statement_blocks(text: str) -> list[tuple[int, list[str], list[str], list[str]]]:
    lines = text.splitlines()
    if len(lines) < 3 or not lines[0].startswith("거래일자,"):
        raise ValueError("This does not look like a Kiwoom transaction-history CSV")
    if (len(lines) - 3) % 3:
        raise ValueError("Kiwoom transaction rows are not complete three-row blocks")

    blocks = []
    for offset in range(3, len(lines), 3):
        summary = next(csv.reader([lines[offset]]))
        detail = normalize_detail_row(next(csv.reader([lines[offset + 1]])))
        foreign = next(csv.reader([lines[offset + 2]]))
        if len(summary) != 11 or len(foreign) != 11:
            raise ValueError(f"Malformed transaction block beginning at line {offset + 1}")
        blocks.append((offset + 1, summary, detail, foreign))
    return blocks


def transaction_key(row: dict[str, str]) -> tuple[str, ...]:
    return tuple(
        row.get(column, "")
        for column in (
            "trade_date",
            "transaction_type",
            "transaction_detail",
            "currency",
            "ticker",
            "quantity",
            "unit_price_native",
            "transaction_amount_native",
            "settlement_amount_native",
        )
    )


def read_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def write_rows(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n", extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def sync_account_registry(kiwoom_rows: list[dict[str, str]]) -> None:
    fields, accounts = read_rows(CONSOLIDATED_ACCOUNTS)
    for account in accounts:
        if account["security_firm"] != "키움증권":
            continue
        account["transaction_count"] = str(len(kiwoom_rows))
        account["first_transaction_date"] = min(row["trade_date"] for row in kiwoom_rows)
        account["last_transaction_date"] = max(row["trade_date"] for row in kiwoom_rows)
        break
    write_rows(CONSOLIDATED_ACCOUNTS, fields, accounts)


def parsed_rows(text: str, existing: list[dict[str, str]]) -> list[dict[str, str]]:
    ticker_asset_types = json.loads(CATALOG.read_text(encoding="utf-8"))["tickerAssetTypes"]
    existing_keys = {transaction_key(row) for row in existing}
    next_sequence = max((int(row["sequence"]) for row in existing), default=0) + 1
    cash = {"KRW": Decimal(0), "USD": Decimal(0)}
    output = []

    for source_line, summary, detail, foreign in statement_blocks(text):
        trade_date = summary[0].replace("/", "-")
        currency = summary[2]
        transaction_detail = detail[1]
        transaction_type = transaction_detail if summary[1] == "매매" else summary[1]
        ticker = detail[0].strip()
        quantity = number(summary[3])
        unit_price = number(detail[2])
        amount_native = number(foreign[4] if currency != "KRW" else summary[4])
        settlement_native = number(foreign[5] if currency != "KRW" else summary[5])
        cash_after_native = number(detail[5] if currency != "KRW" else detail[4])
        cash_after_krw = number(detail[4])
        cash_before_native = cash.get(currency, Decimal(0))
        cash_before_krw = cash["KRW"]
        position_after = number(detail[7]) if transaction_type in {"매수", "매도"} else Decimal(0)
        if transaction_type == "매수":
            position_before = position_after - quantity
        elif transaction_type == "매도":
            position_before = position_after + quantity
        else:
            position_before = Decimal(0)

        candidate = {
            "transaction_id": "",
            "sequence": "",
            "security_firm": "키움증권",
            "trade_date": trade_date,
            "settlement_date": trade_date,
            "transaction_type": transaction_type,
            "transaction_detail": transaction_detail,
            "instrument_name": foreign[1].strip(),
            "instrument_name_export": foreign[1].strip(),
            "instrument_code": ticker,
            "ticker": ticker,
            "asset_type": ticker_asset_types.get(ticker, ""),
            "currency": currency,
            "quantity": decimal_text(quantity),
            "unit_price_native": decimal_text(unit_price),
            "transaction_amount_native": decimal_text(amount_native),
            "settlement_amount_native": decimal_text(settlement_native),
            "cash_balance_before_native": decimal_text(cash_before_native),
            "cash_balance_after_native": decimal_text(cash_after_native),
            "net_cash_change_native": decimal_text(cash_after_native - cash_before_native),
            "position_balance_before": decimal_text(position_before) if transaction_type in {"매수", "매도"} else "",
            "position_balance_after": decimal_text(position_after) if transaction_type in {"매수", "매도"} else "",
            "fee_native": decimal_text(number(foreign[6]) if currency != "KRW" else Decimal(0)),
            "overseas_tax_native": decimal_text(number(foreign[10]) if currency != "KRW" else Decimal(0)),
            "stamp_tax_native": decimal_text(number(summary[7])),
            "transaction_amount_krw": decimal_text(number(summary[4])),
            "settlement_amount_krw": decimal_text(number(summary[5])),
            "cash_balance_before_krw": decimal_text(cash_before_krw),
            "cash_balance_after_krw": decimal_text(cash_after_krw),
            "net_cash_change_krw": decimal_text(cash_after_krw - cash_before_krw),
            "fee_krw": "0",
            "transaction_tax_krw": decimal_text(number(summary[6])),
            "other_tax_krw": "0",
            "exchange_rate": decimal_text(unit_price) if summary[1] == "환전" else "",
            "detailed_source_row": str(source_line + 1),
            "summary_source_row": str(source_line),
        }

        cash[currency] = cash_after_native
        cash["KRW"] = cash_after_krw
        key = transaction_key(candidate)
        if key in existing_keys:
            continue

        digest_source = "|".join(key + (candidate["instrument_name"],))
        candidate["transaction_id"] = f"kiwoom-{hashlib.sha256(digest_source.encode()).hexdigest()[:24]}"
        candidate["sequence"] = str(next_sequence)
        next_sequence += 1
        existing_keys.add(key)
        output.append(candidate)

    return output


def import_file(source: Path, dry_run: bool) -> list[dict[str, str]]:
    text = read_text(source)
    fields, existing = read_rows(KIWOOM_TRANSACTIONS)
    additions = parsed_rows(text, existing)
    if dry_run:
        return additions

    combined = existing + additions
    if additions:
        write_rows(KIWOOM_TRANSACTIONS, fields, combined)

        consolidated_fields, consolidated = read_rows(CONSOLIDATED_TRANSACTIONS)
        consolidated_ids = {row["transaction_id"] for row in consolidated}
        consolidated_additions = [row for row in additions if row["transaction_id"] not in consolidated_ids]
        insert_at = max(
            (index + 1 for index, row in enumerate(consolidated) if row["security_firm"] == "키움증권"),
            default=len(consolidated),
        )
        consolidated[insert_at:insert_at] = consolidated_additions
        if consolidated_additions:
            write_rows(CONSOLIDATED_TRANSACTIONS, consolidated_fields, consolidated)

        archive = ROOT / "private" / "source" / f"키움_{additions[0]['trade_date']}_{additions[-1]['trade_date']}.csv"
        archive.write_text(text, encoding="utf-8", newline="")
    sync_account_registry(combined)
    return additions


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    additions = import_file(args.source.resolve(), args.dry_run)
    external = [
        row
        for row in additions
        if row["currency"] == "KRW" and row["transaction_detail"] in {"이체입금", "이체출금", "은행이체출금", "이체입금(지급결제)"}
    ]
    mode = "Would import" if args.dry_run else "Imported"
    print(f"{mode} {len(additions)} new Kiwoom transactions")
    if additions:
        print(f"Coverage added: {additions[0]['trade_date']} through {additions[-1]['trade_date']}")
    for row in external:
        print(f"External flow: {row['trade_date']} {row['transaction_detail']} {row['net_cash_change_krw']} KRW")


if __name__ == "__main__":
    main()
