from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from digital_oracle.http import JsonHttpClient, UrllibJsonClient

from .base import ProviderError, ProviderParseError, SignalProvider

EDGAR_SUBMISSIONS_URL = "https://data.sec.gov/submissions"
EDGAR_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
EDGAR_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index"


@dataclass(frozen=True)
class EdgarInsiderQuery:
    ticker: str
    limit: int = 20


@dataclass(frozen=True)
class EdgarFiling:
    accession_number: str
    form_type: str
    filing_date: str
    report_date: str
    primary_document: str
    description: str


@dataclass(frozen=True)
class EdgarInsiderSummary:
    ticker: str
    company_name: str
    cik: str
    recent_form4s: tuple[EdgarFiling, ...]
    total_form4_count: int


@dataclass(frozen=True)
class EdgarSearchQuery:
    query: str
    forms: str = ""
    date_start: str = ""
    date_end: str = ""
    limit: int = 10


@dataclass(frozen=True)
class EdgarSearchHit:
    entity_name: str
    file_date: str
    form_type: str
    file_number: str
    description: str


def _extract_description(source: Mapping[str, Any]) -> str:
    """Extract description from a search hit _source."""
    display_names = source.get("display_names")
    if isinstance(display_names, list):
        return str(display_names[0]) if display_names else ""
    if display_names is not None:
        return str(display_names)
    return ""


class EdgarProvider(SignalProvider):
    provider_id = "sec_edgar"
    display_name = "SEC EDGAR"
    capabilities = ("insider_transactions", "filings_search")

    def __init__(
        self,
        http_client: JsonHttpClient | None = None,
        user_email: str | None = None,
    ):
        if http_client is None:
            # SEC EDGAR requires User-Agent with contact email to avoid 403.
            # See: https://www.sec.gov/os/accessing-edgar-data
            ua = f"digital-oracle/0.1 ({user_email})" if user_email else "digital-oracle/0.1"
            http_client = UrllibJsonClient(headers={
                "Accept": "application/json",
                "User-Agent": ua,
            })
        self.http_client: JsonHttpClient = http_client
        self._ticker_map: dict[str, dict[str, Any]] | None = None

    def _resolve_cik(self, ticker: str) -> tuple[str, str]:
        """Return (cik_padded, company_name) for a ticker."""
        if self._ticker_map is None:
            data = self.http_client.get_json(EDGAR_TICKERS_URL)
            if not isinstance(data, Mapping):
                raise ProviderParseError("expected company_tickers.json to be an object")
            self._ticker_map = {}
            for entry in data.values():
                if not isinstance(entry, Mapping):
                    continue
                t = str(entry.get("ticker", "")).upper()
                if t:
                    self._ticker_map[t] = dict(entry)
        ticker_upper = ticker.upper()
        entry = self._ticker_map.get(ticker_upper)
        if not entry:
            raise ProviderError(f"ticker not found: {ticker}")
        cik = str(entry["cik_str"]).zfill(10)
        return cik, str(entry.get("title", ""))

    def get_insider_transactions(self, query: EdgarInsiderQuery) -> EdgarInsiderSummary:
        """Get recent Form 4 filings (insider transactions) for a company."""
        cik, company_name = self._resolve_cik(query.ticker)
        submissions = self.http_client.get_json(
            f"{EDGAR_SUBMISSIONS_URL}/CIK{cik}.json"
        )
        if not isinstance(submissions, Mapping):
            raise ProviderParseError("expected submissions response to be an object")

        filings_block = submissions.get("filings")
        if not isinstance(filings_block, Mapping):
            raise ProviderParseError("expected submissions.filings to be an object")

        recent = filings_block.get("recent")
        if not isinstance(recent, Mapping):
            raise ProviderParseError("expected submissions.filings.recent to be an object")

        forms = recent.get("form", [])
        accession_numbers = recent.get("accessionNumber", [])
        filing_dates = recent.get("filingDate", [])
        report_dates = recent.get("reportDate", [])
        primary_documents = recent.get("primaryDocument", [])
        primary_doc_descriptions = recent.get("primaryDocDescription", [])

        n = len(forms)
        form4_filings: list[EdgarFiling] = []
        total_form4_count = 0
        for i in range(n):
            if str(forms[i]) != "4":
                continue
            total_form4_count += 1
            if len(form4_filings) < query.limit:
                form4_filings.append(
                    EdgarFiling(
                        accession_number=str(accession_numbers[i]) if i < len(accession_numbers) else "",
                        form_type="4",
                        filing_date=str(filing_dates[i]) if i < len(filing_dates) else "",
                        report_date=str(report_dates[i]) if i < len(report_dates) else "",
                        primary_document=str(primary_documents[i]) if i < len(primary_documents) else "",
                        description=str(primary_doc_descriptions[i]) if i < len(primary_doc_descriptions) else "",
                    )
                )

        return EdgarInsiderSummary(
            ticker=query.ticker.upper(),
            company_name=company_name,
            cik=cik,
            recent_form4s=tuple(form4_filings),
            total_form4_count=total_form4_count,
        )

    def search_filings(self, query: EdgarSearchQuery) -> list[EdgarSearchHit]:
        """Full-text search across SEC filings."""
        params: dict[str, object] = {
            "q": query.query,
        }
        if query.forms:
            params["forms"] = query.forms
        if query.date_start and query.date_end:
            params["dateRange"] = "custom"
            params["startdt"] = query.date_start
            params["enddt"] = query.date_end
        elif query.date_start:
            params["dateRange"] = "custom"
            params["startdt"] = query.date_start
        elif query.date_end:
            params["dateRange"] = "custom"
            params["enddt"] = query.date_end

        payload = self.http_client.get_json(EDGAR_SEARCH_URL, params=params)
        if not isinstance(payload, Mapping):
            raise ProviderParseError("expected search response to be an object")

        hits_outer = payload.get("hits")
        if not isinstance(hits_outer, Mapping):
            raise ProviderParseError("expected search response.hits to be an object")

        hits_inner = hits_outer.get("hits", [])
        if not isinstance(hits_inner, list):
            raise ProviderParseError("expected search response.hits.hits to be a list")

        results: list[EdgarSearchHit] = []
        for hit in hits_inner:
            if not isinstance(hit, Mapping):
                continue
            source = hit.get("_source", {})
            if not isinstance(source, Mapping):
                continue
            results.append(
                EdgarSearchHit(
                    entity_name=str(source.get("entity_name", "")),
                    file_date=str(source.get("file_date", "")),
                    form_type=str(source.get("form_type", "")),
                    file_number=str(source.get("file_num", "")),
                    description=_extract_description(source),
                )
            )
            if len(results) >= query.limit:
                break

        return results
