"""Yahoo Finance price history provider.

Requires ``yfinance``: ``pip install yfinance``

Replaces the Stooq provider with Yahoo Finance as the data source for
OHLCV price history.  Supports stocks, ETFs, futures, forex and indices.
"""

from __future__ import annotations

import importlib
import math
import os
import sys
from dataclasses import dataclass, field
from typing import Any, Protocol

from .base import ProviderError, ProviderParseError, SignalProvider
from .prices import PriceBar, PriceHistory, PriceHistoryQuery

# Map PriceHistoryQuery interval codes to yfinance interval strings
_INTERVAL_MAP = {"d": "1d", "w": "1wk", "m": "1mo"}


def _limit_to_period(limit: int | None, interval: str) -> str:
    """Convert a bar *limit* into a yfinance ``period`` string.

    yfinance uses period strings like ``"1mo"``, ``"6mo"`` etc. rather than
    explicit row counts, so we approximate conservatively.
    """
    if limit is None or limit <= 0:
        return "max"

    if interval in ("w", "1wk"):
        days = limit * 7
    elif interval in ("m", "1mo"):
        days = limit * 31
    else:
        days = limit

    # Add generous padding so we never under-fetch
    days = int(days * 1.5) + 10

    if days <= 7:
        return "5d"
    if days <= 30:
        return "1mo"
    if days <= 90:
        return "3mo"
    if days <= 180:
        return "6mo"
    if days <= 365:
        return "1y"
    if days <= 730:
        return "2y"
    if days <= 1825:
        return "5y"
    if days <= 3650:
        return "10y"
    return "max"


# ---------------------------------------------------------------------------
# Fetcher protocol (for testability)
# ---------------------------------------------------------------------------


class PriceFetcher(Protocol):
    """Abstracts raw price data retrieval so tests can supply a fake."""

    def fetch_history(
        self,
        symbol: str,
        *,
        period: str,
        interval: str,
    ) -> list[dict[str, Any]]: ...


class _YFinancePriceFetcher:
    """Default fetcher backed by the *yfinance* library."""

    def __init__(self) -> None:
        try:
            self._yf = importlib.import_module("yfinance")
            return
        except ImportError:
            pass

        # Fall back to a repo-local .deps install if the global environment
        # does not have yfinance available.
        _deps = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), os.pardir, os.pardir, ".deps"
        )
        if os.path.isdir(_deps) and _deps not in sys.path:
            sys.path.insert(0, _deps)

        try:
            self._yf = importlib.import_module("yfinance")
        except ImportError:
            raise ImportError(
                "yfinance is required for YahooPriceProvider but is not installed.\n"
                "Install it with:  uv pip install --target .deps yfinance\n"
            )

    def fetch_history(
        self,
        symbol: str,
        *,
        period: str,
        interval: str,
    ) -> list[dict[str, Any]]:
        t = self._yf.Ticker(symbol)
        df = t.history(period=period, interval=interval)

        rows: list[dict[str, Any]] = []
        for idx, row in df.iterrows():
            d: dict[str, Any] = {"Date": idx}
            for col in df.columns:
                val = row[col]
                if isinstance(val, float) and math.isnan(val):
                    val = None
                d[col] = val
            rows.append(d)
        return rows


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class YahooPriceProvider(SignalProvider):
    """Yahoo Finance OHLCV price history provider.

    Drop-in replacement for StooqProvider.  Uses Yahoo Finance symbols
    (e.g. ``GC=F`` for gold, ``CL=F`` for crude oil, ``SPY`` for S&P 500
    ETF, ``EURUSD=X`` for EUR/USD forex).

    Requires ``yfinance``: ``pip install yfinance``.
    """

    provider_id = "yahoo"
    display_name = "Yahoo Finance Prices"
    capabilities = ("price_history",)

    def __init__(self, *, fetcher: PriceFetcher | None = None) -> None:
        self._fetcher: PriceFetcher = fetcher or _YFinancePriceFetcher()

    def get_history(self, query: PriceHistoryQuery) -> PriceHistory:
        interval = query.interval.lower().strip()
        yf_interval = _INTERVAL_MAP.get(interval)
        if yf_interval is None:
            raise ValueError(
                f"unsupported interval: {query.interval!r} (use 'd', 'w', or 'm')"
            )

        symbol = query.symbol.strip()
        period = _limit_to_period(query.limit, interval)

        raw_rows = self._fetcher.fetch_history(
            symbol, period=period, interval=yf_interval
        )

        bars: list[PriceBar] = []
        for row in raw_rows:
            dt = row.get("Date")
            if dt is None:
                continue

            # Format date as YYYY-MM-DD string
            date_str = dt.strftime("%Y-%m-%d") if hasattr(dt, "strftime") else str(dt)[:10]

            if query.start_date and date_str < query.start_date:
                continue
            if query.end_date and date_str > query.end_date:
                continue

            open_price = row.get("Open")
            high_price = row.get("High")
            low_price = row.get("Low")
            close_price = row.get("Close")

            if any(v is None for v in (open_price, high_price, low_price, close_price)):
                continue

            volume_raw = row.get("Volume")
            volume = float(volume_raw) if volume_raw is not None else None

            bars.append(
                PriceBar(
                    date=date_str,
                    open=float(open_price),
                    high=float(high_price),
                    low=float(low_price),
                    close=float(close_price),
                    volume=volume,
                )
            )

        if query.limit is not None and query.limit >= 0:
            bars = bars[-query.limit:]

        return PriceHistory(
            symbol=symbol,
            raw_symbol=query.symbol,
            interval=interval,
            provider_id=self.provider_id,
            bars=tuple(bars),
        )
