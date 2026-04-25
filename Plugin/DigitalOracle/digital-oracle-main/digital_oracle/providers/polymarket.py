from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Mapping

from digital_oracle.http import JsonHttpClient, UrllibJsonClient

from ._coerce import _coerce_float, _coerce_int
from .base import ProviderParseError, SignalProvider

GAMMA_BASE_URL = "https://gamma-api.polymarket.com"
CLOB_BASE_URL = "https://clob.polymarket.com"


def _json_list(value: object, *, field_name: str) -> list[object]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            decoded = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ProviderParseError(f"invalid {field_name}: {text}") from exc
        if isinstance(decoded, list):
            return decoded
    raise ProviderParseError(f"unexpected {field_name} type: {type(value).__name__}")


def _normalize_event_order(order: str | None) -> str | None:
    if order is None:
        return None
    aliases = {
        "volume_24hr": "volume24hr",
        "start_date": "startDate",
        "end_date": "endDate",
        "closed_time": "closedTime",
    }
    return aliases.get(order, order)


@dataclass(frozen=True)
class OutcomeQuote:
    name: str
    probability: float | None
    token_id: str | None = None


@dataclass
class PolymarketMarket:
    id: str
    slug: str
    question: str
    condition_id: str
    active: bool
    closed: bool
    accepting_orders: bool | None
    start_date: str | None
    end_date: str | None
    volume: float | None
    volume_24hr: float | None
    liquidity: float | None
    best_bid: float | None
    best_ask: float | None
    last_trade_price: float | None
    outcomes: tuple[OutcomeQuote, ...]
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    def probability_for(self, outcome_name: str) -> float | None:
        target = outcome_name.strip().lower()
        for outcome in self.outcomes:
            if outcome.name.strip().lower() == target:
                return outcome.probability
        return None

    def token_id_for(self, outcome_name: str) -> str | None:
        target = outcome_name.strip().lower()
        for outcome in self.outcomes:
            if outcome.name.strip().lower() == target:
                return outcome.token_id
        return None

    @property
    def yes_probability(self) -> float | None:
        return self.probability_for("yes")

    @property
    def midpoint(self) -> float | None:
        if self.best_bid is None or self.best_ask is None:
            return None
        return (self.best_bid + self.best_ask) / 2.0


@dataclass
class PolymarketEvent:
    id: str
    slug: str
    title: str
    description: str | None
    active: bool
    closed: bool
    start_date: str | None
    end_date: str | None
    liquidity: float | None
    volume: float | None
    volume_24hr: float | None
    open_interest: float | None
    markets: tuple[PolymarketMarket, ...]
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    def primary_market(self) -> PolymarketMarket | None:
        if not self.markets:
            return None

        def rank(market: PolymarketMarket) -> tuple[int, float, float, float]:
            live_score = int(market.active and not market.closed and market.accepting_orders is not False)
            return (
                live_score,
                market.volume_24hr or 0.0,
                market.volume or 0.0,
                market.liquidity or 0.0,
            )

        # Prefer the currently live market even if an older resolved series has higher lifetime volume.
        return max(self.markets, key=rank)


@dataclass(frozen=True)
class OrderLevel:
    price: float
    size: float


@dataclass
class OrderBook:
    market_id: str
    token_id: str
    timestamp_ms: int | None
    tick_size: float | None
    min_order_size: float | None
    last_trade_price: float | None
    bids: tuple[OrderLevel, ...]
    asks: tuple[OrderLevel, ...]
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @property
    def best_bid(self) -> float | None:
        if not self.bids:
            return None
        return self.bids[0].price

    @property
    def best_ask(self) -> float | None:
        if not self.asks:
            return None
        return self.asks[0].price

    @property
    def spread(self) -> float | None:
        if self.best_bid is None or self.best_ask is None:
            return None
        return self.best_ask - self.best_bid


@dataclass(frozen=True)
class PolymarketEventQuery:
    limit: int = 20
    offset: int = 0
    active: bool | None = True
    closed: bool | None = False
    order: str | None = "volume_24hr"
    ascending: bool = False
    slug: str | None = None
    slug_contains: str | None = None  # client-side filter on event slug/title
    tag_slug: str | None = None  # server-side tag filter (e.g. "bitcoin", "ukraine")
    tag_id: int | None = None
    title_contains: str | None = None  # client-side filter on event title


class PolymarketProvider(SignalProvider):
    provider_id = "polymarket"
    display_name = "Polymarket"
    capabilities = ("event_markets", "order_book")

    def __init__(self, http_client: JsonHttpClient | None = None):
        self.http_client = http_client or UrllibJsonClient()

    def list_events(self, query: PolymarketEventQuery | None = None) -> list[PolymarketEvent]:
        query = query or PolymarketEventQuery()

        # Determine server-side tag filter.
        # If tag_slug is explicitly set, use it directly.
        # If slug_contains is set but tag_slug is not, try it as a tag_slug
        # (works for common tags like "bitcoin", "ukraine", "taiwan")
        # and also apply client-side title/slug filtering as fallback.
        effective_tag = query.tag_slug
        if effective_tag is None and query.slug_contains:
            effective_tag = query.slug_contains

        payload = self.http_client.get_json(
            f"{GAMMA_BASE_URL}/events",
            params={
                "limit": query.limit,
                "offset": query.offset,
                "active": query.active,
                "closed": query.closed,
                "order": _normalize_event_order(query.order),
                "ascending": query.ascending,
                "slug": query.slug,
                "tag_slug": effective_tag,
                "tag_id": query.tag_id,
            },
        )
        if not isinstance(payload, list):
            raise ProviderParseError("expected events payload to be a list")
        events = [self._parse_event(item) for item in payload]

        # Client-side filtering: slug_contains matches against title and slug.
        if query.slug_contains:
            needle = query.slug_contains.strip().lower()
            events = [
                e for e in events
                if needle in e.title.lower() or needle in e.slug.lower()
            ]

        if query.title_contains:
            needle = query.title_contains.strip().lower()
            events = [e for e in events if needle in e.title.lower()]
        return events

    def get_event(self, slug: str) -> PolymarketEvent | None:
        payload = self.http_client.get_json(
            f"{GAMMA_BASE_URL}/events",
            params={"slug": slug},
        )
        if not isinstance(payload, list):
            raise ProviderParseError("expected single event payload to be a list")
        if not payload:
            return None
        return self._parse_event(payload[0])

    def get_order_book(self, token_id: str) -> OrderBook:
        payload = self.http_client.get_json(
            f"{CLOB_BASE_URL}/book",
            params={"token_id": token_id},
        )
        if not isinstance(payload, dict):
            raise ProviderParseError("expected order book payload to be an object")
        return self._parse_order_book(payload)

    def _parse_event(self, raw_event: Mapping[str, Any]) -> PolymarketEvent:
        raw_markets = raw_event.get("markets")
        if raw_markets is None:
            markets: tuple[PolymarketMarket, ...] = ()
        elif isinstance(raw_markets, list):
            markets = tuple(self._parse_market(item) for item in raw_markets)
        else:
            raise ProviderParseError("event.markets must be a list")

        return PolymarketEvent(
            id=str(raw_event.get("id", "")),
            slug=str(raw_event.get("slug", "")),
            title=str(raw_event.get("title", "")),
            description=raw_event.get("description") if isinstance(raw_event.get("description"), str) else None,
            active=bool(raw_event.get("active", False)),
            closed=bool(raw_event.get("closed", False)),
            start_date=raw_event.get("startDate") if isinstance(raw_event.get("startDate"), str) else None,
            end_date=raw_event.get("endDate") if isinstance(raw_event.get("endDate"), str) else None,
            liquidity=_coerce_float(raw_event.get("liquidity")),
            volume=_coerce_float(raw_event.get("volume")),
            volume_24hr=_coerce_float(raw_event.get("volume24hr")),
            open_interest=_coerce_float(raw_event.get("openInterest")),
            markets=markets,
            raw=raw_event,
        )

    def _parse_market(self, raw_market: Mapping[str, Any]) -> PolymarketMarket:
        outcomes = _json_list(raw_market.get("outcomes"), field_name="outcomes")
        prices = _json_list(raw_market.get("outcomePrices"), field_name="outcomePrices")
        token_ids = _json_list(raw_market.get("clobTokenIds"), field_name="clobTokenIds")

        normalized_outcomes: list[OutcomeQuote] = []
        size = max(len(outcomes), len(prices), len(token_ids))
        for index in range(size):
            outcome_name = str(outcomes[index]) if index < len(outcomes) else f"Outcome {index + 1}"
            probability = _coerce_float(prices[index]) if index < len(prices) else None
            token_id = str(token_ids[index]) if index < len(token_ids) else None
            normalized_outcomes.append(
                OutcomeQuote(
                    name=outcome_name,
                    probability=probability,
                    token_id=token_id,
                )
            )

        return PolymarketMarket(
            id=str(raw_market.get("id", "")),
            slug=str(raw_market.get("slug", "")),
            question=str(raw_market.get("question", "")),
            condition_id=str(raw_market.get("conditionId", "")),
            active=bool(raw_market.get("active", False)),
            closed=bool(raw_market.get("closed", False)),
            accepting_orders=raw_market.get("acceptingOrders")
            if isinstance(raw_market.get("acceptingOrders"), bool)
            else None,
            start_date=raw_market.get("startDate") if isinstance(raw_market.get("startDate"), str) else None,
            end_date=raw_market.get("endDate") if isinstance(raw_market.get("endDate"), str) else None,
            volume=_coerce_float(raw_market.get("volumeNum")) or _coerce_float(raw_market.get("volume")),
            volume_24hr=_coerce_float(raw_market.get("volume24hr")) or _coerce_float(raw_market.get("volume24hrClob")),
            liquidity=_coerce_float(raw_market.get("liquidityNum")) or _coerce_float(raw_market.get("liquidity")),
            best_bid=_coerce_float(raw_market.get("bestBid")),
            best_ask=_coerce_float(raw_market.get("bestAsk")),
            last_trade_price=_coerce_float(raw_market.get("lastTradePrice")),
            outcomes=tuple(normalized_outcomes),
            raw=raw_market,
        )

    def _parse_order_book(self, raw_book: Mapping[str, Any]) -> OrderBook:
        bids = self._parse_order_levels(raw_book.get("bids"), side="bids", reverse=True)
        asks = self._parse_order_levels(raw_book.get("asks"), side="asks", reverse=False)
        return OrderBook(
            market_id=str(raw_book.get("market", "")),
            token_id=str(raw_book.get("asset_id", "")),
            timestamp_ms=_coerce_int(raw_book.get("timestamp")),
            tick_size=_coerce_float(raw_book.get("tick_size")),
            min_order_size=_coerce_float(raw_book.get("min_order_size")),
            last_trade_price=_coerce_float(raw_book.get("last_trade_price")),
            bids=tuple(bids),
            asks=tuple(asks),
            raw=raw_book,
        )

    def _parse_order_levels(
        self,
        raw_levels: object,
        *,
        side: str,
        reverse: bool,
    ) -> list[OrderLevel]:
        if raw_levels is None:
            return []
        if not isinstance(raw_levels, list):
            raise ProviderParseError(f"order book {side} must be a list")

        parsed_levels: list[OrderLevel] = []
        for level in raw_levels:
            if not isinstance(level, Mapping):
                raise ProviderParseError(f"order book {side} entries must be objects")
            price = _coerce_float(level.get("price"))
            size = _coerce_float(level.get("size"))
            if price is None or size is None:
                raise ProviderParseError(f"invalid {side} level: {level}")
            parsed_levels.append(OrderLevel(price=price, size=size))

        return sorted(parsed_levels, key=lambda item: item.price, reverse=reverse)
