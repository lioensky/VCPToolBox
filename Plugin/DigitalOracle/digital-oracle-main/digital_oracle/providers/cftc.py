from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol

from digital_oracle.http import JsonHttpClient, UrllibJsonClient

from ._coerce import _coerce_int as _coerce_int_or_none
from .base import ProviderParseError, SignalProvider

CFTC_SODA_URL = "https://publicreporting.cftc.gov/resource/72hh-3qpy.json"


class CftcHttpClient(JsonHttpClient, Protocol):
    pass


def _coerce_int(value: object) -> int:
    """Coerce to int, defaulting to 0 for COT positioning fields."""
    return _coerce_int_or_none(value) or 0


def _coerce_str(value: object) -> str:
    if value is None:
        return ""
    return str(value)


@dataclass(frozen=True)
class CftcCotQuery:
    commodity_name: str | None = None  # e.g. "GOLD", "CRUDE OIL", "S&P 500"
    limit: int = 10
    primary_only: bool = True  # keep only highest-OI contract per date


@dataclass(frozen=True)
class CftcCotReport:
    market_name: str
    report_date: str
    commodity: str
    # Producer/Merchant
    prod_long: int
    prod_short: int
    # Swap Dealer
    swap_long: int
    swap_short: int
    swap_spread: int
    # Managed Money (speculative)
    mm_long: int
    mm_short: int
    mm_spread: int
    # Other Reportable
    other_long: int
    other_short: int
    other_spread: int
    # Open Interest
    open_interest: int

    @property
    def mm_net(self) -> int:
        """Net speculative (managed money) position."""
        return self.mm_long - self.mm_short

    @property
    def prod_net(self) -> int:
        """Net commercial (producer/merchant) position."""
        return self.prod_long - self.prod_short


def _parse_report(record: Mapping[str, Any]) -> CftcCotReport:
    raw_date = _coerce_str(record.get("report_date_as_yyyy_mm_dd"))
    # Socrata may return ISO timestamps like "2026-03-04T00:00:00.000"
    report_date = raw_date[:10] if raw_date else ""

    return CftcCotReport(
        market_name=_coerce_str(record.get("market_and_exchange_names")),
        report_date=report_date,
        commodity=_coerce_str(record.get("commodity_name")),
        prod_long=_coerce_int(record.get("prod_merc_positions_long_all")),
        prod_short=_coerce_int(record.get("prod_merc_positions_short_all")),
        swap_long=_coerce_int(record.get("swap_positions_long_all")),
        swap_short=_coerce_int(record.get("swap__positions_short_all")),
        swap_spread=_coerce_int(record.get("swap__positions_spread_all")),
        mm_long=_coerce_int(record.get("m_money_positions_long_all")),
        mm_short=_coerce_int(record.get("m_money_positions_short_all")),
        mm_spread=_coerce_int(record.get("m_money_positions_spread_all")),
        other_long=_coerce_int(record.get("other_rept_positions_long_all")),
        other_short=_coerce_int(record.get("other_rept_positions_short_all")),
        other_spread=_coerce_int(record.get("other_rept_positions_spread_all")),
        open_interest=_coerce_int(record.get("open_interest_all")),
    )


@dataclass
class CftcCotProvider(SignalProvider):
    provider_id: str = "cftc_cot"
    display_name: str = "CFTC Commitments of Traders"
    capabilities: tuple[str, ...] = ("positioning",)
    http_client: CftcHttpClient = field(default_factory=UrllibJsonClient)

    def list_reports(self, query: CftcCotQuery | None = None) -> list[CftcCotReport]:
        """Fetch COT reports from the CFTC SODA API.

        Uses SoQL parameters to filter by commodity name, order by date
        descending, and limit results.
        """
        if query is None:
            query = CftcCotQuery()

        params: dict[str, object] = {
            "$order": "report_date_as_yyyy_mm_dd DESC",
            "$limit": query.limit,
        }
        if query.commodity_name:
            upper_name = query.commodity_name.upper().replace("'", "''")
            params["$where"] = f"commodity_name like '%{upper_name}%'"

        payload = self.http_client.get_json(CFTC_SODA_URL, params=params)
        reports = self._parse_reports(payload)
        if query.primary_only:
            reports = self._keep_primary(reports)
        return reports

    def _parse_reports(self, payload: Any) -> list[CftcCotReport]:
        if not isinstance(payload, list):
            raise ProviderParseError("expected CFTC SODA response to be a JSON array")

        reports: list[CftcCotReport] = []
        for record in payload:
            if not isinstance(record, Mapping):
                raise ProviderParseError("expected each CFTC record to be a JSON object")
            reports.append(_parse_report(record))
        return reports

    @staticmethod
    def _keep_primary(reports: list[CftcCotReport]) -> list[CftcCotReport]:
        """Per report date, keep only the contract with the highest open interest."""
        best: dict[str, CftcCotReport] = {}
        for report in reports:
            key = report.report_date
            if key not in best or report.open_interest > best[key].open_interest:
                best[key] = report
        return sorted(best.values(), key=lambda r: r.report_date, reverse=True)
