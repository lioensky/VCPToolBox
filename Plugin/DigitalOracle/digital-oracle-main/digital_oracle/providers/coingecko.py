from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from digital_oracle.http import JsonHttpClient, UrllibJsonClient

from ._coerce import _coerce_float, _coerce_int
from .base import ProviderParseError, SignalProvider

COINGECKO_BASE = "https://api.coingecko.com/api/v3"


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CoinGeckoPrice:
    coin_id: str  # e.g. "bitcoin"
    price_usd: float
    market_cap_usd: float | None = None
    volume_24h_usd: float | None = None
    price_change_24h_pct: float | None = None


@dataclass(frozen=True)
class CoinGeckoPriceQuery:
    coin_ids: tuple[str, ...] = ("bitcoin", "ethereum")
    include_market_cap: bool = True
    include_24h_vol: bool = True


@dataclass(frozen=True)
class CoinGeckoGlobal:
    total_market_cap_usd: float
    total_volume_24h_usd: float
    btc_dominance_pct: float
    eth_dominance_pct: float
    market_cap_change_24h_pct: float
    active_cryptocurrencies: int


@dataclass(frozen=True)
class CoinGeckoMarket:
    coin_id: str
    symbol: str
    name: str
    current_price: float
    market_cap: float
    market_cap_rank: int | None
    total_volume: float
    price_change_24h_pct: float | None
    high_24h: float | None
    low_24h: float | None
    ath: float | None
    atl: float | None


@dataclass(frozen=True)
class CoinGeckoMarketQuery:
    vs_currency: str = "usd"
    order: str = "market_cap_desc"
    per_page: int = 20
    page: int = 1


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class CoinGeckoProvider(SignalProvider):
    provider_id = "coingecko"
    display_name = "CoinGecko"
    capabilities = ("crypto_prices", "crypto_global")

    def __init__(self, http_client: JsonHttpClient | None = None):
        self.http_client = http_client or UrllibJsonClient()

    # -- simple/price -------------------------------------------------------

    def get_prices(self, query: CoinGeckoPriceQuery | None = None) -> list[CoinGeckoPrice]:
        query = query or CoinGeckoPriceQuery()
        payload = self.http_client.get_json(
            f"{COINGECKO_BASE}/simple/price",
            params={
                "ids": ",".join(query.coin_ids),
                "vs_currencies": "usd",
                "include_market_cap": query.include_market_cap,
                "include_24hr_vol": query.include_24h_vol,
            },
        )
        if not isinstance(payload, dict):
            raise ProviderParseError("expected simple/price payload to be an object")
        return self._parse_prices(payload, query.coin_ids)

    def _parse_prices(
        self,
        payload: Mapping[str, Any],
        coin_ids: tuple[str, ...],
    ) -> list[CoinGeckoPrice]:
        results: list[CoinGeckoPrice] = []
        for coin_id in coin_ids:
            coin_data = payload.get(coin_id)
            if coin_data is None or not isinstance(coin_data, dict):
                continue
            price = _coerce_float(coin_data.get("usd"))
            if price is None:
                continue
            results.append(
                CoinGeckoPrice(
                    coin_id=coin_id,
                    price_usd=price,
                    market_cap_usd=_coerce_float(coin_data.get("usd_market_cap")),
                    volume_24h_usd=_coerce_float(coin_data.get("usd_24h_vol")),
                    price_change_24h_pct=_coerce_float(coin_data.get("usd_24h_change")),
                )
            )
        return results

    # -- global -------------------------------------------------------------

    def get_global(self) -> CoinGeckoGlobal:
        payload = self.http_client.get_json(
            f"{COINGECKO_BASE}/global",
        )
        if not isinstance(payload, dict):
            raise ProviderParseError("expected global payload to be an object")
        data = payload.get("data")
        if not isinstance(data, dict):
            raise ProviderParseError("expected global.data to be an object")
        return self._parse_global(data)

    def _parse_global(self, data: Mapping[str, Any]) -> CoinGeckoGlobal:
        total_market_cap = data.get("total_market_cap", {})
        total_volume = data.get("total_volume", {})
        market_cap_pct = data.get("market_cap_percentage", {})

        total_cap_usd = _coerce_float(total_market_cap.get("usd") if isinstance(total_market_cap, dict) else None)
        total_vol_usd = _coerce_float(total_volume.get("usd") if isinstance(total_volume, dict) else None)
        btc_dom = _coerce_float(market_cap_pct.get("btc") if isinstance(market_cap_pct, dict) else None)
        eth_dom = _coerce_float(market_cap_pct.get("eth") if isinstance(market_cap_pct, dict) else None)
        cap_change = _coerce_float(data.get("market_cap_change_percentage_24h_usd"))
        active = _coerce_int(data.get("active_cryptocurrencies"))

        if total_cap_usd is None:
            raise ProviderParseError("missing total_market_cap.usd in global data")
        if total_vol_usd is None:
            raise ProviderParseError("missing total_volume.usd in global data")

        return CoinGeckoGlobal(
            total_market_cap_usd=total_cap_usd,
            total_volume_24h_usd=total_vol_usd,
            btc_dominance_pct=btc_dom or 0.0,
            eth_dominance_pct=eth_dom or 0.0,
            market_cap_change_24h_pct=cap_change or 0.0,
            active_cryptocurrencies=active or 0,
        )

    # -- coins/markets ------------------------------------------------------

    def list_markets(self, query: CoinGeckoMarketQuery | None = None) -> list[CoinGeckoMarket]:
        query = query or CoinGeckoMarketQuery()
        payload = self.http_client.get_json(
            f"{COINGECKO_BASE}/coins/markets",
            params={
                "vs_currency": query.vs_currency,
                "order": query.order,
                "per_page": query.per_page,
                "page": query.page,
            },
        )
        if not isinstance(payload, list):
            raise ProviderParseError("expected coins/markets payload to be a list")
        return [self._parse_market(item) for item in payload]

    def _parse_market(self, raw: Mapping[str, Any]) -> CoinGeckoMarket:
        current_price = _coerce_float(raw.get("current_price"))
        market_cap = _coerce_float(raw.get("market_cap"))
        total_volume = _coerce_float(raw.get("total_volume"))

        if current_price is None:
            raise ProviderParseError(f"missing current_price for coin: {raw.get('id')}")
        if market_cap is None:
            raise ProviderParseError(f"missing market_cap for coin: {raw.get('id')}")
        if total_volume is None:
            raise ProviderParseError(f"missing total_volume for coin: {raw.get('id')}")

        return CoinGeckoMarket(
            coin_id=str(raw.get("id", "")),
            symbol=str(raw.get("symbol", "")),
            name=str(raw.get("name", "")),
            current_price=current_price,
            market_cap=market_cap,
            market_cap_rank=_coerce_int(raw.get("market_cap_rank")),
            total_volume=total_volume,
            price_change_24h_pct=_coerce_float(raw.get("price_change_percentage_24h")),
            high_24h=_coerce_float(raw.get("high_24h")),
            low_24h=_coerce_float(raw.get("low_24h")),
            ath=_coerce_float(raw.get("ath")),
            atl=_coerce_float(raw.get("atl")),
        )
