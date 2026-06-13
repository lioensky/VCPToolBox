#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通用域名/URL 安全检查程序（低交互、静态、非侵入）

能力：
- 支持输入域名或完整 URL，自动规范化 IDN/Punycode。
- DNS 解析：A/AAAA/CNAME/MX/NS/TXT/CAA（优先 dnspython，无依赖时降级）。
- HTTP/HTTPS 探测：状态码、跳转链、响应头、安全头、Cookie 属性。
- TLS 证书检查：颁发者、主题、SAN、有效期、剩余天数、TLS 版本。
- HTML 静态分析：表单、输入框、iframe、script、meta refresh、外链资源。
- JavaScript 静态扫描：混淆、跳转、外传 API、剪贴板、存储、指纹、反调试等。
- 域名启发式：IDN、Punycode、可疑 TLD、新注册/短域名提示、品牌仿冒模式。
- 可选 WHOIS：如果本机有 whois 命令则尝试查询。
- 输出 JSON + Markdown 报告。

注意：
- 不执行 JavaScript。
- 不提交表单。
- 不爆破、不扫描端口、不绕过访问控制。
- 仅做低交互 GET/HEAD 与静态内容分析。
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import html
import ipaddress
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple


VERSION = "1.0.0"

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0 Safari/537.36 DomainSafetyChecker/1.0"
)

SUSPICIOUS_TLDS = {
    "zip", "mov", "top", "xyz", "click", "cam", "icu", "cyou", "cfd", "mom", "monster",
    "quest", "rest", "sbs", "bond", "lol", "live", "work", "support", "shop", "vip",
}

SENSITIVE_WORDS = [
    "password", "passwd", "pwd", "token", "otp", "2fa", "mfa", "verify", "verification",
    "login", "signin", "signup", "register", "wallet", "seed", "mnemonic", "privatekey",
    "银行卡", "身份证", "验证码", "密码", "手机号", "邮箱", "助记词", "私钥", "钱包", "登录", "注册",
]

BRAND_KEYWORDS = [
    "google", "gmail", "apple", "icloud", "microsoft", "office", "outlook", "paypal",
    "binance", "okx", "telegram", "discord", "twitter", "facebook", "instagram",
    "whatsapp", "tiktok", "amazon", "netflix", "steam", "github", "cloudflare",
    "alipay", "wechat", "taobao", "douyin", "bilibili", "bank",
]

SUSPICIOUS_PATTERNS: List[Tuple[str, str, int, str]] = [
    ("credential_terms", r"(?i)(password|passwd|pwd|token|otp|2fa|mfa|验证码|密码|助记词|私钥|钱包|seed phrase|mnemonic|private key)", 3, "出现凭据/敏感信息相关关键字"),
    ("network_exfil", r"(?i)(sendBeacon|XMLHttpRequest|fetch\s*\(|axios\.|websocket|new\s+Image\s*\(|navigator\.sendBeacon)", 3, "脚本包含网络发送/请求能力"),
    ("clipboard_access", r"(?i)(navigator\.clipboard|execCommand\s*\(\s*['\"]copy|paste)", 3, "脚本访问剪贴板"),
    ("storage_cookie_access", r"(?i)(localStorage|sessionStorage|indexedDB|document\.cookie|cookieStore)", 2, "脚本访问本地存储或 Cookie"),
    ("fingerprinting", r"(?i)(canvas|webgl|AudioContext|enumerateDevices|getBattery|deviceMemory|hardwareConcurrency|navigator\.plugins|userAgent)", 2, "疑似浏览器指纹采集"),
    ("anti_debug", r"(?i)(debugger|devtools|disable-devtool|console\.clear|Function\(['\"]debugger)", 4, "疑似反调试/反分析"),
    ("obfuscation", r"(?i)(eval\s*\(|Function\s*\(|atob\s*\(|btoa\s*\(|String\.fromCharCode|unescape\s*\(|\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4})", 4, "疑似混淆或动态执行"),
    ("redirect_popup", r"(?i)(location\.href|location\.replace|window\.open|top\.location|parent\.location|meta\s+http-equiv=['\"]refresh)", 2, "脚本或页面包含跳转/弹窗"),
    ("webhook_bot", r"(?i)(api\.telegram\.org|bot[0-9]{6,}:|discord(?:app)?\.com/api/webhooks|webhook|slack\.com/api)", 5, "出现 Bot/Webhook 外传端点"),
    ("crypto_mining", r"(?i)(coinhive|cryptonight|monero|webminer|miner\.start|stratum\+tcp|wasm)", 6, "疑似加密货币挖矿"),
    ("extension_install", r"(?i)(chrome\.webstore|\.crx|userscript|tampermonkey|greasemonkey)", 4, "诱导安装扩展/用户脚本"),
    ("base64_blob", r"(?i)([A-Za-z0-9+/]{80,}={0,2})", 2, "长 Base64 样式字符串"),
]


@dataclass
class Finding:
    severity: str
    score: int
    category: str
    message: str
    evidence: Dict[str, Any] = field(default_factory=dict)


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self._in_title = False
        self.scripts: List[Dict[str, str]] = []
        self.forms: List[Dict[str, Any]] = []
        self.inputs: List[Dict[str, str]] = []
        self.iframes: List[Dict[str, str]] = []
        self.links: List[Dict[str, str]] = []
        self.meta: List[Dict[str, str]] = []
        self.current_script: Optional[Dict[str, str]] = None
        self.current_form: Optional[Dict[str, Any]] = None

    @staticmethod
    def attrs_dict(attrs: List[Tuple[str, Optional[str]]]) -> Dict[str, str]:
        return {k.lower(): (v or "") for k, v in attrs}

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        t = tag.lower()
        a = self.attrs_dict(attrs)

        if t == "title":
            self._in_title = True
        elif t == "script":
            item = {
                "src": a.get("src", ""),
                "type": a.get("type", ""),
                "integrity": a.get("integrity", ""),
                "crossorigin": a.get("crossorigin", ""),
                "inline": "",
            }
            self.scripts.append(item)
            self.current_script = item
        elif t == "form":
            item = {
                "action": a.get("action", ""),
                "method": a.get("method", "get").upper(),
                "id": a.get("id", ""),
                "class": a.get("class", ""),
                "inputs": [],
            }
            self.forms.append(item)
            self.current_form = item
        elif t in {"input", "textarea", "select"}:
            item = {
                "tag": t,
                "name": a.get("name", ""),
                "id": a.get("id", ""),
                "type": a.get("type", "text" if t == "input" else t),
                "autocomplete": a.get("autocomplete", ""),
                "placeholder": a.get("placeholder", ""),
                "required": "required" if "required" in a else "",
            }
            self.inputs.append(item)
            if self.current_form is not None:
                self.current_form["inputs"].append(item)
        elif t == "iframe":
            self.iframes.append({
                "src": a.get("src", ""),
                "sandbox": a.get("sandbox", ""),
                "allow": a.get("allow", ""),
            })
        elif t in {"a", "link", "img", "source", "video", "audio"}:
            key = "href" if t in {"a", "link"} else "src"
            self.links.append({
                "tag": t,
                "url": a.get(key, ""),
                "rel": a.get("rel", ""),
                "type": a.get("type", ""),
            })
        elif t == "meta":
            self.meta.append({
                "name": a.get("name", ""),
                "property": a.get("property", ""),
                "content": a.get("content", ""),
                "http-equiv": a.get("http-equiv", ""),
            })

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data.strip()
        if self.current_script is not None:
            self.current_script["inline"] += data

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t == "title":
            self._in_title = False
        elif t == "script":
            self.current_script = None
        elif t == "form":
            self.current_form = None


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_json(obj: Any) -> Any:
    try:
        json.dumps(obj, ensure_ascii=False)
        return obj
    except Exception:
        return repr(obj)


def normalize_input(target: str, default_scheme: str = "https") -> Dict[str, str]:
    target = target.strip()
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", target):
        target = f"{default_scheme}://{target}"

    parsed = urllib.parse.urlsplit(target)
    host = parsed.hostname or ""
    unicode_host = host
    ascii_host = host

    try:
        if host.startswith("xn--") or ".xn--" in host:
            unicode_host = host.encode("ascii").decode("idna")
        ascii_host = unicode_host.encode("idna").decode("ascii")
    except Exception:
        ascii_host = host

    port_part = f":{parsed.port}" if parsed.port else ""
    netloc = ascii_host + port_part

    if parsed.username:
        userinfo = urllib.parse.quote(parsed.username, safe="")
        if parsed.password:
            userinfo += ":" + urllib.parse.quote(parsed.password, safe="")
        netloc = userinfo + "@" + netloc

    path = urllib.parse.quote(urllib.parse.unquote(parsed.path or "/"), safe="/:@!$&'()*+,;=")
    query = urllib.parse.quote(urllib.parse.unquote(parsed.query), safe="=&?/:@!$'()*+,;%-._~")
    fragment = urllib.parse.quote(urllib.parse.unquote(parsed.fragment), safe="=&?/:@!$'()*+,;%-._~")

    ascii_url = urllib.parse.urlunsplit((parsed.scheme, netloc, path, query, fragment))
    unicode_netloc = unicode_host + port_part
    unicode_url = urllib.parse.urlunsplit((parsed.scheme, unicode_netloc, parsed.path or "/", parsed.query, parsed.fragment))

    return {
        "input": target,
        "scheme": parsed.scheme,
        "host_unicode": unicode_host,
        "host_ascii": ascii_host,
        "url_ascii": ascii_url,
        "url_unicode": unicode_url,
        "registered_domain_guess": ".".join(ascii_host.split(".")[-2:]) if "." in ascii_host else ascii_host,
        "tld": ascii_host.rsplit(".", 1)[-1].lower() if "." in ascii_host else "",
    }


def urljoin(base: str, child: str) -> str:
    if not child:
        return ""
    return urllib.parse.urljoin(base, child)


def hostname(url: str) -> str:
    try:
        return urllib.parse.urlsplit(url).hostname or ""
    except Exception:
        return ""


def run_command(args: List[str], timeout: int = 15) -> Dict[str, Any]:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        return {
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "stdout": proc.stdout[:20000],
            "stderr": proc.stderr[:10000],
        }
    except FileNotFoundError:
        return {"ok": False, "error": "command_not_found", "args": args}
    except Exception as exc:
        return {"ok": False, "error": repr(exc), "args": args}


def resolve_dns(host: str) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "host": host,
        "records": {"A": [], "AAAA": [], "CNAME": [], "MX": [], "NS": [], "TXT": [], "CAA": []},
        "errors": [],
    }

    try:
        import dns.resolver  # type: ignore

        resolver = dns.resolver.Resolver()
        resolver.lifetime = 8
        resolver.timeout = 4

        for rtype in result["records"].keys():
            try:
                answers = resolver.resolve(host, rtype)
                vals = []
                for ans in answers:
                    vals.append(str(ans).strip())
                result["records"][rtype] = vals
            except Exception as exc:
                result["errors"].append({"type": rtype, "error": repr(exc)})
    except Exception as exc:
        result["dnspython_available"] = False
        result["dnspython_error"] = repr(exc)
        try:
            infos = socket.getaddrinfo(host, None)
            for family, _, _, _, sockaddr in infos:
                ip = sockaddr[0]
                if family == socket.AF_INET and ip not in result["records"]["A"]:
                    result["records"]["A"].append(ip)
                elif family == socket.AF_INET6 and ip not in result["records"]["AAAA"]:
                    result["records"]["AAAA"].append(ip)
        except Exception as e:
            result["errors"].append({"type": "getaddrinfo", "error": repr(e)})
    else:
        result["dnspython_available"] = True

    enriched_ips = []
    for ip in result["records"].get("A", []) + result["records"].get("AAAA", []):
        info = {"ip": ip}
        try:
            obj = ipaddress.ip_address(ip)
            info.update({
                "version": obj.version,
                "is_private": obj.is_private,
                "is_loopback": obj.is_loopback,
                "is_reserved": obj.is_reserved,
                "reverse_pointer": obj.reverse_pointer,
            })
        except Exception:
            pass
        enriched_ips.append(info)
    result["ip_info"] = enriched_ips

    return result


class RedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self) -> None:
        super().__init__()
        self.chain: List[Dict[str, Any]] = []

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.chain.append({
            "from": req.full_url,
            "to": newurl,
            "status": code,
            "message": msg,
            "headers": dict(headers.items()),
        })
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_http(
    url: str,
    method: str = "GET",
    timeout: int = 12,
    max_bytes: int = 2_000_000,
    user_agent: str = DEFAULT_UA,
    proxy_url: str = "",
) -> Dict[str, Any]:
    started = time.time()
    redirect_handler = RedirectHandler()
    handlers = [redirect_handler]
    if proxy_url:
        handlers.append(urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url}))
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(
        url,
        method=method,
        headers={
            "User-Agent": user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
            "Connection": "close",
        },
    )

    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read(max_bytes) if method != "HEAD" else b""
            charset = resp.headers.get_content_charset() or "utf-8"
            text = raw.decode(charset, errors="replace") if raw else ""
            elapsed_ms = int((time.time() - started) * 1000)
            return {
                "ok": True,
                "url": url,
                "method": method,
                "final_url": resp.geturl(),
                "status": getattr(resp, "status", None),
                "headers": dict(resp.headers.items()),
                "content_type": resp.headers.get("Content-Type", ""),
                "charset": charset,
                "elapsed_ms": elapsed_ms,
                "bytes_read": len(raw),
                "sha256": sha256_bytes(raw) if raw else "",
                "redirect_chain": redirect_handler.chain,
                "text": text,
                "error": "",
                "used_proxy": bool(proxy_url),
                "proxy_url": proxy_url if proxy_url else "",
            }
    except urllib.error.HTTPError as exc:
        raw = b""
        try:
            raw = exc.read(max_bytes) if method != "HEAD" else b""
        except Exception:
            pass
        charset = exc.headers.get_content_charset() or "utf-8" if exc.headers else "utf-8"
        text = raw.decode(charset, errors="replace") if raw else ""
        elapsed_ms = int((time.time() - started) * 1000)
        return {
            "ok": False,
            "url": url,
            "method": method,
            "final_url": exc.geturl(),
            "status": exc.code,
            "headers": dict(exc.headers.items()) if exc.headers else {},
            "content_type": exc.headers.get("Content-Type", "") if exc.headers else "",
            "charset": charset,
            "elapsed_ms": elapsed_ms,
            "bytes_read": len(raw),
            "sha256": sha256_bytes(raw) if raw else "",
            "redirect_chain": redirect_handler.chain,
            "text": text,
            "error": repr(exc),
            "used_proxy": bool(proxy_url),
            "proxy_url": proxy_url if proxy_url else "",
        }
    except Exception as exc:
        elapsed_ms = int((time.time() - started) * 1000)
        return {
            "ok": False,
            "url": url,
            "method": method,
            "final_url": "",
            "status": None,
            "headers": {},
            "content_type": "",
            "charset": "",
            "elapsed_ms": elapsed_ms,
            "bytes_read": 0,
            "sha256": "",
            "redirect_chain": redirect_handler.chain,
            "text": "",
            "error": repr(exc),
            "used_proxy": bool(proxy_url),
            "proxy_url": proxy_url if proxy_url else "",
        }


def should_retry_with_proxy(fetch_result: Dict[str, Any]) -> bool:
    if not fetch_result.get("used_proxy") and not fetch_result.get("ok"):
        return True
    status = fetch_result.get("status")
    if isinstance(status, int) and status in {403, 407, 408, 429, 500, 502, 503, 504}:
        return True
    return False


def fetch_http_with_optional_proxy(
    url: str,
    method: str = "GET",
    timeout: int = 12,
    max_bytes: int = 2_000_000,
    user_agent: str = DEFAULT_UA,
    proxy_url: str = "",
    retry_on_failure: bool = True,
) -> Dict[str, Any]:
    direct_result = fetch_http(url, method, timeout, max_bytes, user_agent, proxy_url="")
    if proxy_url and retry_on_failure and should_retry_with_proxy(direct_result):
        proxy_result = fetch_http(url, method, timeout, max_bytes, user_agent, proxy_url=proxy_url)
        proxy_result["direct_attempt"] = {k: v for k, v in direct_result.items() if k != "text"}
        proxy_result["proxy_retry_performed"] = True
        return proxy_result
    direct_result["proxy_retry_performed"] = False
    return direct_result


def get_tls_info(host: str, port: int = 443, timeout: int = 10) -> Dict[str, Any]:
    result: Dict[str, Any] = {"host": host, "port": port, "ok": False}
    try:
        ctx = ssl.create_default_context()
        started = time.time()
        with socket.create_connection((host, port), timeout=timeout) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as ssock:
                cert = ssock.getpeercert()
                cipher = ssock.cipher()
                version = ssock.version()
                elapsed_ms = int((time.time() - started) * 1000)

        not_before = cert.get("notBefore", "")
        not_after = cert.get("notAfter", "")
        expires_dt = None
        days_left = None
        try:
            expires_dt = dt.datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=dt.timezone.utc)
            days_left = (expires_dt - dt.datetime.now(dt.timezone.utc)).days
        except Exception:
            pass

        san = []
        for kind, value in cert.get("subjectAltName", []):
            if kind.lower() == "dns":
                san.append(value)

        result.update({
            "ok": True,
            "tls_version": version,
            "cipher": cipher,
            "elapsed_ms": elapsed_ms,
            "subject": cert.get("subject", []),
            "issuer": cert.get("issuer", []),
            "serialNumber": cert.get("serialNumber", ""),
            "notBefore": not_before,
            "notAfter": not_after,
            "days_left": days_left,
            "subjectAltName_dns": san,
        })
    except Exception as exc:
        result["error"] = repr(exc)
    return result


def parse_set_cookie(headers: Dict[str, str]) -> List[Dict[str, Any]]:
    cookies: List[Dict[str, Any]] = []
    raw_values = []
    for k, v in headers.items():
        if k.lower() == "set-cookie":
            raw_values.append(v)

    for raw in raw_values:
        parts = [p.strip() for p in raw.split(";")]
        if not parts:
            continue
        name = parts[0].split("=", 1)[0]
        attrs = {p.lower().split("=", 1)[0]: p for p in parts[1:]}
        cookies.append({
            "name": name,
            "secure": "secure" in attrs,
            "httponly": "httponly" in attrs,
            "samesite": attrs.get("samesite", ""),
            "raw": raw[:500],
        })
    return cookies


def analyze_security_headers(headers: Dict[str, str], scheme: str) -> Dict[str, Any]:
    lower = {k.lower(): v for k, v in headers.items()}
    checks = {
        "strict-transport-security": "strict-transport-security" in lower,
        "content-security-policy": "content-security-policy" in lower,
        "x-frame-options": "x-frame-options" in lower,
        "x-content-type-options": lower.get("x-content-type-options", "").lower() == "nosniff",
        "referrer-policy": "referrer-policy" in lower,
        "permissions-policy": "permissions-policy" in lower,
    }

    missing = [k for k, ok in checks.items() if not ok]
    return {
        "checks": checks,
        "missing": missing,
        "server": lower.get("server", ""),
        "powered_by": lower.get("x-powered-by", ""),
        "cookies": parse_set_cookie(headers),
        "https_used": scheme == "https",
    }


def extract_domains_from_text(text: str) -> List[str]:
    pattern = r"(?i)\bhttps?://[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:/[^\s'\"<>)]*)?"
    return sorted(set(re.findall(pattern, text)))


def try_decode_obfuscated_strings(text: str, limit: int = 30) -> List[Dict[str, str]]:
    candidates = set(re.findall(r"['\"]([A-Za-z0-9+/=]{16,200})['\"]", text))
    decoded: List[Dict[str, str]] = []

    for c in list(candidates)[:300]:
        attempts = [("base64", c), ("reverse_base64", c[::-1])]
        for method, s in attempts:
            try:
                padded = s + ("=" * ((4 - len(s) % 4) % 4))
                raw = base64.b64decode(padded, validate=False)
                val = raw.decode("utf-8", errors="replace")
                if re.search(r"(?i)(https?://|[a-z0-9.-]+\.[a-z]{2,})", val) and len(val) >= 6:
                    decoded.append({"method": method, "source": c, "decoded": val[:500]})
                    if len(decoded) >= limit:
                        return decoded
            except Exception:
                continue

    return decoded


def scan_text_for_findings(source: str, text: str) -> List[Finding]:
    findings: List[Finding] = []
    for category, pattern, score, msg in SUSPICIOUS_PATTERNS:
        samples = []
        for match in re.finditer(pattern, text):
            start = max(0, match.start() - 90)
            end = min(len(text), match.end() + 90)
            snippet = text[start:end].replace("\n", "\\n").replace("\r", "\\r")
            samples.append({
                "match": match.group(0)[:160],
                "offset": match.start(),
                "snippet": snippet[:320],
            })
            if len(samples) >= 10:
                break
        if samples:
            sev = "high" if score >= 5 else "medium" if score >= 3 else "low"
            findings.append(Finding(sev, score, category, msg, {"source": source, "samples": samples, "sample_count": len(samples)}))
    return findings


def analyze_html(base_url: str, html_text: str, fetch_scripts: bool, timeout: int, proxy_url: str = "", proxy_retry: bool = True) -> Dict[str, Any]:
    parser = PageParser()
    parser.feed(html_text)

    page_host = hostname(base_url)
    forms = []
    findings: List[Finding] = []
    all_text_to_scan = html_text

    for form in parser.forms:
        action_abs = urljoin(base_url, form.get("action", ""))
        action_host = hostname(action_abs)
        sensitive_inputs = []
        for inp in form.get("inputs", []):
            blob = json.dumps(inp, ensure_ascii=False)
            if any(w.lower() in blob.lower() for w in SENSITIVE_WORDS):
                sensitive_inputs.append(inp)

        forms.append({
            "method": form.get("method", ""),
            "action": form.get("action", ""),
            "action_absolute": action_abs,
            "action_host": action_host,
            "cross_domain": bool(action_host and page_host and action_host != page_host),
            "input_count": len(form.get("inputs", [])),
            "sensitive_inputs": sensitive_inputs,
        })

    for form in forms:
        if form["cross_domain"]:
            findings.append(Finding("high", 5, "cross_domain_form", "表单提交到跨域地址", {"form": form}))
        if form["sensitive_inputs"]:
            findings.append(Finding("medium", 3, "sensitive_form", "页面包含敏感输入字段", {"form": form}))

    iframe_items = []
    for iframe in parser.iframes:
        src_abs = urljoin(base_url, iframe.get("src", ""))
        iframe_items.append({**iframe, "src_absolute": src_abs, "host": hostname(src_abs)})
        if src_abs and hostname(src_abs) and hostname(src_abs) != page_host:
            findings.append(Finding("medium", 3, "cross_domain_iframe", "页面包含跨域 iframe", {"iframe": iframe_items[-1]}))

    link_items = []
    external_hosts: Set[str] = set()
    for link in parser.links:
        abs_url = urljoin(base_url, link.get("url", ""))
        h = hostname(abs_url)
        item = {**link, "url_absolute": abs_url, "host": h}
        link_items.append(item)
        if h and page_host and h != page_host:
            external_hosts.add(h)

    script_items = []
    script_hosts: Set[str] = set()
    for idx, script in enumerate(parser.scripts):
        src_abs = urljoin(base_url, script.get("src", ""))
        h = hostname(src_abs)
        inline = script.get("inline", "")
        item: Dict[str, Any] = {
            "index": idx,
            "src": script.get("src", ""),
            "src_absolute": src_abs,
            "host": h,
            "type": script.get("type", ""),
            "integrity": script.get("integrity", ""),
            "crossorigin": script.get("crossorigin", ""),
            "inline_bytes": len(inline.encode("utf-8", errors="replace")),
            "inline_sha256": sha256_bytes(inline.encode("utf-8", errors="replace")) if inline else "",
            "fetched": None,
        }

        if h:
            script_hosts.add(h)
            if page_host and h != page_host and not script.get("integrity", ""):
                findings.append(Finding("medium", 3, "external_script_no_sri", "跨域脚本缺少 Subresource Integrity", {"script": item}))

        if inline:
            findings.extend(scan_text_for_findings(f"inline_script_{idx}", inline))
            all_text_to_scan += "\n" + inline

        if fetch_scripts and src_abs.startswith(("http://", "https://")):
            fetched = fetch_http_with_optional_proxy(src_abs, "GET", timeout=timeout, max_bytes=500_000, proxy_url=proxy_url, retry_on_failure=proxy_retry)
            item["fetched"] = {k: v for k, v in fetched.items() if k != "text"}
            if fetched.get("text"):
                findings.extend(scan_text_for_findings(f"external_script_{idx}:{src_abs}", fetched["text"]))
                all_text_to_scan += "\n" + fetched["text"]

        script_items.append(item)

    meta_refresh = []
    for meta in parser.meta:
        if meta.get("http-equiv", "").lower() == "refresh":
            meta_refresh.append(meta)
            findings.append(Finding("medium", 3, "meta_refresh", "页面包含 meta refresh 跳转", {"meta": meta}))

    decoded_strings = try_decode_obfuscated_strings(all_text_to_scan)
    for d in decoded_strings:
        findings.append(Finding("low", 2, "decoded_hidden_url", "发现可解码的隐藏 URL/域名字符串", d))

    extracted_urls = extract_domains_from_text(all_text_to_scan)

    findings.extend(scan_text_for_findings("html", html_text))

    return {
        "title": parser.title,
        "forms": forms,
        "inputs_total": len(parser.inputs),
        "scripts": script_items,
        "iframes": iframe_items,
        "links": link_items[:300],
        "external_hosts": sorted(external_hosts),
        "script_hosts": sorted(script_hosts),
        "meta": parser.meta,
        "meta_refresh": meta_refresh,
        "decoded_strings": decoded_strings,
        "extracted_urls": extracted_urls[:300],
        "findings": [finding_to_dict(f) for f in findings],
    }


def finding_to_dict(f: Finding) -> Dict[str, Any]:
    return {
        "severity": f.severity,
        "score": f.score,
        "category": f.category,
        "message": f.message,
        "evidence": safe_json(f.evidence),
    }


def domain_heuristics(norm: Dict[str, str]) -> List[Finding]:
    host_u = norm["host_unicode"]
    host_a = norm["host_ascii"]
    tld = norm["tld"]
    findings: List[Finding] = []

    if any(ord(ch) > 127 for ch in host_u):
        findings.append(Finding("medium", 3, "idn_domain", "域名包含非 ASCII 字符，需注意同形字/仿冒风险", {"unicode": host_u, "punycode": host_a}))

    if "xn--" in host_a:
        findings.append(Finding("medium", 3, "punycode_domain", "域名使用 Punycode/IDN 编码", {"host": host_a}))

    if tld in SUSPICIOUS_TLDS:
        findings.append(Finding("low", 2, "suspicious_tld", "域名后缀在滥用场景中较常见", {"tld": tld}))

    labels = host_a.split(".")
    if any(len(label) > 30 for label in labels):
        findings.append(Finding("low", 2, "long_label", "域名标签过长，可能为生成型或混淆域名", {"host": host_a}))

    if re.search(r"\d{4,}|-[a-z0-9]{6,}|[a-z]{10,}\d{2,}", host_a, re.I):
        findings.append(Finding("low", 2, "generated_like_domain", "域名形态疑似自动生成或批量注册", {"host": host_a}))

    for brand in BRAND_KEYWORDS:
        if brand in host_a.lower() and not host_a.lower().endswith(f"{brand}.com"):
            findings.append(Finding("medium", 3, "brand_keyword", "域名包含知名品牌关键字，需警惕仿冒", {"brand": brand, "host": host_a}))
            break

    return findings


def whois_lookup(host: str, enabled: bool) -> Dict[str, Any]:
    if not enabled:
        return {"enabled": False}
    base = ".".join(host.split(".")[-2:]) if "." in host else host
    cmd = ["whois", base]
    res = run_command(cmd, timeout=20)
    return {"enabled": True, "query": base, "result": res}


def score_report(report: Dict[str, Any]) -> Dict[str, Any]:
    score = 0
    findings = []

    def add_from(items: Iterable[Dict[str, Any]]) -> None:
        nonlocal score
        for item in items:
            score += int(item.get("score", 0))
            findings.append(item)

    add_from(report.get("domain_heuristics", []))

    http_checks = report.get("http", {})
    https = http_checks.get("https", {})
    http_plain = http_checks.get("http", {})

    if not https.get("ok") and http_plain.get("ok"):
        f = finding_to_dict(Finding("medium", 4, "no_https", "HTTPS 不可用但 HTTP 可用", {}))
        findings.append(f)
        score += f["score"]

    if https.get("ok"):
        sec = https.get("security_headers", {})
        missing = sec.get("missing", [])
        if "strict-transport-security" in missing:
            f = finding_to_dict(Finding("low", 1, "missing_hsts", "缺少 HSTS 响应头", {}))
            findings.append(f)
            score += f["score"]
        if "content-security-policy" in missing:
            f = finding_to_dict(Finding("low", 1, "missing_csp", "缺少 CSP 响应头", {}))
            findings.append(f)
            score += f["score"]
        if sec.get("powered_by"):
            f = finding_to_dict(Finding("low", 1, "technology_disclosure", "响应头泄露后端技术信息", {"x-powered-by": sec.get("powered_by")}))
            findings.append(f)
            score += f["score"]
        for cookie in sec.get("cookies", []):
            if not cookie.get("secure") or not cookie.get("httponly"):
                f = finding_to_dict(Finding("low", 1, "weak_cookie_flags", "Cookie 缺少 Secure 或 HttpOnly 属性", {"cookie": cookie}))
                findings.append(f)
                score += f["score"]

    tls = report.get("tls", {})
    if tls.get("ok"):
        days_left = tls.get("days_left")
        if isinstance(days_left, int) and days_left < 15:
            f = finding_to_dict(Finding("medium", 3, "tls_expiring", "TLS 证书即将过期", {"days_left": days_left}))
            findings.append(f)
            score += f["score"]
        elif isinstance(days_left, int) and days_left < 0:
            f = finding_to_dict(Finding("high", 6, "tls_expired", "TLS 证书已过期", {"days_left": days_left}))
            findings.append(f)
            score += f["score"]
    elif report.get("normalized", {}).get("scheme") == "https":
        f = finding_to_dict(Finding("medium", 4, "tls_error", "TLS 握手或证书检查失败", {"error": tls.get("error", "")}))
        findings.append(f)
        score += f["score"]

    html_analysis = report.get("html_analysis", {})
    add_from(html_analysis.get("findings", []))

    dns = report.get("dns", {})
    records = dns.get("records", {})
    if not records.get("A") and not records.get("AAAA"):
        f = finding_to_dict(Finding("medium", 4, "no_dns_address", "未解析到 A/AAAA 地址", {}))
        findings.append(f)
        score += f["score"]

    if score >= 30:
        level = "critical"
    elif score >= 18:
        level = "high"
    elif score >= 9:
        level = "medium"
    elif score >= 3:
        level = "low"
    else:
        level = "minimal"

    by_category: Dict[str, int] = {}
    for f in findings:
        by_category[f["category"]] = by_category.get(f["category"], 0) + 1

    return {
        "level": level,
        "score": score,
        "finding_count": len(findings),
        "categories": by_category,
        "findings": findings,
    }


def build_report(target: str, args: argparse.Namespace) -> Dict[str, Any]:
    norm = normalize_input(target, args.default_scheme)
    host = norm["host_ascii"]
    proxy_url = getattr(args, "proxy_url", "") or ""
    proxy_retry = bool(getattr(args, "proxy_retry_on_failure", True))

    report: Dict[str, Any] = {
        "tool": {"name": "domain_safety_checker", "version": VERSION},
        "generated_at": utc_now(),
        "target": target,
        "normalized": norm,
        "domain_heuristics": [finding_to_dict(f) for f in domain_heuristics(norm)],
        "dns": {},
        "tls": {},
        "http": {},
        "html_analysis": {},
        "whois": {},
        "risk": {},
        "network": {
            "proxy_url_configured": bool(proxy_url),
            "proxy_url": proxy_url,
            "proxy_retry_on_failure": proxy_retry,
            "proxy_scope": "HTTP/HTTPS 页面与外部脚本请求；DNS 和 TLS 原始证书握手不经 urllib 代理。",
        },
    }

    report["dns"] = resolve_dns(host)

    if args.tls:
        report["tls"] = get_tls_info(host, 443, args.timeout)

    https_url = norm["url_ascii"]
    if not https_url.startswith("https://"):
        parsed = urllib.parse.urlsplit(https_url)
        https_url = urllib.parse.urlunsplit(("https", parsed.netloc, parsed.path or "/", parsed.query, parsed.fragment))

    http_url = norm["url_ascii"]
    parsed2 = urllib.parse.urlsplit(http_url)
    http_url = urllib.parse.urlunsplit(("http", parsed2.netloc, parsed2.path or "/", parsed2.query, parsed2.fragment))

    http_report: Dict[str, Any] = {}

    if args.http:
        http_fetch = fetch_http_with_optional_proxy(
            http_url,
            "GET" if args.get_http else "HEAD",
            args.timeout,
            args.max_bytes,
            args.user_agent,
            proxy_url=proxy_url,
            retry_on_failure=proxy_retry,
        )
        http_report["http"] = {k: v for k, v in http_fetch.items() if k != "text"}
        http_report["http"]["security_headers"] = analyze_security_headers(http_fetch.get("headers", {}), "http")

    https_fetch = fetch_http_with_optional_proxy(
        https_url,
        "GET",
        args.timeout,
        args.max_bytes,
        args.user_agent,
        proxy_url=proxy_url,
        retry_on_failure=proxy_retry,
    )
    http_report["https"] = {k: v for k, v in https_fetch.items() if k != "text"}
    http_report["https"]["security_headers"] = analyze_security_headers(https_fetch.get("headers", {}), "https")

    report["http"] = http_report

    text = https_fetch.get("text", "")
    content_type = https_fetch.get("content_type", "")
    if text and ("html" in content_type.lower() or text.lstrip().lower().startswith("<!doctype") or "<html" in text[:1000].lower()):
        report["html_analysis"] = analyze_html(
            base_url=https_fetch.get("final_url") or https_url,
            html_text=text,
            fetch_scripts=args.fetch_scripts,
            timeout=args.timeout,
            proxy_url=proxy_url,
            proxy_retry=proxy_retry,
        )

    report["whois"] = whois_lookup(host, args.whois)
    report["risk"] = score_report(report)

    return report


def write_json(path: str, report: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)


def md_escape(text: Any) -> str:
    s = str(text)
    return s.replace("|", "\\|").replace("\n", " ").strip()


def generate_markdown(report: Dict[str, Any], include_json: bool = True) -> str:
    norm = report["normalized"]
    risk = report["risk"]
    https = report.get("http", {}).get("https", {})
    http_plain = report.get("http", {}).get("http", {})
    tls = report.get("tls", {})
    dns = report.get("dns", {})
    html_analysis = report.get("html_analysis", {})
    whois = report.get("whois", {})
    network = report.get("network", {})

    lines = []
    lines.append("# URL / 域名安全核查报告")
    lines.append("")
    lines.append("> 说明：本报告由 DomainSafetyChecker 以低交互、静态、非侵入方式生成；它不会执行 JavaScript、不会提交表单、不会爆破或扫描端口。结论用于风险提示和安全防护建议，不等同于权威信誉背书。")
    lines.append("")
    lines.append("## 1. 核查对象")
    lines.append("")
    lines.append(f"- 原始输入：`{report.get('target')}`")
    lines.append(f"- Unicode 域名：`{norm.get('host_unicode')}`")
    lines.append(f"- ASCII/Punycode 域名：`{norm.get('host_ascii')}`")
    lines.append(f"- 规范化 URL：`{norm.get('url_ascii')}`")
    lines.append(f"- 默认协议：`{norm.get('scheme')}`")
    lines.append(f"- 推测注册域：`{norm.get('registered_domain_guess')}`")
    lines.append(f"- 顶级域名：`{norm.get('tld')}`")
    lines.append(f"- 生成时间：`{report.get('generated_at')}`")
    lines.append("")
    lines.append("## 2. 网络访问配置")
    lines.append("")
    lines.append(f"- 已配置 HTTP/HTTPS 代理：`{network.get('proxy_url_configured', False)}`")
    if network.get("proxy_url_configured"):
        lines.append(f"- 代理地址：`{network.get('proxy_url')}`")
        lines.append(f"- 访问失败自动代理重试：`{network.get('proxy_retry_on_failure')}`")
        lines.append(f"- 代理适用范围：{network.get('proxy_scope')}")
    else:
        lines.append("- 当前使用直连模式；如部分站点访问失败，可在插件 `config.env` 中配置代理后自动重试。")
    lines.append("")
    lines.append("## 3. 总体风险结论")
    lines.append("")
    lines.append(f"- 风险等级：**{risk.get('level')}**")
    lines.append(f"- 风险分数：**{risk.get('score')}**")
    lines.append(f"- 发现项数量：**{risk.get('finding_count')}**")
    lines.append(f"- 发现类别：`{', '.join(sorted(risk.get('categories', {}).keys())) or '无'}`")
    lines.append("")
    lines.append("### 风险等级解释")
    lines.append("")
    lines.append("| 等级 | 含义 | 建议动作 |")
    lines.append("|---|---|---|")
    lines.append("| minimal | 未发现明显静态风险点 | 正常谨慎访问，不输入不必要敏感信息 |")
    lines.append("| low | 存在轻微信息暴露、配置缺失或启发式疑点 | 谨慎访问，避免复用密码 |")
    lines.append("| medium | 存在多个可疑点或中等风险信号 | 不建议输入账号、支付、身份信息；建议隔离环境验证 |")
    lines.append("| high | 存在明显恶意、钓鱼、外传或证书/跳转风险 | 不建议访问或交互，必要时仅在沙箱中查看 |")
    lines.append("| critical | 多个强恶意信号叠加 | 立即停止访问，建议加入拦截/封禁列表 |")
    lines.append("")
    lines.append("## 4. HTTP / HTTPS 探测")
    lines.append("")
    lines.append("### HTTPS")
    lines.append("")
    lines.append(f"- 请求成功：`{https.get('ok')}`")
    lines.append(f"- 状态码：`{https.get('status')}`")
    lines.append(f"- 最终 URL：`{https.get('final_url')}`")
    lines.append(f"- Content-Type：`{https.get('content_type')}`")
    lines.append(f"- 响应耗时：`{https.get('elapsed_ms', '')} ms`")
    lines.append(f"- 读取字节数：`{https.get('bytes_read', '')}`")
    lines.append(f"- 页面 SHA256：`{https.get('sha256', '')}`")
    lines.append(f"- Server：`{https.get('headers', {}).get('Server', '')}`")
    lines.append(f"- 使用代理：`{https.get('used_proxy', False)}`")
    lines.append(f"- 执行过代理重试：`{https.get('proxy_retry_performed', False)}`")
    if https.get("error"):
        lines.append(f"- HTTPS 错误：`{https.get('error')}`")
    lines.append("")
    if http_plain:
        lines.append("### HTTP 明文探测")
        lines.append("")
        lines.append(f"- 请求成功：`{http_plain.get('ok')}`")
        lines.append(f"- 状态码：`{http_plain.get('status')}`")
        lines.append(f"- 最终 URL：`{http_plain.get('final_url')}`")
        lines.append(f"- 响应耗时：`{http_plain.get('elapsed_ms', '')} ms`")
        lines.append(f"- 使用代理：`{http_plain.get('used_proxy', False)}`")
        lines.append(f"- 执行过代理重试：`{http_plain.get('proxy_retry_performed', False)}`")
        if http_plain.get("error"):
            lines.append(f"- HTTP 错误：`{http_plain.get('error')}`")
        lines.append("")
    redirect_chain = https.get("redirect_chain", [])
    if redirect_chain:
        lines.append("### HTTPS 跳转链")
        lines.append("")
        lines.append("| 序号 | 状态码 | 来源 | 目标 |")
        lines.append("|---:|---:|---|---|")
        for idx, item in enumerate(redirect_chain[:20], 1):
            lines.append(f"| {idx} | {md_escape(item.get('status'))} | `{md_escape(item.get('from'))}` | `{md_escape(item.get('to'))}` |")
        lines.append("")
    sec = https.get("security_headers", {})
    if sec:
        lines.append("### 安全响应头")
        lines.append("")
        lines.append("| 检查项 | 是否存在/合格 |")
        lines.append("|---|---|")
        for key, ok in sec.get("checks", {}).items():
            lines.append(f"| `{md_escape(key)}` | `{ok}` |")
        lines.append(f"- 缺失项：`{', '.join(sec.get('missing', [])) or '无'}`")
        if sec.get("powered_by"):
            lines.append(f"- X-Powered-By：`{sec.get('powered_by')}`")
        if sec.get("cookies"):
            lines.append("")
            lines.append("#### Cookie 属性")
            lines.append("")
            lines.append("| 名称 | Secure | HttpOnly | SameSite |")
            lines.append("|---|---|---|---|")
            for cookie in sec.get("cookies", [])[:30]:
                lines.append(f"| `{md_escape(cookie.get('name'))}` | `{cookie.get('secure')}` | `{cookie.get('httponly')}` | `{md_escape(cookie.get('samesite'))}` |")
        lines.append("")
    lines.append("## 5. TLS 证书")
    lines.append("")
    lines.append(f"- TLS 可用：`{tls.get('ok')}`")
    lines.append(f"- TLS 版本：`{tls.get('tls_version', '')}`")
    lines.append(f"- 加密套件：`{tls.get('cipher', '')}`")
    lines.append(f"- 证书剩余天数：`{tls.get('days_left', '')}`")
    lines.append(f"- 证书生效时间：`{tls.get('notBefore', '')}`")
    lines.append(f"- 证书到期时间：`{tls.get('notAfter', '')}`")
    lines.append(f"- SAN DNS：`{', '.join(tls.get('subjectAltName_dns', [])[:20])}`")
    if tls.get("error"):
        lines.append(f"- TLS 错误：`{tls.get('error')}`")
    lines.append("")
    lines.append("## 6. DNS 解析")
    lines.append("")
    records = dns.get("records", {})
    for rtype in ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "CAA"]:
        vals = records.get(rtype, [])
        lines.append(f"- {rtype}: `{', '.join(vals[:10])}`")
    if dns.get("ip_info"):
        lines.append("")
        lines.append("### IP 信息")
        lines.append("")
        lines.append("| IP | 版本 | 私有地址 | 回环 | 保留 | 反向指针 |")
        lines.append("|---|---:|---|---|---|---|")
        for item in dns.get("ip_info", [])[:20]:
            lines.append(f"| `{md_escape(item.get('ip'))}` | `{md_escape(item.get('version', ''))}` | `{item.get('is_private', '')}` | `{item.get('is_loopback', '')}` | `{item.get('is_reserved', '')}` | `{md_escape(item.get('reverse_pointer', ''))}` |")
    if dns.get("errors"):
        lines.append("")
        lines.append("### DNS 错误/缺失记录提示")
        lines.append("")
        for item in dns.get("errors", [])[:20]:
            lines.append(f"- `{md_escape(item.get('type'))}`: `{md_escape(item.get('error'))}`")
    lines.append("")
    lines.append("## 7. 域名启发式分析")
    lines.append("")
    domain_findings = report.get("domain_heuristics", [])
    if domain_findings:
        lines.append("| 严重度 | 分数 | 类别 | 说明 | 证据 |")
        lines.append("|---|---:|---|---|---|")
        for f in domain_findings:
            lines.append(f"| {md_escape(f.get('severity'))} | {md_escape(f.get('score'))} | `{md_escape(f.get('category'))}` | {md_escape(f.get('message'))} | `{md_escape(json.dumps(f.get('evidence', {}), ensure_ascii=False)[:300])}` |")
    else:
        lines.append("- 未发现明显 IDN、Punycode、可疑 TLD、品牌仿冒或生成型域名启发式风险。")
    lines.append("")
    lines.append("## 8. 页面静态结构")
    lines.append("")
    lines.append(f"- 标题：`{html_analysis.get('title', '')}`")
    lines.append(f"- 表单数：`{len(html_analysis.get('forms', []))}`")
    lines.append(f"- 输入控件数：`{html_analysis.get('inputs_total', 0)}`")
    lines.append(f"- 脚本数：`{len(html_analysis.get('scripts', []))}`")
    lines.append(f"- iframe 数：`{len(html_analysis.get('iframes', []))}`")
    lines.append(f"- 外部资源主机数：`{len(html_analysis.get('external_hosts', []))}`")
    lines.append(f"- 脚本主机数：`{len(html_analysis.get('script_hosts', []))}`")
    if html_analysis.get("external_hosts"):
        lines.append(f"- 外部资源主机：`{', '.join(html_analysis.get('external_hosts', [])[:30])}`")
    if html_analysis.get("script_hosts"):
        lines.append(f"- 脚本主机：`{', '.join(html_analysis.get('script_hosts', [])[:30])}`")
    lines.append("")
    if html_analysis.get("forms"):
        lines.append("### 表单摘要")
        lines.append("")
        lines.append("| 序号 | 方法 | action_host | 跨域 | 敏感输入数 | action |")
        lines.append("|---:|---|---|---|---:|---|")
        for idx, form in enumerate(html_analysis.get("forms", [])[:30], 1):
            lines.append(f"| {idx} | `{md_escape(form.get('method'))}` | `{md_escape(form.get('action_host'))}` | `{form.get('cross_domain')}` | {len(form.get('sensitive_inputs', []))} | `{md_escape(form.get('action_absolute'))}` |")
        lines.append("")
    if html_analysis.get("iframes"):
        lines.append("### iframe 摘要")
        lines.append("")
        lines.append("| 序号 | host | sandbox | src |")
        lines.append("|---:|---|---|---|")
        for idx, iframe in enumerate(html_analysis.get("iframes", [])[:30], 1):
            lines.append(f"| {idx} | `{md_escape(iframe.get('host'))}` | `{md_escape(iframe.get('sandbox'))}` | `{md_escape(iframe.get('src_absolute'))}` |")
        lines.append("")
    if html_analysis.get("decoded_strings"):
        lines.append("## 9. 解码出的隐藏字符串")
        lines.append("")
        for item in html_analysis.get("decoded_strings", [])[:20]:
            lines.append(f"- `{md_escape(item.get('decoded', ''))}`")
        lines.append("")
    if html_analysis.get("extracted_urls"):
        lines.append("## 10. 页面中提取到的 URL")
        lines.append("")
        for item in html_analysis.get("extracted_urls", [])[:50]:
            lines.append(f"- `{md_escape(item)}`")
        lines.append("")
    lines.append("## 11. 主要发现与证据")
    lines.append("")
    findings = risk.get("findings", [])
    if findings:
        lines.append("| 序号 | 严重度 | 分数 | 类别 | 说明 | 证据摘要 |")
        lines.append("|---:|---|---:|---|---|---|")
        for idx, f in enumerate(findings[:100], 1):
            evidence_text = json.dumps(f.get("evidence", {}), ensure_ascii=False)
            lines.append(f"| {idx} | {md_escape(f.get('severity'))} | {md_escape(f.get('score'))} | `{md_escape(f.get('category'))}` | {md_escape(f.get('message'))} | `{md_escape(evidence_text[:500])}` |")
    else:
        lines.append("- 未发现明显风险项。")
    lines.append("")
    lines.append("## 12. 防护建议")
    lines.append("")
    lvl = risk.get("level")
    if lvl in {"critical", "high"}:
        lines.append("- **不建议访问或继续交互**：不要在主力设备、主力浏览器中打开该站点。")
        lines.append("- **禁止输入敏感信息**：不要登录、注册、付款、输入验证码、身份证、银行卡、助记词、私钥或企业凭据。")
        lines.append("- **不要安装任何内容**：不要安装其提供的证书、客户端、浏览器扩展、脚本、系统代理配置或移动端描述文件。")
        lines.append("- **隔离验证**：如必须核验，请使用虚拟机/沙箱、临时邮箱、随机密码和无重要 Cookie 的浏览器配置。")
        lines.append("- **组织防护**：建议将域名、解析 IP、可疑外部主机加入网关、DNS、EDR 或浏览器安全策略的观察/拦截列表。")
    elif lvl == "medium":
        lines.append("- **谨慎访问**：存在明显可疑点，建议避免输入账号、密码、支付和身份信息。")
        lines.append("- **降低暴露面**：使用隐私窗口或隔离浏览器配置，不复用常用密码，不授予通知/剪贴板/下载等权限。")
        lines.append("- **二次验证**：若该网站声称来自知名品牌，请通过官方 App、官方搜索结果或已知可信书签核对真实域名。")
        lines.append("- **监控行为**：若已访问并输入信息，建议尽快修改相关密码并检查账号登录记录。")
    else:
        lines.append("- **保持基本谨慎**：静态检查未发现强恶意特征，但仍不代表网站完全可信。")
        lines.append("- **敏感操作前复核**：对登录、支付、安装客户端、授权钱包、下载可执行文件等动作继续保持警惕。")
        lines.append("- **检查域名来源**：优先从官方渠道进入网站，不点击来源不明的短链、广告或私信链接。")
    lines.append("")
    if whois.get("enabled"):
        lines.append("## 13. WHOIS 查询")
        lines.append("")
        lines.append(f"- 查询对象：`{whois.get('query')}`")
        result = whois.get("result", {})
        lines.append(f"- 执行成功：`{result.get('ok')}`")
        if result.get("stdout"):
            lines.append("")
            lines.append("```text")
            lines.append(str(result.get("stdout", ""))[:6000])
            lines.append("```")
        if result.get("stderr"):
            lines.append("")
            lines.append("```text")
            lines.append(str(result.get("stderr", ""))[:2000])
            lines.append("```")
        lines.append("")
    if include_json:
        lines.append("## 14. 原始 JSON 结构化结果")
        lines.append("")
        lines.append("以下 JSON 是本次核查的完整结构化数据，已与 Markdown 报告合并返回，便于 Agent 继续做证据追踪、风险解释或生成用户可读建议。")
        lines.append("")
        lines.append("```json")
        lines.append(json.dumps(report, ensure_ascii=False, indent=2))
        lines.append("```")
        lines.append("")
    return "\n".join(lines)


def write_markdown(path: str, report: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(generate_markdown(report, include_json=True))


def print_summary(report: Dict[str, Any], json_path: str, md_path: str) -> None:
    norm = report["normalized"]
    risk = report["risk"]
    https = report.get("http", {}).get("https", {})
    summary = {
        "target": report["target"],
        "host_unicode": norm.get("host_unicode"),
        "host_ascii": norm.get("host_ascii"),
        "https_status": https.get("status"),
        "final_url": https.get("final_url"),
        "risk_level": risk.get("level"),
        "risk_score": risk.get("score"),
        "finding_count": risk.get("finding_count"),
        "json_report": json_path,
        "markdown_report": md_path,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def configure_stdio_encoding() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def make_args_from_payload(payload: Dict[str, Any]) -> argparse.Namespace:
    env_proxy_enabled = str(os.environ.get("DOMAIN_SAFETY_PROXY_ENABLED", "false")).lower() == "true"
    env_proxy_url = os.environ.get("DOMAIN_SAFETY_PROXY_URL", "").strip()
    env_proxy_retry = str(os.environ.get("DOMAIN_SAFETY_PROXY_RETRY_ON_FAILURE", "true")).lower() != "false"
    payload_proxy_url = str(payload.get("proxy_url", payload.get("proxyUrl", "")) or "").strip()
    proxy_enabled = bool(payload.get("proxy_enabled", payload.get("proxyEnabled", env_proxy_enabled)))
    proxy_url = payload_proxy_url or (env_proxy_url if proxy_enabled else "")

    return argparse.Namespace(
        target=str(payload.get("target") or payload.get("url") or payload.get("domain") or "").strip(),
        out="",
        md="",
        timeout=int(payload.get("timeout", 12)),
        max_bytes=int(payload.get("max_bytes", payload.get("maxBytes", 2_000_000))),
        default_scheme=str(payload.get("default_scheme", payload.get("defaultScheme", "https")) or "https").lower(),
        user_agent=str(payload.get("user_agent", payload.get("userAgent", DEFAULT_UA)) or DEFAULT_UA),
        fetch_scripts=bool(payload.get("fetch_scripts", payload.get("fetchScripts", False))),
        tls=not bool(payload.get("no_tls", payload.get("noTls", False))),
        http=not bool(payload.get("no_http", payload.get("noHttp", False))),
        get_http=bool(payload.get("get_http", payload.get("getHttp", False))),
        whois=bool(payload.get("whois", False)),
        proxy_url=proxy_url,
        proxy_retry_on_failure=bool(payload.get("proxy_retry_on_failure", payload.get("proxyRetryOnFailure", env_proxy_retry))),
    )


def print_vcp_response(status: str, result: Any = None, error: str = "") -> None:
    payload: Dict[str, Any] = {"status": status}
    if status == "success":
        payload["result"] = result
    else:
        payload["error"] = error
    print(json.dumps(payload, ensure_ascii=False), file=sys.stdout, flush=True)


def run_vcp_stdio(stdin_text: str) -> int:
    try:
        payload = json.loads(stdin_text) if stdin_text.strip() else {}
        if not isinstance(payload, dict):
            raise ValueError("stdin JSON 必须是对象。")
        args = make_args_from_payload(payload)
        if args.default_scheme not in {"http", "https"}:
            args.default_scheme = "https"
        if not args.target:
            raise ValueError("缺少 target/url/domain 参数。")

        report = build_report(args.target, args)
        markdown = generate_markdown(report, include_json=bool(payload.get("include_json", payload.get("includeJson", True))))
        result = {
            "content": [
                {
                    "type": "text",
                    "text": markdown,
                }
            ],
            "details": {
                "target": report.get("target"),
                "normalized": report.get("normalized"),
                "risk": report.get("risk"),
                "generated_at": report.get("generated_at"),
                "report_json": report,
            },
        }
        print_vcp_response("success", result=result)
        return 0
    except Exception as exc:
        print_vcp_response("error", error=f"DomainSafetyChecker 执行失败: {exc}")
        return 1


def main() -> int:
    configure_stdio_encoding()
    stdin_text = ""
    if not sys.stdin.isatty():
        stdin_text = sys.stdin.read()
    if stdin_text.strip():
        return run_vcp_stdio(stdin_text)

    parser = argparse.ArgumentParser(description="通用域名/URL 安全检查程序（低交互、静态、非侵入）")
    parser.add_argument("target", help="域名或 URL，例如 example.com 或 https://example.com/path")
    parser.add_argument("--out", default="", help="JSON 报告路径，默认不写入；指定后写入完整 JSON")
    parser.add_argument("--md", default="", help="Markdown 报告路径，默认不写入；指定后写入合并 JSON 的 Markdown")
    parser.add_argument("--timeout", type=int, default=12, help="网络请求超时秒数")
    parser.add_argument("--max-bytes", type=int, default=2_000_000, help="单次 HTTP 最多读取字节数")
    parser.add_argument("--default-scheme", default="https", choices=["http", "https"], help="输入裸域名时默认 scheme")
    parser.add_argument("--user-agent", default=DEFAULT_UA, help="HTTP User-Agent")
    parser.add_argument("--fetch-scripts", action="store_true", help="额外下载外部 JS 做静态扫描")
    parser.add_argument("--no-tls", dest="tls", action="store_false", help="跳过 TLS 证书检查")
    parser.add_argument("--no-http", dest="http", action="store_false", help="跳过明文 HTTP 探测")
    parser.add_argument("--get-http", action="store_true", help="明文 HTTP 也使用 GET，默认只用 HEAD")
    parser.add_argument("--whois", action="store_true", help="尝试调用系统 whois 命令")
    parser.add_argument("--no-json-in-md", dest="include_json", action="store_false", help="Markdown 中不附加完整 JSON")
    parser.add_argument("--proxy-url", default=os.environ.get("DOMAIN_SAFETY_PROXY_URL", "") if str(os.environ.get("DOMAIN_SAFETY_PROXY_ENABLED", "false")).lower() == "true" else "", help="HTTP/HTTPS 代理地址，例如 http://127.0.0.1:7890")
    parser.add_argument("--no-proxy-retry", dest="proxy_retry_on_failure", action="store_false", help="直连访问失败时不使用代理自动重试")
    parser.set_defaults(tls=True, http=True, include_json=True, proxy_retry_on_failure=str(os.environ.get("DOMAIN_SAFETY_PROXY_RETRY_ON_FAILURE", "true")).lower() != "false")

    args = parser.parse_args()
    report = build_report(args.target, args)
    markdown = generate_markdown(report, include_json=args.include_json)

    if args.out:
        write_json(args.out, report)
    if args.md:
        write_markdown(args.md, report)

    print(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())