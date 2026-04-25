import json
import os
import sys
import traceback
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


CURRENT_DIR = Path(__file__).resolve().parent
UPSTREAM_ROOT = CURRENT_DIR / "digital-oracle-main"
if str(UPSTREAM_ROOT) not in sys.path:
    sys.path.insert(0, str(UPSTREAM_ROOT))

from digital_oracle import (  # noqa: E402
    BisProvider,
    BisRateQuery,
    CMEFedWatchProvider,
    CftcCotProvider,
    CftcCotQuery,
    CoinGeckoPriceQuery,
    CoinGeckoProvider,
    DeribitFuturesCurveQuery,
    DeribitOptionChainQuery,
    DeribitProvider,
    EdgarInsiderQuery,
    EdgarProvider,
    FearGreedProvider,
    KalshiMarketQuery,
    KalshiProvider,
    OptionsChainQuery,
    PolymarketEventQuery,
    PolymarketProvider,
    PriceHistoryQuery,
    USTreasuryProvider,
    WebSearchProvider,
    WorldBankProvider,
    WorldBankQuery,
    YahooPriceProvider,
    YFinanceProvider,
    YieldCurveQuery,
    gather,
)


def normalize_proxy_url() -> str | None:
    proxy_url = os.environ.get("DIGITAL_ORACLE_PROXY_URL", "").strip()
    proxy_port = os.environ.get("DIGITAL_ORACLE_PROXY_PORT", "").strip()

    if proxy_url:
        parsed = urlparse(proxy_url)
        if not parsed.scheme:
            proxy_url = f"http://{proxy_url}"
    elif proxy_port:
        if proxy_port.isdigit():
            proxy_url = f"http://127.0.0.1:{proxy_port}"
        else:
            proxy_url = proxy_port
            parsed = urlparse(proxy_url)
            if not parsed.scheme:
                proxy_url = f"http://{proxy_url}"
    else:
        return None

    parsed = urlparse(proxy_url)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError("代理配置无效，请使用类似 http://127.0.0.1:7890 的地址。")

    return proxy_url


def configure_proxy_from_env() -> None:
    proxy_url = normalize_proxy_url()
    if not proxy_url:
        return

    os.environ["HTTP_PROXY"] = proxy_url
    os.environ["HTTPS_PROXY"] = proxy_url
    os.environ["http_proxy"] = proxy_url
    os.environ["https_proxy"] = proxy_url


def read_stdin_json() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("stdin 输入必须是 JSON 对象。")
    return payload


def lower_key_map(data: dict[str, Any]) -> dict[str, Any]:
    return {str(k).lower(): v for k, v in data.items()}


def pick(data: dict[str, Any], *names: str, default: Any = None) -> Any:
    lowered = lower_key_map(data)
    for name in names:
        value = lowered.get(name.lower())
        if value is not None:
            return value
    return default


def coerce_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off"}:
        return False
    return default


def coerce_int(value: Any, default: int) -> int:
    if value is None or value == "":
        return default
    return int(value)


def coerce_tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, (list, tuple)):
        return tuple(str(item).strip() for item in value if str(item).strip())
    text = str(value).strip()
    if not text:
        return ()
    if text.startswith("[") and text.endswith("]"):
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return tuple(str(item).strip() for item in parsed if str(item).strip())
    return tuple(part.strip() for part in text.split(",") if part.strip())


def coerce_json_object(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return {}
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    raise ValueError("params/json 参数必须是 JSON 对象。")


def simplify(value: Any) -> Any:
    if is_dataclass(value):
        return simplify(asdict(value))
    if isinstance(value, dict):
        return {str(k): simplify(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [simplify(v) for v in value]
    if hasattr(value, "__dict__") and not isinstance(value, (str, bytes, int, float, bool)):
        return simplify(vars(value))
    return value


def short_json(value: Any, max_length: int = 1200) -> str:
    text = json.dumps(simplify(value), ensure_ascii=False, indent=2)
    if len(text) <= max_length:
        return text
    return text[: max_length - 20] + "\n... [已截断]"


def build_provider_registry() -> dict[str, dict[str, Any]]:
    return {
        "polymarket": {
            "summary": "预测市场事件与概率定价",
            "params": ["slug_contains", "title_contains", "limit", "active", "closed"],
        },
        "kalshi": {
            "summary": "美国监管二元市场",
            "params": ["series_ticker", "event_ticker", "limit", "status"],
        },
        "yahoo": {
            "summary": "股票/ETF/商品/外汇价格历史",
            "params": ["symbol", "interval", "limit", "start_date", "end_date"],
        },
        "treasury": {
            "summary": "美债收益率曲线",
            "params": ["curve_kind", "year"],
        },
        "cftc": {
            "summary": "CFTC 持仓报告（聪明钱方向）",
            "params": ["commodity_name", "limit"],
        },
        "coingecko": {
            "summary": "加密现货价格与市值",
            "params": ["coin_ids", "vs_currency", "include_market_cap"],
        },
        "deribit_futures": {
            "summary": "加密期货期限结构",
            "params": ["currency"],
        },
        "deribit_options": {
            "summary": "加密期权链与隐含波动率",
            "params": ["currency", "kind", "expired"],
        },
        "fear_greed": {
            "summary": "CNN 恐惧贪婪指数",
            "params": [],
        },
        "cme_fedwatch": {
            "summary": "美联储会议隐含概率",
            "params": [],
        },
        "worldbank": {
            "summary": "世界银行宏观指标",
            "params": ["indicator", "countries"],
        },
        "bis": {
            "summary": "央行政策利率",
            "params": ["countries", "start_year"],
        },
        "web": {
            "summary": "网页搜索补充 VIX/CDS/OAS 等交易信号",
            "params": ["query"],
        },
        "yfinance_options": {
            "summary": "美股期权链、IV、Greeks",
            "params": ["ticker", "expiration"],
        },
        "edgar": {
            "summary": "SEC 内部人交易 Form 4",
            "params": ["ticker", "limit"],
        },
    }


def list_providers_command() -> str:
    registry = build_provider_registry()
    lines = [
        "# DigitalOracle 可用信源",
        "",
        "| 信源标识 | 用途 | 常用参数 |",
        "|---|---|---|",
    ]
    for provider, meta in registry.items():
        lines.append(
            f"| {provider} | {meta['summary']} | {', '.join(meta['params']) if meta['params'] else '无'} |"
        )
    lines.extend(
        [
            "",
            "## 使用建议",
            "- 若用户要“手动选择信源一键拉取”，优先先调用 ListProviders 查看可选信源。",
            "- 单次调用建议聚焦 1~4 个独立维度，避免无关信号堆砌。",
            "- 若需市场总览，可调用 GetGlobalMacroDashboard。",
        ]
    )
    return "\n".join(lines)


def fetch_single_provider(provider_name: str, params: dict[str, Any]) -> dict[str, Any]:
    provider = provider_name.strip().lower()

    if provider == "polymarket":
        client = PolymarketProvider()
        query = PolymarketEventQuery(
            slug_contains=pick(params, "slug_contains", "keyword", "query"),
            title_contains=pick(params, "title_contains"),
            limit=coerce_int(pick(params, "limit"), 10),
            active=pick(params, "active", default=True),
            closed=pick(params, "closed", default=False),
        )
        result = client.list_events(query)
        return {
            "provider": provider,
            "count": len(result),
            "data": simplify(result[:10]),
        }

    if provider == "kalshi":
        client = KalshiProvider()
        query = KalshiMarketQuery(
            series_ticker=pick(params, "series_ticker"),
            event_ticker=pick(params, "event_ticker"),
            limit=coerce_int(pick(params, "limit"), 10),
            status=pick(params, "status"),
        )
        result = client.list_markets(query)
        return {
            "provider": provider,
            "count": len(result),
            "data": simplify(result[:10]),
        }

    if provider == "yahoo":
        client = YahooPriceProvider()
        symbol = pick(params, "symbol", "ticker")
        if not symbol:
            raise ValueError("yahoo 信源必须提供 symbol。")
        query = PriceHistoryQuery(
            symbol=str(symbol),
            interval=str(pick(params, "interval", default="d")),
            limit=coerce_int(pick(params, "limit"), 30),
            start_date=pick(params, "start_date"),
            end_date=pick(params, "end_date"),
        )
        result = client.get_history(query)
        return {
            "provider": provider,
            "symbol": symbol,
            "bar_count": len(result.bars),
            "data": simplify(result),
        }

    if provider == "treasury":
        client = USTreasuryProvider()
        query = YieldCurveQuery(
            year=coerce_int(pick(params, "year"), 0) or None,
            curve_kind=str(pick(params, "curve_kind", default="nominal")),
        )
        if query.year is None:
            query = YieldCurveQuery(curve_kind=query.curve_kind)
        result = client.latest_yield_curve(query)
        return {
            "provider": provider,
            "data": simplify(result),
        }

    if provider == "cftc":
        client = CftcCotProvider()
        commodity_name = pick(params, "commodity_name", "commodity")
        if not commodity_name:
            raise ValueError("cftc 信源必须提供 commodity_name。")
        query = CftcCotQuery(
            commodity_name=str(commodity_name).upper(),
            limit=coerce_int(pick(params, "limit"), 4),
        )
        result = client.list_reports(query)
        return {
            "provider": provider,
            "commodity_name": commodity_name,
            "count": len(result),
            "data": simplify(result),
        }

    if provider == "coingecko":
        client = CoinGeckoProvider()
        coin_ids = coerce_tuple(pick(params, "coin_ids", "coins"))
        if not coin_ids:
            raise ValueError("coingecko 信源必须提供 coin_ids。")
        query = CoinGeckoPriceQuery(
            coin_ids=coin_ids,
            include_market_cap=coerce_bool(pick(params, "include_market_cap"), True),
            include_24h_vol=coerce_bool(pick(params, "include_24h_vol"), True),
        )
        result = client.get_prices(query)
        return {
            "provider": provider,
            "coin_ids": list(coin_ids),
            "count": len(result),
            "data": simplify(result),
        }

    if provider == "deribit_futures":
        client = DeribitProvider()
        currency = str(pick(params, "currency", default="BTC")).upper()
        query = DeribitFuturesCurveQuery(currency=currency)
        result = client.get_futures_term_structure(query)
        return {
            "provider": provider,
            "currency": currency,
            "data": simplify(result),
        }

    if provider == "deribit_options":
        client = DeribitProvider()
        currency = str(pick(params, "currency", default="BTC")).upper()
        kind = str(pick(params, "kind", default="option"))
        query = DeribitOptionChainQuery(
            currency=currency,
            kind=kind,
            expired=coerce_bool(pick(params, "expired"), False),
        )
        result = client.get_option_chain(query)
        return {
            "provider": provider,
            "currency": currency,
            "quote_count": len(getattr(result, "quotes", []) or []),
            "data": simplify(result),
        }

    if provider == "fear_greed":
        client = FearGreedProvider()
        result = client.get_index()
        return {
            "provider": provider,
            "data": simplify(result),
        }

    if provider == "cme_fedwatch":
        client = CMEFedWatchProvider()
        result = client.get_probabilities()
        return {
            "provider": provider,
            "count": len(result),
            "data": simplify(result),
        }

    if provider == "worldbank":
        client = WorldBankProvider()
        indicator = pick(params, "indicator")
        countries = coerce_tuple(pick(params, "countries"))
        if not indicator or not countries:
            raise ValueError("worldbank 信源必须提供 indicator 和 countries。")
        query = WorldBankQuery(
            indicator=str(indicator),
            countries=countries,
        )
        result = client.get_indicator(query)
        return {
            "provider": provider,
            "indicator": indicator,
            "countries": list(countries),
            "data": simplify(result),
        }

    if provider == "bis":
        client = BisProvider()
        countries = coerce_tuple(pick(params, "countries"))
        if not countries:
            raise ValueError("bis 信源必须提供 countries。")
        query = BisRateQuery(
            countries=countries,
            start_year=coerce_int(pick(params, "start_year"), 2020),
        )
        result = client.get_policy_rates(query)
        return {
            "provider": provider,
            "countries": list(countries),
            "count": len(result),
            "data": simplify(result),
        }

    if provider == "web":
        client = WebSearchProvider()
        query = pick(params, "query", "keyword")
        if not query:
            raise ValueError("web 信源必须提供 query。")
        result = client.search(str(query))
        return {
            "provider": provider,
            "query": query,
            "data": simplify(result),
        }

    if provider == "yfinance_options":
        client = YFinanceProvider()
        ticker = pick(params, "ticker", "symbol")
        expiration = pick(params, "expiration")
        if not ticker or not expiration:
            raise ValueError("yfinance_options 信源必须提供 ticker 和 expiration。")
        query = OptionsChainQuery(
            ticker=str(ticker),
            expiration=str(expiration),
        )
        result = client.get_chain(query)
        return {
            "provider": provider,
            "ticker": ticker,
            "expiration": expiration,
            "data": simplify(result),
        }

    if provider == "edgar":
        email = os.environ.get("DIGITAL_ORACLE_SEC_EMAIL") or os.environ.get("SEC_USER_EMAIL")
        if not email:
            raise ValueError("edgar 信源需要环境变量 DIGITAL_ORACLE_SEC_EMAIL 或 SEC_USER_EMAIL。")
        client = EdgarProvider(user_email=email)
        ticker = pick(params, "ticker", "symbol")
        if not ticker:
            raise ValueError("edgar 信源必须提供 ticker。")
        query = EdgarInsiderQuery(
            ticker=str(ticker).upper(),
            limit=coerce_int(pick(params, "limit"), 10),
        )
        result = client.get_insider_transactions(query)
        return {
            "provider": provider,
            "ticker": ticker,
            "data": simplify(result),
        }

    raise ValueError(f"不支持的 provider/source: {provider_name}")


def render_provider_result(result: dict[str, Any]) -> str:
    provider = result.get("provider", "unknown")
    summary_lines = [
        f"# DigitalOracle 单信源结果：{provider}",
        "",
    ]

    meta_keys = [key for key in result.keys() if key not in {"provider", "data"}]
    if meta_keys:
        summary_lines.append("## 摘要")
        for key in meta_keys:
            summary_lines.append(f"- {key}: {result[key]}")
        summary_lines.append("")

    summary_lines.extend(
        [
            "## 原始结构化数据",
            "```json",
            short_json(result.get("data")),
            "```",
        ]
    )
    return "\n".join(summary_lines)


def fetch_market_data_command(args: dict[str, Any]) -> str:
    provider_name = pick(args, "provider", "source", "signal_source")
    if not provider_name:
        raise ValueError("FetchMarketData 必须提供 provider/source 参数。")
    params = coerce_json_object(pick(args, "params", "json", default={}))
    merged = dict(args)
    merged.update(params)
    result = fetch_single_provider(str(provider_name), merged)
    return render_provider_result(result)


def get_global_macro_dashboard_command(args: dict[str, Any]) -> str:
    risk_assets = coerce_tuple(pick(args, "risk_assets", default="SPY,QQQ,GC=F,CL=F,BTC-USD"))
    coin_ids = coerce_tuple(pick(args, "coin_ids", default="bitcoin,ethereum"))
    countries = coerce_tuple(pick(args, "countries", default="US,CN,JP,EU"))
    tasks = {
        "fear_greed": lambda: fetch_single_provider("fear_greed", {}),
        "fedwatch": lambda: fetch_single_provider("cme_fedwatch", {}),
        "yield_curve": lambda: fetch_single_provider("treasury", {"curve_kind": "nominal"}),
        "crypto": lambda: fetch_single_provider("coingecko", {"coin_ids": list(coin_ids)}),
        "btc_curve": lambda: fetch_single_provider("deribit_futures", {"currency": "BTC"}),
        "rates": lambda: fetch_single_provider("bis", {"countries": list(countries), "start_year": 2023}),
        "gold": lambda: fetch_single_provider("yahoo", {"symbol": "GC=F", "limit": 30}),
        "oil": lambda: fetch_single_provider("yahoo", {"symbol": "CL=F", "limit": 30}),
    }

    for symbol in risk_assets:
        label = f"asset_{symbol.replace('=', '_').replace('-', '_')}"
        tasks[label] = lambda symbol=symbol: fetch_single_provider(
            "yahoo", {"symbol": symbol, "limit": 30}
        )

    outcome = gather(tasks, timeout_seconds=120, fail_fast=False)

    lines = [
        "# DigitalOracle 全球金融监控面板",
        "",
        "## 成功信号",
    ]
    if outcome.results:
        for key, value in outcome.results.items():
            provider = value.get("provider", "unknown")
            lines.append(f"- {key}: {provider} 成功")
    else:
        lines.append("- 无成功结果")

    lines.extend(["", "## 失败信号"])
    if outcome.errors:
        for key, error in outcome.errors.items():
            lines.append(f"- {key}: {error}")
    else:
        lines.append("- 无")

    lines.extend(["", "## 结构化数据摘要"])
    for key, value in outcome.results.items():
        lines.extend(
            [
                f"### {key}",
                "```json",
                short_json(value),
                "```",
            ]
        )

    return "\n".join(lines)


def execute_command(args: dict[str, Any]) -> str:
    command = str(pick(args, "command", default="FetchMarketData")).strip()

    if command == "ListProviders":
        return list_providers_command()
    if command == "FetchMarketData":
        return fetch_market_data_command(args)
    if command == "GetGlobalMacroDashboard":
        return get_global_macro_dashboard_command(args)

    raise ValueError(f"不支持的 command: {command}")


def print_success(result: Any) -> None:
    print(json.dumps({"status": "success", "result": result}, ensure_ascii=False))


def print_error(message: str, *, code: str = "PLUGIN_ERROR", details: Any = None) -> None:
    payload = {
        "status": "error",
        "code": code,
        "error": message,
    }
    if details is not None:
        payload["details"] = details
    print(json.dumps(payload, ensure_ascii=False))


def main() -> None:
    try:
        configure_proxy_from_env()
        args = read_stdin_json()
        result = execute_command(args)
        print_success(result)
    except Exception as exc:
        debug_enabled = coerce_bool(os.environ.get("DIGITAL_ORACLE_DEBUG"), False)
        details = traceback.format_exc() if debug_enabled else None
        print_error(str(exc), details=details)
        sys.exit(1)


if __name__ == "__main__":
    main()