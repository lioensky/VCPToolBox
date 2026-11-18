from __future__ import annotations

import csv
from dataclasses import dataclass, field
from datetime import date
from io import StringIO
from typing import Any, Mapping, Protocol

from digital_oracle.http import JsonHttpClient, TextHttpClient, UrllibJsonClient

from ._coerce import _coerce_float
from .base import ProviderParseError, SignalProvider

TREASURY_RATES_CSV_URL = (
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv"
)
FISCALDATA_BASE_URL = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od"


class TreasuryHttpClient(JsonHttpClient, TextHttpClient, Protocol):
    pass


CURVE_KIND_TO_TYPE = {
    "nominal": "daily_treasury_yield_curve",
    "real": "daily_treasury_real_yield_curve",
    "bill": "daily_treasury_bill_rates",
    "long_term": "daily_treasury_long_term_rate",
}

TENOR_ALIASES = {
    "1 MO": "1M",
    "1.5 MONTH": "1.5M",
    "2 MO": "2M",
    "3 MO": "3M",
    "4 MO": "4M",
    "6 MO": "6M",
    "1 YR": "1Y",
    "2 YR": "2Y",
    "3 YR": "3Y",
    "5 YR": "5Y",
    "7 YR": "7Y",
    "10 YR": "10Y",
    "20 YR": "20Y",
    "30 YR": "30Y",
}


def _normalize_tenor_label(value: str) -> str:
    normalized = " ".join(value.strip().replace('"', "").upper().split())
    normalized = TENOR_ALIASES.get(normalized, normalized)
    return normalized.replace(" ", "")


def _build_in_filter(field: str, values: tuple[str, ...]) -> str | None:
    if not values:
        return None
    joined = ",".join(values)
    return f"{field}:in:({joined})"


def _fiscal_filter(query: "ExchangeRateQuery") -> str | None:
    filters: list[str] = []
    country_filter = _build_in_filter("country", query.countries)
    if country_filter:
        filters.append(country_filter)
    currency_filter = _build_in_filter("currency", query.currencies)
    if currency_filter:
        filters.append(currency_filter)
    if query.country_currency_desc:
        desc_filter = _build_in_filter("country_currency_desc", query.country_currency_desc)
        if desc_filter:
            filters.append(desc_filter)
    if query.record_date_gte:
        filters.append(f"record_date:gte:{query.record_date_gte}")
    if query.record_date_lte:
        filters.append(f"record_date:lte:{query.record_date_lte}")
    if not filters:
        return None
    return ",".join(filters)


@dataclass(frozen=True)
class YieldPoint:
    tenor: str
    value: float


@dataclass
class YieldCurveSnapshot:
    curve_kind: str
    date: str
    points: tuple[YieldPoint, ...]
    raw: Mapping[str, str] = field(default_factory=dict, repr=False)

    def yield_for(self, tenor: str) -> float | None:
        target = _normalize_tenor_label(tenor)
        for point in self.points:
            if point.tenor == target:
                return point.value
        return None

    def spread(self, long_tenor: str, short_tenor: str) -> float | None:
        long_rate = self.yield_for(long_tenor)
        short_rate = self.yield_for(short_tenor)
        if long_rate is None or short_rate is None:
            return None
        return long_rate - short_rate


@dataclass(frozen=True)
class YieldCurveQuery:
    year: int = field(default_factory=lambda: date.today().year)
    curve_kind: str = "nominal"


@dataclass
class ExchangeRateRecord:
    record_date: str
    country: str | None
    currency: str | None
    country_currency_desc: str
    exchange_rate: float | None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)


@dataclass(frozen=True)
class ExchangeRateQuery:
    countries: tuple[str, ...] = ()
    currencies: tuple[str, ...] = ()
    country_currency_desc: tuple[str, ...] = ()
    record_date_gte: str | None = None
    record_date_lte: str | None = None
    limit: int = 100
    page_number: int = 1
    sort: str = "-record_date"


class USTreasuryProvider(SignalProvider):
    provider_id = "us_treasury"
    display_name = "U.S. Treasury"
    capabilities = ("yield_curves", "fiscal_exchange_rates")

    def __init__(self, http_client: TreasuryHttpClient | None = None):
        self.http_client = http_client or UrllibJsonClient()

    def list_yield_curve(self, query: YieldCurveQuery | None = None) -> list[YieldCurveSnapshot]:
        query = query or YieldCurveQuery()
        curve_type = CURVE_KIND_TO_TYPE.get(query.curve_kind)
        if curve_type is None:
            raise ValueError(f"unsupported curve kind: {query.curve_kind}")

        payload = self.http_client.get_text(
            f"{TREASURY_RATES_CSV_URL}/{query.year}/all",
            params={"type": curve_type},
        )
        return self._parse_curve_csv(payload, curve_kind=query.curve_kind)

    def latest_yield_curve(self, query: YieldCurveQuery | None = None) -> YieldCurveSnapshot | None:
        observations = self.list_yield_curve(query)
        if not observations:
            return None
        # Treasury CSV is newest-first; take the first row as the latest.
        return observations[0]

    def list_exchange_rates(self, query: ExchangeRateQuery | None = None) -> list[ExchangeRateRecord]:
        query = query or ExchangeRateQuery()
        payload = self.http_client.get_json(
            f"{FISCALDATA_BASE_URL}/rates_of_exchange",
            params={
                "fields": "record_date,country,currency,country_currency_desc,exchange_rate",
                "filter": _fiscal_filter(query),
                "sort": query.sort,
                "page[size]": query.limit,
                "page[number]": query.page_number,
            },
        )
        if not isinstance(payload, Mapping):
            raise ProviderParseError("expected FiscalData payload to be an object")

        raw_rows = payload.get("data")
        if not isinstance(raw_rows, list):
            raise ProviderParseError("expected FiscalData payload.data to be a list")

        records: list[ExchangeRateRecord] = []
        for row in raw_rows:
            if not isinstance(row, Mapping):
                raise ProviderParseError("expected FiscalData rows to be objects")
            records.append(
                ExchangeRateRecord(
                    record_date=str(row.get("record_date", "")),
                    country=row.get("country") if isinstance(row.get("country"), str) else None,
                    currency=row.get("currency") if isinstance(row.get("currency"), str) else None,
                    country_currency_desc=str(row.get("country_currency_desc", "")),
                    exchange_rate=_coerce_float(row.get("exchange_rate")),
                    raw=row,
                )
            )
        return records

    def _parse_curve_csv(self, payload: str, *, curve_kind: str) -> list[YieldCurveSnapshot]:
        reader = csv.DictReader(StringIO(payload))
        if not reader.fieldnames or "Date" not in reader.fieldnames:
            raise ProviderParseError("expected Treasury CSV to include a Date column")

        points_columns = [field for field in reader.fieldnames if field != "Date"]
        observations: list[YieldCurveSnapshot] = []
        for row in reader:
            if not row:
                continue
            raw_date = row.get("Date")
            if not raw_date:
                continue

            points: list[YieldPoint] = []
            for column in points_columns:
                value = _coerce_float(row.get(column))
                if value is None:
                    continue
                points.append(YieldPoint(tenor=_normalize_tenor_label(column), value=value))

            observations.append(
                YieldCurveSnapshot(
                    curve_kind=curve_kind,
                    date=str(raw_date),
                    points=tuple(points),
                    raw={key: value or "" for key, value in row.items()},
                )
            )
        return observations
