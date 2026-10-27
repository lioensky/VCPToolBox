"""Optional user-run downloads of daily bars and financials for VTrade's local JSON sources.

The VTrade server never imports or runs this file. Install AKShare or baostock in your own Python
environment, choose your own securities and dates, and keep the output outside the source tree.
"""

import argparse
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import json
import math
import os
from pathlib import Path
import re
import tempfile

SOURCE = {"adjustment": "none", "currency": "CNY", "timezone": "Asia/Shanghai", "volumeUnit": "shares"}
AKSHARE_FIELDS = {
    "eps": ("每股收益", "每股收益，元"),
    "revenue": ("营业总收入-营业总收入", "营业总收入，元"),
    "revenueYoY": ("营业总收入-同比增长", "营业总收入同比增长，%"),
    "netProfit": ("净利润-净利润", "净利润，元"),
    "netProfitYoY": ("净利润-同比增长", "净利润同比增长，%"),
    "bps": ("每股净资产", "每股净资产，元"),
    "roe": ("净资产收益率", "净资产收益率，%"),
    "ocfps": ("每股经营现金流量", "每股经营现金流量，元"),
    "grossMargin": ("销售毛利率", "销售毛利率，%"),
}
BAOSTOCK_FIELDS = {
    "roeAvg": "净资产收益率（平均），小数",
    "npMargin": "销售净利率，小数",
    "gpMargin": "销售毛利率，小数",
    "netProfit": "净利润，元",
    "epsTTM": "每股收益 TTM，元",
    "MBRevenue": "主营营业收入，元",
    "totalShare": "总股本，股",
    "liqaShare": "流通股本，股",
    "YOYEquity": "净资产同比增长率，小数",
    "YOYAsset": "总资产同比增长率，小数",
    "YOYNI": "净利润同比增长率，小数",
    "YOYEPSBasic": "基本每股收益同比增长率，小数",
    "YOYPNI": "归母净利润同比增长率，小数",
}


def scaled_integer(value, factor, field):
    try:
        number = Decimal(str(value)) * factor
        if not number.is_finite() or number != number.to_integral_value() or number < 0:
            raise ValueError(f"Invalid {field}: expected a nonnegative exact integer after conversion")
        return int(number)
    except InvalidOperation as error:
        raise ValueError(f"Invalid {field}") from error


def security(symbol):
    """VTrade symbol (SH.xxxxxx or xxxxxx.SH) -> (VTrade symbol, exchange, six digits)."""
    match = re.fullmatch(r"(SH|SZ|BJ)\.(\d{6})|(\d{6})\.(SH|SZ|BJ)", symbol.strip(), re.IGNORECASE)
    if not match:
        raise ValueError(f"Use symbols like SH.xxxxxx or xxxxxx.SZ (six digits), not {symbol!r}")
    exchange, code = (match[1] or match[4]).upper(), match[2] or match[3]
    return f"{exchange}.{code}", exchange, code


def number(value):
    if value is None or value == "":
        return None
    result = float(value)
    return None if math.isnan(result) or math.isinf(result) else result


def day(value):
    return date.fromisoformat(str(value)[:10]).isoformat()


def optional_day(value):
    if value is None or value == "" or str(value) in ("NaT", "nan", "None"):
        return None
    return day(value)


def quarters(years, today=None):
    """Report quarters whose period has ended; unpublished future periods are not requested."""
    today = today or date.today()
    ends = ["03-31", "06-30", "09-30", "12-31"]
    return [(year, q) for year in years for q in (1, 2, 3, 4) if date.fromisoformat(f"{year}-{ends[q - 1]}") < today]


def bars_from_akshare(records):
    """stock_zh_a_hist(adjust=""): prices in yuan, 成交量 in lots of 100 shares."""
    bars = []
    for row in records:
        bar = {"date": day(row["日期"])}
        for source, target in [("开盘", "openCents"), ("最高", "highCents"), ("最低", "lowCents"), ("收盘", "closeCents")]:
            bar[target] = scaled_integer(row[source], 100, source)
            if bar[target] <= 0:
                raise ValueError("Nonpositive daily prices are not supported")
        bar["volume"] = scaled_integer(row["成交量"], 100, "volume (lots)")
        bars.append(bar)
    return bars


def bars_from_baostock(records):
    """query_history_k_data_plus(adjustflag="3"): prices in yuan, volume in shares, tradestatus 0 = suspended."""
    bars = []
    for row in records:
        bar = {"date": day(row["date"])}
        for source, target in [("open", "openCents"), ("high", "highCents"), ("low", "lowCents"), ("close", "closeCents")]:
            bar[target] = scaled_integer(row[source], 100, source)
            if bar[target] <= 0:
                raise ValueError("Nonpositive daily prices are not supported")
        bar["volume"] = scaled_integer(row["volume"] or "0", 1, "volume (shares)")
        if str(row.get("tradestatus")) == "0":
            bar["suspended"] = True
        bars.append(bar)
    return bars


def daily_dataset(provider, series):
    securities = []
    for symbol, name, bars in series:
        bars.sort(key=lambda bar: bar["date"])
        if len(bars) < 2 or len({bar["date"] for bar in bars}) != len(bars):
            raise ValueError(f"{symbol}: expected at least two distinct daily bars")
        securities.append({"symbol": symbol, "name": name or symbol, "bars": bars})
    return {"schemaVersion": 1, "source": {"kind": provider, "name": f"用户通过 {provider} 下载的日线", **SOURCE},
            "securities": securities}


def financials_from_akshare(frames, symbols):
    """stock_yjbb_em(date=period) per report period. 最新公告日期 is the latest announcement, so it is conservative."""
    by_code = {security(symbol)[2]: security(symbol)[0] for symbol in symbols}
    reports = {symbol: [] for symbol in by_code.values()}
    for period, records in frames:
        for row in records:
            symbol = by_code.get(str(row["股票代码"]).zfill(6))
            if symbol is None:
                continue
            reports[symbol].append({
                "period": day(period),
                "publishedAt": optional_day(row.get("最新公告日期")),
                "metrics": {key: number(row.get(column)) for key, (column, _) in AKSHARE_FIELDS.items()},
            })
    fields = {key: text for key, (_, text) in AKSHARE_FIELDS.items()}
    return financial_dataset("akshare", fields, reports)


def financials_from_baostock(rows_by_symbol):
    """query_profit_data and query_growth_data rows merged by statDate; the later pubDate wins (conservative)."""
    reports = {}
    for symbol, rows in rows_by_symbol.items():
        merged = {}
        for row in rows:
            period = day(row["statDate"])
            item = merged.setdefault(period, {"period": period, "publishedAt": None, "metrics": {}})
            published = optional_day(row.get("pubDate"))
            if published:
                item["publishedAt"] = max(item["publishedAt"] or published, published)
            for key in BAOSTOCK_FIELDS:
                if key in row:
                    item["metrics"][key] = number(row[key])
        reports[symbol] = list(merged.values())
    return financial_dataset("baostock", dict(BAOSTOCK_FIELDS), reports)


def financial_dataset(provider, fields, reports):
    return {"schemaVersion": 1, "kind": "financials",
            "source": {"name": f"用户通过 {provider} 下载的财务摘要", "provider": provider}, "fields": fields,
            "securities": [{"symbol": symbol, "reports": sorted(items, key=lambda r: r["period"])}
                           for symbol, items in reports.items()]}


def baostock_rows(result):
    if result.error_code != "0":
        raise RuntimeError(f"baostock error {result.error_code}: {result.error_msg}")
    rows = []
    while result.next():
        rows.append(dict(zip(result.fields, result.get_row_data())))
    if result.error_code != "0":
        raise RuntimeError(f"baostock error {result.error_code}: {result.error_msg}")
    return rows


def write(dataset, out, replace):
    out.parent.mkdir(parents=True, exist_ok=True)
    if not replace:
        with out.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(dataset, handle, ensure_ascii=False, allow_nan=False, indent=2)
            handle.write("\n")
        return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=out.parent,
                                         prefix=out.name + ".", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(dataset, handle, ensure_ascii=False, allow_nan=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, out)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def download_daily(provider, symbols, start, end, names):
    series = []
    if provider == "akshare":
        import akshare as ak
        for symbol in symbols:
            name, _, code = security(symbol)
            frame = ak.stock_zh_a_hist(symbol=code, period="daily", start_date=start.strftime("%Y%m%d"),
                                       end_date=end.strftime("%Y%m%d"), adjust="", timeout=20)
            series.append((name, names.get(name), bars_from_akshare(frame.to_dict("records"))))
        return daily_dataset("akshare", series)
    import baostock as bs
    login = bs.login()
    if login.error_code != "0":
        raise RuntimeError(f"baostock login failed: {login.error_msg}")
    try:
        for symbol in symbols:
            name, exchange, code = security(symbol)
            if exchange == "BJ":
                raise ValueError("baostock covers Shanghai and Shenzhen only")
            rows = baostock_rows(bs.query_history_k_data_plus(
                f"{exchange.lower()}.{code}", "date,open,high,low,close,volume,tradestatus",
                start_date=start.isoformat(), end_date=end.isoformat(), frequency="d", adjustflag="3"))
            series.append((name, names.get(name), bars_from_baostock(rows)))
    finally:
        bs.logout()
    return daily_dataset("baostock", series)


def download_financials(provider, symbols, years):
    ended = quarters(years)
    if not ended:
        raise ValueError("No report period in --years has ended yet")
    if provider == "akshare":
        import akshare as ak
        periods = [f"{year}{['0331', '0630', '0930', '1231'][quarter - 1]}" for year, quarter in ended]
        frames = [(period, ak.stock_yjbb_em(date=period).to_dict("records")) for period in periods]
        return financials_from_akshare(frames, symbols)
    import baostock as bs
    login = bs.login()
    if login.error_code != "0":
        raise RuntimeError(f"baostock login failed: {login.error_msg}")
    try:
        rows = {}
        for symbol in symbols:
            name, exchange, code = security(symbol)
            if exchange == "BJ":
                raise ValueError("baostock covers Shanghai and Shenzhen only")
            rows[name] = []
            for year, quarter in ended:
                for query in (bs.query_profit_data, bs.query_growth_data):
                    rows[name].extend(baostock_rows(query(code=f"{exchange.lower()}.{code}", year=year, quarter=quarter)))
    finally:
        bs.logout()
    return financials_from_baostock(rows)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Download user-selected data into a local VTrade JSON file")
    sub = parser.add_subparsers(dest="kind", required=True)
    for kind in ("daily", "financials"):
        command = sub.add_parser(kind)
        command.add_argument("--provider", choices=["akshare", "baostock"], required=True)
        command.add_argument("--symbols", required=True, help="Comma-separated SH.xxxxxx / SZ.xxxxxx / BJ.xxxxxx codes (at most 100)")
        command.add_argument("--out", type=Path, required=True, help="New local JSON file outside the source tree")
        command.add_argument("--replace", action="store_true", help="Atomically replace --out after a complete download")
        if kind == "daily":
            command.add_argument("--start", required=True, help="YYYYMMDD")
            command.add_argument("--end", required=True, help="YYYYMMDD; use completed trading days")
            command.add_argument("--name", action="append", default=[], help="Optional SYMBOL=display name, repeatable")
        else:
            command.add_argument("--years", required=True, help="YYYY or YYYY-YYYY report years")
    args = parser.parse_args(argv)
    try:
        symbols = [security(item)[0] for item in args.symbols.split(",") if item.strip()]
    except ValueError as error:
        parser.error(str(error))
    if not 0 < len(symbols) <= 100 or len(set(symbols)) != len(symbols):
        parser.error("--symbols needs 1 to 100 distinct securities")
    if args.out.exists() and not args.replace:
        parser.error("--out already exists; choose a new file or pass --replace")
    module = args.provider
    try:
        __import__(module)
    except ImportError:
        parser.error(f"Install {module} in your own Python environment first: python -m pip install {module}")
    if args.kind == "daily":
        start = datetime.strptime(args.start, "%Y%m%d").date()
        end = datetime.strptime(args.end, "%Y%m%d").date()
        if start >= end:
            parser.error("--start must precede --end")
        names = {}
        for item in args.name:
            key, _, value = item.partition("=")
            try:
                names[security(key)[0]] = value
            except ValueError as error:
                parser.error(str(error))
        dataset = download_daily(args.provider, symbols, start, end, names)
    else:
        match = re.fullmatch(r"(\d{4})(?:-(\d{4}))?", args.years)
        if not match or int(match[2] or match[1]) < int(match[1]):
            parser.error("--years must be YYYY or YYYY-YYYY")
        dataset = download_financials(args.provider, symbols, range(int(match[1]), int(match[2] or match[1]) + 1))
    write(dataset, args.out, args.replace)
    count = sum(len(item.get("bars", item.get("reports", []))) for item in dataset["securities"])
    print(f"Saved {count} {args.kind} records for {len(symbols)} securities. Point a VTrade source or tool at this JSON.")


if __name__ == "__main__":
    main()
