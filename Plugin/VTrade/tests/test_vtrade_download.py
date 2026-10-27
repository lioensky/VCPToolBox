"""Offline tests for scripts/vtrade_download.py: no AKShare or baostock installation and no network calls."""

import contextlib
from datetime import date
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "vtrade_download", Path(__file__).resolve().parents[1] / "scripts" / "vtrade_download.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

AK_ROWS = [{"日期": f"2025-01-0{i}", "开盘": "10.01", "最高": "10.10", "最低": "9.90", "收盘": "10.05", "成交量": "123.5"}
           for i in [6, 7]]


class FakeResult:
    def __init__(self, fields, rows, error_code="0"):
        self.fields, self.rows, self.error_code, self.error_msg = fields, list(rows), error_code, "synthetic"

    def next(self):
        return bool(self.rows)

    def get_row_data(self):
        return self.rows.pop(0)


def fake_baostock(calls):
    def history(code, fields, **kwargs):
        calls.append((code, kwargs))
        return FakeResult(fields.split(","), [
            ["2025-01-06", "10.0000", "10.2000", "9.9000", "10.1000", "120000", "1"],
            ["2025-01-07", "10.1000", "10.1000", "10.1000", "10.1000", "0", "0"]])
    profit = lambda code, year, quarter: FakeResult(
        ["code", "pubDate", "statDate", "roeAvg", "netProfit"], [[code, f"{year}-04-28", f"{year}-03-31", "0.051234", ""]]
        if quarter == 1 else [])
    growth = lambda code, year, quarter: FakeResult(
        ["code", "pubDate", "statDate", "YOYNI"], [[code, f"{year}-04-29", f"{year}-03-31", "0.023456"]] if quarter == 1 else [])
    return SimpleNamespace(login=lambda: SimpleNamespace(error_code="0"), logout=lambda: None,
                           query_history_k_data_plus=history, query_profit_data=profit, query_growth_data=growth)


class ConversionTests(unittest.TestCase):
    def test_symbols_map_to_one_vtrade_form(self):
        self.assertEqual(module.security("sh.000000"), ("SH.000000", "SH", "000000"))
        self.assertEqual(module.security("000000.sz"), ("SZ.000000", "SZ", "000000"))
        with self.assertRaises(ValueError):
            module.security("000000")

    def test_akshare_daily_units_are_exact(self):
        bars = module.bars_from_akshare(AK_ROWS)
        self.assertEqual(bars[0]["openCents"], 1001)
        self.assertEqual(bars[0]["volume"], 12350)
        dataset = module.daily_dataset("akshare", [("SZ.000000", None, bars)])
        self.assertEqual(dataset["source"]["adjustment"], "none")
        self.assertEqual(dataset["securities"][0]["name"], "SZ.000000")

    def test_invalid_or_fractional_prices_fail(self):
        for value in ["NaN", "Infinity", "1.001", "-1"]:
            with self.assertRaises(ValueError):
                module.scaled_integer(value, 100, "price")

    def test_baostock_daily_keeps_shares_and_marks_suspension(self):
        rows = [dict(zip(["date", "open", "high", "low", "close", "volume", "tradestatus"], r)) for r in [
            ["2025-01-06", "10.0000", "10.2000", "9.9000", "10.1000", "120000", "1"],
            ["2025-01-07", "10.1000", "10.1000", "10.1000", "10.1000", "0", "0"]]]
        bars = module.bars_from_baostock(rows)
        self.assertEqual(bars[0]["openCents"], 1000)
        self.assertEqual(bars[0]["volume"], 120000)
        self.assertTrue(bars[1]["suspended"])
        self.assertNotIn("suspended", bars[0])

    def test_akshare_financials_keep_requested_symbols_and_announcement_dates(self):
        frames = [("20240331", [
            {"股票代码": "0", "每股收益": 0.1, "净利润-净利润": 1.5e9, "净资产收益率": float("nan"), "最新公告日期": "2024-04-27"},
            {"股票代码": "999999", "每股收益": 9, "最新公告日期": "2024-04-01"}]),
            ("20240630", [{"股票代码": "000000", "每股收益": 0.2, "最新公告日期": float("nan")}])]
        result = module.financials_from_akshare(frames, ["SZ.000000"])
        self.assertEqual([s["symbol"] for s in result["securities"]], ["SZ.000000"])
        first, second = result["securities"][0]["reports"]
        self.assertEqual((first["period"], first["publishedAt"]), ("2024-03-31", "2024-04-27"))
        self.assertIsNone(first["metrics"]["roe"])
        self.assertIsNone(second["publishedAt"])
        self.assertIn("%", result["fields"]["roe"])

    def test_baostock_financials_merge_by_period_and_take_the_later_publication(self):
        rows = {"SH.000000": [
            {"pubDate": "2024-04-28", "statDate": "2024-03-31", "roeAvg": "0.051234", "netProfit": ""},
            {"pubDate": "2024-04-29", "statDate": "2024-03-31", "YOYNI": "0.023456"}]}
        report = module.financials_from_baostock(rows)["securities"][0]["reports"][0]
        self.assertEqual(report["publishedAt"], "2024-04-29")
        self.assertEqual(report["metrics"], {"roeAvg": 0.051234, "netProfit": None, "YOYNI": 0.023456})

    def test_only_ended_report_quarters_are_requested(self):
        self.assertEqual(module.quarters([2025], today=date(2025, 7, 15)), [(2025, 1), (2025, 2)])


class CommandTests(unittest.TestCase):
    def run_main(self, args, modules):
        with patch.dict("sys.modules", modules), contextlib.redirect_stdout(io.StringIO()):
            module.main(args)

    def test_replace_is_atomic_and_a_failed_download_preserves_the_previous_output(self):
        rows = [dict(row) for row in AK_ROWS]
        fake = SimpleNamespace(stock_zh_a_hist=lambda **kwargs: SimpleNamespace(to_dict=lambda _: rows))
        with tempfile.TemporaryDirectory(prefix="vtrade-download-") as directory:
            output = Path(directory) / "daily.json"
            output.write_text("old fixture", encoding="utf-8")
            args = ["daily", "--provider", "akshare", "--symbols", "SZ.000000", "--start", "20250106",
                    "--end", "20250107", "--out", str(output)]
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.run_main(args, {"akshare": fake})
            self.assertEqual(output.read_text(encoding="utf-8"), "old fixture")
            self.run_main(args + ["--replace", "--name", "SZ.000000=Synthetic"], {"akshare": fake})
            previous = output.read_text(encoding="utf-8")
            self.assertEqual(json.loads(previous)["securities"][0]["name"], "Synthetic")
            rows[0]["开盘"] = "NaN"
            with self.assertRaises(ValueError):
                self.run_main(args + ["--replace"], {"akshare": fake})
            self.assertEqual(output.read_text(encoding="utf-8"), previous)
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_baostock_commands_use_unadjusted_daily_bars_and_quarterly_reports(self):
        calls = []
        with tempfile.TemporaryDirectory(prefix="vtrade-download-") as directory:
            daily, fin = Path(directory) / "daily.json", Path(directory) / "fin.json"
            self.run_main(["daily", "--provider", "baostock", "--symbols", "SH.000000", "--start", "20250106",
                           "--end", "20250107", "--out", str(daily)], {"baostock": fake_baostock(calls)})
            self.assertEqual(calls[0], ("sh.000000", {"start_date": "2025-01-06", "end_date": "2025-01-07",
                                                      "frequency": "d", "adjustflag": "3"}))
            self.assertEqual(json.loads(daily.read_text(encoding="utf-8"))["source"]["kind"], "baostock")
            self.run_main(["financials", "--provider", "baostock", "--symbols", "SH.000000", "--years", "2024",
                           "--out", str(fin)], {"baostock": fake_baostock(calls)})
            reports = json.loads(fin.read_text(encoding="utf-8"))["securities"][0]["reports"]
            self.assertEqual([(r["period"], r["publishedAt"]) for r in reports], [("2024-03-31", "2024-04-29")])


if __name__ == "__main__":
    unittest.main()
