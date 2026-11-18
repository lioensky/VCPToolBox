from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol

from digital_oracle.http import JsonHttpClient, UrllibJsonClient

from ._coerce import _coerce_float
from .base import ProviderParseError, SignalProvider

KALSHI_API_URL = "https://api.elections.kalshi.com/trade-api/v2"


class KalshiHttpClient(JsonHttpClient, Protocol):
    pass


def _unwrap_object(payload: Any, *, key: str) -> Mapping[str, Any]:
    if not isinstance(payload, Mapping):
        raise ProviderParseError("expected Kalshi payload to be an object")
    value = payload.get(key)
    if not isinstance(value, Mapping):
        raise ProviderParseError(f"expected Kalshi payload.{key} to be an object")
    return value


def _unwrap_list(payload: Any, *, key: str) -> list[object]:
    if not isinstance(payload, Mapping):
        raise ProviderParseError("expected Kalshi payload to be an object")
    value = payload.get(key)
    if not isinstance(value, list):
        raise ProviderParseError(f"expected Kalshi payload.{key} to be a list")
    return value


def _cent_probability(value: object) -> float | None:
    raw = _coerce_float(value)
    if raw is None:
        return None
    return raw / 100.0


@dataclass(frozen=True)
class KalshiMarketQuery:
    limit: int = 20
    cursor: str | None = None
    status: str | None = "open"
    event_ticker: str | None = None
    series_ticker: str | None = None
    tickers: tuple[str, ...] = ()
    exclude_multivariate: bool = True


@dataclass
class KalshiMarket:
    ticker: str
    event_ticker: str
    status: str
    market_type: str
    title: str
    subtitle: str | None
    yes_sub_title: str | None
    no_sub_title: str | None
    yes_bid: float | None
    yes_ask: float | None
    no_bid: float | None
    no_ask: float | None
    last_price: float | None
    volume: float | None
    volume_24h: float | None
    open_interest: float | None
    liquidity: float | None
    strike_type: str | None
    floor_strike: float | None
    open_time: str | None
    close_time: str | None
    expiration_time: str | None
    rules_primary: str | None
    rules_secondary: str | None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @property
    def midpoint(self) -> float | None:
        if self.yes_bid is None or self.yes_ask is None:
            return None
        return (self.yes_bid + self.yes_ask) / 2.0

    @property
    def yes_probability(self) -> float | None:
        """Probability estimate for the "yes" outcome.

        Returns the midpoint of yes_bid/yes_ask when both are available,
        otherwise falls back to last_price.  This keeps the API consistent
        with PolymarketMarket.yes_probability.
        """
        return self.midpoint if self.midpoint is not None else self.last_price


@dataclass
class KalshiEvent:
    event_ticker: str
    series_ticker: str
    title: str
    subtitle: str | None
    category: str | None
    strike_date: str | None
    mutually_exclusive: bool | None
    available_on_brokers: bool | None
    markets: tuple[KalshiMarket, ...]
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    def market_by_ticker(self, ticker: str) -> KalshiMarket:
        for market in self.markets:
            if market.ticker == ticker:
                return market
        raise KeyError(ticker)

    def most_active_market(self) -> KalshiMarket:
        if not self.markets:
            raise ProviderParseError("event has no markets")
        return max(
            self.markets,
            key=lambda market: (
                market.volume_24h or 0.0,
                market.volume or 0.0,
                market.open_interest or 0.0,
            ),
        )


@dataclass(frozen=True)
class KalshiOrderLevel:
    price: float
    size: float


@dataclass
class KalshiOrderBook:
    market_ticker: str
    yes_bids: tuple[KalshiOrderLevel, ...]
    no_bids: tuple[KalshiOrderLevel, ...]
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @property
    def best_yes_bid(self) -> float | None:
        if not self.yes_bids:
            return None
        return self.yes_bids[0].price

    @property
    def best_no_bid(self) -> float | None:
        if not self.no_bids:
            return None
        return self.no_bids[0].price

    @property
    def best_yes_ask(self) -> float | None:
        if self.best_no_bid is None:
            return None
        return 1.0 - self.best_no_bid

    @property
    def best_no_ask(self) -> float | None:
        if self.best_yes_bid is None:
            return None
        return 1.0 - self.best_yes_bid

    @property
    def yes_spread(self) -> float | None:
        if self.best_yes_bid is None or self.best_yes_ask is None:
            return None
        return self.best_yes_ask - self.best_yes_bid

    @property
    def midpoint(self) -> float | None:
        if self.best_yes_bid is None or self.best_yes_ask is None:
            return None
        return (self.best_yes_bid + self.best_yes_ask) / 2.0


class KalshiProvider(SignalProvider):
    provider_id = "kalshi"
    display_name = "Kalshi"
    capabilities = ("event_markets", "order_book")

    def __init__(self, http_client: KalshiHttpClient | None = None):
        self.http_client = http_client or UrllibJsonClient()

    def list_markets(self, query: KalshiMarketQuery | None = None) -> list[KalshiMarket]:
        query = query or KalshiMarketQuery()
        payload = self.http_client.get_json(
            f"{KALSHI_API_URL}/markets",
            params={
                "limit": query.limit,
                "cursor": query.cursor,
                "status": query.status,
                "event_ticker": query.event_ticker,
                "series_ticker": query.series_ticker,
                "tickers": ",".join(query.tickers) if query.tickers else None,
                "mve_filter": "exclude" if query.exclude_multivariate else None,
            },
        )
        raw_markets = _unwrap_list(payload, key="markets")
        markets: list[KalshiMarket] = []
        for raw in raw_markets:
            if not isinstance(raw, Mapping):
                raise ProviderParseError("expected Kalshi market rows to be objects")
            markets.append(self._parse_market(raw))
        return markets

    def get_market(self, ticker: str) -> KalshiMarket:
        payload = self.http_client.get_json(f"{KALSHI_API_URL}/markets/{ticker}")
        raw = _unwrap_object(payload, key="market")
        return self._parse_market(raw)

    def get_event(self, event_ticker: str) -> KalshiEvent:
        payload = self.http_client.get_json(f"{KALSHI_API_URL}/events/{event_ticker}")
        raw_event = _unwrap_object(payload, key="event")
        raw_markets = _unwrap_list(payload, key="markets")
        markets: list[KalshiMarket] = []
        for raw in raw_markets:
            if not isinstance(raw, Mapping):
                raise ProviderParseError("expected Kalshi event markets to be objects")
            markets.append(self._parse_market(raw))
        return KalshiEvent(
            event_ticker=str(raw_event.get("event_ticker", "")),
            series_ticker=str(raw_event.get("series_ticker", "")),
            title=str(raw_event.get("title", "")),
            subtitle=raw_event.get("sub_title") if isinstance(raw_event.get("sub_title"), str) else None,
            category=raw_event.get("category") if isinstance(raw_event.get("category"), str) else None,
            strike_date=raw_event.get("strike_date") if isinstance(raw_event.get("strike_date"), str) else None,
            mutually_exclusive=bool(raw_event.get("mutually_exclusive"))
            if raw_event.get("mutually_exclusive") is not None
            else None,
            available_on_brokers=bool(raw_event.get("available_on_brokers"))
            if raw_event.get("available_on_brokers") is not None
            else None,
            markets=tuple(markets),
            raw=raw_event,
        )

    def get_order_book(self, ticker: str, *, depth: int = 10) -> KalshiOrderBook:
        payload = self.http_client.get_json(
            f"{KALSHI_API_URL}/markets/{ticker}/orderbook",
            params={"depth": depth},
        )
        if not isinstance(payload, Mapping):
            raise ProviderParseError("expected Kalshi orderbook payload to be an object")

        orderbook_fp = payload.get("orderbook_fp")
        orderbook = payload.get("orderbook")
        if isinstance(orderbook_fp, Mapping):
            yes_levels = self._parse_orderbook_side(orderbook_fp.get("yes_dollars"))
            no_levels = self._parse_orderbook_side(orderbook_fp.get("no_dollars"))
        elif isinstance(orderbook, Mapping):
            yes_levels = self._parse_orderbook_side(orderbook.get("yes_dollars") or orderbook.get("yes"), cents_fallback=True)
            no_levels = self._parse_orderbook_side(orderbook.get("no_dollars") or orderbook.get("no"), cents_fallback=True)
        else:
            raise ProviderParseError("expected Kalshi orderbook or orderbook_fp payload")

        return KalshiOrderBook(
            market_ticker=ticker,
            yes_bids=yes_levels,
            no_bids=no_levels,
            raw=payload,
        )

    def _parse_market(self, raw: Mapping[str, Any]) -> KalshiMarket:
        return KalshiMarket(
            ticker=str(raw.get("ticker", "")),
            event_ticker=str(raw.get("event_ticker", "")),
            status=str(raw.get("status", "")),
            market_type=str(raw.get("market_type", "")),
            title=str(raw.get("title", "")),
            subtitle=raw.get("subtitle") if isinstance(raw.get("subtitle"), str) else None,
            yes_sub_title=raw.get("yes_sub_title") if isinstance(raw.get("yes_sub_title"), str) else None,
            no_sub_title=raw.get("no_sub_title") if isinstance(raw.get("no_sub_title"), str) else None,
            yes_bid=_cent_probability(raw.get("yes_bid")),
            yes_ask=_cent_probability(raw.get("yes_ask")),
            no_bid=_cent_probability(raw.get("no_bid")),
            no_ask=_cent_probability(raw.get("no_ask")),
            last_price=_cent_probability(raw.get("last_price")),
            volume=_coerce_float(raw.get("volume")),
            volume_24h=_coerce_float(raw.get("volume_24h")),
            open_interest=_coerce_float(raw.get("open_interest")),
            liquidity=_coerce_float(raw.get("liquidity")),
            strike_type=raw.get("strike_type") if isinstance(raw.get("strike_type"), str) else None,
            floor_strike=_coerce_float(raw.get("floor_strike")),
            open_time=raw.get("open_time") if isinstance(raw.get("open_time"), str) else None,
            close_time=raw.get("close_time") if isinstance(raw.get("close_time"), str) else None,
            expiration_time=raw.get("expiration_time") if isinstance(raw.get("expiration_time"), str) else None,
            rules_primary=raw.get("rules_primary") if isinstance(raw.get("rules_primary"), str) else None,
            rules_secondary=raw.get("rules_secondary") if isinstance(raw.get("rules_secondary"), str) else None,
            raw=raw,
        )

    def _parse_orderbook_side(
        self,
        raw_levels: object,
        *,
        cents_fallback: bool = False,
    ) -> tuple[KalshiOrderLevel, ...]:
        if raw_levels is None:
            return ()
        if not isinstance(raw_levels, list):
            raise ProviderParseError("expected Kalshi orderbook side to be a list")

        levels: list[KalshiOrderLevel] = []
        for raw_level in raw_levels:
            if not isinstance(raw_level, (list, tuple)) or len(raw_level) < 2:
                raise ProviderParseError("expected Kalshi orderbook levels to contain price and size")
            price_raw = raw_level[0]
            size_raw = raw_level[1]
            if cents_fallback and isinstance(price_raw, (int, float)):
                price = float(price_raw) / 100.0
            else:
                price = _coerce_float(price_raw)
            size = _coerce_float(size_raw)
            if price is None or size is None:
                raise ProviderParseError(f"invalid Kalshi orderbook level: {raw_level}")
            levels.append(KalshiOrderLevel(price=price, size=size))
        return tuple(sorted(levels, key=lambda level: level.price, reverse=True))
