from __future__ import annotations

from dataclasses import dataclass

from ..http import JsonHttpClient, UrllibJsonClient
from ._coerce import _coerce_float
from .base import ProviderParseError, SignalProvider

_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"


def _rating_from_score(score: float) -> str:
    if score < 25:
        return "Extreme Fear"
    if score < 45:
        return "Fear"
    if score <= 55:
        return "Neutral"
    if score <= 74:
        return "Greed"
    return "Extreme Greed"


@dataclass(frozen=True)
class FearGreedSnapshot:
    score: float
    rating: str
    timestamp: str | None
    previous_close: float | None
    one_week_ago: float | None
    one_month_ago: float | None
    one_year_ago: float | None


_BROWSER_HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://edition.cnn.com/",
}


class FearGreedProvider(SignalProvider):
    provider_id = "fear_greed"
    display_name = "CNN Fear & Greed Index"
    capabilities = ("market_sentiment",)

    def __init__(self, http_client: JsonHttpClient | None = None) -> None:
        self.http_client = http_client or UrllibJsonClient(headers=_BROWSER_HEADERS)

    def get_index(self) -> FearGreedSnapshot:
        data = self.http_client.get_json(_URL)

        if not isinstance(data, dict):
            raise ProviderParseError("unexpected response type from CNN Fear & Greed")

        fg = data.get("fear_and_greed")
        if not isinstance(fg, dict):
            raise ProviderParseError("missing 'fear_and_greed' in response")

        score = _coerce_float(fg.get("score"))
        if score is None:
            raise ProviderParseError("missing or invalid 'score' in fear_and_greed")

        rating = fg.get("rating")
        if not isinstance(rating, str) or not rating:
            rating = _rating_from_score(score)

        return FearGreedSnapshot(
            score=score,
            rating=rating,
            timestamp=fg.get("timestamp"),
            previous_close=_coerce_float(fg.get("previous_close")),
            one_week_ago=_coerce_float(fg.get("previous_1_week")),
            one_month_ago=_coerce_float(fg.get("previous_1_month")),
            one_year_ago=_coerce_float(fg.get("previous_1_year")),
        )
