from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol

from digital_oracle.http import JsonHttpClient, UrllibJsonClient

from ._coerce import _coerce_float, _coerce_int
from .base import ProviderParseError, SignalProvider

DERIBIT_API_URL = "https://www.deribit.com/api/v2/public"


class DeribitHttpClient(JsonHttpClient, Protocol):
    pass


def _unwrap_result(payload: Any) -> Any:
    if not isinstance(payload, Mapping):
        raise ProviderParseError("expected Deribit payload to be an object")
    if "result" not in payload:
        raise ProviderParseError("expected Deribit payload.result")
    return payload["result"]


def _first_non_none(*values: object) -> object | None:
    for value in values:
        if value is not None:
            return value
    return None


@dataclass(frozen=True)
class DeribitInstrumentsQuery:
    currency: str = "BTC"
    kind: str = "future"
    expired: bool = False


@dataclass(frozen=True)
class DeribitFuturesCurveQuery:
    currency: str = "BTC"
    expired: bool = False
    include_perpetual: bool = True


@dataclass(frozen=True)
class DeribitOptionChainQuery:
    currency: str = "BTC"
    expiration_label: str | None = None
    expired: bool = False


@dataclass
class DeribitInstrument:
    instrument_name: str
    kind: str
    base_currency: str
    quote_currency: str | None
    settlement_currency: str | None
    settlement_period: str | None
    expiration_timestamp: int | None
    tick_size: float | None
    contract_size: float | None
    strike: float | None
    option_type: str | None
    is_active: bool
    price_index: str | None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @property
    def is_perpetual(self) -> bool:
        return self.instrument_name.endswith("-PERPETUAL") or self.settlement_period == "perpetual"

    @property
    def expiration_label(self) -> str | None:
        if self.is_perpetual:
            return None
        parts = self.instrument_name.split("-")
        if len(parts) < 2:
            return None
        return parts[1]


@dataclass(frozen=True)
class DeribitOrderLevel:
    price: float
    size: float


@dataclass
class DeribitOrderBook:
    instrument_name: str
    timestamp_ms: int | None
    state: str | None
    last_price: float | None
    mark_price: float | None
    index_price: float | None
    open_interest: float | None
    bids: tuple[DeribitOrderLevel, ...]
    asks: tuple[DeribitOrderLevel, ...]
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


@dataclass
class DeribitBookSummary:
    instrument_name: str
    creation_timestamp: int | None
    bid_price: float | None
    ask_price: float | None
    mid_price: float | None
    last_price: float | None
    mark_price: float | None
    open_interest: float | None
    volume: float | None
    volume_usd: float | None
    underlying_price: float | None
    underlying_index: str | None
    mark_iv: float | None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @property
    def reference_price(self) -> float | None:
        value = _first_non_none(self.mark_price, self.mid_price, self.last_price)
        return value if isinstance(value, float) else None


@dataclass
class DeribitFutureTermPoint:
    instrument_name: str
    expiration_label: str | None
    expiration_timestamp: int | None
    settlement_period: str | None
    is_perpetual: bool
    bid_price: float | None
    ask_price: float | None
    mid_price: float | None
    last_price: float | None
    mark_price: float | None
    open_interest: float | None
    volume: float | None
    basis_vs_perpetual: float | None
    annualized_basis_vs_perpetual: float | None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)


@dataclass
class DeribitFuturesTermStructure:
    currency: str
    generated_timestamp_ms: int | None
    points: tuple[DeribitFutureTermPoint, ...]

    def perpetual(self) -> DeribitFutureTermPoint | None:
        for point in self.points:
            if point.is_perpetual:
                return point
        return None


@dataclass
class DeribitOptionQuote:
    instrument_name: str
    expiration_label: str | None
    expiration_timestamp: int | None
    strike: float
    option_type: str
    bid_price: float | None
    ask_price: float | None
    mid_price: float | None
    last_price: float | None
    mark_price: float | None
    mark_iv: float | None
    open_interest: float | None
    volume: float | None
    underlying_price: float | None
    underlying_index: str | None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)


@dataclass
class DeribitOptionStrike:
    strike: float
    call: DeribitOptionQuote | None = None
    put: DeribitOptionQuote | None = None


@dataclass
class DeribitOptionChain:
    currency: str
    expiration_label: str
    expiration_timestamp: int | None
    underlying_price: float | None
    underlying_index: str | None
    strikes: tuple[DeribitOptionStrike, ...]
    raw_quotes: tuple[Mapping[str, Any], ...] = field(default_factory=tuple, repr=False)

    def atm_strike(self) -> DeribitOptionStrike | None:
        if not self.strikes or self.underlying_price is None:
            return None
        return min(self.strikes, key=lambda strike: abs(strike.strike - self.underlying_price))


class DeribitProvider(SignalProvider):
    provider_id = "deribit"
    display_name = "Deribit"
    capabilities = ("derivatives_instruments", "order_book", "futures_term_structure", "option_chain")

    def __init__(self, http_client: DeribitHttpClient | None = None):
        self.http_client = http_client or UrllibJsonClient()

    def list_instruments(self, query: DeribitInstrumentsQuery | None = None) -> list[DeribitInstrument]:
        query = query or DeribitInstrumentsQuery()
        payload = self.http_client.get_json(
            f"{DERIBIT_API_URL}/get_instruments",
            params={
                "currency": query.currency.upper(),
                "kind": query.kind.strip().lower(),
                "expired": query.expired,
            },
        )
        result = _unwrap_result(payload)
        if not isinstance(result, list):
            raise ProviderParseError("expected Deribit get_instruments result to be a list")

        instruments: list[DeribitInstrument] = []
        for item in result:
            if not isinstance(item, Mapping):
                raise ProviderParseError("expected Deribit instrument rows to be objects")
            instruments.append(self._parse_instrument(item))

        return sorted(
            instruments,
            key=lambda item: (
                item.is_perpetual,
                item.expiration_timestamp or 0,
                item.instrument_name,
            ),
        )

    def get_order_book(self, instrument_name: str, *, depth: int = 5) -> DeribitOrderBook:
        payload = self.http_client.get_json(
            f"{DERIBIT_API_URL}/get_order_book",
            params={
                "instrument_name": instrument_name,
                "depth": depth,
            },
        )
        result = _unwrap_result(payload)
        if not isinstance(result, Mapping):
            raise ProviderParseError("expected Deribit get_order_book result to be an object")
        return self._parse_order_book(result)

    def get_futures_term_structure(
        self,
        query: DeribitFuturesCurveQuery | None = None,
    ) -> DeribitFuturesTermStructure:
        query = query or DeribitFuturesCurveQuery()
        currency = query.currency.upper()
        instruments = self.list_instruments(
            DeribitInstrumentsQuery(currency=currency, kind="future", expired=query.expired)
        )
        summary_map = {
            summary.instrument_name: summary
            for summary in self._list_book_summaries(currency=currency, kind="future")
        }
        generated_timestamp_ms = max(
            (summary.creation_timestamp or 0 for summary in summary_map.values()),
            default=0,
        ) or None

        perpetual_reference_price: float | None = None
        for instrument in instruments:
            if not instrument.is_perpetual:
                continue
            summary = summary_map.get(instrument.instrument_name)
            if summary and summary.reference_price is not None:
                perpetual_reference_price = summary.reference_price
                break

        points: list[DeribitFutureTermPoint] = []
        for instrument in instruments:
            if instrument.is_perpetual and not query.include_perpetual:
                continue
            summary = summary_map.get(instrument.instrument_name)
            if summary is None:
                continue
            points.append(
                self._build_future_term_point(
                    instrument=instrument,
                    summary=summary,
                    perpetual_reference_price=perpetual_reference_price,
                    generated_timestamp_ms=generated_timestamp_ms,
                )
            )

        points.sort(
            key=lambda point: (
                not point.is_perpetual,
                point.expiration_timestamp or 0,
                point.instrument_name,
            )
        )
        return DeribitFuturesTermStructure(
            currency=currency,
            generated_timestamp_ms=generated_timestamp_ms,
            points=tuple(points),
        )

    def get_option_chain(self, query: DeribitOptionChainQuery | None = None) -> DeribitOptionChain | None:
        query = query or DeribitOptionChainQuery()
        currency = query.currency.upper()
        instruments = self.list_instruments(
            DeribitInstrumentsQuery(currency=currency, kind="option", expired=query.expired)
        )
        if not instruments:
            return None

        target_expiration = query.expiration_label.upper() if query.expiration_label else None
        if target_expiration is None:
            target_expiration = next(
                (instrument.expiration_label for instrument in instruments if instrument.expiration_label),
                None,
            )
        if target_expiration is None:
            return None

        chain_instruments = [
            instrument for instrument in instruments if instrument.expiration_label == target_expiration
        ]
        if not chain_instruments:
            return None

        summary_map = {
            summary.instrument_name: summary
            for summary in self._list_book_summaries(currency=currency, kind="option")
        }

        strike_map: dict[float, DeribitOptionStrike] = {}
        raw_quotes: list[Mapping[str, Any]] = []
        underlying_price: float | None = None
        underlying_index: str | None = None
        expiration_timestamp = chain_instruments[0].expiration_timestamp

        for instrument in chain_instruments:
            summary = summary_map.get(instrument.instrument_name)
            quote = self._build_option_quote(instrument=instrument, summary=summary)
            strike_bucket = strike_map.setdefault(quote.strike, DeribitOptionStrike(strike=quote.strike))
            if quote.option_type == "call":
                strike_bucket.call = quote
            else:
                strike_bucket.put = quote
            raw_quotes.append(summary.raw if summary is not None else instrument.raw)
            if underlying_price is None and quote.underlying_price is not None:
                underlying_price = quote.underlying_price
            if underlying_index is None and quote.underlying_index is not None:
                underlying_index = quote.underlying_index

        strikes = tuple(sorted(strike_map.values(), key=lambda strike: strike.strike))
        return DeribitOptionChain(
            currency=currency,
            expiration_label=target_expiration,
            expiration_timestamp=expiration_timestamp,
            underlying_price=underlying_price,
            underlying_index=underlying_index,
            strikes=strikes,
            raw_quotes=tuple(raw_quotes),
        )

    def _parse_instrument(self, raw: Mapping[str, Any]) -> DeribitInstrument:
        return DeribitInstrument(
            instrument_name=str(raw.get("instrument_name", "")),
            kind=str(raw.get("kind", "")),
            base_currency=str(raw.get("base_currency", "")),
            quote_currency=raw.get("quote_currency") if isinstance(raw.get("quote_currency"), str) else None,
            settlement_currency=(
                raw.get("settlement_currency")
                if isinstance(raw.get("settlement_currency"), str)
                else None
            ),
            settlement_period=(
                raw.get("settlement_period") if isinstance(raw.get("settlement_period"), str) else None
            ),
            expiration_timestamp=_coerce_int(raw.get("expiration_timestamp")),
            tick_size=_coerce_float(raw.get("tick_size")),
            contract_size=_coerce_float(raw.get("contract_size")),
            strike=_coerce_float(raw.get("strike")),
            option_type=raw.get("option_type") if isinstance(raw.get("option_type"), str) else None,
            is_active=bool(raw.get("is_active")),
            price_index=raw.get("price_index") if isinstance(raw.get("price_index"), str) else None,
            raw=raw,
        )

    def _parse_order_book(self, raw: Mapping[str, Any]) -> DeribitOrderBook:
        return DeribitOrderBook(
            instrument_name=str(raw.get("instrument_name", "")),
            timestamp_ms=_coerce_int(raw.get("timestamp")),
            state=raw.get("state") if isinstance(raw.get("state"), str) else None,
            last_price=_coerce_float(raw.get("last_price")),
            mark_price=_coerce_float(raw.get("mark_price")),
            index_price=_coerce_float(raw.get("index_price")),
            open_interest=_coerce_float(raw.get("open_interest")),
            bids=self._parse_levels(raw.get("bids"), reverse=True),
            asks=self._parse_levels(raw.get("asks"), reverse=False),
            raw=raw,
        )

    def _parse_book_summary(self, raw: Mapping[str, Any]) -> DeribitBookSummary:
        return DeribitBookSummary(
            instrument_name=str(raw.get("instrument_name", "")),
            creation_timestamp=_coerce_int(raw.get("creation_timestamp")),
            bid_price=_coerce_float(raw.get("bid_price")),
            ask_price=_coerce_float(raw.get("ask_price")),
            mid_price=_coerce_float(raw.get("mid_price")),
            last_price=_coerce_float(raw.get("last")),
            mark_price=_coerce_float(raw.get("mark_price")),
            open_interest=_coerce_float(raw.get("open_interest")),
            volume=_coerce_float(raw.get("volume")),
            volume_usd=_coerce_float(raw.get("volume_usd")),
            underlying_price=_coerce_float(raw.get("underlying_price")),
            underlying_index=(
                raw.get("underlying_index") if isinstance(raw.get("underlying_index"), str) else None
            ),
            mark_iv=_coerce_float(raw.get("mark_iv")),
            raw=raw,
        )

    def _list_book_summaries(self, *, currency: str, kind: str) -> list[DeribitBookSummary]:
        payload = self.http_client.get_json(
            f"{DERIBIT_API_URL}/get_book_summary_by_currency",
            params={
                "currency": currency.upper(),
                "kind": kind,
            },
        )
        result = _unwrap_result(payload)
        if not isinstance(result, list):
            raise ProviderParseError("expected Deribit get_book_summary_by_currency result to be a list")

        summaries: list[DeribitBookSummary] = []
        for item in result:
            if not isinstance(item, Mapping):
                raise ProviderParseError("expected Deribit book summary rows to be objects")
            summaries.append(self._parse_book_summary(item))
        return summaries

    def _build_future_term_point(
        self,
        *,
        instrument: DeribitInstrument,
        summary: DeribitBookSummary,
        perpetual_reference_price: float | None,
        generated_timestamp_ms: int | None,
    ) -> DeribitFutureTermPoint:
        reference_price = summary.reference_price
        basis_vs_perpetual: float | None = None
        annualized_basis_vs_perpetual: float | None = None
        if perpetual_reference_price is not None and reference_price is not None:
            if instrument.is_perpetual:
                basis_vs_perpetual = 0.0
            else:
                basis_vs_perpetual = reference_price / perpetual_reference_price - 1.0
                if instrument.expiration_timestamp is not None and generated_timestamp_ms is not None:
                    ms_to_expiry = instrument.expiration_timestamp - generated_timestamp_ms
                    if ms_to_expiry > 0:
                        days_to_expiry = ms_to_expiry / 86_400_000
                        annualized_basis_vs_perpetual = basis_vs_perpetual * 365.0 / days_to_expiry

        return DeribitFutureTermPoint(
            instrument_name=instrument.instrument_name,
            expiration_label=instrument.expiration_label,
            expiration_timestamp=instrument.expiration_timestamp,
            settlement_period=instrument.settlement_period,
            is_perpetual=instrument.is_perpetual,
            bid_price=summary.bid_price,
            ask_price=summary.ask_price,
            mid_price=summary.mid_price,
            last_price=summary.last_price,
            mark_price=summary.mark_price,
            open_interest=summary.open_interest,
            volume=summary.volume,
            basis_vs_perpetual=basis_vs_perpetual,
            annualized_basis_vs_perpetual=annualized_basis_vs_perpetual,
            raw={"instrument": instrument.raw, "summary": summary.raw},
        )

    def _build_option_quote(
        self,
        *,
        instrument: DeribitInstrument,
        summary: DeribitBookSummary | None,
    ) -> DeribitOptionQuote:
        if instrument.strike is None or instrument.option_type is None:
            raise ProviderParseError(f"expected Deribit option instrument fields on {instrument.instrument_name}")
        return DeribitOptionQuote(
            instrument_name=instrument.instrument_name,
            expiration_label=instrument.expiration_label,
            expiration_timestamp=instrument.expiration_timestamp,
            strike=instrument.strike,
            option_type=instrument.option_type,
            bid_price=summary.bid_price if summary is not None else None,
            ask_price=summary.ask_price if summary is not None else None,
            mid_price=summary.mid_price if summary is not None else None,
            last_price=summary.last_price if summary is not None else None,
            mark_price=summary.mark_price if summary is not None else None,
            mark_iv=summary.mark_iv if summary is not None else None,
            open_interest=summary.open_interest if summary is not None else None,
            volume=summary.volume if summary is not None else None,
            underlying_price=summary.underlying_price if summary is not None else None,
            underlying_index=summary.underlying_index if summary is not None else None,
            raw=summary.raw if summary is not None else instrument.raw,
        )

    def _parse_levels(self, raw_levels: object, *, reverse: bool) -> tuple[DeribitOrderLevel, ...]:
        if raw_levels is None:
            return ()
        if not isinstance(raw_levels, list):
            raise ProviderParseError("expected Deribit order book levels to be a list")

        levels: list[DeribitOrderLevel] = []
        for item in raw_levels:
            if not isinstance(item, (list, tuple)) or len(item) < 2:
                raise ProviderParseError("expected Deribit order book levels to contain price and size")
            price = _coerce_float(item[0])
            size = _coerce_float(item[1])
            if price is None or size is None:
                raise ProviderParseError(f"invalid Deribit order book level: {item}")
            levels.append(DeribitOrderLevel(price=price, size=size))
        return tuple(sorted(levels, key=lambda level: level.price, reverse=reverse))
