"""Yahoo Finance options chain provider.

Requires ``yfinance``: ``pip install yfinance``

This provider fetches US equity options chains from Yahoo Finance and computes
Black-Scholes Greeks using only the Python standard library (``math.erf``).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Protocol, Sequence

from ._coerce import _coerce_float, _coerce_int
from .base import ProviderError, ProviderParseError, SignalProvider


# ---------------------------------------------------------------------------
# Black-Scholes Greeks (pure stdlib, no scipy needed)
# ---------------------------------------------------------------------------


def _norm_cdf(x: float) -> float:
    """Standard normal CDF using ``math.erf`` (exact)."""
    return (1.0 + math.erf(x / math.sqrt(2.0))) / 2.0


def _norm_pdf(x: float) -> float:
    """Standard normal PDF."""
    return math.exp(-x * x / 2.0) / math.sqrt(2.0 * math.pi)


@dataclass(frozen=True)
class OptionGreeks:
    """Black-Scholes Greeks for a single option contract."""

    delta: float
    gamma: float
    theta: float  # per calendar day
    vega: float  # per 1% move in IV


def black_scholes_greeks(
    S: float,
    K: float,
    T: float,
    r: float,
    sigma: float,
    option_type: str,
) -> OptionGreeks | None:
    """Compute Black-Scholes Greeks.

    Args:
        S: Underlying price.
        K: Strike price.
        T: Time to expiration in years.
        r: Risk-free rate (annualised, e.g. 0.045 for 4.5%).
        sigma: Implied volatility (annualised, e.g. 0.30 for 30%).
        option_type: ``"call"`` or ``"put"``.

    Returns:
        :class:`OptionGreeks` or ``None`` if inputs are invalid.
    """
    if T <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        return None

    sqrt_T = math.sqrt(T)
    d1 = (math.log(S / K) + (r + sigma * sigma / 2.0) * T) / (sigma * sqrt_T)
    d2 = d1 - sigma * sqrt_T

    pdf_d1 = _norm_pdf(d1)

    gamma = pdf_d1 / (S * sigma * sqrt_T)
    vega = S * pdf_d1 * sqrt_T / 100.0  # per 1pp IV move

    if option_type == "call":
        delta = _norm_cdf(d1)
        theta = (
            -S * pdf_d1 * sigma / (2.0 * sqrt_T)
            - r * K * math.exp(-r * T) * _norm_cdf(d2)
        ) / 365.0
    else:
        delta = _norm_cdf(d1) - 1.0
        theta = (
            -S * pdf_d1 * sigma / (2.0 * sqrt_T)
            + r * K * math.exp(-r * T) * _norm_cdf(-d2)
        ) / 365.0

    return OptionGreeks(delta=delta, gamma=gamma, theta=theta, vega=vega)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OptionsChainQuery:
    """Query parameters for fetching an options chain."""

    ticker: str
    expiration: str | None = None  # YYYY-MM-DD; ``None`` → nearest expiration
    risk_free_rate: float = 0.045  # annualised; used for Greeks calculation
    compute_greeks: bool = True


@dataclass(frozen=True)
class OptionContract:
    """A single option contract with optional Greeks."""

    contract_symbol: str
    option_type: str  # "call" or "put"
    expiration: str  # YYYY-MM-DD
    strike: float
    last_price: float | None = None
    bid: float | None = None
    ask: float | None = None
    mid: float | None = None  # (bid + ask) / 2
    volume: int | None = None
    open_interest: int | None = None
    implied_volatility: float | None = None
    in_the_money: bool | None = None
    greeks: OptionGreeks | None = None


@dataclass(frozen=True)
class OptionsExpirations:
    """Available expiration dates for a ticker."""

    ticker: str
    expirations: tuple[str, ...]


@dataclass
class OptionsChain:
    """Full options chain for a single expiration date."""

    ticker: str
    expiration: str
    underlying_price: float | None
    calls: tuple[OptionContract, ...]
    puts: tuple[OptionContract, ...]

    # -- convenience properties ------------------------------------------

    @property
    def atm_strike(self) -> float | None:
        """Strike nearest to the underlying price."""
        if self.underlying_price is None:
            return None
        all_strikes = [c.strike for c in self.calls]
        if not all_strikes:
            all_strikes = [p.strike for p in self.puts]
        if not all_strikes:
            return None
        return min(all_strikes, key=lambda s: abs(s - self.underlying_price))

    @property
    def atm_call(self) -> OptionContract | None:
        """Nearest ATM call."""
        strike = self.atm_strike
        if strike is None:
            return None
        return next((c for c in self.calls if c.strike == strike), None)

    @property
    def atm_put(self) -> OptionContract | None:
        """Nearest ATM put."""
        strike = self.atm_strike
        if strike is None:
            return None
        return next((p for p in self.puts if p.strike == strike), None)

    @property
    def atm_iv(self) -> float | None:
        """ATM implied volatility (average of ATM call and put IV)."""
        ivs = [
            c.implied_volatility
            for c in [self.atm_call, self.atm_put]
            if c is not None and c.implied_volatility is not None
        ]
        if not ivs:
            return None
        return sum(ivs) / len(ivs)

    def implied_move(self) -> float | None:
        """ATM straddle implied move as a fraction of the underlying.

        Multiply by 100 to get a percentage.
        """
        call = self.atm_call
        put = self.atm_put
        if call is None or put is None or self.underlying_price is None:
            return None
        call_mid = call.mid if call.mid is not None else call.last_price
        put_mid = put.mid if put.mid is not None else put.last_price
        if call_mid is None or put_mid is None or self.underlying_price <= 0:
            return None
        return (call_mid + put_mid) / self.underlying_price

    @property
    def put_call_volume_ratio(self) -> float | None:
        """Total put volume / total call volume."""
        call_vol = sum(c.volume for c in self.calls if c.volume is not None)
        put_vol = sum(p.volume for p in self.puts if p.volume is not None)
        if call_vol == 0:
            return None
        return put_vol / call_vol

    @property
    def put_call_oi_ratio(self) -> float | None:
        """Total put OI / total call OI."""
        call_oi = sum(c.open_interest for c in self.calls if c.open_interest is not None)
        put_oi = sum(p.open_interest for p in self.puts if p.open_interest is not None)
        if call_oi == 0:
            return None
        return put_oi / call_oi

    @property
    def total_volume(self) -> int:
        """Total volume across all contracts."""
        return sum(c.volume for c in self.calls if c.volume is not None) + sum(
            p.volume for p in self.puts if p.volume is not None
        )

    @property
    def total_open_interest(self) -> int:
        """Total open interest across all contracts."""
        return sum(
            c.open_interest for c in self.calls if c.open_interest is not None
        ) + sum(p.open_interest for p in self.puts if p.open_interest is not None)

    def max_pain(self) -> float | None:
        """Max pain strike – the strike where option writers would pay least.

        For each candidate strike, sums the intrinsic value that ITM options
        would pay out weighted by open interest and picks the strike that
        minimises the total.
        """
        all_strikes = sorted({c.strike for c in self.calls} | {p.strike for p in self.puts})
        if not all_strikes:
            return None

        min_pain = float("inf")
        max_pain_strike = all_strikes[0]

        for test_strike in all_strikes:
            total_pain = 0.0
            for c in self.calls:
                oi = c.open_interest or 0
                intrinsic = max(test_strike - c.strike, 0.0)
                total_pain += intrinsic * oi
            for p in self.puts:
                oi = p.open_interest or 0
                intrinsic = max(p.strike - test_strike, 0.0)
                total_pain += intrinsic * oi
            if total_pain < min_pain:
                min_pain = total_pain
                max_pain_strike = test_strike

        return max_pain_strike


# ---------------------------------------------------------------------------
# Fetcher protocol (for testability)
# ---------------------------------------------------------------------------


class _ChainRows:
    """Container for raw option chain data (list-of-dicts)."""

    __slots__ = ("calls", "puts")

    def __init__(
        self, calls: list[dict[str, Any]], puts: list[dict[str, Any]]
    ) -> None:
        self.calls = calls
        self.puts = puts


class OptionsFetcher(Protocol):
    """Protocol that abstracts option data retrieval.

    The default implementation wraps *yfinance*; tests can supply a fake.
    """

    def fetch_expirations(self, ticker: str) -> tuple[str, ...]: ...
    def fetch_chain(self, ticker: str, expiration: str) -> _ChainRows: ...
    def fetch_underlying_price(self, ticker: str) -> float | None: ...


class _YFinanceFetcher:
    """Default fetcher backed by the *yfinance* library."""

    def __init__(self) -> None:
        import sys, os

        # Check local .deps directory first (from manual uv pip install --target)
        _deps = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), os.pardir, os.pardir, ".deps"
        )
        if os.path.isdir(_deps) and _deps not in sys.path:
            sys.path.insert(0, _deps)

        try:
            import yfinance  # type: ignore[import-untyped]
        except ImportError:
            raise ImportError(
                "yfinance is required for options chain analysis but is not installed.\n"
                "Install it with:  uv pip install --target .deps yfinance\n"
                "See README for details."
            )

        self._yf = yfinance

    def fetch_expirations(self, ticker: str) -> tuple[str, ...]:
        t = self._yf.Ticker(ticker)
        return tuple(t.options)

    def fetch_chain(self, ticker: str, expiration: str) -> _ChainRows:
        t = self._yf.Ticker(ticker)
        chain = t.option_chain(expiration)

        def _df_to_dicts(df: Any) -> list[dict[str, Any]]:  # pragma: no cover
            records: list[dict[str, Any]] = []
            for _, row in df.iterrows():
                d: dict[str, Any] = {}
                for col in df.columns:
                    val = row[col]
                    # Convert NaN to None
                    if isinstance(val, float) and math.isnan(val):
                        val = None
                    d[col] = val
                records.append(d)
            return records

        return _ChainRows(
            calls=_df_to_dicts(chain.calls),
            puts=_df_to_dicts(chain.puts),
        )

    def fetch_underlying_price(self, ticker: str) -> float | None:
        t = self._yf.Ticker(ticker)
        try:
            return float(t.fast_info["lastPrice"])
        except Exception:
            try:
                info = t.info
                price = info.get("regularMarketPrice") or info.get("currentPrice")
                return float(price) if price is not None else None
            except Exception:
                return None


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class YFinanceProvider(SignalProvider):
    """Yahoo Finance options chain provider.

    Provides options chain data with computed Black-Scholes Greeks.
    Requires ``yfinance``: ``pip install yfinance``.
    """

    provider_id = "yfinance"
    display_name = "Yahoo Finance Options"
    capabilities = ("options_chain", "options_expirations", "greeks")

    def __init__(self, *, fetcher: OptionsFetcher | None = None) -> None:
        self._fetcher: OptionsFetcher = fetcher or _YFinanceFetcher()

    # -- public API --------------------------------------------------------

    def get_expirations(self, ticker: str) -> OptionsExpirations:
        """List available options expiration dates for *ticker*."""
        exps = self._fetcher.fetch_expirations(ticker.upper())
        return OptionsExpirations(ticker=ticker.upper(), expirations=exps)

    def get_chain(self, query: OptionsChainQuery) -> OptionsChain:
        """Fetch the options chain for a specific expiration.

        If *query.expiration* is ``None`` the nearest available expiration is
        used.
        """
        ticker = query.ticker.upper()

        # Determine expiration
        expiration = query.expiration
        if expiration is None:
            exps = self._fetcher.fetch_expirations(ticker)
            if not exps:
                raise ProviderParseError(
                    f"no options expirations found for {ticker}"
                )
            expiration = exps[0]

        # Fetch raw data
        raw = self._fetcher.fetch_chain(ticker, expiration)
        underlying = self._fetcher.fetch_underlying_price(ticker)

        # Time to expiration (years)
        try:
            exp_date = datetime.strptime(expiration, "%Y-%m-%d").date()
            days_to_exp = (exp_date - date.today()).days
            T = max(days_to_exp, 0) / 365.0
        except ValueError:
            T = 0.0

        # Parse contracts
        calls = self._parse_contracts(
            raw.calls,
            "call",
            expiration,
            underlying,
            T,
            query.risk_free_rate,
            query.compute_greeks,
        )
        puts = self._parse_contracts(
            raw.puts,
            "put",
            expiration,
            underlying,
            T,
            query.risk_free_rate,
            query.compute_greeks,
        )

        return OptionsChain(
            ticker=ticker,
            expiration=expiration,
            underlying_price=underlying,
            calls=tuple(calls),
            puts=tuple(puts),
        )

    # -- internal ----------------------------------------------------------

    def _parse_contracts(
        self,
        rows: list[dict[str, Any]],
        option_type: str,
        expiration: str,
        underlying: float | None,
        T: float,
        risk_free_rate: float,
        compute_greeks: bool,
    ) -> list[OptionContract]:
        contracts: list[OptionContract] = []
        for row in rows:
            strike = _coerce_float(row.get("strike"))
            if strike is None:
                continue

            bid = _coerce_float(row.get("bid"))
            ask = _coerce_float(row.get("ask"))
            mid = None
            if bid is not None and ask is not None:
                mid = (bid + ask) / 2.0

            iv = _coerce_float(row.get("impliedVolatility"))

            # Compute Greeks when possible
            greeks = None
            if compute_greeks and iv is not None and underlying is not None and T > 0:
                greeks = black_scholes_greeks(
                    S=underlying,
                    K=strike,
                    T=T,
                    r=risk_free_rate,
                    sigma=iv,
                    option_type=option_type,
                )

            volume = _coerce_int(row.get("volume"))
            oi = _coerce_int(row.get("openInterest"))

            contract_symbol = str(row.get("contractSymbol", ""))
            last_price = _coerce_float(row.get("lastPrice"))
            in_the_money = row.get("inTheMoney")
            if in_the_money is not None:
                in_the_money = bool(in_the_money)

            contracts.append(
                OptionContract(
                    contract_symbol=contract_symbol,
                    option_type=option_type,
                    expiration=expiration,
                    strike=strike,
                    last_price=last_price,
                    bid=bid,
                    ask=ask,
                    mid=mid,
                    volume=volume,
                    open_interest=oi,
                    implied_volatility=iv,
                    in_the_money=in_the_money,
                    greeks=greeks,
                )
            )

        return contracts
