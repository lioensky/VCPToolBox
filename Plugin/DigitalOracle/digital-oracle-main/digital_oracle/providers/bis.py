from __future__ import annotations

import csv
from dataclasses import dataclass, field
from io import StringIO
from typing import Protocol

from digital_oracle.http import TextHttpClient, UrllibJsonClient

from ._coerce import _coerce_float
from .base import ProviderParseError, SignalProvider

BIS_BASE_URL = "https://stats.bis.org/api/v1"


class BisHttpClient(TextHttpClient, Protocol):
    pass


@dataclass(frozen=True)
class BisRateQuery:
    countries: tuple[str, ...] = ("US",)
    start_year: int = 2020


@dataclass(frozen=True)
class BisPolicyRate:
    country: str
    period: str  # e.g. "2026-01"
    rate: float


@dataclass(frozen=True)
class BisCreditGapQuery:
    countries: tuple[str, ...] = ("US",)
    start_year: int = 2015


@dataclass(frozen=True)
class BisCreditGap:
    country: str
    period: str  # e.g. "2025-Q3"
    gap_pct: float  # credit-to-GDP gap percentage points


class BisProvider(SignalProvider):
    provider_id = "bis"
    display_name = "Bank for International Settlements"
    capabilities = ("policy_rates", "credit_gaps")

    def __init__(self, http_client: BisHttpClient | None = None):
        self.http_client = http_client or UrllibJsonClient()

    def get_policy_rates(self, query: BisRateQuery | None = None) -> list[BisPolicyRate]:
        query = query or BisRateQuery()
        country_codes = "+".join(query.countries)
        url = f"{BIS_BASE_URL}/data/WS_CBPOL/M.{country_codes}"
        payload = self.http_client.get_text(
            url,
            params={
                "startPeriod": query.start_year,
                "detail": "dataonly",
                "format": "csv",
            },
        )
        return self._parse_policy_rates_csv(payload)

    def get_credit_to_gdp(self, query: BisCreditGapQuery | None = None) -> list[BisCreditGap]:
        query = query or BisCreditGapQuery()
        country_codes = "+".join(query.countries)
        url = f"{BIS_BASE_URL}/data/WS_CREDIT_GAP/Q.{country_codes}"
        payload = self.http_client.get_text(
            url,
            params={
                "startPeriod": query.start_year,
                "detail": "dataonly",
                "format": "csv",
            },
        )
        return self._parse_credit_gap_csv(payload)

    def _parse_policy_rates_csv(self, payload: str) -> list[BisPolicyRate]:
        reader = csv.DictReader(StringIO(payload))
        if not reader.fieldnames:
            raise ProviderParseError("BIS policy rates CSV has no headers")

        required = {"REF_AREA", "TIME_PERIOD", "OBS_VALUE"}
        if not required.issubset(set(reader.fieldnames)):
            raise ProviderParseError(
                f"BIS policy rates CSV missing required columns; "
                f"expected {required}, got {reader.fieldnames}"
            )

        rates: list[BisPolicyRate] = []
        for row in reader:
            if not row:
                continue
            value = _coerce_float(row.get("OBS_VALUE"))
            if value is None:
                continue
            rates.append(
                BisPolicyRate(
                    country=row["REF_AREA"],
                    period=row["TIME_PERIOD"],
                    rate=value,
                )
            )
        return rates

    def _parse_credit_gap_csv(self, payload: str) -> list[BisCreditGap]:
        reader = csv.DictReader(StringIO(payload))
        if not reader.fieldnames:
            raise ProviderParseError("BIS credit gap CSV has no headers")

        required = {"TIME_PERIOD", "OBS_VALUE"}
        if not required.issubset(set(reader.fieldnames)):
            raise ProviderParseError(
                f"BIS credit gap CSV missing required columns; "
                f"expected {required}, got {reader.fieldnames}"
            )

        # BIS uses REF_AREA or BORROWERS_CTY depending on the dataset version
        country_col = "REF_AREA" if "REF_AREA" in reader.fieldnames else "BORROWERS_CTY"

        gaps: list[BisCreditGap] = []
        for row in reader:
            if not row:
                continue
            value = _coerce_float(row.get("OBS_VALUE"))
            if value is None:
                continue
            gaps.append(
                BisCreditGap(
                    country=row.get(country_col, ""),
                    period=row["TIME_PERIOD"],
                    gap_pct=value,
                )
            )
        return gaps
