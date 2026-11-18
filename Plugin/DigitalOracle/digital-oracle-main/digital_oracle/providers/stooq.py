from __future__ import annotations

from dataclasses import dataclass, field

from .base import SignalProvider
from .prices import PriceHistory, PriceHistoryQuery
from .yahoo import PriceFetcher, YahooPriceProvider

_STOOQ_SYMBOL_MAP = {
    "cb.c": "BZ=F",
    "cl.c": "CL=F",
    "eurusd": "EURUSD=X",
    "gbpusd": "GBPUSD=X",
    "hg.c": "HG=F",
    "ng.c": "NG=F",
    "usdchf": "USDCHF=X",
    "usdcny": "USDCNY=X",
    "usdjpy": "USDJPY=X",
    "usdrub": "USDRUB=X",
    "usdtwd": "USDTWD=X",
    "xagusd": "SI=F",
    "xauusd": "GC=F",
    "zc.c": "ZC=F",
    "zs.c": "ZS=F",
    "zw.c": "ZW=F",
}


def _to_yahoo_symbol(symbol: str) -> str:
    normalized = symbol.strip()
    lowered = normalized.lower()
    if lowered in _STOOQ_SYMBOL_MAP:
        return _STOOQ_SYMBOL_MAP[lowered]

    if lowered.endswith(".us"):
        return lowered[:-3].upper()

    if len(lowered) == 6 and lowered.isalpha():
        return f"{lowered.upper()}=X"

    return normalized.upper()


@dataclass
class StooqProvider(SignalProvider):
    """Backward-compatible price provider backed by Yahoo Finance."""

    provider_id: str = "stooq"
    display_name: str = "Stooq (compat via Yahoo Finance)"
    capabilities: tuple[str, ...] = ("price_history",)
    _provider: YahooPriceProvider = field(init=False, repr=False)

    def __init__(
        self,
        *,
        fetcher: PriceFetcher | None = None,
        yahoo_provider: YahooPriceProvider | None = None,
    ) -> None:
        object.__setattr__(
            self,
            "_provider",
            yahoo_provider or YahooPriceProvider(fetcher=fetcher),
        )

    def get_history(self, query: PriceHistoryQuery) -> PriceHistory:
        mapped_symbol = _to_yahoo_symbol(query.symbol)
        delegated = self._provider.get_history(
            PriceHistoryQuery(
                symbol=mapped_symbol,
                interval=query.interval,
                start_date=query.start_date,
                end_date=query.end_date,
                limit=query.limit,
            )
        )
        return PriceHistory(
            symbol=delegated.symbol,
            raw_symbol=query.symbol,
            interval=delegated.interval,
            provider_id=self.provider_id,
            bars=delegated.bars,
            metadata={
                **delegated.metadata,
                "source_symbol": query.symbol,
                "yahoo_symbol": mapped_symbol,
            },
        )
