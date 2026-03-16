#!/usr/bin/env python3

# -*- coding: utf-8 -*-



import sys

import os

import json

import re

import random

import uuid

import csv

import math

import time

import subprocess

import sqlite3

import hashlib

import unicodedata

import threading

import atexit

from collections import OrderedDict

from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FuturesTimeoutError

from datetime import datetime, timedelta

from typing import Dict, Any, List, Tuple



try:

    import requests

except Exception:

    requests = None



try:

    from sudachipy import dictionary as sudachi_dictionary

    from sudachipy import tokenizer as sudachi_tokenizer

except Exception:

    sudachi_dictionary = None

    sudachi_tokenizer = None

try:

    import jaconv

except Exception:

    jaconv = None

try:

    import neologdn

except Exception:

    neologdn = None

try:

    import budoux

except Exception:

    budoux = None

try:

    from pykakasi import kakasi as pykakasi_kakasi

except Exception:

    pykakasi_kakasi = None

try:

    from janome.tokenizer import Tokenizer as janome_tokenizer_cls

except Exception:

    janome_tokenizer_cls = None

try:

    import spacy

except Exception:

    spacy = None

try:

    import ginza as ginza_pkg

except Exception:

    ginza_pkg = None



try:

    import cutlet as cutlet_pkg

except Exception:

    cutlet_pkg = None

try:

    import analyze_desumasu_dearu as add_style_pkg

except Exception:

    add_style_pkg = None

try:

    import ja_sentence_segmenter as ja_sentence_segmenter_pkg

except Exception:

    ja_sentence_segmenter_pkg = None



PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))

if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

WRONGBOOK_PATH = os.path.join(PLUGIN_DIR, "wrongbook.json")

SESSION_PATH = os.path.join(PLUGIN_DIR, "study_sessions.json")

REVIEW_STATE_PATH = os.path.join(PLUGIN_DIR, "review_state.json")

REVIEW_LOG_PATH = os.path.join(PLUGIN_DIR, "review_log.json")

EXPORT_DIR = os.path.join(PLUGIN_DIR, "exports")

ONLINE_CACHE_PATH = os.path.join(PLUGIN_DIR, "online_cache.json")

ONLINE_CACHE_LOCK_PATH = ONLINE_CACHE_PATH + ".lock"

PROVIDER_STATE_PATH = os.path.join(PLUGIN_DIR, "provider_circuit.json")

PROVIDER_STATE_LOCK_PATH = PROVIDER_STATE_PATH + ".lock"



REQUEST_TIMEOUT = float(os.environ.get("REQUEST_TIMEOUT", "10"))

JISHO_API_ENABLED = os.environ.get("JISHO_API_ENABLED", "true").strip().lower() == "true"

SUDACHI_SPLIT_MODE = os.environ.get("SUDACHI_SPLIT_MODE", "C").strip().upper()

USER_LEXICON_PATH = os.environ.get("USER_LEXICON_PATH", os.path.join(PLUGIN_DIR, "user_lexicon.json"))

DOMAIN_LEXICON_PATH = os.environ.get("DOMAIN_LEXICON_PATH", os.path.join(PLUGIN_DIR, "domain_lexicon.json"))

# 统一将相对路径锚定到插件目录，避免受当前工作目录影响

if not os.path.isabs(USER_LEXICON_PATH):

    USER_LEXICON_PATH = os.path.normpath(os.path.join(PLUGIN_DIR, USER_LEXICON_PATH))

if not os.path.isabs(DOMAIN_LEXICON_PATH):

    DOMAIN_LEXICON_PATH = os.path.normpath(os.path.join(PLUGIN_DIR, DOMAIN_LEXICON_PATH))

ENABLE_ADAPTIVE_SESSION = os.environ.get("ENABLE_ADAPTIVE_SESSION", "true").strip().lower() == "true"



# 外部知识库（可选接入）

GRAMMAR_DB_PATH = os.environ.get("GRAMMAR_DB_PATH", os.path.join(PLUGIN_DIR, "grammar_explainers_ext.json"))

JMDICT_MINI_PATH = os.environ.get("JMDICT_MINI_PATH", os.path.join(PLUGIN_DIR, "jmdict_mini.json"))

KANJIDIC_MINI_PATH = os.environ.get("KANJIDIC_MINI_PATH", os.path.join(PLUGIN_DIR, "kanjidic_mini.json"))

PITCH_ACCENT_EXT_PATH = os.environ.get("PITCH_ACCENT_EXT_PATH", os.path.join(PLUGIN_DIR, "pitch_accent_ext.json"))

LEGACY_RESOURCE_DIR = os.path.join(PLUGIN_DIR, "data", "legacy_resources")

def _load_legacy_json(filename: str, default: Any):
    path = os.path.join(LEGACY_RESOURCE_DIR, filename)
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, type(default)) else default
    except Exception:
        return default




# JLPT full-db lookup（轻量缓存）

JLPT_DB_PATH = os.environ.get(

    "GRAMMAR_FULL_DB_PATH",

    os.environ.get("JMDICT_FULL_DB_PATH", os.path.join(PLUGIN_DIR, "data", "db", "jdict_full.sqlite"))

)

if not os.path.isabs(JLPT_DB_PATH):

    JLPT_DB_PATH = os.path.normpath(os.path.join(PLUGIN_DIR, JLPT_DB_PATH))

JLPT_DB_TIMEOUT_SEC = float(os.environ.get("JLPT_DB_TIMEOUT_SEC", "0.35"))

JLPT_DB_CACHE_MAX = int(os.environ.get("JLPT_DB_CACHE_MAX", "4096"))

_JLPT_DB_CACHE = OrderedDict()



# Local/Online hybrid dictionary configs

ONLINE_DICT_MODE = os.environ.get("ONLINE_DICT_MODE", "race").strip().lower()  # race | aggregate

ONLINE_DICT_TIMEOUT = float(os.environ.get("ONLINE_DICT_TIMEOUT", "1.2"))

ONLINE_DICT_GLOBAL_TIMEOUT = float(os.environ.get("ONLINE_DICT_GLOBAL_TIMEOUT", "2.5"))

ONLINE_DICT_RETRY = int(os.environ.get("ONLINE_DICT_RETRY", "1"))

ONLINE_CACHE_TTL_SEC = int(os.environ.get("ONLINE_CACHE_TTL_SEC", "86400"))

ONLINE_PROVIDER_ORDER = [x.strip().lower() for x in os.environ.get("ONLINE_PROVIDER_ORDER", "jisho,jotoba").split(",") if x.strip()]

JOTOBA_API_ENABLED = os.environ.get("JOTOBA_API_ENABLED", "false").strip().lower() == "true"



# P0 stability knobs

ONLINE_CACHE_MAX_ITEMS = int(os.environ.get("ONLINE_CACHE_MAX_ITEMS", "2000"))

ONLINE_CACHE_FLUSH_INTERVAL_SEC = float(os.environ.get("ONLINE_CACHE_FLUSH_INTERVAL_SEC", "2.0"))

ONLINE_CACHE_STALE_IF_ERROR_SEC = int(os.environ.get("ONLINE_CACHE_STALE_IF_ERROR_SEC", "600"))

ONLINE_CACHE_LOCK_TIMEOUT_SEC = float(os.environ.get("ONLINE_CACHE_LOCK_TIMEOUT_SEC", "2.0"))

ONLINE_DICT_BACKOFF_BASE_SEC = float(os.environ.get("ONLINE_DICT_BACKOFF_BASE_SEC", "0.15"))

ONLINE_DICT_BACKOFF_MAX_SEC = float(os.environ.get("ONLINE_DICT_BACKOFF_MAX_SEC", "1.2"))

ONLINE_PROVIDER_CB_FAIL_THRESHOLD = int(os.environ.get("ONLINE_PROVIDER_CB_FAIL_THRESHOLD", "3"))

ONLINE_PROVIDER_CB_COOLDOWN_SEC = float(os.environ.get("ONLINE_PROVIDER_CB_COOLDOWN_SEC", "20"))

ONLINE_PROVIDER_CB_HALFOPEN_PROB = float(os.environ.get("ONLINE_PROVIDER_CB_HALFOPEN_PROB", "0.25"))



# 统一超时预算：在线查询超时受 REQUEST_TIMEOUT 约束

if REQUEST_TIMEOUT > 0:

    ONLINE_DICT_TIMEOUT = min(max(0.1, ONLINE_DICT_TIMEOUT), REQUEST_TIMEOUT)

    ONLINE_DICT_GLOBAL_TIMEOUT = min(max(0.1, ONLINE_DICT_GLOBAL_TIMEOUT), REQUEST_TIMEOUT)

else:

    ONLINE_DICT_TIMEOUT = max(0.1, ONLINE_DICT_TIMEOUT)

    ONLINE_DICT_GLOBAL_TIMEOUT = max(0.1, ONLINE_DICT_GLOBAL_TIMEOUT)



# 全局超时不应小于单请求超时

if ONLINE_DICT_GLOBAL_TIMEOUT < ONLINE_DICT_TIMEOUT:

    ONLINE_DICT_GLOBAL_TIMEOUT = ONLINE_DICT_TIMEOUT



LOCAL_DICT = _load_legacy_json("local_dict_builtin.json", {})



GRAMMAR_PATTERNS = [

    (r"ました", "「〜ました」：礼貌体过去时"),

    (r"ます", "「〜ます」：礼貌体"),

    (r"ない", "「〜ない」：否定形"),

    (r"たい", "「〜たい」：想要…"),

    (r"に行く|にいく", "「〜に行く」：去做某事"),

    (r"ています|でいます", "「〜ています」：进行/持续（礼貌体）"),

    (r"ている|でいる", "「〜ている」：进行/持续"),

    (r"ことができる", "「〜ことができる」：能够…"),

]



PHRASE_PATTERNS = _load_legacy_json("phrase_patterns.json", {})



PITCH_ACCENT_DICT = _load_legacy_json("pitch_accent_dict.json", {})



MINIMAL_PAIR_BANK = _load_legacy_json("minimal_pair_bank.json", [])



JLPT_WORD_LEVELS = _load_legacy_json("jlpt_word_levels.json", {})



GRAMMAR_EXPLAINERS = _load_legacy_json("grammar_explainers_builtin.json", [])



SPLIT_MARKERS = sorted([

    "しています", "ています", "でいます", "ている", "でいる",

    "では", "には", "へは", "とは",

    "から", "まで", "より", "だけ", "しか", "など", "ので", "のに",

    "でも", "ても", "たり", "だり",

    "ました", "ません", "ます", "です", "ない", "たい",

    "と", "に", "へ", "で", "を", "は", "が", "も", "や", "か", "ね", "よ"

], key=len, reverse=True)



_SUDACHI_TAGGER = None

_BUDOUX_PARSER = None



# P3: 会话抽题过滤增强（难度/JLPT/停用词）

SESSION_STOPWORDS = {

    "する", "いる", "ある", "こと", "もの", "これ", "それ", "あれ", "ため", "よう"

}

JLPT_HARDNESS = {"N5": 1, "N4": 2, "N3": 3, "N2": 4, "N1": 5}



# P1: 排序增强与表记摇れ/异体字映射

SOURCE_CREDIBILITY_WEIGHTS = {

    "local": 0.28,

    "user": 0.24,

    "domain": 0.22,

    "jisho": 0.18,

    "jotoba": 0.14,

    "unknown": 0.10

}

JLPT_SCORE_WEIGHTS = {"N5": 0.24, "N4": 0.20, "N3": 0.16, "N2": 0.12, "N1": 0.08}

WORD_FREQUENCY_HINT = {

    "する": 0.25, "ある": 0.24, "いる": 0.24, "こと": 0.23, "もの": 0.20,

    "日本語": 0.18, "勉強": 0.18, "今日": 0.16, "明日": 0.16, "昨日": 0.16

}

VARIANT_WORD_MAP = {

    "出来る": "できる",

    "下さい": "ください",

    "其れ": "それ",

    "此れ": "これ",

    "彼れ": "あれ",

    "利害關係者": "利害関係者",

    "學問": "学問",

    "圖書館": "図書館"

}

VARIANT_CHAR_MAP = {

    "學": "学", "國": "国", "體": "体", "關": "関", "圖": "図", "會": "会",

    "氣": "気", "變": "変", "實": "実", "處": "処", "敎": "教", "廣": "広",

    "澤": "沢", "邊": "辺", "兩": "両", "當": "当", "擴": "拡", "續": "続"

}



# P2: 可观测日志

OBSERVABILITY_LOG_PATH = os.environ.get(

    "OBSERVABILITY_LOG_PATH",

    os.path.join(PLUGIN_DIR, "observability.log")

)

_OBS_LOCK = threading.Lock()



def log_observation(event: str, **fields) -> None:

    try:

        payload = {

            "ts": datetime.now().isoformat(timespec="seconds"),

            "event": str(event or "unknown")

        }

        payload.update(fields)

        line = json.dumps(payload, ensure_ascii=False)

        with _OBS_LOCK:

            with open(OBSERVABILITY_LOG_PATH, "a", encoding="utf-8") as f:

                f.write(line + "\n")

    except Exception:

        # 可观测日志不应影响主流程

        pass



def _jlpt_hardness(level: str) -> int:

    lv = str(level or "").strip().upper()

    return JLPT_HARDNESS.get(lv, 0)



def normalize_variants(text: str) -> str:

    s = unicodedata.normalize("NFKC", str(text or "")).strip()

    if not s:

        return s

    # 先做通用日文正规化（若依赖可用）

    try:

        if jaconv is not None:

            s = jaconv.normalize(s, "NFKC")

    except Exception:

        pass

    try:

        if neologdn is not None:

            s = neologdn.normalize(s)

    except Exception:

        pass

    # 先整词映射（优先）

    if s in VARIANT_WORD_MAP:

        s = VARIANT_WORD_MAP[s]

    # 再逐字映射（旧字体/异体字）

    s = "".join(VARIANT_CHAR_MAP.get(ch, ch) for ch in s)

    # 再做一次整词映射（字符替换后可能命中）

    s = VARIANT_WORD_MAP.get(s, s)

    return s



def _source_weight(src: str) -> float:

    return float(SOURCE_CREDIBILITY_WEIGHTS.get(str(src or "unknown").lower(), SOURCE_CREDIBILITY_WEIGHTS["unknown"]))



def _jlpt_weight_for_word(word: str) -> float:

    lv = lookup_jlpt_for_word(word)

    return float(JLPT_SCORE_WEIGHTS.get(lv, 0.06 if lv else 0.04))



def _freq_weight_for_word(word: str) -> float:

    return float(WORD_FREQUENCY_HINT.get(str(word or ""), 0.05))



def _wrongbook_weight_for_word(word: str) -> float:

    # 错题越多，越应前排（上限抑制）

    wrong = _wrong_count_for_word(word)

    return min(0.30, wrong * 0.06)



def _context_neighbor_tokens(context_text: str) -> List[str]:

    txt = str(context_text or "").strip()

    if not txt:

        return []

    rows = sudachi_rows(txt)

    if rows:

        out = []

        for r in rows:

            s = str(r.get("surface") or "").strip()

            if s:

                out.append(s)

        return out

    return fallback_segment(txt)



def _homograph_context_boost(word: str, reading: str, pos: str, context_text: str) -> float:

    # 轻量同形异义消歧（邻词 + 词性启发）

    w = str(word or "")

    rd = str(reading or "")

    p = str(pos or "")

    if not context_text:

        return 0.0

    if not ((rd in ("はし", "あめ")) or (w in ("橋", "箸", "端", "雨", "飴"))):

        return 0.0

    neighbors = set(_context_neighbor_tokens(context_text))



    boost = 0.0



    # はし：橋/箸/端

    if rd == "はし" or w in ("橋", "箸", "端"):

        if w == "橋":

            if neighbors & {"川", "渡る", "道路", "向こう", "駅"}:

                boost += 0.22

        elif w == "箸":

            if neighbors & {"食べる", "ご飯", "料理", "使う", "茶碗"}:

                boost += 0.22

        elif w == "端":

            if neighbors & {"机", "隅", "右", "左", "寄る"}:

                boost += 0.22



    # あめ：雨/飴

    if rd == "あめ" or w in ("雨", "飴"):

        if w == "雨" and (neighbors & {"降る", "天気", "傘", "曇り"}):

            boost += 0.20

        if w == "飴" and (neighbors & {"甘い", "舐める", "お菓子", "買う"}):

            boost += 0.20



    # 词性启发：名词在「を」后更可能是宾语名词，而非副词/连体

    if "名詞" in p and ("を" in neighbors or "が" in neighbors):

        boost += 0.03



    return min(0.30, boost)



def _compose_rank_score(

    base_match_score: float,

    source: str,

    word: str,

    reading: str,

    pos: str,

    context_text: str

) -> float:

    score = 0.0

    score += float(base_match_score) * 0.42

    score += _source_weight(source)

    score += _wrongbook_weight_for_word(word)

    score += _jlpt_weight_for_word(word)

    score += _freq_weight_for_word(word)

    score += _homograph_context_boost(word, reading, pos, context_text)

    return float(score)



def safe_read_input() -> Dict[str, Any]:

    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")

    if not raw.strip():

        raise ValueError("没有接收到标准输入数据")

    return json.loads(raw)



def safe_write_output(payload: Dict[str, Any], code: int = 0):

    out = json.dumps(payload, ensure_ascii=False)

    sys.stdout.buffer.write(out.encode("utf-8", errors="replace"))

    sys.stdout.buffer.write(b"\n")

    sys.stdout.buffer.flush()

    sys.exit(code)



def as_bool(v: Any, default: bool = False) -> bool:

    if isinstance(v, bool):

        return v

    if v is None:

        return default

    s = str(v).strip().lower()

    if s in ("1", "true", "yes", "y", "on"):

        return True

    if s in ("0", "false", "no", "n", "off"):

        return False

    return default



def normalize_text(s: str) -> str:

    s = unicodedata.normalize("NFKC", (s or ""))

    # 日文正规化增强：jaconv + neologdn（可选依赖）

    try:

        if jaconv is not None:

            s = jaconv.normalize(s, "NFKC")

    except Exception:

        pass

    try:

        if neologdn is not None:

            s = neologdn.normalize(s)

    except Exception:

        pass

    s = s.strip().lower()

    s = s.replace("　", " ")

    s = normalize_variants(s)

    # 统一到平假名（便于索引匹配）

    try:

        if jaconv is not None:

            s = jaconv.kata2hira(s)

        else:

            s = kata_to_hira(s)

    except Exception:

        s = kata_to_hira(s)

    s = re.sub(r"\s+", "", s)

    return s



def kata_to_hira(text: str) -> str:

    out = []

    for ch in text:

        c = ord(ch)

        if 0x30A1 <= c <= 0x30F6:

            out.append(chr(c - 0x60))

        else:

            out.append(ch)

    return "".join(out)



def _now_ts() -> float:

    return time.time()



def _stable_hash(s: str) -> str:

    return hashlib.sha1((s or "").encode("utf-8", errors="ignore")).hexdigest()



ONLINE_CACHE = OrderedDict()

ONLINE_CACHE_DIRTY = False

ONLINE_CACHE_LAST_FLUSH_TS = 0.0

ONLINE_CACHE_STOP_EVENT = threading.Event()



ONLINE_METRICS: Dict[str, Any] = {

    "cache_hit_fresh": 0,

    "cache_hit_stale": 0,

    "cache_miss": 0,

    "cache_set": 0,

    "cache_evicted_lru": 0,

    "cache_flush_ok": 0,

    "cache_flush_error": 0,

    "provider_blocked": 0,

    "provider_halfopen_probe": 0,

    "provider_circuit_opened": 0,

    "stale_if_error_served": 0

}

PROVIDER_CIRCUIT_STATE: Dict[str, Dict[str, Any]] = {}

PROVIDER_STATE_DIRTY = False

PROVIDER_STATE_LAST_FLUSH_TS = 0.0

PROVIDER_STATE_FLUSH_INTERVAL_SEC = float(os.environ.get("ONLINE_PROVIDER_STATE_FLUSH_INTERVAL_SEC", "1.0"))



def _metric_inc(key: str, n: int = 1) -> None:

    ONLINE_METRICS[key] = int(ONLINE_METRICS.get(key, 0)) + int(n)



def _metric_add(key: str, value: float) -> None:

    ONLINE_METRICS[key] = float(ONLINE_METRICS.get(key, 0.0)) + float(value)



def _provider_lock_acquire(timeout_sec: float = ONLINE_CACHE_LOCK_TIMEOUT_SEC):

    start = _now_ts()

    fd = None

    stale_sec = max(1.0, float(timeout_sec) * 5.0)

    while True:

        try:

            fd = os.open(PROVIDER_STATE_LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_RDWR)

            os.write(fd, str(os.getpid()).encode("utf-8", errors="ignore"))

            return fd

        except FileExistsError:

            try:

                mtime = os.path.getmtime(PROVIDER_STATE_LOCK_PATH)

                if (_now_ts() - float(mtime)) > stale_sec:

                    os.unlink(PROVIDER_STATE_LOCK_PATH)

                    continue

            except Exception:

                pass

            if (_now_ts() - start) >= max(0.1, timeout_sec):

                raise TimeoutError("provider_state lock timeout")

            time.sleep(0.02)



def _provider_lock_release(fd) -> None:

    try:

        if fd is not None:

            os.close(fd)

    except Exception:

        pass

    try:

        if os.path.exists(PROVIDER_STATE_LOCK_PATH):

            owner = ""

            try:

                with open(PROVIDER_STATE_LOCK_PATH, "r", encoding="utf-8") as f:

                    owner = (f.read() or "").strip()

            except Exception:

                owner = ""

            # 仅在锁文件为空或归属当前进程时删除，降低竞态误删风险

            if (not owner) or owner == str(os.getpid()):

                os.unlink(PROVIDER_STATE_LOCK_PATH)

    except FileNotFoundError:

        pass

    except Exception:

        pass



def _load_provider_circuit_state() -> Dict[str, Dict[str, Any]]:

    if not os.path.exists(PROVIDER_STATE_PATH):

        return {}

    try:

        with open(PROVIDER_STATE_PATH, "r", encoding="utf-8") as f:

            data = json.load(f)

        if not isinstance(data, dict):

            return {}

        out: Dict[str, Dict[str, Any]] = {}

        for k, v in data.items():

            if not isinstance(v, dict):

                continue

            out[str(k)] = {

                "fail_count": int(v.get("fail_count", 0) or 0),

                "open_until": float(v.get("open_until", 0.0) or 0.0),

                "last_error_ts": float(v.get("last_error_ts", 0.0) or 0.0),

            }

        return out

    except Exception:

        _metric_inc("provider_state_load_error")

        return {}



def _mark_provider_state_dirty() -> None:

    global PROVIDER_STATE_DIRTY

    PROVIDER_STATE_DIRTY = True



def _flush_provider_circuit_state(force: bool = False) -> None:

    global PROVIDER_STATE_DIRTY, PROVIDER_STATE_LAST_FLUSH_TS



    now = _now_ts()

    if not force:

        if not PROVIDER_STATE_DIRTY:

            return

        if (now - PROVIDER_STATE_LAST_FLUSH_TS) < max(0.1, PROVIDER_STATE_FLUSH_INTERVAL_SEC):

            return



    fd = None

    try:

        fd = _provider_lock_acquire()

        tmp_path = PROVIDER_STATE_PATH + ".tmp"

        with open(tmp_path, "w", encoding="utf-8") as f:

            json.dump(PROVIDER_CIRCUIT_STATE, f, ensure_ascii=False, indent=2)

            f.flush()

            os.fsync(f.fileno())

        os.replace(tmp_path, PROVIDER_STATE_PATH)

        PROVIDER_STATE_DIRTY = False

        PROVIDER_STATE_LAST_FLUSH_TS = now

        _metric_inc("provider_state_flush_ok")

    except Exception:

        _metric_inc("provider_state_flush_error")

    finally:

        _provider_lock_release(fd)



def _provider_state(provider: str) -> Dict[str, Any]:

    p = (provider or "").strip().lower()

    st = PROVIDER_CIRCUIT_STATE.get(p)

    if st is None:

        st = {"fail_count": 0, "open_until": 0.0, "last_error_ts": 0.0}

        PROVIDER_CIRCUIT_STATE[p] = st

    return st



def _provider_is_allowed(provider: str) -> bool:

    st = _provider_state(provider)

    now = _now_ts()

    open_until = float(st.get("open_until", 0.0) or 0.0)

    if open_until <= now:

        return True



    # half-open 探活概率

    probe_prob = max(0.0, min(1.0, ONLINE_PROVIDER_CB_HALFOPEN_PROB))

    if random.random() < probe_prob:

        _metric_inc("provider_halfopen_probe")

        return True



    _metric_inc("provider_blocked")

    return False



def _provider_record_success(provider: str) -> None:

    st = _provider_state(provider)

    changed = False

    if int(st.get("fail_count", 0)) != 0:

        st["fail_count"] = 0

        changed = True

    if float(st.get("open_until", 0.0) or 0.0) != 0.0:

        st["open_until"] = 0.0

        changed = True

    if changed:

        _mark_provider_state_dirty()

        _flush_provider_circuit_state(force=False)



def _provider_record_failure(provider: str) -> None:

    st = _provider_state(provider)

    st["fail_count"] = int(st.get("fail_count", 0)) + 1

    st["last_error_ts"] = _now_ts()

    opened_now = False

    if st["fail_count"] >= max(1, ONLINE_PROVIDER_CB_FAIL_THRESHOLD):

        old_open_until = float(st.get("open_until", 0.0) or 0.0)

        st["open_until"] = _now_ts() + max(0.1, ONLINE_PROVIDER_CB_COOLDOWN_SEC)

        opened_now = st["open_until"] > old_open_until

        _metric_inc("provider_circuit_opened")

    _mark_provider_state_dirty()

    _flush_provider_circuit_state(force=opened_now)



def _shutdown_provider_state() -> None:

    try:

        _flush_provider_circuit_state(force=True)

    except Exception:

        pass



# 启动时恢复熔断状态（跨进程生效）

PROVIDER_CIRCUIT_STATE = _load_provider_circuit_state()

PROVIDER_STATE_LAST_FLUSH_TS = _now_ts()



def _cache_lock_acquire(timeout_sec: float = ONLINE_CACHE_LOCK_TIMEOUT_SEC):

    start = _now_ts()

    fd = None

    stale_sec = max(1.0, float(timeout_sec) * 5.0)



    while True:

        try:

            fd = os.open(ONLINE_CACHE_LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_RDWR)

            os.write(fd, str(os.getpid()).encode("utf-8", errors="ignore"))

            return fd

        except FileExistsError:

            # 尝试清理陈旧锁（进程崩溃残留）

            try:

                mtime = os.path.getmtime(ONLINE_CACHE_LOCK_PATH)

                if (_now_ts() - float(mtime)) > stale_sec:

                    os.unlink(ONLINE_CACHE_LOCK_PATH)

                    continue

            except Exception:

                pass



            if (_now_ts() - start) >= max(0.1, timeout_sec):

                raise TimeoutError("online_cache lock timeout")

            time.sleep(0.02)



def _cache_lock_release(fd) -> None:

    try:

        if fd is not None:

            os.close(fd)

    except Exception:

        pass

    try:

        if os.path.exists(ONLINE_CACHE_LOCK_PATH):

            owner = ""

            try:

                with open(ONLINE_CACHE_LOCK_PATH, "r", encoding="utf-8") as f:

                    owner = (f.read() or "").strip()

            except Exception:

                owner = ""

            # 仅在锁文件为空或归属当前进程时删除，降低竞态误删风险

            if (not owner) or owner == str(os.getpid()):

                os.unlink(ONLINE_CACHE_LOCK_PATH)

    except FileNotFoundError:

        pass

    except Exception:

        pass



def _cache_prune_lru() -> None:

    max_items = max(1, int(ONLINE_CACHE_MAX_ITEMS))

    while len(ONLINE_CACHE) > max_items:

        ONLINE_CACHE.popitem(last=False)

        _metric_inc("cache_evicted_lru")



def _load_online_cache() -> OrderedDict:

    out = OrderedDict()

    if not os.path.exists(ONLINE_CACHE_PATH):

        return out

    try:

        with open(ONLINE_CACHE_PATH, "r", encoding="utf-8") as f:

            data = json.load(f)

        if not isinstance(data, dict):

            return out

        now = _now_ts()

        for k, v in data.items():

            if not isinstance(v, dict):

                continue

            exp = float(v.get("expire_at", 0) or 0)

            stale_until = float(v.get("stale_until", exp + max(0, ONLINE_CACHE_STALE_IF_ERROR_SEC)) or 0)

            value = v.get("value")

            # 保留未超过 stale 窗口的数据，支持 stale-if-error

            if stale_until > now:

                out[str(k)] = {

                    "expire_at": exp,

                    "stale_until": stale_until,

                    "value": value

                }

        return out

    except Exception:

        _metric_inc("cache_load_error")

        return OrderedDict()



def _flush_online_cache(force: bool = False) -> None:

    global ONLINE_CACHE_DIRTY, ONLINE_CACHE_LAST_FLUSH_TS



    now = _now_ts()

    if not force:

        if not ONLINE_CACHE_DIRTY:

            return

        if (now - ONLINE_CACHE_LAST_FLUSH_TS) < max(0.1, ONLINE_CACHE_FLUSH_INTERVAL_SEC):

            return



    fd = None

    try:

        fd = _cache_lock_acquire()

        tmp_path = ONLINE_CACHE_PATH + ".tmp"

        snapshot = dict(ONLINE_CACHE)

        with open(tmp_path, "w", encoding="utf-8") as f:

            json.dump(snapshot, f, ensure_ascii=False, indent=2)

        os.replace(tmp_path, ONLINE_CACHE_PATH)

        ONLINE_CACHE_DIRTY = False

        ONLINE_CACHE_LAST_FLUSH_TS = now

        _metric_inc("cache_flush_ok")

    except Exception:

        _metric_inc("cache_flush_error")

    finally:

        _cache_lock_release(fd)



def _online_cache_mark_dirty() -> None:

    global ONLINE_CACHE_DIRTY

    ONLINE_CACHE_DIRTY = True



def _online_cache_get(key: str, allow_stale: bool = False) -> Any:

    item = ONLINE_CACHE.get(key)

    if not isinstance(item, dict):

        _metric_inc("cache_miss")

        return None



    now = _now_ts()

    exp = float(item.get("expire_at", 0) or 0)

    stale_until = float(item.get("stale_until", exp) or 0)



    # 新鲜命中

    if exp > now:

        ONLINE_CACHE.move_to_end(key, last=True)

        _metric_inc("cache_hit_fresh")

        return item.get("value")



    # 处于 stale 窗口：仅 allow_stale 时返回；否则保留条目等待兜底使用

    if stale_until > now:

        if allow_stale:

            ONLINE_CACHE.move_to_end(key, last=True)

            _metric_inc("cache_hit_stale")

            return item.get("value")

        _metric_inc("cache_miss")

        return None



    # 超出 stale 窗口，彻底过期，剔除

    ONLINE_CACHE.pop(key, None)

    _online_cache_mark_dirty()

    _metric_inc("cache_miss")

    return None



def _online_cache_set(key: str, value: Any, ttl_sec: int = ONLINE_CACHE_TTL_SEC) -> None:

    now = _now_ts()

    ttl = max(1, int(ttl_sec))

    exp = now + ttl

    ONLINE_CACHE[key] = {

        "expire_at": exp,

        "stale_until": exp + max(0, int(ONLINE_CACHE_STALE_IF_ERROR_SEC)),

        "value": value

    }

    ONLINE_CACHE.move_to_end(key, last=True)

    _cache_prune_lru()

    _online_cache_mark_dirty()

    _metric_inc("cache_set")

    _flush_online_cache(force=False)



def _cache_flush_worker():

    interval = max(0.1, ONLINE_CACHE_FLUSH_INTERVAL_SEC)

    while not ONLINE_CACHE_STOP_EVENT.wait(interval):

        _flush_online_cache(force=False)



def _shutdown_cache_worker():

    try:

        ONLINE_CACHE_STOP_EVENT.set()

    except Exception:

        pass

    _flush_online_cache(force=True)



ONLINE_CACHE = _load_online_cache()

_cache_prune_lru()

ONLINE_CACHE_LAST_FLUSH_TS = _now_ts()

_CACHE_FLUSH_THREAD = threading.Thread(target=_cache_flush_worker, name="online-cache-flusher", daemon=True)

_CACHE_FLUSH_THREAD.start()

atexit.register(_shutdown_cache_worker)

atexit.register(_shutdown_provider_state)



def is_punct(ch: str) -> bool:

    return bool(re.match(r"[。、「」！？!?，,．.]", ch))



def _get_budoux_parser():

    global _BUDOUX_PARSER

    if budoux is None:

        return None

    if _BUDOUX_PARSER is not None:

        return _BUDOUX_PARSER

    try:

        _BUDOUX_PARSER = budoux.load_default_japanese_parser()

        return _BUDOUX_PARSER

    except Exception:

        return None



def split_sentences(text: str) -> List[str]:

    s = str(text or "").strip()

    if not s:

        return []

    parser = _get_budoux_parser()

    if parser is not None:

        try:

            chunks = parser.parse(s)

            if isinstance(chunks, list) and chunks:

                out = []

                buf = ""

                for ck in chunks:

                    buf += str(ck)

                    if re.search(r"[。！？!?]$", buf):

                        out.append(buf)

                        buf = ""

                if buf:

                    out.append(buf)

                return [x for x in out if x]

        except Exception:

            pass

    return [x for x in re.split(r"(?<=[。！？!?])", s) if x and x.strip()]



def _load_json(path: str, default: Any):

    if not os.path.exists(path):

        return default

    try:

        with open(path, "r", encoding="utf-8") as f:

            return json.load(f)

    except Exception as e:

        # 避免静默吞错：记录可观测信息后回退默认值

        log_observation("json_load_fallback", path=os.path.abspath(path), error=str(e))

        return default



def _save_json(path: str, data: Any) -> None:

    # 原子写 + 轻量文件锁，降低并发写损坏风险

    abs_path = os.path.abspath(path)

    parent = os.path.dirname(abs_path) or "."

    os.makedirs(parent, exist_ok=True)



    lock_path = abs_path + ".wlock"

    fd = None

    start = _now_ts()

    timeout_sec = max(0.2, float(ONLINE_CACHE_LOCK_TIMEOUT_SEC))



    while True:

        try:

            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_RDWR)

            os.write(fd, str(os.getpid()).encode("utf-8", errors="ignore"))

            break

        except FileExistsError:

            try:

                mtime = os.path.getmtime(lock_path)

                if (_now_ts() - float(mtime)) > max(1.0, timeout_sec * 5.0):

                    os.unlink(lock_path)

                    continue

            except Exception:

                pass

            if (_now_ts() - start) >= timeout_sec:

                raise TimeoutError(f"save_json lock timeout: {abs_path}")

            time.sleep(0.02)



    try:

        tmp_path = abs_path + ".tmp"

        with open(tmp_path, "w", encoding="utf-8") as f:

            json.dump(data, f, ensure_ascii=False, indent=2)

            f.flush()

            os.fsync(f.fileno())

        os.replace(tmp_path, abs_path)

    finally:

        try:

            if fd is not None:

                os.close(fd)

        except Exception:

            pass

        try:

            if os.path.exists(lock_path):

                owner = ""

                try:

                    with open(lock_path, "r", encoding="utf-8") as lf:

                        owner = (lf.read() or "").strip()

                except Exception:

                    owner = ""

                if (not owner) or owner == str(os.getpid()):

                    os.unlink(lock_path)

        except Exception:

            pass



def _load_lexicon_file(path: str) -> Dict[str, Dict[str, Any]]:

    data = _load_json(path, {})

    result: Dict[str, Dict[str, Any]] = {}



    if isinstance(data, dict):

        for k, v in data.items():

            if isinstance(k, str) and isinstance(v, dict):

                result[k] = {

                    "reading": str(v.get("reading", "")),

                    "meaning": str(v.get("meaning", "")),

                    "pos": str(v.get("pos", "")),

                    "jlpt": str(v.get("jlpt", "")),

                    "tags": v.get("tags", [])

                }

    elif isinstance(data, list):

        for it in data:

            if not isinstance(it, dict):

                continue

            word = str(it.get("word") or "").strip()

            if not word:

                continue

            result[word] = {

                "reading": str(it.get("reading", "")),

                "meaning": str(it.get("meaning", "")),

                "pos": str(it.get("pos", "")),

                "jlpt": str(it.get("jlpt", "")),

                "tags": it.get("tags", [])

            }



    return result



def _save_lexicon_file(path: str, lex: Dict[str, Dict[str, Any]]) -> None:

    _save_json(path, lex)



JMDICT_MINI: Dict[str, Any] = {}

KANJIDIC_MINI: Dict[str, Any] = {}

EXTERNAL_RESOURCE_STATUS: Dict[str, Any] = {

    "grammar_ext_count": 0,

    "pitch_ext_count": 0,

    "jmdict_count": 0,

    "kanjidic_count": 0

}



def _load_external_json_safely(path: str, default: Any):

    if not path:

        return default

    try:

        if not os.path.exists(path):

            return default

        with open(path, "r", encoding="utf-8") as f:

            return json.load(f)

    except Exception as e:

        log_observation("external_json_load_failed", path=os.path.abspath(path), error=str(e))

        return default



def _merge_external_resources() -> None:

    global GRAMMAR_EXPLAINERS, PITCH_ACCENT_DICT, JMDICT_MINI, KANJIDIC_MINI, EXTERNAL_RESOURCE_STATUS



    grammar_added = 0

    pitch_added = 0



    grammar_ext = _load_external_json_safely(GRAMMAR_DB_PATH, [])

    if isinstance(grammar_ext, list):

        existing_ids = {str(x.get("id", "")).strip() for x in GRAMMAR_EXPLAINERS if isinstance(x, dict)}

        for g in grammar_ext:

            if not isinstance(g, dict):

                continue

            gid = str(g.get("id", "")).strip()

            pat = str(g.get("pattern", "")).strip()

            title = str(g.get("title", "")).strip()

            if (not gid) or (not pat) or (not title):

                continue

            if gid in existing_ids:

                continue

            GRAMMAR_EXPLAINERS.append({

                "id": gid,

                "pattern": pat,

                "title": title,

                "jlpt": str(g.get("jlpt", "")).strip() or "-",

                "meaning": str(g.get("meaning", "")).strip(),

                "structure": str(g.get("structure", "")).strip(),

                "pitfall": str(g.get("pitfall", "")).strip(),

                "example": str(g.get("example", "")).strip()

            })

            existing_ids.add(gid)

            grammar_added += 1



    pitch_ext = _load_external_json_safely(PITCH_ACCENT_EXT_PATH, {})

    if isinstance(pitch_ext, dict):

        for k, v in pitch_ext.items():

            if not isinstance(k, str) or not isinstance(v, dict):

                continue

            if k not in PITCH_ACCENT_DICT:

                pitch_added += 1

            PITCH_ACCENT_DICT[k] = {

                "reading": str(v.get("reading", "")),

                "accent_type": str(v.get("accent_type", "")),

                "accent": str(v.get("accent", "")),

                "note": str(v.get("note", ""))

            }



    jmd = _load_external_json_safely(JMDICT_MINI_PATH, {})

    JMDICT_MINI = jmd if isinstance(jmd, dict) else {}



    kd = _load_external_json_safely(KANJIDIC_MINI_PATH, {})

    KANJIDIC_MINI = kd if isinstance(kd, dict) else {}



    EXTERNAL_RESOURCE_STATUS = {

        "grammar_ext_count": grammar_added,

        "pitch_ext_count": pitch_added,

        "jmdict_count": len(JMDICT_MINI),

        "kanjidic_count": len(KANJIDIC_MINI)

    }



USER_LEXICON = _load_lexicon_file(USER_LEXICON_PATH)

DOMAIN_LEXICON = _load_lexicon_file(DOMAIN_LEXICON_PATH)

_merge_external_resources()



LOCAL_INDEX: Dict[str, List[Tuple[str, str]]] = {}

ALL_LEXICON_KEYS: List[str] = []



def _build_local_index() -> None:

    global LOCAL_INDEX, ALL_LEXICON_KEYS

    idx: Dict[str, List[Tuple[str, str]]] = {}



    def _push(key: str, source: str, word: str):

        k = normalize_text(key)

        if not k:

            return

        idx.setdefault(k, []).append((source, word))



    for w, v in LOCAL_DICT.items():

        _push(w, "local", w)

        _push(v.get("reading", ""), "local", w)



    for w, v in USER_LEXICON.items():

        _push(w, "user", w)

        _push(v.get("reading", ""), "user", w)



    for w, v in DOMAIN_LEXICON.items():

        _push(w, "domain", w)

        _push(v.get("reading", ""), "domain", w)



    LOCAL_INDEX = idx

    # 预计算分词匹配键：按长度降序，避免运行期重复构建

    merged_keys = set(LOCAL_DICT.keys()) | set(USER_LEXICON.keys()) | set(DOMAIN_LEXICON.keys())

    ALL_LEXICON_KEYS = sorted(merged_keys, key=len, reverse=True)



_build_local_index()



def reload_lexicons() -> Tuple[int, int]:

    global USER_LEXICON, DOMAIN_LEXICON

    USER_LEXICON = _load_lexicon_file(USER_LEXICON_PATH)

    DOMAIN_LEXICON = _load_lexicon_file(DOMAIN_LEXICON_PATH)

    _build_local_index()

    return len(USER_LEXICON), len(DOMAIN_LEXICON)



def local_lookup_candidates(word: str, context_text: str = "") -> List[Tuple[str, str, Dict[str, Any], float]]:

    """

    返回候选: (source, matched_word, entry, rank_score)

    rank_score = 本地匹配分 + 来源可信度 + 错题权重 + JLPT/词频权重 + 轻量上下文消歧增益

    """

    w = (word or "").strip()

    if not w:

        return []



    cands: List[Tuple[str, str, Dict[str, Any], float]] = []



    def _append(src: str, key: str, entry: Dict[str, Any], base_score: float):

        if not entry:

            return

        cands.append((src, key, entry, base_score))



    query_forms = {w}

    vw = normalize_variants(w)

    if vw:

        query_forms.add(vw)



    # exact key match（含表记摇れ映射）

    for q in query_forms:

        if q in USER_LEXICON:

            _append("user", q, USER_LEXICON[q], 1.0)

        if q in DOMAIN_LEXICON:

            _append("domain", q, DOMAIN_LEXICON[q], 1.0)

        if q in LOCAL_DICT:

            _append("local", q, LOCAL_DICT[q], 1.0)



    # normalized index match（含 old/new 字体归一）

    for q in query_forms:

        nk = normalize_text(q)

        for src, kw in LOCAL_INDEX.get(nk, []):

            if src == "user" and kw in USER_LEXICON:

                _append("user", kw, USER_LEXICON[kw], 0.9)

            elif src == "domain" and kw in DOMAIN_LEXICON:

                _append("domain", kw, DOMAIN_LEXICON[kw], 0.9)

            elif src == "local" and kw in LOCAL_DICT:

                _append("local", kw, LOCAL_DICT[kw], 0.9)



    # de-dup by (src,key), keep best base score

    best: Dict[Tuple[str, str], Tuple[str, str, Dict[str, Any], float]] = {}

    for it in cands:

        k = (it[0], it[1])

        if k not in best or it[3] > best[k][3]:

            best[k] = it



    out: List[Tuple[str, str, Dict[str, Any], float]] = []

    for src, kw, entry, base in best.values():

        rank = _compose_rank_score(

            base_match_score=base,

            source=src,

            word=kw,

            reading=str(entry.get("reading", "")),

            pos=str(entry.get("pos", "")),

            context_text=context_text

        )

        out.append((src, kw, entry, rank))



    out = sorted(out, key=lambda x: x[3], reverse=True)

    return out



def lexicon_lookup(word: str) -> Dict[str, Any]:

    cands = local_lookup_candidates(word)

    if not cands:

        return {}

    return cands[0][2]


def lexicon_lookup_fast(word: str) -> Dict[str, Any]:
    """
    仅做本地轻量词典命中，不触发 full-db 补查。
    用于 sudachi_rows / reading_aid / analyze_sentence 等热路径，
    避免 token 级大量 SQLite 查询导致超时。
    """
    w = str(word or "").strip()
    if not w:
        return {}

    if w in USER_LEXICON:
        return USER_LEXICON[w]
    if w in DOMAIN_LEXICON:
        return DOMAIN_LEXICON[w]
    if w in LOCAL_DICT:
        return LOCAL_DICT[w]

    nk = normalize_text(w)
    for src, kw in LOCAL_INDEX.get(nk, []):
        if src == "user" and kw in USER_LEXICON:
            return USER_LEXICON[kw]
        if src == "domain" and kw in DOMAIN_LEXICON:
            return DOMAIN_LEXICON[kw]
        if src == "local" and kw in LOCAL_DICT:
            return LOCAL_DICT[kw]

    return {}



def _all_lexicon_keys() -> List[str]:

    return ALL_LEXICON_KEYS



def split_chunk_by_local_dict(chunk: str) -> List[str]:

    if chunk in LOCAL_DICT or chunk in USER_LEXICON or chunk in DOMAIN_LEXICON:

        return [chunk]



    result = []

    i = 0

    keys = _all_lexicon_keys()



    while i < len(chunk):

        best = None

        for k in keys:

            if chunk.startswith(k, i):

                if best is None or len(k) > len(best):

                    best = k



        if best:

            result.append(best)

            i += len(best)

        else:

            result.append(chunk[i])

            i += 1



    merged = []

    buf = ""

    for t in result:

        if len(t) == 1 and t not in LOCAL_DICT and t not in USER_LEXICON and t not in DOMAIN_LEXICON and re.match(r"[一-龯ぁ-んァ-ンー]", t):

            buf += t

        else:

            if buf:

                merged.append(buf)

                buf = ""

            merged.append(t)

    if buf:

        merged.append(buf)

    return merged



def fallback_segment(text: str) -> List[str]:

    tokens: List[str] = []

    i = 0

    n = len(text)



    while i < n:

        ch = text[i]

        if ch.isspace():

            i += 1

            continue



        if is_punct(ch):

            tokens.append(ch)

            i += 1

            continue



        marker = None

        for m in SPLIT_MARKERS:

            if text.startswith(m, i):

                marker = m

                break



        if marker:

            tokens.append(marker)

            i += len(marker)

            continue



        j = i + 1

        while j < n:

            cj = text[j]

            if cj.isspace() or is_punct(cj):

                break

            if any(text.startswith(m, j) for m in SPLIT_MARKERS):

                break

            j += 1



        chunk = text[i:j]

        tokens.extend(split_chunk_by_local_dict(chunk))

        i = j



    return tokens



def _sudachi_mode():

    if sudachi_tokenizer is None:

        return None

    mode = (SUDACHI_SPLIT_MODE or "C").upper().strip()

    mapping = {

        "A": sudachi_tokenizer.Tokenizer.SplitMode.A,

        "B": sudachi_tokenizer.Tokenizer.SplitMode.B,

        "C": sudachi_tokenizer.Tokenizer.SplitMode.C,

    }

    return mapping.get(mode, sudachi_tokenizer.Tokenizer.SplitMode.C)



def _get_sudachi_tagger():

    global _SUDACHI_TAGGER

    if sudachi_dictionary is None:

        return None

    if _SUDACHI_TAGGER is not None:

        return _SUDACHI_TAGGER

    try:

        _SUDACHI_TAGGER = sudachi_dictionary.Dictionary().create()

        return _SUDACHI_TAGGER

    except Exception:

        return None



def _join_pos(parts: Any) -> str:

    if not isinstance(parts, (list, tuple)):

        return "未知"

    vals = [str(x) for x in parts if x and str(x) != "*"]

    return "-".join(vals) if vals else "未知"



def sudachi_rows(text: str) -> List[Dict[str, str]]:

    tagger = _get_sudachi_tagger()

    mode = _sudachi_mode()

    if tagger is None or mode is None:

        return []



    rows: List[Dict[str, str]] = []

    try:

        for m in tagger.tokenize(text, mode):

            surf = m.surface()

            if not surf:

                continue

            lemma = m.dictionary_form() or surf

            norm = m.normalized_form() or lemma

            reading = kata_to_hira(m.reading_form() or "")

            pos = _join_pos(m.part_of_speech())



            info = lexicon_lookup_fast(lemma) or lexicon_lookup_fast(norm) or lexicon_lookup_fast(surf) or {}

            if not reading:

                reading = str(info.get("reading", ""))



            # 功能词不过度给释义，避免噪声（如助词被词典长释义污染）

            if (

                pos.startswith("助詞")

                or pos.startswith("助動詞")

                or pos.startswith("補助記号")

                or ("非自立可能" in pos)

            ):

                meaning = ""

            else:

                meaning = str(info.get("meaning", ""))



            rows.append({

                "surface": surf,

                "lemma": lemma,

                "normalized": norm,

                "pos": pos,

                "reading": reading,

                "meaning": meaning,

            })

    except Exception:

        return []



    return rows



def _verb_lemma_from_sudachi(text: str) -> str:

    rows = sudachi_rows(text)

    for r in rows:

        if "動詞" in r.get("pos", ""):

            return r.get("lemma") or r.get("surface") or text

    if rows:

        return rows[0].get("lemma") or text

    return text



def _infer_error_type(user_answer: str, expected: str, reading: str = "") -> str:

    ua = normalize_text(user_answer)

    ea = normalize_text(expected)

    if not ua:

        return "blank"

    if ua == ea:

        return "correct"



    raw = (user_answer or "").strip()

    if reading and normalize_text(raw) == normalize_text(reading):

        return "kana_instead_of_kanji"

    if re.fullmatch(r"[ぁ-んァ-ンー]+", raw) and re.search(r"[一-龯]", expected or ""):

        return "kana_instead_of_kanji"



    if abs(len(ua) - len(ea)) <= 1:

        overlap = len(set(ua) & set(ea))

        if overlap >= max(1, min(len(ua), len(ea)) - 1):

            return "typo"



    return "semantic_or_unknown"



_WRONGBOOK_CACHE_DATA: List[Dict[str, Any]] = []

_WRONGBOOK_CACHE_MTIME: float = -1.0

_WRONGBOOK_CACHE_VALID: bool = False



def _load_wrongbook() -> List[Dict[str, Any]]:

    global _WRONGBOOK_CACHE_DATA, _WRONGBOOK_CACHE_MTIME, _WRONGBOOK_CACHE_VALID



    try:

        mtime = os.path.getmtime(WRONGBOOK_PATH) if os.path.exists(WRONGBOOK_PATH) else -1.0

    except Exception:

        mtime = -1.0



    if _WRONGBOOK_CACHE_VALID and mtime == _WRONGBOOK_CACHE_MTIME:

        return list(_WRONGBOOK_CACHE_DATA)



    data = _load_json(WRONGBOOK_PATH, [])

    items = data if isinstance(data, list) else []

    _WRONGBOOK_CACHE_DATA = list(items)

    _WRONGBOOK_CACHE_MTIME = mtime

    _WRONGBOOK_CACHE_VALID = True

    return list(items)



def _save_wrongbook(items: List[Dict[str, Any]]) -> None:

    global _WRONGBOOK_CACHE_DATA, _WRONGBOOK_CACHE_MTIME, _WRONGBOOK_CACHE_VALID

    _save_json(WRONGBOOK_PATH, items)

    try:

        mtime = os.path.getmtime(WRONGBOOK_PATH) if os.path.exists(WRONGBOOK_PATH) else -1.0

    except Exception:

        mtime = -1.0

    _WRONGBOOK_CACHE_DATA = list(items) if isinstance(items, list) else []

    _WRONGBOOK_CACHE_MTIME = mtime

    _WRONGBOOK_CACHE_VALID = True



def _wrong_count_for_word(word: str) -> int:

    key = normalize_text(word)

    if not key:

        return 0

    items = _load_wrongbook()

    cnt = 0

    for it in items:

        w = str(it.get("word") or it.get("expected_answer") or "").strip()

        if normalize_text(w) == key:

            cnt += 1

    return cnt



def _build_wrongbook_freq_map(items: List[Dict[str, Any]] = None) -> Dict[str, int]:

    if items is None:

        items = _load_wrongbook()

    freq: Dict[str, int] = {}

    for it in items:

        w = str(it.get("word") or it.get("expected_answer") or "").strip()

        key = normalize_text(w)

        if not key:

            continue

        freq[key] = freq.get(key, 0) + 1

    return freq



def _adaptive_score(word: str, wrong_freq_map: Dict[str, int] = None) -> float:

    if wrong_freq_map is None:

        wrong = _wrong_count_for_word(word)

    else:

        wrong = int(wrong_freq_map.get(normalize_text(word), 0))

    return 1.0 + min(3.0, wrong * 0.6)



def _weighted_sample(items: List[Dict[str, Any]], k: int) -> List[Dict[str, Any]]:

    if k <= 0:

        return []

    if k >= len(items):

        return random.sample(items, len(items))



    pool = items[:]

    chosen: List[Dict[str, Any]] = []

    for _ in range(k):

        total = 0.0

        for it in pool:

            total += max(float(it.get("score", 1.0)), 0.01)



        r = random.uniform(0, total)

        acc = 0.0

        idx = 0

        for i, it in enumerate(pool):

            acc += max(float(it.get("score", 1.0)), 0.01)

            if acc >= r:

                idx = i

                break

        chosen.append(pool.pop(idx))

    return chosen



def is_noise_token(row: Dict[str, str]) -> bool:

    surf = str(row.get("surface", "") or "")

    pos = str(row.get("pos", "") or "")

    if not surf:

        return True

    if pos.startswith("補助記号"):

        return True

    if re.fullmatch(r"[。、「」！？!?，,．.・…（）()\[\]【】『』“”\"'：:；;]+", surf):

        return True

    return False



def lookup_jlpt_for_word(word: str) -> str:

    w = str(word or "").strip()

    if not w:

        return ""



    forms = []

    wv = normalize_variants(w)

    for x in (w, wv):

        if x and x not in forms:

            forms.append(x)



    # 1) 先查用户/领域词典（避免走 lexicon_lookup 造成递归）

    for f in forms:

        if f in USER_LEXICON:

            lv = str(USER_LEXICON[f].get("jlpt", "")).strip().upper()

            if lv:

                return lv

        if f in DOMAIN_LEXICON:

            lv = str(DOMAIN_LEXICON[f].get("jlpt", "")).strip().upper()

            if lv:

                return lv



    # 2) 通过 normalized index 反查 user/domain

    for f in forms:

        nk = normalize_text(f)

        for src, kw in LOCAL_INDEX.get(nk, []):

            if src == "user" and kw in USER_LEXICON:

                lv = str(USER_LEXICON[kw].get("jlpt", "")).strip().upper()

                if lv:

                    return lv

            if src == "domain" and kw in DOMAIN_LEXICON:

                lv = str(DOMAIN_LEXICON[kw].get("jlpt", "")).strip().upper()

                if lv:

                    return lv



    # 3) 静态JLPT表

    for f in forms:

        lv = str(JLPT_WORD_LEVELS.get(f, "")).strip().upper()

        if lv:

            return lv



    return ""



def jlpt_level_for_token(row: Dict[str, str]) -> str:

    keys = [row.get("lemma", ""), row.get("normalized", ""), row.get("surface", "")]

    for k in keys:

        if not k:

            continue

        lv = lookup_jlpt_for_word(k)

        if not lv:

            kv = normalize_variants(str(k))

            lv = str(JLPT_WORD_LEVELS.get(k, "")).strip().upper() or str(JLPT_WORD_LEVELS.get(kv, "")).strip().upper()

        if lv:

            return lv



    pos = str(row.get("pos", "") or "")

    if pos.startswith("助詞") or pos.startswith("助動詞"):

        return "N5"

    if "接尾辞" in pos and (row.get("lemma") in ("れる", "られる", "にくい") or row.get("surface") in ("れる", "られる", "にくい")):

        return "N4" if row.get("lemma") in ("れる", "られる") else "N3"

    return ""



def detect_grammar_points(text: str) -> List[Dict[str, str]]:

    hits: List[Dict[str, str]] = []

    for g in GRAMMAR_EXPLAINERS:

        try:

            if re.search(g["pattern"], text):

                hits.append(g)

        except Exception:

            continue

    return hits



def grammar_explain(text: str, grammar: str = "") -> str:

    text = (text or "").strip()

    grammar = (grammar or "").strip()

    if not text and not grammar:

        return "缺少参数：请提供 text 或 grammar。"



    targets: List[Dict[str, str]] = []

    if grammar:

        q = normalize_text(grammar)

        for g in GRAMMAR_EXPLAINERS:

            if q in normalize_text(g.get("title", "")) or q == normalize_text(g.get("id", "")):

                targets.append(g)

    if text:

        for g in detect_grammar_points(text):

            if g not in targets:

                targets.append(g)



    if not targets:

        return "未命中可讲解语法点。"



    lines = ["### 语法点精讲（JLPT）"]

    if text:

        lines.append(f"原句：{text}")

    lines.append("")

    for i, g in enumerate(targets, 1):

        lines.append(f"{i}. {g.get('title','(unknown)')}  [{g.get('jlpt','-')}]")

        lines.append(f"   - 含义: {g.get('meaning','')}")

        lines.append(f"   - 接续: {g.get('structure','')}")

        lines.append(f"   - 易错: {g.get('pitfall','')}")

        lines.append(f"   - 例句: {g.get('example','')}")



    # jlpt source/license summary (phase3, optional)

    db_path = os.environ.get(

        "GRAMMAR_FULL_DB_PATH",

        os.path.join(PLUGIN_DIR, "data", "db", "jdict_full.sqlite")

    )

    try:

        if os.path.exists(db_path):

            conn = sqlite3.connect(db_path, timeout=3.0)

            cur = conn.cursor()

            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='jlpt_lex' LIMIT 1")

            if cur.fetchone() is not None:

                lines.append("")

                lines.append("#### jlpt_license_summary")

                rows = cur.execute(

                    """

                    SELECT COALESCE(source_repo,''), COALESCE(license,''), COALESCE(confidence,''), COUNT(1)

                    FROM jlpt_lex

                    GROUP BY 1,2,3

                    ORDER BY COUNT(1) DESC

                    """

                ).fetchall()

                for r in rows:

                    lines.append(f"- source_repo={r[0]} | license={r[1]} | confidence={r[2]} | rows={r[3]}")

            conn.close()

    except Exception as _e:

        lines.append(f"- jlpt_license_summary_error: {_e}")



    return "\n".join(lines)



def jlpt_tag(text: str) -> str:

    text = (text or "").strip()

    if not text:

        return "缺少 text 参数。"

    rows = sudachi_rows(text)

    if not rows:

        rows = []

        for w in fallback_segment(text):

            info = lexicon_lookup(w)

            rows.append({

                "surface": w,

                "lemma": w,

                "normalized": w,

                "pos": info.get("pos", "未知"),

                "reading": info.get("reading", ""),

                "meaning": info.get("meaning", "")

            })



    lines = [f"### JLPT分级标注\n原句：{text}\n", "#### 词级标注"]

    stat = {"N1":0,"N2":0,"N3":0,"N4":0,"N5":0,"未知":0}



    counter_set = {"冊", "人", "本", "匹", "枚", "台", "回", "個", "つ", "年", "月", "日", "時", "分"}

    i = 0

    shown = 0

    while i < len(rows):

        r = rows[i]

        if is_noise_token(r):

            i += 1

            continue



        # 数词 + 助数词 合并显示（如 一 + 冊 => 一冊）

        if i + 1 < len(rows):

            r2 = rows[i + 1]

            pos1 = str(r.get("pos", ""))

            surf1 = str(r.get("surface", ""))

            surf2 = str(r2.get("surface", ""))

            if ("数詞" in pos1) and (surf2 in counter_set):

                merged_surface = f"{surf1}{surf2}"

                merged_lemma = merged_surface

                merged_reading = f"{r.get('reading','')}{r2.get('reading','')}"

                lv = lookup_jlpt_for_word(merged_surface) or jlpt_level_for_token(r2) or jlpt_level_for_token(r) or "N5"

                stat[lv if lv in stat else "未知"] += 1

                shown += 1

                row_text = f"{shown}. {merged_surface} ｜原形:{merged_lemma} ｜JLPT:{lv}"

                if merged_reading:

                    row_text += f" ｜读音:{merged_reading}"

                lines.append(row_text)

                i += 2

                continue



        lv = jlpt_level_for_token(r) or "未知"

        stat[lv if lv in stat else "未知"] += 1

        shown += 1



        row_text = f"{shown}. {r.get('surface','')} ｜原形:{r.get('lemma','')} ｜JLPT:{lv}"

        if r.get("reading"):

            row_text += f" ｜读音:{r.get('reading')}"

        meaning_text = str(r.get("meaning", ""))

        pos_text = str(r.get("pos", ""))

        if meaning_text and not (

            pos_text.startswith("助詞")

            or pos_text.startswith("助動詞")

            or pos_text.startswith("補助記号")

            or ("非自立可能" in pos_text)

        ):

            if len(meaning_text) > 80:

                meaning_text = meaning_text[:80] + "..."

            row_text += f" ｜释义:{meaning_text}"

        lines.append(row_text)

        i += 1



    lines.append("\n#### 统计")

    for k in ["N1","N2","N3","N4","N5","未知"]:

        lines.append(f"- {k}: {stat.get(k,0)}")

    return "\n".join(lines)



def analyze_sentence(text: str, strict_grammar: bool = False) -> str:

    text = (text or "").strip()

    if not text:

        return "缺少 text 参数。"



    lines = [f"### 日语句子解析\n原句：{text}\n"]

    sents = split_sentences(text)

    if sents:

        lines.append("#### 0) 分句")

        for i, s in enumerate(sents, 1):

            lines.append(f"{i}. {s}")

        lines.append("")



    lines.append("#### 1) 分词")

    rows = sudachi_rows(text)



    if not rows:

        for w in fallback_segment(text):

            info = lexicon_lookup(w)

            rows.append({

                "surface": w,

                "lemma": w,

                "normalized": w,

                "pos": info.get("pos", "未知"),

                "reading": info.get("reading", ""),

                "meaning": info.get("meaning", "")

            })



    for i, r in enumerate(rows, 1):

        row = f"{i}. {r['surface']} ｜原形:{r['lemma']} ｜词性:{r['pos']}"

        if r.get("normalized") and r["normalized"] != r["lemma"]:

            row += f" ｜规范形:{r['normalized']}"

        if r.get("reading"):

            row += f" ｜读音:{r['reading']}"

        if r.get("meaning"):

            row += f" ｜释义:{r['meaning']}"

        lv = jlpt_level_for_token(r)

        if lv:

            row += f" ｜JLPT:{lv}"

        lines.append(row)



    lines.append("\n#### 2) 语法点")

    hits = [desc for patt, desc in GRAMMAR_PATTERNS if re.search(patt, text)]

    if hits:

        for i, h in enumerate(dict.fromkeys(hits), 1):

            lines.append(f"{i}. {h}")

    else:

        lines.append("未命中预设语法点。")



    detail_hits = detect_grammar_points(text)

    # 默认启用轻量去误判（strict_grammar=false）
    # 典型场景：新闻体「〜によりますと/〜によると」中的「より」并非比较语法「〜より」。
    if (not strict_grammar) and detail_hits:
        if re.search(r"(によりますと|によると|によれば|によって)", text):
            filtered_hits = []
            for g in detail_hits:
                title = str(g.get("title", ""))
                patt = str(g.get("pattern", ""))
                # 仅过滤“比较的〜より”类误报；若句子确有比较结构则保留
                if ("より" in title) or ("より" in patt):
                    has_compare_cue = bool(re.search(r"(よりも|AはBより|ほうが|方が)", text))
                    if has_compare_cue:
                        filtered_hits.append(g)
                else:
                    filtered_hits.append(g)
            detail_hits = filtered_hits

    lines.append("\n#### 2.1) 语法精讲速览")

    if detail_hits:

        for i, g in enumerate(detail_hits, 1):

            lines.append(f"{i}. {g.get('title')} [{g.get('jlpt')}] - {g.get('meaning')}")

    else:

        lines.append("未命中精讲规则。")



    lines.append("\n#### 3) 建议")

    lines.append("- 跟读3次，再逐词复述。")

    lines.append("- 用命中语法各造1句。")

    lines.append("- 24小时后做一次复习。")

    return "\n".join(lines)



def _provider_jisho(word: str, timeout_sec: float) -> List[Dict[str, Any]]:

    if not JISHO_API_ENABLED or requests is None:

        return []

    try:

        resp = requests.get(

            "https://jisho.org/api/v1/search/words",

            params={"keyword": word},

            timeout=timeout_sec

        )

        resp.raise_for_status()

        data = resp.json().get("data", [])

        out: List[Dict[str, Any]] = []

        for d in data[:8]:

            jp = (d.get("japanese") or [{}])[0]

            senses = d.get("senses") or []

            s0 = senses[0] if senses else {}

            word_jp = jp.get("word") or jp.get("reading") or word

            reading = kata_to_hira(jp.get("reading") or "")

            pos = " / ".join((s0.get("parts_of_speech") or [])[:4])

            defs = (s0.get("english_definitions") or [])[:6]

            out.append({

                "word": word_jp,

                "reading": reading,

                "pos": pos,

                "meanings": defs,

                "source": "jisho",

                "score": 0.85

            })

        return out

    except Exception:

        return []



def _provider_jotoba(word: str, timeout_sec: float) -> List[Dict[str, Any]]:

    # 可选源：默认关闭，避免外部接口不稳定影响主流程

    if (not JOTOBA_API_ENABLED) or requests is None:

        return []

    try:

        # Jotoba API 结构可能变动，这里做宽松解析

        resp = requests.get(

            "https://jotoba.de/api/search/words",

            params={"query": word},

            timeout=timeout_sec

        )

        resp.raise_for_status()

        data = resp.json()

        rows = data if isinstance(data, list) else data.get("words", [])

        out: List[Dict[str, Any]] = []

        for it in rows[:8]:

            w = (it.get("word") or it.get("kanji") or it.get("surface") or word)

            r = kata_to_hira(it.get("reading") or it.get("kana") or "")

            senses = it.get("senses") or it.get("meanings") or []

            defs: List[str] = []

            if senses and isinstance(senses, list):

                first = senses[0]

                if isinstance(first, dict):

                    defs = first.get("glosses") or first.get("english") or []

                elif isinstance(first, str):

                    defs = [first]

            pos = ""

            if isinstance(it.get("pos"), list):

                pos = " / ".join(it.get("pos")[:4])

            elif isinstance(it.get("pos"), str):

                pos = it.get("pos")

            out.append({

                "word": w,

                "reading": r,

                "pos": pos,

                "meanings": defs[:6],

                "source": "jotoba",

                "score": 0.8

            })

        return out

    except Exception:

        return []



def _online_lookup_single(provider: str, word: str) -> List[Dict[str, Any]]:

    provider = (provider or "").strip().lower()

    cache_key = f"online::{provider}::{_stable_hash(normalize_text(word))}"



    # 先读新鲜缓存

    cached = _online_cache_get(cache_key, allow_stale=False)

    if cached is not None:

        log_observation("provider_cache_hit", provider=provider, cache_hit="fresh", key=cache_key)

        return cached if isinstance(cached, list) else []



    # 熔断中：仅允许概率探活，否则尝试返回 stale

    if not _provider_is_allowed(provider):

        stale = _online_cache_get(cache_key, allow_stale=True)

        if stale is not None:

            _metric_inc("stale_if_error_served")

            log_observation("provider_cache_hit", provider=provider, cache_hit="stale", reason="circuit_open", key=cache_key)

            return stale if isinstance(stale, list) else []

        log_observation("provider_skipped", provider=provider, reason="circuit_open_no_stale")

        return []



    retries = max(1, ONLINE_DICT_RETRY + 1)



    for i in range(retries):

        t0 = _now_ts()

        rows: List[Dict[str, Any]] = []

        try:

            if provider == "jisho":

                rows = _provider_jisho(word, ONLINE_DICT_TIMEOUT)

            elif provider == "jotoba":

                rows = _provider_jotoba(word, ONLINE_DICT_TIMEOUT)

            else:

                rows = []



            elapsed = max(0.0, _now_ts() - t0)

            _metric_inc(f"provider_{provider}_attempts")

            _metric_add(f"provider_{provider}_latency_sum", elapsed)



            if rows:

                _provider_record_success(provider)

                _metric_inc(f"provider_{provider}_success")

                _online_cache_set(cache_key, rows, ONLINE_CACHE_TTL_SEC)

                log_observation(

                    "provider_call",

                    provider=provider,

                    ok=True,

                    elapsed_ms=int(elapsed * 1000),

                    result_count=len(rows),

                    timeout_sec=ONLINE_DICT_TIMEOUT

                )

                return rows



            # 空结果也计作一次失败（用于弱熔断）

            _metric_inc(f"provider_{provider}_empty")

            _provider_record_failure(provider)

            log_observation(

                "provider_call",

                provider=provider,

                ok=False,

                elapsed_ms=int(elapsed * 1000),

                result_count=0,

                error="empty_result",

                timeout_sec=ONLINE_DICT_TIMEOUT

            )



        except Exception as e:

            _metric_inc(f"provider_{provider}_errors")

            if requests is not None and isinstance(e, requests.Timeout):

                _metric_inc(f"provider_{provider}_timeout")

            _provider_record_failure(provider)

            log_observation(

                "provider_call",

                provider=provider,

                ok=False,

                elapsed_ms=int(max(0.0, (_now_ts() - t0)) * 1000),

                result_count=0,

                error=str(e),

                timeout_sec=ONLINE_DICT_TIMEOUT

            )



        if i < retries - 1:

            backoff = min(

                max(0.01, ONLINE_DICT_BACKOFF_MAX_SEC),

                max(0.0, ONLINE_DICT_BACKOFF_BASE_SEC) * (2 ** i)

            )

            time.sleep(backoff)



    # 在线失败兜底：允许返回短期过期缓存

    stale = _online_cache_get(cache_key, allow_stale=True)

    if stale is not None:

        _metric_inc("stale_if_error_served")

        log_observation("provider_cache_hit", provider=provider, cache_hit="stale", reason="online_failed", key=cache_key)

        return stale if isinstance(stale, list) else []



    # 负缓存，避免同一失败高频穿透

    _online_cache_set(cache_key, [], 120)

    return []



def _merge_online_results(rows: List[Dict[str, Any]], context_text: str = "") -> List[Dict[str, Any]]:

    # 去重增强：词条 + 读音 + 词性

    merged: Dict[str, Dict[str, Any]] = {}

    for r in rows:

        word = str(r.get("word", ""))

        reading = str(r.get("reading", ""))

        pos = str(r.get("pos", ""))

        key = normalize_text(f"{word}|{reading}|{pos}")

        if not key:

            continue

        if key not in merged:

            merged[key] = {

                "word": word,

                "reading": reading,

                "pos": pos,

                "meanings": list(r.get("meanings", []) or []),

                "sources": [r.get("source", "unknown")],

                "base_score": float(r.get("score", 0.5))

            }

        else:

            m = merged[key]

            m["base_score"] = max(float(m.get("base_score", 0.0)), float(r.get("score", 0.0)))

            m["sources"].append(r.get("source", "unknown"))

            old_defs = list(m.get("meanings", []))

            new_defs = list(r.get("meanings", []) or [])

            m["meanings"] = list(dict.fromkeys(old_defs + new_defs))[:8]

            if not m.get("pos") and pos:

                m["pos"] = pos



    out: List[Dict[str, Any]] = []

    for m in merged.values():

        src0 = (m.get("sources") or ["unknown"])[0]

        rank = _compose_rank_score(

            base_match_score=float(m.get("base_score", 0.5)),

            source=str(src0),

            word=str(m.get("word", "")),

            reading=str(m.get("reading", "")),

            pos=str(m.get("pos", "")),

            context_text=context_text

        )

        m["score"] = rank

        m["sources"] = list(dict.fromkeys([str(s) for s in m.get("sources", []) if s]))

        m.pop("base_score", None)

        out.append(m)



    out = sorted(out, key=lambda x: float(x.get("score", 0.0)), reverse=True)

    return out



def parallel_online_lookup(word: str, mode: str = "race", context_text: str = "") -> List[Dict[str, Any]]:

    if requests is None:

        return []



    providers = []

    for p in ONLINE_PROVIDER_ORDER:

        if p == "jisho" and JISHO_API_ENABLED:

            providers.append(p)

        elif p == "jotoba" and JOTOBA_API_ENABLED:

            providers.append(p)



    if not providers:

        return []



    mode = (mode or ONLINE_DICT_MODE or "race").strip().lower()

    if mode not in ("race", "aggregate"):

        mode = "race"



    def _shutdown_executor_now(executor: ThreadPoolExecutor) -> None:

        if executor is None:

            return

        try:

            executor.shutdown(wait=False, cancel_futures=True)

        except TypeError:

            # py<3.9 无 cancel_futures

            try:

                executor.shutdown(wait=False)

            except Exception:

                pass

        except Exception:

            pass



    collected: List[Dict[str, Any]] = []

    start_ts = _now_ts()

    timeout_hits = 0



    ex = ThreadPoolExecutor(max_workers=len(providers))

    try:

        futs = {ex.submit(_online_lookup_single, p, word): p for p in providers}



        if mode == "race":

            try:

                for fut in as_completed(futs, timeout=ONLINE_DICT_GLOBAL_TIMEOUT):

                    p = futs.get(fut, "unknown")

                    try:

                        rows = fut.result()

                    except Exception:

                        _metric_inc(f"provider_{p}_future_error")

                        rows = []

                    if rows:

                        # race 命中后立即取消其余任务，避免等待拖慢返回

                        for other in futs.keys():

                            if other is not fut:

                                other.cancel()

                        _shutdown_executor_now(ex)

                        return _merge_online_results(rows, context_text=context_text)

            except FuturesTimeoutError:

                timeout_hits += 1

                _metric_inc("global_timeout_hits")



            # race 模式下到这里说明没拿到可用结果（超时或全空）

            return _merge_online_results(collected, context_text=context_text)



        # aggregate 模式

        try:

            for fut in as_completed(futs, timeout=ONLINE_DICT_GLOBAL_TIMEOUT):

                p = futs.get(fut, "unknown")

                try:

                    rows = fut.result()

                except Exception:

                    _metric_inc(f"provider_{p}_future_error")

                    rows = []

                if rows:

                    collected.extend(rows)

        except FuturesTimeoutError:

            timeout_hits += 1

            _metric_inc("global_timeout_hits")



        return _merge_online_results(collected, context_text=context_text)



    finally:

        _shutdown_executor_now(ex)

        _metric_add("global_lookup_time_sum", max(0.0, _now_ts() - start_ts))

        _metric_inc("global_lookup_calls")

        if timeout_hits > 0:

            _metric_inc("global_lookup_timeout_calls", timeout_hits)



def lookup_word(word: str, online_mode: str = "", use_parallel_online: bool = True, force_online: bool = False, context_text: str = "") -> str:

    t0 = _now_ts()

    word = normalize_variants((word or "").strip())

    if not word:

        return "缺少 word/keyword 参数。"



    lines = [f"### 单词查询\n查询词：{word}\n", "#### 本地词典（多索引）"]



    local_cands = local_lookup_candidates(word, context_text=context_text)

    if local_cands:

        for i, (src, kw, entry, score) in enumerate(local_cands[:3], 1):

            lines.append(f"{i}. 词条: {kw}  (source={src}, score={score:.2f})")

            if entry.get("reading"):

                lines.append(f"   - 读音: {entry.get('reading')}")

            if entry.get("pos"):

                lines.append(f"   - 词性: {entry.get('pos')}")

            if entry.get("meaning"):

                lines.append(f"   - 释义: {entry.get('meaning')}")

            lv = lookup_jlpt_for_word(kw)

            if lv:

                lines.append(f"   - JLPT: {lv}")

            tags = entry.get("tags", [])

            if tags:

                lines.append(f"   - 标签: {tags}")

    else:

        lv = lookup_jlpt_for_word(word)

        if lv:

            lines.append(f"- 未命中本地词条，JLPT(推定): {lv}")

        else:

            lines.append("- 未命中内置/自定义词典。")



    online_rows: List[Dict[str, Any]] = []

    need_online = force_online or (not local_cands)

    if use_parallel_online and need_online:

        lines.append("\n#### 在线词典（并联）")

        online_rows = parallel_online_lookup(word, mode=(online_mode or ONLINE_DICT_MODE), context_text=context_text)

        if not online_rows:

            lines.append("- 在线未返回有效结果（可能超时/禁用/无命中）。")

        else:

            for i, r in enumerate(online_rows[:5], 1):

                lines.append(f"{i}. 词条: {r.get('word','')}  (sources={','.join(r.get('sources', []))}, score={float(r.get('score',0)):.2f})")

                if r.get("reading"):

                    lines.append(f"   - 读音: {r.get('reading')}")

                if r.get("pos"):

                    lines.append(f"   - 词性: {r.get('pos')}")

                defs = list(r.get("meanings", []) or [])

                if defs:

                    lines.append(f"   - 英文释义: {', '.join(defs[:6])}")

    else:

        lines.append("\n#### 在线词典（并联）")

        if not use_parallel_online:

            lines.append("- 已跳过（use_parallel_online=false）。")

        elif local_cands and not force_online:

            lines.append("- 已跳过（本地命中且未强制在线）。")

        else:

            lines.append("- 已跳过（未满足触发条件）。")



    cost_ms = int((_now_ts() - t0) * 1000)

    top1 = ""

    first_usable = False

    if local_cands:

        top1 = local_cands[0][1]

        e0 = local_cands[0][2]

        first_usable = bool(top1 and (e0.get("meaning") or e0.get("reading")))

    elif online_rows:

        top1 = str(online_rows[0].get("word", ""))

        first_usable = bool(top1 and online_rows[0].get("meanings"))



    log_observation(

        "lookup_word",

        query=word,

        context=context_text,

        local_hit=len(local_cands),

        online_hit=len(online_rows),

        top1=top1,

        first_usable=first_usable,

        cost_ms=cost_ms,

        mode=(online_mode or ONLINE_DICT_MODE),

        force_online=bool(force_online),

        use_parallel_online=bool(use_parallel_online)

    )



    return "\n".join(lines)



def lookup_word_json(args: Dict[str, Any]) -> Dict[str, Any]:

    t0 = _now_ts()

    word = normalize_variants(str(args.get("word") or args.get("keyword") or args.get("text") or "").strip())

    if not word:

        return {"ok": False, "error": "缺少 word/keyword 参数。"}



    context_text = str(args.get("context") or args.get("context_text") or args.get("sentence") or "").strip()

    online_mode = str(args.get("online_mode") or ONLINE_DICT_MODE)

    use_parallel_online = as_bool(args.get("use_parallel_online"), True)

    force_online = as_bool(args.get("force_online"), False)



    local_cands = local_lookup_candidates(word, context_text=context_text)

    local_cards: List[Dict[str, Any]] = []

    for src, kw, entry, score in local_cands:

        local_cards.append({

            "word": kw,

            "reading": str(entry.get("reading", "")),

            "pos": str(entry.get("pos", "")),

            "meanings": [str(entry.get("meaning", ""))] if entry.get("meaning") else [],

            "source": src,

            "sources": [src],

            "score": float(score),

            "jlpt": lookup_jlpt_for_word(kw)

        })



    online_cards: List[Dict[str, Any]] = []

    need_online = force_online or (not local_cands)

    if use_parallel_online and need_online:

        rows = parallel_online_lookup(word, mode=online_mode, context_text=context_text)

        for r in rows:

            online_cards.append({

                "word": str(r.get("word", "")),

                "reading": str(r.get("reading", "")),

                "pos": str(r.get("pos", "")),

                "meanings": list(r.get("meanings", []) or []),

                "source": "online",

                "sources": list(r.get("sources", []) or []),

                "score": float(r.get("score", 0.0)),

                "jlpt": lookup_jlpt_for_word(str(r.get("word", "")))

            })



    # 聚合去重：词条+读音+词性

    merged: Dict[str, Dict[str, Any]] = {}

    for c in (local_cards + online_cards):

        k = normalize_text(f"{c.get('word','')}|{c.get('reading','')}|{c.get('pos','')}")

        if not k:

            continue

        if k not in merged:

            merged[k] = c

        else:

            old = merged[k]

            old["score"] = max(float(old.get("score", 0.0)), float(c.get("score", 0.0)))

            old["sources"] = list(dict.fromkeys(list(old.get("sources", [])) + list(c.get("sources", []))))

            old["meanings"] = list(dict.fromkeys(list(old.get("meanings", [])) + list(c.get("meanings", []))))[:8]

            if (not old.get("pos")) and c.get("pos"):

                old["pos"] = c.get("pos")



    cards = sorted(merged.values(), key=lambda x: float(x.get("score", 0.0)), reverse=True)

    top1 = cards[0]["word"] if cards else ""

    first_usable = bool(cards and cards[0].get("word") and cards[0].get("meanings"))

    cost_ms = int((_now_ts() - t0) * 1000)



    log_observation(

        "lookup_word_json",

        query=word,

        context=context_text,

        local_hit=len(local_cards),

        online_hit=len(online_cards),

        merged=len(cards),

        top1=top1,

        first_usable=first_usable,

        cost_ms=cost_ms,

        mode=online_mode,

        force_online=bool(force_online),

        use_parallel_online=bool(use_parallel_online)

    )



    return {

        "ok": True,

        "query": word,

        "context": context_text,

        "meta": {

            "online_mode": online_mode,

            "use_parallel_online": bool(use_parallel_online),

            "force_online": bool(force_online),

            "cost_ms": cost_ms

        },

        "stats": {

            "local_hit": len(local_cards),

            "online_hit": len(online_cards),

            "merged_hit": len(cards),

            "top1": top1,

            "first_usable": first_usable

        },

        "cards": cards

    }



def kanji_lookup(kanji: str) -> str:

    kanji = str(kanji or "").strip()

    if not kanji:

        return "缺少 kanji 参数。"



    ch = kanji[0]

    item = KANJIDIC_MINI.get(ch, {}) if isinstance(KANJIDIC_MINI, dict) else {}



    lines = ["### 汉字查询", f"- 字: {ch}"]

    if isinstance(item, dict) and item:

        onyomi = item.get("onyomi", [])

        kunyomi = item.get("kunyomi", [])

        meaning = item.get("meaning", [])

        jlpt = item.get("jlpt", "")

        strokes = item.get("strokes", "")

        radical = item.get("radical", "")

        lines.append(f"- 音读: {', '.join(onyomi) if isinstance(onyomi, list) else onyomi}")

        lines.append(f"- 训读: {', '.join(kunyomi) if isinstance(kunyomi, list) else kunyomi}")

        lines.append(f"- 含义: {', '.join(meaning) if isinstance(meaning, list) else meaning}")

        if jlpt:

            lines.append(f"- JLPT: {jlpt}")

        if strokes:

            lines.append(f"- 笔画: {strokes}")

        if radical:

            lines.append(f"- 部首: {radical}")

        return "\n".join(lines)



    # fallback（无外部字典时）

    if re.match(r"[一-龯]", ch):

        lines.append("- 当前未命中 KANJIDIC_MINI 词典条目。")

        lines.append("- 提示: 可在 kanjidic_mini.json 补充该字后重载。")

    else:

        lines.append("- 输入首字符不是常用汉字。")

    return "\n".join(lines)



def add_furigana(text: str, mode: str = "ruby") -> str:

    text = (text or "").strip()

    mode = str(mode or "ruby").strip().lower()

    if not text:

        return "缺少 text 参数。"



    rows = sudachi_rows(text)

    token_rows = rows if rows else []

    if not token_rows:

        for tok in fallback_segment(text):

            info = lexicon_lookup(tok)

            token_rows.append({

                "surface": tok,

                "reading": str(info.get("reading", "")),

            })



    token_rows = _merge_kana_continuation_units(token_rows)



    parts_plain = []

    parts_ruby = []

    for r in token_rows:

        surf = str(r.get("surface", ""))

        rd = str(r.get("reading", ""))

        has_kanji = bool(re.search(r"[一-龯]", surf))

        if rd and has_kanji:

            parts_plain.append(f"{surf}({rd})")

            parts_ruby.append(f"<ruby>{surf}<rt>{rd}</rt></ruby>")

        else:

            parts_plain.append(surf)

            parts_ruby.append(surf)



    plain = "".join(parts_plain)

    ruby_html = "".join(parts_ruby)



    if mode in ("plain", "paren", "fallback"):

        return "### 假名标注\n原文：" + text + "\n\n标注结果：\n" + plain



    return (

        "### 假名标注\n原文：" + text

        + "\n\n标注结果（Ruby HTML）：\n"

        + "<div class=\"jp-ruby\" style=\"line-height:2.1;font-size:1.05em;\">"

        + ruby_html

        + "</div>\n\n兼容纯文本：\n"

        + plain

    )



def _conjugate_forms(lemma: str) -> Dict[str, Any]:

    base = str(lemma or "").strip()

    if not base:

        return {"ok": False, "error": "empty_lemma"}



    irregular = {

        "する": {"class": "irregular", "masu": "します", "te": "して", "nai": "しない", "past": "した", "potential": "できる"},

        "来る": {"class": "irregular", "masu": "きます", "te": "きて", "nai": "こない", "past": "きた", "potential": "こられる"},

        "くる": {"class": "irregular", "masu": "きます", "te": "きて", "nai": "こない", "past": "きた", "potential": "こられる"},

    }

    if base in irregular:

        f = irregular[base]

        return {

            "ok": True,

            "lemma": base,

            "verb_class": f["class"],

            "confidence": 1.0,

            "forms": {

                "dictionary": base,

                "masu": f["masu"],

                "te": f["te"],

                "nai": f["nai"],

                "past": f["past"],

                "potential": f["potential"],

            }

        }



    # 行く 特例

    if base in ("行く", "いく"):

        pre = base[:-1]

        return {

            "ok": True,

            "lemma": base,

            "verb_class": "godan-special",

            "confidence": 0.95,

            "forms": {

                "dictionary": base,

                "masu": f"{pre}きます",

                "te": f"{pre}って",

                "nai": f"{pre}かない",

                "past": f"{pre}った",

                "potential": f"{pre}ける",

            }

        }



    # 一段判定（启发式）

    ichidan_exceptions = {"入る", "走る", "帰る", "切る", "知る", "要る", "滑る", "喋る", "減る", "焦る", "限る"}

    if base.endswith("る") and base not in ichidan_exceptions:

        if len(base) >= 2:

            pre_ch = base[-2]

            if pre_ch in "いきぎしじちぢにひびぴみりえけげせぜてでねへべぺめれ":

                stem = base[:-1]

                return {

                    "ok": True,

                    "lemma": base,

                    "verb_class": "ichidan",

                    "confidence": 0.9,

                    "forms": {

                        "dictionary": base,

                        "masu": f"{stem}ます",

                        "te": f"{stem}て",

                        "nai": f"{stem}ない",

                        "past": f"{stem}た",

                        "potential": f"{stem}られる",

                    }

                }



    godan = {

        "う": ("い", "って", "わない", "った", "える"),

        "く": ("き", "いて", "かない", "いた", "ける"),

        "ぐ": ("ぎ", "いで", "がない", "いだ", "げる"),

        "す": ("し", "して", "さない", "した", "せる"),

        "つ": ("ち", "って", "たない", "った", "てる"),

        "ぬ": ("に", "んで", "なない", "んだ", "ねる"),

        "ぶ": ("び", "んで", "ばない", "んだ", "べる"),

        "む": ("み", "んで", "まない", "んだ", "める"),

        "る": ("り", "って", "らない", "った", "れる"),

    }

    end = base[-1]

    if end in godan:

        pre = base[:-1]

        irow, te, nai, past, can = godan[end]

        return {

            "ok": True,

            "lemma": base,

            "verb_class": "godan",

            "confidence": 0.86,

            "forms": {

                "dictionary": base,

                "masu": f"{pre}{irow}ます",

                "te": f"{pre}{te}",

                "nai": f"{pre}{nai}",

                "past": f"{pre}{past}",

                "potential": f"{pre}{can}",

            }

        }



    return {

        "ok": False,

        "lemma": base,

        "verb_class": "unknown",

        "confidence": 0.55,

        "error": "unsupported_ending"

    }



def conjugate_verb(verb: str) -> str:

    verb = (verb or "").strip()

    if not verb:

        return "缺少 verb 参数。"

    base = _verb_lemma_from_sudachi(verb) if sudachi_dictionary is not None else verb

    info = _conjugate_forms(base)

    lines = [f"### 动词活用\n输入：{verb}"]

    if base != verb:

        lines.append(f"- 已自动词形还原: {base}")

    lines.append("")

    if not info.get("ok"):

        lines.append("- 未识别词尾，请输入辞书形（如 書く / 食べる / する）。")

        return "\n".join(lines)

    f = info.get("forms", {})

    lines += [

        f"- 类型: {info.get('verb_class', 'unknown')}",

        f"- 置信度: {float(info.get('confidence', 0.0)):.2f}",

        f"- ます形: {f.get('masu','')}",

        f"- て形: {f.get('te','')}",

        f"- ない形: {f.get('nai','')}",

        f"- 过去形: {f.get('past','')}",

        f"- 可能形: {f.get('potential','')}",

    ]

    return "\n".join(lines)



def conjugate_verb_v2(args: Dict[str, Any]) -> str:

    verb = str(args.get("verb") or args.get("word") or args.get("text") or "").strip()

    if not verb:

        return json.dumps({

            "ok": False,

            "schema_version": globals().get("PHASE2_SCHEMA_VERSION", "2.12.7"),

            "command": "ConjugateV2",

            "error": {"code": "MISSING_VERB", "message": "缺少 verb/word/text 参数。"}

        }, ensure_ascii=False)



    base = _verb_lemma_from_sudachi(verb) if sudachi_dictionary is not None else verb

    info = _conjugate_forms(base)

    payload = {

        "ok": bool(info.get("ok")),

        "schema_version": globals().get("PHASE2_SCHEMA_VERSION", "2.12.7"),

        "command": "ConjugateV2",

        "data": {

            "input": verb,

            "lemma": base,

            "verb_class": info.get("verb_class", "unknown"),

            "confidence": float(info.get("confidence", 0.0)),

            "forms": info.get("forms", {})

        }

    }

    if not info.get("ok"):

        payload["error"] = {"code": "UNSUPPORTED_ENDING", "message": str(info.get("error", "unknown"))}

    return json.dumps(payload, ensure_ascii=False)



def srs_schedule(args: Dict[str, Any]) -> str:

    try:

        quality = int(args.get("quality", 4))

    except Exception:

        quality = 4

    try:

        repetition = int(args.get("repetition", 0))

    except Exception:

        repetition = 0

    try:

        interval = int(args.get("interval", 0))

    except Exception:

        interval = 0

    try:

        easiness = float(args.get("easiness", 2.5))

    except Exception:

        easiness = 2.5



    quality = max(0, min(5, quality))



    if quality < 3:

        repetition = 0

        interval = 1

    else:

        if repetition == 0:

            interval = 1

        elif repetition == 1:

            interval = 6

        else:

            interval = round(interval * easiness)

        repetition += 1



    easiness = easiness + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))

    if easiness < 1.3:

        easiness = 1.3



    return "\n".join([

        "### SRS 复习排程（SM-2）",

        f"- 输入质量(quality): {quality}",

        f"- 下次连续记住次数: {repetition}",

        f"- 下次间隔: {interval} 天",

        f"- 新的易度因子(EF): {easiness:.2f}"

    ])



def _collect_vocab_candidates(text: str, adaptive: bool = True) -> List[Dict[str, Any]]:

    rows = sudachi_rows(text)

    candidates: List[Dict[str, Any]] = []

    seen = set()

    wrong_freq_map: Dict[str, int] = {}

    if adaptive and ENABLE_ADAPTIVE_SESSION:

        wrong_freq_map = _build_wrongbook_freq_map()



    if rows:

        for r in rows:

            pos = r.get("pos", "")

            if pos.startswith("助詞") or pos.startswith("助動詞") or pos.startswith("補助記号"):

                continue



            keys = [r.get("lemma", ""), r.get("normalized", ""), r.get("surface", "")]

            chosen_key = ""

            info = {}

            for k in keys:

                x = lexicon_lookup(k)

                if x:

                    chosen_key = k

                    info = x

                    break



            # 词典未命中时，回退为 Sudachi 内容词候选（提升召回）

            if not chosen_key:

                chosen_key = r.get("lemma") or r.get("surface") or ""

            chosen_key = str(chosen_key).strip()

            if not chosen_key or chosen_key in seen:

                continue



            if not info:

                if not any(t in pos for t in ("名詞", "動詞", "形容詞", "副詞", "連体詞")):

                    continue

                if len(chosen_key) == 1 and not re.search(r"[一-龯]", chosen_key):

                    continue

                info = {

                    "reading": r.get("reading", ""),

                    "meaning": "",

                    "pos": pos

                }



            seen.add(chosen_key)



            local_pos = str(info.get("pos", "") or "")

            if local_pos in ("助词", "助动词", "补助片段", "补助结构") or local_pos.startswith("助詞") or local_pos.startswith("助動詞"):

                continue



            score = 1.0

            if adaptive and ENABLE_ADAPTIVE_SESSION:

                score = _adaptive_score(chosen_key, wrong_freq_map)



            candidates.append({

                "word": chosen_key,

                "reading": info.get("reading", "") or r.get("reading", ""),

                "meaning": info.get("meaning", ""),

                "pos": info.get("pos", ""),

                "score": score

            })



        if candidates:

            return candidates



    tokens = fallback_segment(text)

    seen = set()

    for tok in tokens:

        if tok in seen:

            continue

        seen.add(tok)

        info = lexicon_lookup(tok)

        if not info:

            continue

        pos = info.get("pos", "")

        if pos in ("助词", "助动词", "补助片段", "补助结构"):

            continue



        score = 1.0

        if adaptive and ENABLE_ADAPTIVE_SESSION:

            score = _adaptive_score(tok, wrong_freq_map)



        candidates.append({

            "word": tok,

            "reading": info.get("reading", ""),

            "meaning": info.get("meaning", ""),

            "pos": info.get("pos", ""),

            "score": score

        })



    return candidates



def extract_vocab(text: str) -> str:

    text = (text or "").strip()

    if not text:

        return "缺少 text 参数。"



    candidates = _collect_vocab_candidates(text, adaptive=True)

    lines = [f"### 词汇提取\n原句：{text}\n", "#### 候选词汇"]



    for item in candidates:

        row = f"- {item['word']}"

        if item.get("reading"):

            row += f" ({item['reading']})"

        if item.get("meaning"):

            row += f"：{item['meaning']}"

        if item.get("pos"):

            row += f" [{item['pos']}]"

        row += f" | 复习权重:{item.get('score', 1.0):.2f}"

        lines.append(row)



    if len(lines) == 2:

        lines.append("- 未命中可学习词汇（可扩充词典）。")



    return "\n".join(lines)



def generate_quiz(text: str, quiz_mode: str = "meaning_to_word", count: int = 3, adaptive: bool = True) -> str:

    text = (text or "").strip()

    if not text:

        return "缺少 text 参数。"



    try:

        count = int(count)

    except Exception:

        count = 3

    count = max(1, min(10, count))



    candidates = _collect_vocab_candidates(text, adaptive=adaptive)

    if not candidates:

        return "未命中可出题词汇。"



    picked = _weighted_sample(candidates, min(count, len(candidates))) if adaptive else random.sample(candidates, min(count, len(candidates)))

    mode = (quiz_mode or "meaning_to_word").strip().lower()



    lines = [f"### 词汇测验\n原句：{text}\n", f"模式：{mode} | adaptive={adaptive}", ""]

    for i, item in enumerate(picked, 1):

        w = item["word"]

        r = item.get("reading") or "（无读音）"

        m = item.get("meaning") or "（无释义）"



        if mode == "reading_to_word":

            lines.append(f"{i}. 请写出这个读音对应的单词：{r}")

            lines.append(f"   参考答案：{w}")

        elif mode == "word_to_meaning":

            lines.append(f"{i}. 这个词是什么意思：{w}")

            lines.append(f"   参考答案：{m}")

        else:

            lines.append(f"{i}. 根据中文写日语单词：{m}")

            lines.append(f"   参考答案：{w}（{r}）")

    return "\n".join(lines)



def quiz_check(args: Dict[str, Any]) -> str:

    # 兼容单题与批量字段：user_answer/answer 优先，answers/user_answers 次之（取首个）

    user_answer = str(args.get("user_answer") or args.get("answer") or "").strip()

    if not user_answer:

        raw_answers = args.get("answers")

        if raw_answers is None:

            raw_answers = args.get("user_answers")

        if isinstance(raw_answers, list):

            for x in raw_answers:

                s = str(x).strip()

                if s:

                    user_answer = s

                    break

        else:

            ans_text = str(raw_answers or "").strip()

            if ans_text:

                user_answer = re.split(r"[,，]", ans_text)[0].strip()



    expected = str(args.get("expected_answer") or args.get("correct_answer") or "").strip()

    reading = str(args.get("reading") or "").strip()

    question = str(args.get("question") or "").strip()



    if not user_answer:

        return "缺少 user_answer 参数（可用 user_answer/answer/answers/user_answers）。"



    if not expected and question:

        m = re.search(r"参考答案[:：]\s*(.+)$", question)

        if m:

            expected = m.group(1).strip()

    if not expected:

        return "缺少 expected_answer/correct_answer 参数。"



    ua = normalize_text(user_answer)



    # 更严格的答案判定：不再使用子串包含，避免误判

    raw_expected = expected.strip()

    candidates_raw: List[str] = [raw_expected]



    # 兼容“词条（读音）”格式，补充一个去括号候选

    m = re.match(r"^(.+?)\s*[（(].*[）)]\s*$", raw_expected)

    if m and m.group(1).strip():

        candidates_raw.append(m.group(1).strip())



    # 兼容多答案分隔

    for sep in ["|", "/", "／", "、", ",", "，", ";", "；"]:

        parts: List[str] = []

        for c in candidates_raw:

            parts.extend([x.strip() for x in c.split(sep) if x.strip()])

        if parts:

            candidates_raw = parts



    candidates = {normalize_text(x) for x in candidates_raw if normalize_text(x)}

    is_correct = ua in candidates

    error_type = "correct" if is_correct else _infer_error_type(user_answer, expected, reading)



    quality = 5 if is_correct else 2

    lines = [

        "### 测验判题结果",

        f"- 你的答案: {user_answer}",

        f"- 参考答案: {expected}",

        f"- 判定: {'✅ 正确' if is_correct else '❌ 错误'}",

        f"- 错因标签: {error_type}",

        f"- SRS建议quality: {quality}",

    ]

    return "\n".join(lines)



def quiz_check_batch(args: Dict[str, Any]) -> str:

    """批量判题：支持 answers/user_answers 与 expected_answers/correct_answers。"""



    def _to_list(v: Any) -> List[str]:

        if isinstance(v, list):

            return [str(x).strip() for x in v if str(x).strip()]

        s = str(v or "").strip()

        if not s:

            return []

        # 优先支持 JSON 数组字符串输入，如 ["昨日","日本語","行く"]

        if s.startswith("[") and s.endswith("]"):

            try:

                arr = json.loads(s)

                if isinstance(arr, list):

                    return [str(x).strip() for x in arr if str(x).strip()]

            except Exception:

                pass

        # 回退：中英文逗号分割，并清理首尾引号

        return [x.strip().strip('"').strip("'") for x in re.split(r"[,，]", s) if x.strip().strip('"').strip("'")]



    answers = _to_list(

        args.get("answers")

        if args.get("answers") is not None

        else (args.get("user_answers") if args.get("user_answers") is not None else args.get("answer"))

    )

    expecteds = _to_list(

        args.get("expected_answers")

        if args.get("expected_answers") is not None

        else (

            args.get("correct_answers")

            if args.get("correct_answers") is not None

            else (args.get("expected_answer") if args.get("expected_answer") is not None else args.get("correct_answer"))

        )

    )

    readings = _to_list(args.get("readings"))



    if not answers:

        return "缺少 answers/user_answers 参数。"

    if not expecteds:

        return "缺少 expected_answers/correct_answers 参数。"



    total = min(len(answers), len(expecteds))

    if total <= 0:

        return "批量判题失败：可对齐题目数为0。"



    lines = ["### 批量测验判题结果", f"- 题目数: {total}"]

    score = 0

    for i in range(total):

        ua_raw = answers[i]

        ex_raw = expecteds[i]

        rd = readings[i] if i < len(readings) else ""

        item_result = quiz_check({

            "user_answer": ua_raw,

            "expected_answer": ex_raw,

            "reading": rd

        })

        ok = "✅ 正确" in item_result

        if ok:

            score += 1

        verdict = "✅" if ok else "❌"

        lines.append(f"{i+1}. {verdict} 你的答案: {ua_raw} ｜ 参考: {ex_raw}")



    lines.append(f"- 总分: {score}/{total}")

    return "\n".join(lines)



def error_explain(args: Dict[str, Any]) -> str:

    user_answer = str(args.get("user_answer") or args.get("answer") or "").strip()

    expected = str(args.get("expected_answer") or args.get("correct_answer") or "").strip()

    reading = str(args.get("reading") or "").strip()

    if not user_answer or not expected:

        return "缺少参数：请提供 user_answer 与 expected_answer。"



    et = _infer_error_type(user_answer, expected, reading)

    explain_map = {

        "blank": "你没有作答，通常是提取失败或不确定。建议先做读音确认再作答。",

        "kana_instead_of_kanji": "你写成了假名而非目标汉字词。建议做“读音→汉字”反向练习。",

        "typo": "很接近正确答案，属于拼写/输入误差。",

        "semantic_or_unknown": "可能是词义混淆、近义词误用或记忆偏差。",

        "correct": "答案正确，无需错因解释。"

    }

    drill_map = {

        "blank": "训练建议：先看题目→口头复述→再输入，降低空答率。",

        "kana_instead_of_kanji": "训练建议：同词做3组“かな→漢字”默写（间隔重复）。",

        "typo": "训练建议：该词连续正确输入3次，强化字形。",

        "semantic_or_unknown": "训练建议：对比近义词造句2组，并用 rewrite_sentence 改写一次。",

        "correct": "继续保持，可提升到更高难度题型。"

    }



    lines = [

        "### 错因解释器",

        f"- 你的答案: {user_answer}",

        f"- 参考答案: {expected}",

        f"- 归因标签: {et}",

        f"- 解释: {explain_map.get(et, '未知错因')}",

        f"- {drill_map.get(et, '')}"

    ]

    return "\n".join(lines)



def wrongbook_add(args: Dict[str, Any]) -> str:

    word = str(args.get("word") or "").strip()

    user_answer = str(args.get("user_answer") or args.get("answer") or "").strip()

    expected = str(args.get("expected_answer") or args.get("correct_answer") or "").strip()

    reading = str(args.get("reading") or "").strip()



    if not word and not expected:

        return "缺少必要参数：至少提供 word 或 expected_answer。"



    error_type = str(args.get("error_type") or "").strip()

    if not error_type:

        error_type = _infer_error_type(user_answer, expected or word, reading)



    item = {

        "word": word or expected,

        "reading": reading,

        "meaning": str(args.get("meaning") or ""),

        "user_answer": user_answer,

        "expected_answer": expected or word,

        "error_type": error_type,

        "source_sentence": str(args.get("source_sentence") or args.get("text") or ""),

        "timestamp": datetime.now().isoformat(timespec="seconds")

    }



    items = _load_wrongbook()

    items.append(item)

    _save_wrongbook(items)



    return "\n".join([

        "### 错题本已记录",

        f"- 词条: {item.get('word')}",

        f"- 错因: {item.get('error_type')}",

        f"- 当前总条目: {len(items)}"

    ])



def wrongbook_list(limit: int = 20, error_type: str = "") -> str:

    try:

        limit = int(limit)

    except Exception:

        limit = 20

    limit = max(1, min(100, limit))

    et = (error_type or "").strip()



    items = _load_wrongbook()

    if et:

        items = [x for x in items if str(x.get("error_type", "")).strip() == et]



    if not items:

        return "### 错题本\n当前为空。"



    picked = items[-limit:][::-1]

    lines = [f"### 错题本（最近 {len(picked)} 条）", ""]



    for i, it in enumerate(picked, 1):

        lines.append(f"{i}. {it.get('word', '（未提供）')} ({it.get('reading', '')})")

        lines.append(f"   - 你的答案: {it.get('user_answer', '（空）')}")

        lines.append(f"   - 参考答案: {it.get('expected_answer', '（空）')}")

        lines.append(f"   - 错因: {it.get('error_type', 'unknown')}")

        lines.append(f"   - 时间: {it.get('timestamp', '（未知时间）')}")

    return "\n".join(lines)



def wrongbook_stats() -> str:

    items = _load_wrongbook()

    if not items:

        return "### 错题本统计\n当前为空。"



    total = len(items)

    freq_word = {}

    freq_type = {}

    for it in items:

        w = str(it.get("word") or it.get("expected_answer") or "（未提供）").strip()

        t = str(it.get("error_type") or "unknown").strip()

        freq_word[w] = freq_word.get(w, 0) + 1

        freq_type[t] = freq_type.get(t, 0) + 1



    top_words = sorted(freq_word.items(), key=lambda x: x[1], reverse=True)[:5]

    top_types = sorted(freq_type.items(), key=lambda x: x[1], reverse=True)



    lines = [f"### 错题本统计", f"- 总条目: {total}", f"- 不同词条数: {len(freq_word)}", "", "高频错题 TOP5:"]

    for i, (w, c) in enumerate(top_words, 1):

        lines.append(f"{i}. {w} × {c}")



    lines.append("")

    lines.append("错因分布:")

    for t, c in top_types:

        lines.append(f"- {t}: {c}")

    return "\n".join(lines)



def _auto_wrongbook_category(item: Dict[str, Any]) -> str:

    et = normalize_text(str(item.get("error_type") or ""))

    w = str(item.get("word") or item.get("expected_answer") or "").strip()

    ua = str(item.get("user_answer") or "").strip()

    ex = str(item.get("expected_answer") or "").strip()

    sent = str(item.get("source_sentence") or "").strip()



    particle_set = {"は", "が", "を", "に", "で", "へ", "と", "も", "の", "や", "か"}

    if w in particle_set:

        return "助词"

    if any(k in et for k in ("particle", "助词", "助詞")):

        return "助词"



    if ("kana_instead_of_kanji" in et) or (re.fullmatch(r"[ぁ-んァ-ンー]+", ua or "") and re.search(r"[一-龯]", ex or "")):

        return "字形/汉字"



    if re.search(r"ば.+ほど|ないことはない|なくはない|ことになる|わけではない|ようになる|ようにする|てしまう", sent):

        return "语法"

    if any(k in et for k in ("grammar", "文法", "接续", "活用")):

        return "语法"



    return "词汇"



def wrongbook_analyze(args: Dict[str, Any]) -> str:

    try:

        days = int(args.get("days", 30))

    except Exception:

        days = 30

    days = max(1, min(365, days))



    try:

        top_n = int(args.get("top_n", 8))

    except Exception:

        top_n = 8

    top_n = max(3, min(30, top_n))



    items = _load_wrongbook()

    if not items:

        return "### 错题本深度分析\n当前错题本为空。"



    now = datetime.now()

    recent_items: List[Dict[str, Any]] = []

    cat_recent: Dict[str, int] = {}

    type_recent: Dict[str, int] = {}

    word_recent: Dict[str, int] = {}

    day_recent: Dict[str, int] = {}



    for it in items:

        ts = str(it.get("timestamp") or "").strip()

        dt = None

        if ts:

            try:

                dt = datetime.fromisoformat(ts)

            except Exception:

                dt = None



        is_recent = (dt is None) or ((now - dt).days <= days)

        if not is_recent:

            continue



        recent_items.append(it)

        cat = _auto_wrongbook_category(it)

        cat_recent[cat] = cat_recent.get(cat, 0) + 1

        et = str(it.get("error_type") or "unknown").strip() or "unknown"

        type_recent[et] = type_recent.get(et, 0) + 1

        w = str(it.get("word") or it.get("expected_answer") or "").strip()

        if w:

            word_recent[w] = word_recent.get(w, 0) + 1

        if dt:

            key = dt.date().isoformat()

            day_recent[key] = day_recent.get(key, 0) + 1



    top_words = sorted(word_recent.items(), key=lambda x: x[1], reverse=True)[:top_n]

    top_types = sorted(type_recent.items(), key=lambda x: x[1], reverse=True)[:top_n]

    top_cats = sorted(cat_recent.items(), key=lambda x: x[1], reverse=True)



    lines = [

        "### 错题本深度分析",

        f"- 总错题: {len(items)}",

        f"- 统计窗口: 最近 {days} 天",

        f"- 窗口内错题: {len(recent_items)}",

        ""

    ]



    lines.append("#### 自动分类分布（窗口内）")

    if top_cats:

        for c, n in top_cats:

            lines.append(f"- {c}: {n}")

    else:

        lines.append("- 暂无数据")



    lines.append("")

    lines.append("#### 高频错因（窗口内）")

    if top_types:

        for i, (t, n) in enumerate(top_types, 1):

            lines.append(f"{i}. {t}: {n}")

    else:

        lines.append("- 暂无数据")



    lines.append("")

    lines.append(f"#### 高频错词 TOP{top_n}（窗口内）")

    if top_words:

        for i, (w, n) in enumerate(top_words, 1):

            lv = lookup_jlpt_for_word(w) or "未知"

            lines.append(f"{i}. {w} [{lv}] × {n}")

    else:

        lines.append("- 暂无数据")



    lines.append("")

    lines.append("#### 近7天趋势")

    for d in sorted(day_recent.keys())[-7:]:

        lines.append(f"- {d}: {day_recent[d]}")



    lines.append("")

    lines.append("#### 结论")

    if top_cats:

        lines.append(f"- 当前主导薄弱面: {top_cats[0][0]}")

    if top_words:

        lines.append(f"- 优先修复词: {', '.join([w for w, _ in top_words[:3]])}")

    lines.append("- 建议搭配命令: wrongbook_recommend 获取定制训练方案。")

    return "\n".join(lines)



def wrongbook_recommend(args: Dict[str, Any]) -> str:

    try:

        days = int(args.get("days", 30))

    except Exception:

        days = 30

    days = max(1, min(365, days))



    try:

        focus_count = int(args.get("focus_count", 5))

    except Exception:

        focus_count = 5

    focus_count = max(3, min(12, focus_count))



    items = _load_wrongbook()

    if not items:

        return "### 错题本训练建议\n当前错题本为空，建议先进行 quiz_check / study_session_submit 产生样本。"



    now = datetime.now()

    recent = []

    for it in items:

        ts = str(it.get("timestamp") or "").strip()

        dt = None

        if ts:

            try:

                dt = datetime.fromisoformat(ts)

            except Exception:

                dt = None

        if (dt is None) or ((now - dt).days <= days):

            recent.append(it)

    base = recent if recent else items



    cat_count: Dict[str, int] = {}

    word_count: Dict[str, int] = {}

    for it in base:

        cat = _auto_wrongbook_category(it)

        cat_count[cat] = cat_count.get(cat, 0) + 1

        w = str(it.get("word") or it.get("expected_answer") or "").strip()

        if w:

            word_count[w] = word_count.get(w, 0) + 1



    top_cat = sorted(cat_count.items(), key=lambda x: x[1], reverse=True)[0][0] if cat_count else "词汇"

    top_words = sorted(word_count.items(), key=lambda x: x[1], reverse=True)[:focus_count]



    lines = [

        "### 错题本定制训练建议",

        f"- 统计窗口: 最近 {days} 天",

        f"- 主导薄弱面: {top_cat}",

        f"- 重点词数: {len(top_words)}",

        "",

        "#### 今日训练清单"

    ]



    if top_words:

        for i, (w, n) in enumerate(top_words, 1):

            lv = lookup_jlpt_for_word(w) or "未知"

            lines.append(f"{i}. {w} [{lv}]（近窗错{n}次）")

    else:

        lines.append("- 暂无高频词，建议扩大样本。")



    lines.append("")

    lines.append("#### 训练策略")

    if top_cat == "助词":

        lines.append("- 先对错句执行 particle_check，定位助词冲突。")

        lines.append("- 每个高频词造 2 句：一个正确句、一个对比错误句并自纠。")

    elif top_cat == "字形/汉字":

        lines.append("- 使用 add_furigana 做读音确认，再做“读音→汉字”反向默写。")

        lines.append("- 对高频词执行 kanji_lookup，拆解核心汉字记忆。")

    elif top_cat == "语法":

        lines.append("- 对高频错句执行 grammar_explain_deep，聚焦接续与易错点。")

        lines.append("- 每个语法做 3 句变体：肯定/否定/疑问。")

    else:

        lines.append("- 对高频词执行 lookup_word + rewrite_sentence，强化语义与搭配。")

        lines.append("- 用 quiz_generate(word_to_meaning) 做短测回灌。")



    lines.append("")

    lines.append("#### 推荐命令模板")

    lines.append("- command=wrongbook_analyze, days=30")

    lines.append("- command=quiz_generate, text=..., quiz_mode=word_to_meaning, count=5")

    lines.append("- command=review_due_list, mode=due, limit=30")

    lines.append("- command=review_submit, word=..., result=记住/模糊/忘记")

    return "\n".join(lines)



def wrongbook_clear(confirm: str = "") -> str:

    token = str(confirm or "").strip().lower()

    if token not in ("yes", "y", "true", "1", "confirm"):

        return "为防误操作，请传入 confirm=yes 后再执行清空。"

    _save_wrongbook([])

    return "### 错题本已清空\n当前总条目: 0"



def _load_sessions() -> Dict[str, Any]:

    data = _load_json(SESSION_PATH, {})

    return data if isinstance(data, dict) else {}



def _save_sessions(sessions: Dict[str, Any]) -> None:

    _save_json(SESSION_PATH, sessions)



def _load_review_state() -> Dict[str, Any]:

    data = _load_json(REVIEW_STATE_PATH, {})

    if not isinstance(data, dict):

        return {"cards": {}}

    cards = data.get("cards", {})

    if not isinstance(cards, dict):

        cards = {}

    return {"cards": cards}



def _save_review_state(state: Dict[str, Any]) -> None:

    if not isinstance(state, dict):

        state = {"cards": {}}

    cards = state.get("cards", {})

    if not isinstance(cards, dict):

        cards = {}

    _save_json(REVIEW_STATE_PATH, {"cards": cards})



def _load_review_log() -> List[Dict[str, Any]]:

    data = _load_json(REVIEW_LOG_PATH, [])

    if not isinstance(data, list):

        return []

    out: List[Dict[str, Any]] = []

    for it in data:

        if isinstance(it, dict):

            out.append({

                "word": str(it.get("word", "")),

                "grade": int(it.get("grade", 0) or 0),

                "result": str(it.get("result", "")),

                "timestamp": str(it.get("timestamp", "")),

                "correct": bool(it.get("correct", False)),

            })

    return out



def _save_review_log(items: List[Dict[str, Any]]) -> None:

    _save_json(REVIEW_LOG_PATH, items)



def _result_to_grade(result_text: str, default_grade: int = 3) -> int:

    r = normalize_text(result_text)

    if r in ("记住", "记得", "remembered", "easy", "good"):

        return 4

    if r in ("模糊", "一般", "fuzzy", "hard"):

        return 3

    if r in ("忘记", "忘了", "forgot", "again", "fail"):

        return 1

    try:

        g = int(default_grade)

    except Exception:

        g = 3

    return max(0, min(5, g))



def study_session_start(args: Dict[str, Any]) -> str:

    text = str(args.get("text") or args.get("sentence") or args.get("content") or args.get("source_text") or "").strip()

    if not text:

        return "缺少 text 参数。"



    try:

        count = int(args.get("count", 3))

    except Exception:

        count = 3

    count = max(1, min(10, count))



    adaptive = as_bool(args.get("adaptive"), ENABLE_ADAPTIVE_SESSION)

    candidates = _collect_vocab_candidates(text, adaptive=adaptive)

    if not candidates:

        return "未命中可学习词汇。"



    # P3: JLPT 难度过滤 + 停用词过滤 + 可选仅保留有释义词

    min_jlpt = str(args.get("min_jlpt") or args.get("jlpt_min") or "").strip().upper()

    max_jlpt = str(args.get("max_jlpt") or args.get("jlpt_max") or "").strip().upper()

    allow_unknown = as_bool(args.get("allow_unknown"), False)

    require_meaning = as_bool(args.get("require_meaning"), False)

    exclude_stopwords = as_bool(args.get("exclude_stopwords"), True)



    ex_raw = args.get("exclude_words", [])

    if isinstance(ex_raw, str):

        ex_words = {x.strip() for x in re.split(r"[,，]", ex_raw) if x.strip()}

    elif isinstance(ex_raw, list):

        ex_words = {str(x).strip() for x in ex_raw if str(x).strip()}

    else:

        ex_words = set()



    if exclude_stopwords:

        ex_words |= SESSION_STOPWORDS



    filtered = []

    min_h = _jlpt_hardness(min_jlpt) if min_jlpt else 0

    max_h = _jlpt_hardness(max_jlpt) if max_jlpt else 999

    filter_stats = {

        "total": len(candidates),

        "excluded_empty_word": 0,

        "excluded_by_words": 0,

        "excluded_by_meaning": 0,

        "excluded_by_jlpt_range": 0,

        "excluded_by_unknown": 0,

        "passed": 0

    }



    for it in candidates:

        w = str(it.get("word") or "").strip()

        if not w:

            filter_stats["excluded_empty_word"] += 1

            continue

        if w in ex_words:

            filter_stats["excluded_by_words"] += 1

            continue

        if require_meaning and not str(it.get("meaning") or "").strip():

            filter_stats["excluded_by_meaning"] += 1

            continue



        lv = lookup_jlpt_for_word(w)

        if lv:

            h = _jlpt_hardness(lv)

            if h and (h < min_h or h > max_h):

                filter_stats["excluded_by_jlpt_range"] += 1

                continue

        else:

            if (min_jlpt or max_jlpt) and not allow_unknown:

                filter_stats["excluded_by_unknown"] += 1

                continue



        filtered.append(it)

        filter_stats["passed"] += 1



    # 严格应用过滤结果：即使为空也不回退到原候选，避免“过滤参数形同虚设”

    candidates = filtered



    if not candidates:

        return (

            "过滤后无可学习词汇。可放宽 JLPT 范围、允许 unknown，或关闭 require_meaning。"

            f"\n过滤统计: total={filter_stats['total']}, passed={filter_stats['passed']}, "

            f"excluded_by_words={filter_stats['excluded_by_words']}, "

            f"excluded_by_meaning={filter_stats['excluded_by_meaning']}, "

            f"excluded_by_jlpt_range={filter_stats['excluded_by_jlpt_range']}, "

            f"excluded_by_unknown={filter_stats['excluded_by_unknown']}"

        )



    # 有释义优先，避免“纯词形”题过多

    candidates = sorted(

        candidates,

        key=lambda x: (0 if str(x.get("meaning") or "").strip() else 1, -len(str(x.get("word") or "")))

    )



    picked = _weighted_sample(candidates, min(count, len(candidates))) if adaptive else random.sample(candidates, min(count, len(candidates)))

    session_id = uuid.uuid4().hex[:8]



    sessions = _load_sessions()

    sessions[session_id] = {

        "created_at": datetime.now().isoformat(timespec="seconds"),

        "source_text": text,

        "adaptive": adaptive,

        "items": picked

    }

    _save_sessions(sessions)



    lines = [

        "### 学习会话已创建",

        f"- session_id: {session_id}",

        f"- adaptive: {adaptive}",

        f"- 题目数: {len(picked)}",

        f"- jlpt_filter: {min_jlpt or 'N5'} ~ {max_jlpt or 'N1'}",

        f"- allow_unknown: {allow_unknown}",

        f"- require_meaning: {require_meaning}",

        f"- exclude_stopwords: {exclude_stopwords}",

        f"- filter_stats: total={filter_stats['total']}, passed={filter_stats['passed']}, by_words={filter_stats['excluded_by_words']}, by_meaning={filter_stats['excluded_by_meaning']}, by_jlpt={filter_stats['excluded_by_jlpt_range']}, by_unknown={filter_stats['excluded_by_unknown']}",

        "",

        "请按顺序作答（逗号分隔）:"

    ]

    for i, it in enumerate(picked, 1):

        hint = it.get('meaning') or (f"读音：{it.get('reading')}" if it.get('reading') else f"词形：{it.get('word')}")

        lines.append(f"{i}. 根据提示写日语：{hint}")

    return "\n".join(lines)



def study_session_submit(args: Dict[str, Any]) -> str:

    session_id = str(args.get("session_id") or "").strip()

    if not session_id:

        return "缺少 session_id 参数。"



    raw_answers = args.get("answers")

    if isinstance(raw_answers, list):

        user_answers = [str(x).strip() for x in raw_answers if str(x).strip()]

    else:

        ans_text = str(raw_answers or "").strip()

        if not ans_text:

            return "缺少 answers 参数。"

        user_answers = [x.strip() for x in re.split(r"[,，]", ans_text) if x.strip()]



    sessions = _load_sessions()

    sess = sessions.get(session_id)

    if not sess:

        return "session_id 不存在或已过期。"



    items = sess.get("items", [])

    total = len(items)

    if total == 0:

        return "该会话没有可用题目。"



    score = 0

    wrong_count = 0

    wrong_entries: List[Dict[str, Any]] = []

    review_updates: List[Dict[str, Any]] = []

    lines = [f"### 学习会话提交结果", f"- session_id: {session_id}", ""]



    for idx, item in enumerate(items, 1):

        expected = str(item.get("word") or "").strip()

        reading = str(item.get("reading") or "").strip()

        meaning = str(item.get("meaning") or "").strip()

        ua = user_answers[idx - 1] if idx - 1 < len(user_answers) else ""



        ok = normalize_text(ua) == normalize_text(expected)

        grade = 5 if ok else 2

        review_updates.append({

            "word": expected,

            "grade": grade,

            "source": "study_session_submit"

        })

        if ok:

            score += 1

        else:

            wrong_count += 1

            et = _infer_error_type(ua, expected, reading)

            wrong_entries.append({

                "word": expected,

                "reading": reading,

                "meaning": meaning,

                "user_answer": ua,

                "expected_answer": expected,

                "error_type": et,

                "source_sentence": sess.get("source_text", ""),

                "timestamp": datetime.now().isoformat(timespec="seconds")

            })



        lines.append(f"{idx}. 你的答案: {ua or '（空）'} ｜ 正确: {expected}（{reading}）｜ {'✅' if ok else '❌'}")



    sessions.pop(session_id, None)

    _save_sessions(sessions)



    if wrong_entries:

        wb_items = _load_wrongbook()

        wb_items.extend(wrong_entries)

        _save_wrongbook(wb_items)



    review_state = _load_review_state()

    cards = review_state.get("cards", {})

    if not isinstance(cards, dict):

        cards = {}

    for ru in review_updates:

        _update_review_card_sm2(

            cards,

            str(ru.get("word") or ""),

            int(ru.get("grade", 3)),

            str(ru.get("source") or "study_session_submit")

        )

    review_state["cards"] = cards

    _save_review_state(review_state)



    lines.append("")

    lines.append(f"总分: {score}/{total}")

    lines.append(f"错题数: {wrong_count}")

    return "\n".join(lines)



def _update_review_card_sm2(cards: Dict[str, Any], word: str, grade: int, source: str = "") -> None:

    word = str(word or "").strip()

    if not word:

        return



    try:

        grade = int(grade)

    except Exception:

        grade = 3

    grade = max(0, min(5, grade))



    card = cards.get(word, {})

    if not isinstance(card, dict):

        card = {}



    reps = int(card.get("reps", 0) or 0)

    interval = int(card.get("interval", 0) or 0)

    ease = float(card.get("ease", 2.5) or 2.5)



    if grade < 3:

        reps = 0

        interval = 1

    else:

        if reps == 0:

            interval = 1

        elif reps == 1:

            interval = 6

        else:

            interval = max(1, int(round(interval * ease)))

        reps += 1



    ease = ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02))

    if ease < 1.3:

        ease = 1.3



    due_dt = datetime.now() + timedelta(days=interval)

    card["reps"] = reps

    card["interval"] = interval

    card["ease"] = round(ease, 4)

    card["last_grade"] = grade

    card["last_review"] = datetime.now().isoformat(timespec="seconds")

    card["due_at"] = due_dt.isoformat(timespec="seconds")

    if source:

        card["source"] = source



    cards[word] = card

def review_due_list(args: Dict[str, Any]) -> str:

    try:

        limit = int(args.get("limit", 30))

    except Exception:

        limit = 30

    limit = max(1, min(200, limit))



    mode = str(args.get("mode") or "due").strip().lower()

    if mode not in ("due", "upcoming", "all"):

        mode = "due"



    try:

        window_days = int(args.get("window_days", 1))

    except Exception:

        window_days = 1

    window_days = max(1, min(365, window_days))



    state = _load_review_state()

    cards = state.get("cards", {})

    if not isinstance(cards, dict):

        cards = {}



    now = datetime.now()

    window_end = now + timedelta(days=window_days)



    picked_rows = []

    for word, card in cards.items():

        if not isinstance(card, dict):

            continue



        due_at = str(card.get("due_at", "")).strip()

        try:

            due_dt = datetime.fromisoformat(due_at) if due_at else now

        except Exception:

            due_dt = now



        is_due = due_dt <= now

        is_upcoming = (due_dt > now) and (due_dt <= window_end)



        if mode == "all":

            matched = True

        elif mode == "upcoming":

            matched = is_upcoming

        else:

            matched = is_due



        if matched:

            picked_rows.append((word, card, due_dt, is_due, is_upcoming))



    picked_rows.sort(key=lambda x: x[2])

    showing = picked_rows[:limit]



    lines = [

        "### 待复习列表",

        f"- mode: {mode}",

        f"- window_days: {window_days}",

        f"- now: {now.isoformat(timespec='seconds')}",

        f"- matched_count: {len(picked_rows)}",

        f"- showing: {len(showing)}",

        ""

    ]



    for i, (w, c, d, is_due, is_upcoming) in enumerate(showing, 1):

        status = "due" if is_due else ("upcoming" if is_upcoming else "future")

        lines.append(f"{i}. {w}")

        lines.append(f" - status: {status}")

        lines.append(f" - due_at: {d.isoformat(timespec='seconds')}")

        lines.append(f" - interval: {c.get('interval', 1)}")

        lines.append(f" - ease: {c.get('ease', 2.5)}")

        lines.append(f" - reps: {c.get('reps', 0)}")

        if c.get("source"):

            lines.append(f" - source: {c.get('source')}")



    if not showing:

        if mode == "due":

            lines.append("- 当前没有到期卡片。")

        elif mode == "upcoming":

            lines.append(f"- 当前未来 {window_days} 天没有即将到期卡片。")

        else:

            lines.append("- 当前没有复习卡片。")



    return "\n".join(lines)



def lexicon_add(args: Dict[str, Any]) -> str:

    word = str(args.get("word") or args.get("surface") or "").strip()

    if not word:

        return "缺少 word 参数。"



    reading = str(args.get("reading") or "")

    meaning = str(args.get("meaning") or args.get("meaning_zh") or "")

    pos = str(args.get("pos") or "").strip()

    # P2: 未提供词性时自动推断，降低录词心智负担

    if not pos:

        if re.search(r"(する|くる|来る|行く|いく|[うくぐすつぬぶむる])$", word):

            pos = "动词"

        elif re.search(r"い$", word):

            pos = "形容词"

        else:

            pos = "名词"

    jlpt = str(args.get("jlpt") or "").strip()

    target = str(args.get("lexicon") or args.get("scope") or "user").strip().lower()

    tags_raw = args.get("tags", [])

    if isinstance(tags_raw, str):

        tags = [x.strip() for x in re.split(r"[,，]", tags_raw) if x.strip()]

    elif isinstance(tags_raw, list):

        tags = [str(x).strip() for x in tags_raw if str(x).strip()]

    else:

        tags = []



    item = {"reading": reading, "meaning": meaning, "pos": pos, "jlpt": jlpt, "tags": tags}



    if target == "domain":

        DOMAIN_LEXICON[word] = item

        _save_lexicon_file(DOMAIN_LEXICON_PATH, DOMAIN_LEXICON)

        _build_local_index()

        return f"已写入 DOMAIN 词典: {word}"

    else:

        USER_LEXICON[word] = item

        _save_lexicon_file(USER_LEXICON_PATH, USER_LEXICON)

        _build_local_index()

        return f"已写入 USER 词典: {word}"



def lexicon_list(args: Dict[str, Any]) -> str:

    target = str(args.get("lexicon") or args.get("scope") or "all").strip().lower()

    try:

        limit = int(args.get("limit", 50))

    except Exception:

        limit = 50

    limit = max(1, min(200, limit))



    items: List[Tuple[str, Dict[str, Any], str]] = []

    if target in ("all", "user"):

        for k, v in USER_LEXICON.items():

            items.append((k, v, "user"))

    if target in ("all", "domain"):

        for k, v in DOMAIN_LEXICON.items():

            items.append((k, v, "domain"))



    if not items:

        return "词典为空。"



    picked = items[:limit]

    lines = [f"### 词典列表 ({target})", f"- total: {len(items)}", f"- showing: {len(picked)}", ""]

    for i, (w, v, src) in enumerate(picked, 1):

        lines.append(f"{i}. {w} ({src})")

        lines.append(f"   - reading: {v.get('reading', '')}")

        lines.append(f"   - meaning: {v.get('meaning', '')}")

        lines.append(f"   - pos: {v.get('pos', '')}")

        tg = v.get("tags", [])

        if tg:

            lines.append(f"   - tags: {tg}")

    return "\n".join(lines)



def lexicon_reload() -> str:

    u, d = reload_lexicons()

    return f"词典已重载：user={u}, domain={d}"



# [JLPT_PHASE3_PATCH]

def jlpt_stats() -> str:

    plugin_dir = globals().get("PLUGIN_DIR", os.path.dirname(os.path.abspath(__file__)))

    db_path = os.environ.get(

        "GRAMMAR_FULL_DB_PATH",

        os.path.join(plugin_dir, "data", "db", "jdict_full.sqlite"),

    )

    if not os.path.exists(db_path):

        return f"JLPT stats: DB not found: {db_path}"



    try:

        conn = sqlite3.connect(db_path, timeout=5.0)

        cur = conn.cursor()



        total = cur.execute("SELECT COUNT(1) FROM jlpt_lex").fetchone()[0]



        lines = ["### JLPT 词库统计", f"- db_path: {db_path}", f"- jlpt_lex_total: {total}", ""]



        rows = cur.execute(

            """

            SELECT COALESCE(source_repo,''), COALESCE(license,''), COALESCE(confidence,''), COUNT(1)

            FROM jlpt_lex

            GROUP BY 1,2,3

            ORDER BY COUNT(1) DESC

            """

        ).fetchall()

        lines.append("[来源/许可/置信度]")

        for r in rows:

            lines.append(f"- source_repo={r[0]} | license={r[1]} | confidence={r[2]} | rows={r[3]}")



        lines.append("")

        lv = cur.execute(

            """

            SELECT COALESCE(level,''), COUNT(1)

            FROM jlpt_lex

            GROUP BY COALESCE(level,'')

            ORDER BY level

            """

        ).fetchall()

        lines.append("[等级分布]")

        for l, n in lv:

            lines.append(f"- {l or '(empty)'}: {n}")



        conn.close()

        return "\n".join(lines)

    except Exception as e:

        return f"JLPT stats error: {e}"



def health_check() -> str:

    req_ok = requests is not None

    sudachi_import_ok = sudachi_dictionary is not None and sudachi_tokenizer is not None

    sudachi_tagger_ok = _get_sudachi_tagger() is not None

    user_lex_exists = os.path.exists(USER_LEXICON_PATH)

    domain_lex_exists = os.path.exists(DOMAIN_LEXICON_PATH)

    wrongbook_exists = os.path.exists(WRONGBOOK_PATH)

    session_exists = os.path.exists(SESSION_PATH)

    review_state_exists = os.path.exists(REVIEW_STATE_PATH)



    lines = [

        "### JapaneseHelper 健康检查",

        f"- requests: {'OK' if req_ok else 'MISSING'}",

        f"- SudachiPy import: {'OK' if sudachi_import_ok else 'MISSING'}",

        f"- Sudachi tokenizer init: {'OK' if sudachi_tagger_ok else 'FAILED'}",

        f"- janome import: {'OK' if janome_tokenizer_cls is not None else 'MISSING'}",

        f"- janome tokenizer init: {'OK' if _get_janome_tokenizer() is not None else 'FAILED'}",

        f"- spacy import: {'OK' if spacy is not None else 'MISSING'}",

        f"- ginza package import: {'OK' if ginza_pkg is not None else 'MISSING'}",

        f"- ginza parser init: {'OK' if _get_ginza_nlp() is not None else 'FAILED'}",

        f"- ginza last error: {globals().get('_GINZA_LAST_ERROR', '') or '-'}",

        f"- pykakasi import: {'OK' if pykakasi_kakasi is not None else 'MISSING'}",

        f"- cutlet import: {'OK' if cutlet_pkg is not None else 'MISSING'}",

        f"- analyze-desumasu-dearu import: {'OK' if add_style_pkg is not None else 'MISSING'}",

        f"- ja_sentence_segmenter import: {'OK' if ja_sentence_segmenter_pkg is not None else 'MISSING'}",

        f"- Sudachi split mode: {SUDACHI_SPLIT_MODE}",

        f"- USER_LEXICON: {USER_LEXICON_PATH} ({len(USER_LEXICON)} entries, exists={user_lex_exists})",

        f"- DOMAIN_LEXICON: {DOMAIN_LEXICON_PATH} ({len(DOMAIN_LEXICON)} entries, exists={domain_lex_exists})",

        f"- WRONGBOOK: {WRONGBOOK_PATH} (exists={wrongbook_exists})",

        f"- STUDY_SESSION: {SESSION_PATH} (exists={session_exists})",

        f"- REVIEW_STATE: {REVIEW_STATE_PATH} (exists={review_state_exists})",

        f"- Adaptive session: {ENABLE_ADAPTIVE_SESSION}",

        "",

        "#### External resources",

        f"- grammar_ext_loaded: {EXTERNAL_RESOURCE_STATUS.get('grammar_ext_count', 0)}",

        f"- pitch_ext_loaded: {EXTERNAL_RESOURCE_STATUS.get('pitch_ext_count', 0)}",

        f"- jmdict_entries: {EXTERNAL_RESOURCE_STATUS.get('jmdict_count', 0)}",

        f"- kanjidic_entries: {EXTERNAL_RESOURCE_STATUS.get('kanjidic_count', 0)}",

        f"- OJAD_API_ENDPOINT: {'configured' if str(os.environ.get('OJAD_API_ENDPOINT', '')).strip() else 'not_configured'}",

        f"- OJAD_TIMEOUT_SEC: {os.environ.get('OJAD_TIMEOUT_SEC', '1.8')}", 

        "",

        "#### Online Cache / Timeout / CircuitBreaker",

        f"- ONLINE_DICT_TIMEOUT: {ONLINE_DICT_TIMEOUT}",

        f"- ONLINE_DICT_GLOBAL_TIMEOUT: {ONLINE_DICT_GLOBAL_TIMEOUT}",

        f"- ONLINE_DICT_RETRY: {ONLINE_DICT_RETRY}",

        f"- ONLINE_DICT_BACKOFF_BASE_SEC: {ONLINE_DICT_BACKOFF_BASE_SEC}",

        f"- ONLINE_DICT_BACKOFF_MAX_SEC: {ONLINE_DICT_BACKOFF_MAX_SEC}",

        f"- ONLINE_CACHE_TTL_SEC: {ONLINE_CACHE_TTL_SEC}",

        f"- ONLINE_CACHE_STALE_IF_ERROR_SEC: {ONLINE_CACHE_STALE_IF_ERROR_SEC}",

        f"- ONLINE_CACHE_MAX_ITEMS: {ONLINE_CACHE_MAX_ITEMS}",

        f"- ONLINE_CACHE_FLUSH_INTERVAL_SEC: {ONLINE_CACHE_FLUSH_INTERVAL_SEC}",

        f"- ONLINE_PROVIDER_CB_FAIL_THRESHOLD: {ONLINE_PROVIDER_CB_FAIL_THRESHOLD}",

        f"- ONLINE_PROVIDER_CB_COOLDOWN_SEC: {ONLINE_PROVIDER_CB_COOLDOWN_SEC}",

        f"- ONLINE_PROVIDER_CB_HALFOPEN_PROB: {ONLINE_PROVIDER_CB_HALFOPEN_PROB}",

f"- ONLINE_PROVIDER_STATE_FLUSH_INTERVAL_SEC: {PROVIDER_STATE_FLUSH_INTERVAL_SEC}",

        "",

        "#### Runtime metrics",

        f"- cache_hit_fresh: {ONLINE_METRICS.get('cache_hit_fresh', 0)}",

        f"- cache_hit_stale: {ONLINE_METRICS.get('cache_hit_stale', 0)}",

        f"- cache_miss: {ONLINE_METRICS.get('cache_miss', 0)}",

        f"- stale_if_error_served: {ONLINE_METRICS.get('stale_if_error_served', 0)}",

        f"- global_timeout_hits: {ONLINE_METRICS.get('global_timeout_hits', 0)}",

        f"- provider_blocked: {ONLINE_METRICS.get('provider_blocked', 0)}",

        f"- provider_halfopen_probe: {ONLINE_METRICS.get('provider_halfopen_probe', 0)}",

        f"- provider_circuit_opened: {ONLINE_METRICS.get('provider_circuit_opened', 0)}",

        "",

        "#### Provider states"

    ]



    if PROVIDER_CIRCUIT_STATE:

        now = _now_ts()

        for p, st in PROVIDER_CIRCUIT_STATE.items():

            open_until = float(st.get("open_until", 0.0) or 0.0)

            remain = max(0.0, open_until - now)

            lines.append(

                f"- {p}: fail_count={int(st.get('fail_count',0))}, open_for={remain:.2f}s"

            )

    else:

        lines.append("- (empty)")



    return "\n".join(lines)



def particle_check(text: str) -> str:

    text = (text or "").strip()

    if not text:

        return "缺少 text 参数。"



    issues: List[Dict[str, str]] = []



    # 规则1：移动动词前常用「に/へ」，而不是「を」

    if re.search(r"を\s*(行く|いく|行きます|いきます|来る|くる|来ます|きます|帰る|かえる|帰ります|かえります|向かう|むかう|向かいます|むかいます)", text):

        issues.append({

            "rule": "movement_destination",

            "message": "检测到「を + 移动动词」，通常目的地更常用「に/へ」。",

            "suggestion": "例：学校を行く → 学校に行く"

        })



    # 规则2：存在句「〜でいる/ある」常见为场所「に」

    if re.search(r"で(いる|います|ある|あります)", text):

        issues.append({

            "rule": "existence_location",

            "message": "检测到存在表达「でいる/ある」，很多语境下场所助词应优先考虑「に」。",

            "suggestion": "例：教室でいます → 教室にいます"

        })



    # 规则3：时间点常用「に」（但有省略/例外）

    if re.search(r"(今日|明日|昨日|[0-9０-９]+時|[0-9０-９]+日|[0-9０-９]+月)で", text):

        issues.append({

            "rule": "time_particle",

            "message": "时间点后出现「で」，请确认是否应使用「に」。",

            "suggestion": "例：3時で会う → 3時に会う"

        })



    # 规则4：他动词宾语常用「を」

    if re.search(r"(映画|本|ご飯|日本語|テレビ)が(見る|見ます|読|食べる|食べます|勉強する|勉強します)", text):

        issues.append({

            "rule": "transitive_object",

            "message": "检测到典型宾语 + 「が」+ 他动词结构，可能应改为「を」。",

            "suggestion": "例：映画が見ます → 映画を見ます"

        })



    lines = [f"### 助词检查\n原句：{text}\n"]

    if not issues:

        lines.append("未发现明显助词问题（仅基于启发式规则，仍建议结合语境复核）。")

        return "\n".join(lines)



    lines.append("#### 可能问题")

    for i, it in enumerate(issues, 1):

        lines.append(f"{i}. [{it['rule']}] {it['message']}")

        lines.append(f"   - 建议：{it['suggestion']}")



    lines.append("\n#### 说明")

    lines.append("- 本功能为规则启发式检查，不替代完整语法判定。")

    lines.append("- 若句子为口语、省略句、引用句，可能出现“可疑但可接受”的情况。")

    return "\n".join(lines)



def rewrite_sentence(text: str, style: str = "polite") -> str:

    text = (text or "").strip()

    style = (style or "polite").strip().lower()

    if not text:

        return "缺少 text 参数。"



    out = text



    # 先做常见病句修正（与风格无关）

    out = re.sub(

        r"([一-龯ぁ-んァ-ンーA-Za-z0-9]+)を\s*(行く|いく|行きます|いきます|来る|くる|来ます|きます|帰る|かえる|帰ります|かえります|向かう|むかう|向かいます|むかいます)",

        lambda m: f"{m.group(1)}に{m.group(2)}",

        out

    )

    out = re.sub(

        r"(映画|本|ご飯|日本語|テレビ)が\s*(見る|見ます|読む|読みます|食べる|食べます|勉強する|勉強します)",

        lambda m: f"{m.group(1)}を{m.group(2)}",

        out

    )



    if style in ("polite", "teinei", "敬体"):

        rules = [

            (r"である", "です"),

            (r"だ。?$", "です。"),

            (r"する", "します"),

            (r"した", "しました"),

            (r"いる", "います"),

            (r"ある", "あります"),

            (r"行く", "行きます"),

            (r"来る", "来ます"),

            (r"食べる", "食べます"),

            (r"見る", "見ます"),

            (r"読む", "読みます"),

            (r"勉強する", "勉強します"),

        ]

        for p, rpl in rules:

            out = re.sub(p, rpl, out)



    elif style in ("plain", "casual", "普通体", "简体"):

        rules = [

            (r"です。?$", "だ。"),

            (r"でした", "だった"),

            (r"します", "する"),

            (r"しました", "した"),

            (r"います", "いる"),

            (r"ありました", "あった"),

            (r"あります", "ある"),

            (r"行きます", "行く"),

            (r"来ます", "来る"),

            (r"食べます", "食べる"),

            (r"見ます", "見る"),

            (r"読みます", "読む"),

        ]

        for p, rpl in rules:

            out = re.sub(p, rpl, out)



    elif style in ("written", "formal", "书面"):

        rules = [

            (r"けど", "が"),

            (r"でも", "しかし"),

            (r"すごく", "非常に"),

            (r"ちょっと", "やや"),

        ]

        for p, rpl in rules:

            out = re.sub(p, rpl, out)

    else:

        return "不支持的 style。可用：polite | plain | written"



    return "\n".join([

        "### 句子改写",

        f"- 风格: {style}",

        f"- 原句: {text}",

        f"- 改写: {out}",

        "",

        "提示：规则改写可能不完全自然，建议再用 analyze_sentence/grammar_explain 复核。"

    ])



def phrase_pattern(word: str) -> str:

    text = (word or "").strip()

    if not text:

        return "缺少 word/text 参数。"



    pattern_rules = [

        {

            "id": "ba_hodo",

            "regex": r"ば.+ほど",

            "title": "〜ば〜ほど",

            "jlpt": "N2",

            "register": "中性（口语/书面均可）",

            "meaning": "越…越…",

            "explain": "前项条件变化会带来后项程度的相应变化。",

            "examples": [

                "勉強すればするほど面白くなる。",

                "読めば読むほど分からなくなる部分もある。",

                "練習すればするほど上手になる。"

            ],

            "errors": [

                "× 勉強するばするほど（接续错误）",

                "× ばほど（缺少对应前项）"

            ],

            "source": "builtin"

        },

        {

            "id": "nai_koto_wa_nai",

            "regex": r"ないことはない|なくはない",

            "title": "〜ないことはない / 〜なくはない",

            "jlpt": "N3",

            "register": "口语/书面（委婉）",

            "meaning": "并非不…；也不是完全不…（双重否定，委婉肯定）",

            "explain": "表达“可以说是…，但保留态度”的中间立场。",

            "examples": [

                "行かないことはないが、今日は忙しい。",

                "この案が悪くはない。",

                "食べられなくはないけど、好きではない。"

            ],

            "errors": [

                "将其误解为强否定（实际多为弱肯定）",

                "与 〜わけではない 混用导致语气失真"

            ],

            "source": "builtin"

        },

        {

            "id": "wake_dewa_nai",

            "regex": r"わけではない|訳ではない",

            "title": "〜わけではない",

            "jlpt": "N3",

            "register": "中性偏书面",

            "meaning": "并不是说…（部分否定）",

            "explain": "否定的是命题整体，常用于避免绝对化表达。",

            "examples": [

                "日本語が嫌いなわけではない。",

                "反対しているわけではないが、再検討は必要だ。"

            ],

            "errors": [

                "误当作完全否定",

                "与 〜ないことはない 的语气轻重混淆"

            ],

            "source": "builtin"

        },

        {

            "id": "to_wa_kagiranai",

            "regex": r"とは限らない|と[はわ]かぎらない",

            "title": "〜とは限らない",

            "jlpt": "N2",

            "register": "中性偏书面",

            "meaning": "不一定…；未必…",

            "explain": "用于否定一般化断言，表示并非总是如此。",

            "examples": [

                "彼が来るとは限らない。",

                "高い物が必ずしも良いとは限らない。",

                "日本人だからといって納豆が好きとは限らない。"

            ],

            "errors": [

                "误解为“绝对不会”",

                "前项缺少可被否定的一般命题"

            ],

            "source": "builtin"

        },

        {

            "id": "ni_chigainai",

            "regex": r"に違いない|にちがいない",

            "title": "〜に違いない",

            "jlpt": "N2",

            "register": "书面/郑重推断",

            "meaning": "一定…；肯定…（说话人高确信推量）",

            "explain": "基于线索作高确信推断，主观把握较强。",

            "examples": [

                "彼は成功するに違いない。",

                "あの顔色だと、相当疲れているに違いない。",

                "こんなに静かなのは、みんな帰ったに違いない。"

            ],

            "errors": [

                "与 〜かもしれない（低确信）混淆",

                "证据不足时滥用导致语气过强"

            ],

            "source": "builtin"

        }

    ]



    def _canon_title(t: str) -> str:

        x = normalize_text(t)

        x = re.sub(r"[（(].*?[)）]", "", x)

        x = x.replace("〜", "").replace("~", "").replace(" ", "")

        return x



    matched_patterns: List[Dict[str, Any]] = []

    seen_titles = set()



    # 1) 内置规则

    for rule in pattern_rules:

        try:

            if re.search(rule["regex"], text):

                ck = _canon_title(str(rule.get("title", "")))

                if ck not in seen_titles:

                    matched_patterns.append(rule)

                    seen_titles.add(ck)

        except Exception:

            continue



    # 2) 动态规则（来自 GRAMMAR_EXPLAINERS）

    focus_keys = (

        "限らない", "違いない", "わけではない", "ないことはない", "なくはない",

        "ば", "ほど", "べき", "かもしれない", "ようになる", "ようにする",

        "にしては", "にとって", "によって", "ところだ", "てしまう", "つもり",

        "ながら", "たら", "ので", "のに", "と思う"

    )



    for g in GRAMMAR_EXPLAINERS:

        if not isinstance(g, dict):

            continue

        patt = str(g.get("pattern", "")).strip()

        title = str(g.get("title", "")).strip()

        if not patt or not title:

            continue



        probe = title + "|" + patt

        if not any(k in probe for k in focus_keys):

            continue



        try:

            _hit = False

            if re.search(patt, text):

                _hit = True

            else:

                # 活用补偿：ようになる / てしまう 的常见变形

                if ("ようになる" in patt) and re.search(r"ようにな(る|り|った|って|らない|ります|っている)", text):

                    _hit = True

                elif (("てしまう" in patt) or ("でしまう" in patt)) and re.search(

                    r"(て|で)しま(う|い|った|って|わない|います|いました|っている|っちゃう|じゃう|っちゃった|じゃった)",

                    text

                ):

                    _hit = True



            if _hit:

                ck = _canon_title(title)

                if ck in seen_titles:

                    continue



                meaning = str(g.get("meaning", "")).strip()

                structure = str(g.get("structure", "")).strip()

                pitfall = str(g.get("pitfall", "")).strip()

                example = str(g.get("example", "")).strip()

                jlpt = str(g.get("jlpt", "-")).strip() or "-"



                examples = [example] if example else []

                if len(examples) < 3:

                    fallback_examples = {

                        "ようになる": ["日本語が話せるようになった。", "最近早起きできるようになった。"],

                        "てしまう": ["宿題を忘れてしまった。", "電車で寝てしまった。"],

                        "かもしれない": ["明日は雪が降るかもしれない。", "彼はもう帰ったかもしれない。"],

                        "べきだ": ["約束は守るべきだ。", "健康のために早く寝るべきだ。"],

                        "にしては": ["彼は初心者にしては上手だ。", "この店は駅前にしては安い。"],

                        "にとって": ["这是私にとって大切な経験だ。", "家族にとって安心が一番だ。"],

                        "によって": ["人によって考え方が違う。", "国によって文化が異なる。"],

                        "ところだ": ["今から出かけるところだ。", "ちょうど食べ終わったところだ。"],

                    }

                    added = []

                    for k, vals in fallback_examples.items():

                        if (k in title) or (k in patt):

                            added = vals

                            break

                    if not added:

                        if "ない" in (title + structure):

                            added = ["今日は忙しくない。", "明日は行かない。"]

                        else:

                            added = ["文脈に合わせて例文を作る。", "接续を変えて言い換える。"]

                    for ex_item in added:

                        if ex_item and ex_item not in examples:

                            examples.append(ex_item)

                    while len(examples) < 3:

                        examples.append("文脈に合わせて例文を作る。")

                matched_patterns.append({

                    "id": str(g.get("id", "")),

                    "regex": patt,

                    "title": title,

                    "jlpt": jlpt,

                    "register": "中性（动态规则）",

                    "meaning": meaning or "请结合上下文理解该句型语义。",

                    "explain": structure or "请关注其接续与语义边界。",

                    "examples": examples[:5],

                    "errors": [pitfall] if pitfall else ["注意接续、语气与语境匹配。"],

                    "source": "dynamic_grammar_ext"

                })

                seen_titles.add(ck)

        except Exception:

            continue



    collocation_hits: List[Tuple[str, List[str]]] = []

    exact = PHRASE_PATTERNS.get(text)

    if exact:

        collocation_hits.append((text, exact))

    else:

        for k, vals in PHRASE_PATTERNS.items():

            if k in text or text in k:

                collocation_hits.append((k, vals))

            elif len(text) >= 4 and re.search(r"[。！？!?,，]", text) and (k in text):

                collocation_hits.append((k, vals))



    dedup_coll: List[Tuple[str, List[str]]] = []

    seen_keys = set()

    for k, vals in collocation_hits:

        if k not in seen_keys:

            dedup_coll.append((k, vals))

            seen_keys.add(k)

    collocation_hits = dedup_coll[:8]



    if not matched_patterns and not collocation_hits:

        return f"未识别到句型或固定搭配：{text}"



    lines = ["### 句型模式识别 / 固定搭配", f"输入：{text}", ""]



    if matched_patterns:

        lines.append("#### 句型识别")

        for i, p in enumerate(matched_patterns, 1):

            lines.append(f"{i}. {p.get('title')} [{p.get('jlpt')}]")

            lines.append(f" - 正式度: {p.get('register')}")

            lines.append(f" - 含义: {p.get('meaning')}")

            lines.append(f" - 解释: {p.get('explain')}")

            lines.append(f" - 来源: {p.get('source', 'unknown')}")

            lines.append(" - 例句:")

            for j, ex in enumerate(p.get("examples", [])[:5], 1):

                lines.append(f"   {j}) {ex}")

            lines.append(" - 常见错误:")

            for j, er in enumerate(p.get("errors", [])[:5], 1):

                lines.append(f"   {j}) {er}")

            lines.append("")



    if collocation_hits:

        lines.append("#### 固定搭配")

        for k, vals in collocation_hits:

            lines.append(f"- {k}:")

            for v in vals[:8]:

                lines.append(f"  - {v}")



    return "\n".join(lines).rstrip()



def _pitch_query_ojad(word: str) -> Dict[str, str]:

    endpoint = str(os.environ.get("OJAD_API_ENDPOINT", "")).strip()

    if not endpoint or requests is None:

        return {}

    try:

        timeout = float(os.environ.get("OJAD_TIMEOUT_SEC", "1.8"))

    except Exception:

        timeout = 1.8



    try:

        resp = requests.get(endpoint, params={"word": word}, timeout=timeout)

        if resp.status_code != 200:

            return {}

        data = resp.json()

        if isinstance(data, dict) and isinstance(data.get("data"), dict):

            data = data.get("data")

        if not isinstance(data, dict):

            return {}



        reading = str(data.get("reading", "")).strip()

        accent = str(data.get("accent", "")).strip()

        accent_type = str(data.get("accent_type", "")).strip()

        note = str(data.get("note", "")).strip()



        if not (reading or accent or accent_type):

            return {}

        return {

            "reading": reading,

            "accent": accent or "-",

            "accent_type": accent_type or "未知",

            "note": note or "来自 OJAD 接口",

            "source": "OJAD"

        }

    except Exception:

        return {}



def pitch_accent(word: str) -> str:

    word = (word or "").strip()

    if not word:

        return "缺少 word/text 参数。"



    item = PITCH_ACCENT_DICT.get(word)

    if item:

        return "\n".join([

            "### 声调/重音",

            f"- 词条: {word}",

            f"- 读音: {item.get('reading','')}",

            f"- 类型: {item.get('accent_type','未知')}",

            f"- 标记: {item.get('accent','-')}",

            f"- 说明: {item.get('note','')}",

            "- 来源: local_ext_or_builtin"

        ])



    for k, v in PITCH_ACCENT_DICT.items():

        if word in k or k in word:

            return "\n".join([

                "### 声调/重音",

                f"- 词条: {k}",

                f"- 读音: {v.get('reading','')}",

                f"- 类型: {v.get('accent_type','未知')}",

                f"- 标记: {v.get('accent','-')}",

                f"- 说明: {v.get('note','')}",

                "- 来源: local_fuzzy",

                "- 备注: 基于模糊匹配命中。"

            ])



    ojad = _pitch_query_ojad(word)

    if ojad:

        return "\n".join([

            "### 声调/重音",

            f"- 词条: {word}",

            f"- 读音: {ojad.get('reading','')}",

            f"- 类型: {ojad.get('accent_type','未知')}",

            f"- 标记: {ojad.get('accent','-')}",

            f"- 说明: {ojad.get('note','')}",

            f"- 来源: {ojad.get('source','OJAD')}"

        ])



    endpoint = str(os.environ.get("OJAD_API_ENDPOINT", "")).strip()

    endpoint_hint = "已配置" if endpoint else "未配置"

    return "\n".join([

        "### 声调/重音",

        f"- 词条: {word}",

        "- 当前词典未收录该词重音（有则显示，无则略过）。",

        f"- OJAD接口: {endpoint_hint}"

    ])



def minimal_pair_quiz(args: Dict[str, Any]) -> str:

    pair_id = str(args.get("pair_id") or "").strip()

    user_answer = str(args.get("user_answer") or args.get("answer") or "").strip()

    topic = str(args.get("topic") or "all").strip().lower()



    # 单题判定模式

    if pair_id and user_answer:

        item = None

        for it in MINIMAL_PAIR_BANK:

            if it.get("id") == pair_id:

                item = it

                break

        if not item:

            return f"未找到 pair_id={pair_id}。"



        ans = str(item.get("answer") or "").strip()

        ok = normalize_text(user_answer) == normalize_text(ans)

        return "\n".join([

            "### 易混题判定",

            f"- 题目ID: {pair_id}",

            f"- 你的答案: {user_answer}",

            f"- 正确答案: {ans}",

            f"- 判定: {'✅ 正确' if ok else '❌ 错误'}",

            f"- 讲解: {item.get('explain','')}"

        ])



    # 出题模式

    try:

        count = int(args.get("count", 3))

    except Exception:

        count = 3

    count = max(1, min(10, count))



    bank = MINIMAL_PAIR_BANK[:]

    if topic != "all":

        bank = [x for x in bank if str(x.get("topic", "")).strip().lower() == topic]



    if not bank:

        return f"题库为空（topic={topic}）。"



    picked = random.sample(bank, min(count, len(bank)))

    lines = ["### 易混题训练（Minimal Pair Quiz）", f"- topic: {topic}", f"- 题量: {len(picked)}", ""]

    for i, it in enumerate(picked, 1):

        lines.append(f"{i}. [{it.get('id')}] {it.get('question')}")

        lines.append(f"   A) {it.get('a')}   B) {it.get('b')}")

        lines.append(f"   参考答案: {it.get('answer')}")

        lines.append(f"   讲解: {it.get('explain')}")

    lines.append("")

    lines.append("可用判题：command=minimal_pair_quiz, pair_id=..., user_answer=...")

    return "\n".join(lines)



def fsrs_schedule(args: Dict[str, Any]) -> str:

    # 简化版 FSRS（与 SM-2 并存），用于更现代的复习间隔估计

    try:

        grade = int(args.get("grade", 3))  # 0-5

    except Exception:

        grade = 3

    grade = max(0, min(5, grade))



    try:

        stability = float(args.get("stability", 2.5))  # 记忆稳定度

    except Exception:

        stability = 2.5

    stability = max(0.1, stability)



    try:

        difficulty = float(args.get("difficulty", 5.0))  # 难度 1-10

    except Exception:

        difficulty = 5.0

    difficulty = max(1.0, min(10.0, difficulty))



    try:

        retrievability = float(args.get("retrievability", 0.9))  # 当前可提取概率

    except Exception:

        retrievability = 0.9

    retrievability = max(0.1, min(0.99, retrievability))



    try:

        target_retention = float(args.get("target_retention", 0.9))

    except Exception:

        target_retention = 0.9

    target_retention = max(0.7, min(0.97, target_retention))



    recalled = grade >= 3



    if recalled:

        gain = 1.0 + 0.12 * (11.0 - difficulty) + 0.18 * (grade - 3)

        new_stability = max(0.1, stability * gain)

        new_difficulty = max(1.0, min(10.0, difficulty - 0.25 * (grade - 3)))

    else:

        new_stability = max(0.1, stability * 0.45)

        new_difficulty = max(1.0, min(10.0, difficulty + 0.8))



    # 用稳定度反推下一次间隔（简化近似）

    ratio = max(0.2, min(2.5, retrievability / target_retention))

    next_interval = max(1, int(round(new_stability * ratio)))



    return "\n".join([

        "### FSRS 复习排程（简化版）",

        f"- grade: {grade} ({'recalled' if recalled else 'forgot'})",

        f"- stability: {stability:.3f} -> {new_stability:.3f}",

        f"- difficulty: {difficulty:.3f} -> {new_difficulty:.3f}",

        f"- retrievability: {retrievability:.3f}",

        f"- target_retention: {target_retention:.3f}",

        f"- 建议下次间隔: {next_interval} 天"

    ])



def import_export_data(args: Dict[str, Any]) -> str:

    action = str(args.get("action") or "export").strip().lower()   # export / import

    dataset = str(args.get("dataset") or "wrongbook").strip().lower()  # wrongbook|user_lexicon|domain_lexicon|sessions|all

    fmt = str(args.get("format") or "").strip().lower()  # json/csv

    file_path = str(args.get("file_path") or args.get("path") or "").strip()



    if not fmt and file_path:

        ext = os.path.splitext(file_path)[1].lower().strip(".")

        fmt = ext

    if fmt not in ("json", "csv"):

        fmt = "json"



    os.makedirs(EXPORT_DIR, exist_ok=True)



    def _default_export_path(ds: str, f: str) -> str:

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")

        return os.path.join(EXPORT_DIR, f"{ds}_{ts}.{f}")



    if action == "export":

        target = file_path or _default_export_path(dataset, fmt)



        if fmt == "json":

            payload: Any

            if dataset == "wrongbook":

                payload = _load_wrongbook()

            elif dataset == "user_lexicon":

                payload = USER_LEXICON

            elif dataset == "domain_lexicon":

                payload = DOMAIN_LEXICON

            elif dataset == "sessions":

                payload = _load_sessions()

            elif dataset == "all":

                payload = {

                    "wrongbook": _load_wrongbook(),

                    "user_lexicon": USER_LEXICON,

                    "domain_lexicon": DOMAIN_LEXICON,

                    "sessions": _load_sessions()

                }

            else:

                return f"不支持的 dataset: {dataset}"



            with open(target, "w", encoding="utf-8") as f:

                json.dump(payload, f, ensure_ascii=False, indent=2)

            return f"导出成功：{target}"



        # CSV 导出

        rows: List[Dict[str, Any]] = []

        fieldnames: List[str] = []



        if dataset == "wrongbook":

            rows = _load_wrongbook()

            fieldnames = ["word", "reading", "meaning", "user_answer", "expected_answer", "error_type", "source_sentence", "timestamp"]

        elif dataset in ("user_lexicon", "domain_lexicon"):

            lex = USER_LEXICON if dataset == "user_lexicon" else DOMAIN_LEXICON

            for w, v in lex.items():

                rows.append({

                    "word": w,

                    "reading": v.get("reading", ""),

                    "meaning": v.get("meaning", ""),

                    "pos": v.get("pos", ""),

                    "tags": "|".join([str(x) for x in (v.get("tags", []) or [])])

                })

            fieldnames = ["word", "reading", "meaning", "pos", "tags"]

        else:

            return "CSV 导出当前仅支持 wrongbook / user_lexicon / domain_lexicon。"



        with open(target, "w", encoding="utf-8-sig", newline="") as f:

            w = csv.DictWriter(f, fieldnames=fieldnames)

            w.writeheader()

            for r in rows:

                w.writerow({k: r.get(k, "") for k in fieldnames})

        return f"导出成功：{target}"



    elif action == "import":

        if not file_path:

            return "import 模式需要 file_path。"

        if not os.path.exists(file_path):

            return f"文件不存在：{file_path}"



        if fmt == "json":

            with open(file_path, "r", encoding="utf-8") as f:

                data = json.load(f)



            if dataset == "wrongbook":

                _save_wrongbook(data if isinstance(data, list) else [])

                return f"导入成功：wrongbook <- {file_path}"

            if dataset == "user_lexicon":

                if isinstance(data, dict):

                    _save_lexicon_file(USER_LEXICON_PATH, data)

                    reload_lexicons()

                    return f"导入成功：user_lexicon <- {file_path}"

                return "导入失败：user_lexicon 需为 JSON 对象。"

            if dataset == "domain_lexicon":

                if isinstance(data, dict):

                    _save_lexicon_file(DOMAIN_LEXICON_PATH, data)

                    reload_lexicons()

                    return f"导入成功：domain_lexicon <- {file_path}"

                return "导入失败：domain_lexicon 需为 JSON 对象。"

            if dataset == "sessions":

                _save_sessions(data if isinstance(data, dict) else {})

                return f"导入成功：sessions <- {file_path}"

            if dataset == "all":

                if not isinstance(data, dict):

                    return "导入失败：all 需要 JSON 对象。"

                if "wrongbook" in data:

                    _save_wrongbook(data.get("wrongbook") if isinstance(data.get("wrongbook"), list) else [])

                if "user_lexicon" in data and isinstance(data.get("user_lexicon"), dict):

                    _save_lexicon_file(USER_LEXICON_PATH, data["user_lexicon"])

                if "domain_lexicon" in data and isinstance(data.get("domain_lexicon"), dict):

                    _save_lexicon_file(DOMAIN_LEXICON_PATH, data["domain_lexicon"])

                if "sessions" in data:

                    _save_sessions(data.get("sessions") if isinstance(data.get("sessions"), dict) else {})

                reload_lexicons()

                return f"导入成功：all <- {file_path}"

            return f"不支持的 dataset: {dataset}"



        # CSV 导入

        with open(file_path, "r", encoding="utf-8-sig", newline="") as f:

            reader = csv.DictReader(f)

            rows = list(reader)



        if dataset == "wrongbook":

            items = []

            for r in rows:

                items.append({

                    "word": r.get("word", ""),

                    "reading": r.get("reading", ""),

                    "meaning": r.get("meaning", ""),

                    "user_answer": r.get("user_answer", ""),

                    "expected_answer": r.get("expected_answer", ""),

                    "error_type": r.get("error_type", "unknown"),

                    "source_sentence": r.get("source_sentence", ""),

                    "timestamp": r.get("timestamp", datetime.now().isoformat(timespec="seconds"))

                })

            _save_wrongbook(items)

            return f"导入成功：wrongbook(csv) <- {file_path}"



        if dataset in ("user_lexicon", "domain_lexicon"):

            lex: Dict[str, Dict[str, Any]] = {}

            for r in rows:

                w = str(r.get("word") or "").strip()

                if not w:

                    continue

                tags = [x.strip() for x in str(r.get("tags") or "").split("|") if x.strip()]

                lex[w] = {

                    "reading": str(r.get("reading") or ""),

                    "meaning": str(r.get("meaning") or ""),

                    "pos": str(r.get("pos") or ""),

                    "tags": tags

                }

            if dataset == "user_lexicon":

                _save_lexicon_file(USER_LEXICON_PATH, lex)

            else:

                _save_lexicon_file(DOMAIN_LEXICON_PATH, lex)

            reload_lexicons()

            return f"导入成功：{dataset}(csv) <- {file_path}"



        return "CSV 导入当前仅支持 wrongbook / user_lexicon / domain_lexicon。"



    return "action 仅支持 export 或 import。"



def progress_report(args: Dict[str, Any]) -> str:

    try:

        days = int(args.get("days", 30))

    except Exception:

        days = 30

    days = max(1, min(365, days))



    items = _load_wrongbook()

    total = len(items)



    # 近N天统计

    now = datetime.now()

    recent = 0

    by_type: Dict[str, int] = {}

    by_word: Dict[str, int] = {}

    by_jlpt: Dict[str, int] = {"N1": 0, "N2": 0, "N3": 0, "N4": 0, "N5": 0, "未知": 0}



    for it in items:

        t = str(it.get("timestamp") or "").strip()

        w = str(it.get("word") or it.get("expected_answer") or "").strip()

        et = str(it.get("error_type") or "unknown").strip()



        if et:

            by_type[et] = by_type.get(et, 0) + 1

        if w:

            by_word[w] = by_word.get(w, 0) + 1

            lv = lookup_jlpt_for_word(w) or "未知"

            by_jlpt[lv if lv in by_jlpt else "未知"] += 1



        if t:

            try:

                dt = datetime.fromisoformat(t)

                if (now - dt).days <= days:

                    recent += 1

            except Exception:

                pass



    top_types = sorted(by_type.items(), key=lambda x: x[1], reverse=True)[:5]

    top_words = sorted(by_word.items(), key=lambda x: x[1], reverse=True)[:8]



    lines = [

        "### 学习进度报告",

        f"- 统计窗口: 最近 {days} 天",

        f"- 错题总数: {total}",

        f"- 窗口内新增错题: {recent}",

        f"- 错题去重词条数: {len(by_word)}",

        ""

    ]



    lines.append("#### 高频错因 TOP5")

    if top_types:

        for i, (k, v) in enumerate(top_types, 1):

            lines.append(f"{i}. {k}: {v}")

    else:

        lines.append("- 暂无数据")



    lines.append("")

    lines.append("#### 高频薄弱词 TOP8")

    if top_words:

        for i, (k, v) in enumerate(top_words, 1):

            lv = lookup_jlpt_for_word(k) or "未知"

            lines.append(f"{i}. {k} [{lv}] × {v}")

    else:

        lines.append("- 暂无数据")



    lines.append("")

    lines.append("#### JLPT薄弱层分布（基于错题词）")

    for lv in ["N1", "N2", "N3", "N4", "N5", "未知"]:

        lines.append(f"- {lv}: {by_jlpt.get(lv, 0)}")



    lines.append("")

    lines.append("#### 下一步建议")

    if top_words:

        lines.append("- 先复习 TOP3 高频错词，做读音+造句+改写各1次。")

    if top_types:

        lines.append(f"- 重点修正错因：{top_types[0][0]}。")

    if total == 0:

        lines.append("- 当前无错题，建议开始一次 study_session_start 建立基线。")

    return "\n".join(lines)



# Full SQLite dictionary integration (JMdict / KANJIDIC2)

try:

    from full_db_integration import apply_full_db_integration

    apply_full_db_integration(globals())

except Exception as e:

    try:

        log_observation("full_db_integration_load_failed", error=str(e))

    except Exception:

        pass



def resource_status(args: Dict[str, Any]) -> str:

    db_path = str(

        args.get("db_path")

        or os.environ.get("JMDICT_FULL_DB_PATH")

        or os.path.join(PLUGIN_DIR, "data", "db", "jdict_full.sqlite")

    ).strip()

    if not os.path.isabs(db_path):

        db_path = os.path.normpath(os.path.join(PLUGIN_DIR, db_path))



    ojad_ep = str(os.environ.get("OJAD_API_ENDPOINT", "")).strip()

    ojad_state = "configured" if ojad_ep else "not_configured"

    lines = ["### 资源状态", f"- db_path: {db_path}", f"- exists: {os.path.exists(db_path)}", f"- ojad_api: {ojad_state}"]



    if not os.path.exists(db_path):

        return "\n".join(lines)



    try:

        st = os.stat(db_path)

        lines.append(f"- size_bytes: {st.st_size}")

        lines.append(f"- mtime: {datetime.fromtimestamp(st.st_mtime).isoformat(timespec='seconds')}")

    except Exception as e:

        lines.append(f"- stat_error: {e}")



    try:

        import sqlite3 as _sqlite3

        conn = _sqlite3.connect(db_path, timeout=2.0)

        try:

            def _table_exists(name: str) -> bool:

                row = conn.execute(

                    "SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",

                    (name,)

                ).fetchone()

                return row is not None



            jm_cnt = conn.execute("SELECT count(1) FROM jm_lex").fetchone()[0] if _table_exists("jm_lex") else 0

            kd_cnt = conn.execute("SELECT count(1) FROM kd_lex").fetchone()[0] if _table_exists("kd_lex") else 0

            lines.append(f"- jm_lex_rows: {jm_cnt}")

            lines.append(f"- kd_lex_rows: {kd_cnt}")



            if _table_exists("resource_meta"):

                metas = conn.execute(

                    "SELECT key, value FROM resource_meta WHERE key IN "

                    "('jmdict_imported_at','kanjidic_imported_at','jmdict_entry_count','jmdict_row_count','kanjidic_char_count','kanjidic_row_count')"

                ).fetchall()

                if metas:

                    lines.append("- resource_meta:")

                    for k, v in metas:

                        lines.append(f"  - {k}: {v}")

        finally:

            conn.close()

    except Exception as e:

        lines.append(f"- sqlite_error: {e}")



    return "\n".join(lines)



def resource_update(args: Dict[str, Any]) -> str:

    download = as_bool(args.get("download"), False)

    script_path = os.path.join(PLUGIN_DIR, "scripts", "update_resources.py")

    if not os.path.exists(script_path):

        return f"update script not found: {script_path}"



    releases_dir = os.path.join(PLUGIN_DIR, "releases")

    os.makedirs(releases_dir, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    out_log = os.path.join(releases_dir, f"full_db_update_{ts}.log")

    err_log = os.path.join(releases_dir, f"full_db_update_{ts}.err.log")



    cmd = [sys.executable, script_path]

    if download:

        cmd.append("--download")



    try:

        import subprocess as _subprocess

        out_f = open(out_log, "w", encoding="utf-8")

        err_f = open(err_log, "w", encoding="utf-8")

        proc = _subprocess.Popen(

            cmd,

            cwd=PLUGIN_DIR,

            stdout=out_f,

            stderr=err_f

        )

        return "\n".join([

            "### 资源更新任务已启动",

            f"- pid: {proc.pid}",

            f"- command: {' '.join(cmd)}",

            f"- log: {out_log}",

            f"- err: {err_log}",

            f"- download: {download}"

        ])

    except Exception as e:

        return f"resource_update 启动失败: {e}"



def grammar_explain_deep_v2(args: Dict[str, Any]) -> str:

    text = str(args.get("text") or args.get("sentence") or "").strip()

    grammar = str(args.get("grammar") or "").strip()

    if not text and not grammar:

        return "缺少参数：请提供 text 或 grammar。"



    def _n(s: str) -> str:

        return normalize_text(str(s or ""))



    builtin_rules: List[Dict[str, Any]] = [

        {

            "title": "〜とは限らない",

            "jlpt": "N2",

            "aliases": ["とは限らない", "〜とは限らない", "とはかぎらない", "と[はわ]かぎらない"],

            "regex": [r"とは限らない", r"と[はわ]かぎらない"],

            "definition": "表示“并非总是如此 / 不一定成立”，用于对一般化判断做保留或反驳。",

            "register": "中性偏书面",

            "rules": [

                "普通形 + とは限らない",

                "名词 + だからといって ... とは限らない（常见搭配）"

            ],

            "examples": [

                "彼が来るとは限らない。",

                "高い物が必ずしも良いとは限らない。",

                "日本人だからといって納豆が好きとは限らない。"

            ],

            "errors": [

                "误解为“绝对不会”（实际是“不一定”）",

                "前项缺少可被否定的一般命题"

            ],

            "tips": [

                "N2常见：与 必ずしも〜ない 联动考查。",

                "阅读题常通过该句型削弱绝对化断言。"

            ]

        },

        {

            "title": "〜に違いない",

            "jlpt": "N2",

            "aliases": ["に違いない", "〜に違いない", "にちがいない"],

            "regex": [r"に違いない", r"にちがいない"],

            "definition": "表示说话人基于线索做出的高确信度推断（“一定…”）。",

            "register": "书面/郑重推断",

            "rules": [

                "普通形 + に違いない",

                "名词/な形容词语干 + に違いない"

            ],

            "examples": [

                "彼は成功するに違いない。",

                "こんなに暗いのだから、雨が降るに違いない。",

                "あの態度は何か隠しているに違いない。"

            ],

            "errors": [

                "与 〜かもしれない（低确信）混用",

                "证据不足时使用会显得武断"

            ],

            "tips": [

                "N2常考“推量强度”对比：に違いない > だろう > かもしれない。"

            ]

        },

        {

            "title": "〜ないことはない / 〜なくはない",

            "jlpt": "N3",

            "aliases": ["ないことはない", "なくはない", "〜ないことはない"],

            "regex": [r"ないことはない", r"なくはない"],

            "definition": "双重否定，表示“并非完全不…”，语气委婉保留。",

            "register": "口语/书面（委婉）",

            "rules": [

                "动词ない形 + ことはない",

                "形容词く + なくはない"

            ],

            "examples": [

                "行かないことはないが、今日は忙しい。",

                "この案が悪くはない。",

                "食べられなくはないけど、好きではない。"

            ],

            "errors": [

                "误判为强否定",

                "与 〜わけではない 语用边界混淆"

            ],

            "tips": [

                "N3常考语气：弱肯定 + 保留立场。"

            ]

        },

        {

            "title": "〜わけではない",

            "jlpt": "N3",

            "aliases": ["わけではない", "訳ではない", "〜わけではない"],

            "regex": [r"わけではない", r"訳ではない"],

            "definition": "部分否定，表示“并不是说…（但也不代表相反）”。",

            "register": "中性偏书面",

            "rules": [

                "普通形 + わけではない"

            ],

            "examples": [

                "日本語が嫌いなわけではない。",

                "反対しているわけではないが、再検討は必要だ。",

                "高ければ買わないわけではない。"

            ],

            "errors": [

                "误解为全盘否定",

                "与 〜ないことはない 互换使用导致语气偏差"

            ],

            "tips": [

                "N3阅读常考“让步 + 保留”语用。"

            ]

        },

        {

            "title": "〜ば〜ほど",

            "jlpt": "N2",

            "aliases": ["ばほど", "〜ば〜ほど", "ば〜ほど"],

            "regex": [r"ば.+ほど"],

            "definition": "前后项程度联动变化，表示“越…越…”。",

            "register": "中性（口语/书面）",

            "rules": [

                "动词ば形 + 同一动词辞书形 + ほど",

                "い形容词ければ + い形容词 + ほど"

            ],

            "examples": [

                "勉強すればするほど面白くなる。",

                "読めば読むほど分からなくなる部分もある。",

                "練習すればするほど上手になる。"

            ],

            "errors": [

                "缺少对应前项（×ばほど）",

                "前后项不形成程度联动"

            ],

            "tips": [

                "N2语法改写常见：程度递增结构。"

            ]

        },

        {

            "title": "〜ない（否定形）",

            "jlpt": "N5",

            "aliases": ["ない", "〜ない", "否定形"],

            "regex": [r"ない", r"ません", r"ではない", r"じゃない", r"くない", r"ありません"],

            "definition": "表示否定（不做某动作 / 不是某状态）。覆盖动词、形容词、名词与形容动词常见否定表达。",

            "register": "普通体偏口语；礼貌体常对应 〜ません / 〜ではありません",

            "rules": [

                "五段动词：う段→あ段 + ない（書く→書かない）",

                "一段动词：去る + ない（食べる→食べない）",

                "不规则：する→しない、来る→こない",

                "い形容词：去い + くない（暑い→暑くない）",

                "な形容词/名词：〜ではない / 〜じゃない"

            ],

            "examples": [

                "今日は暑くないです。",

                "毎日日本語を勉強しない。",

                "彼は学生ではない。",

                "この部屋は静かじゃない。",

                "明日行きません。"

            ],

            "errors": [

                "×暑いない → ○暑くない",

                "×食べるない → ○食べない",

                "×来るない → ○こない"

            ],

            "tips": [

                "N5高频：〜ない 与 〜ません 对应。",

                "易错：五段否定（買う→買わない）。"

            ]

        }

    ]



    def _match_builtin(q: str, t: str) -> List[Dict[str, Any]]:

        qn = _n(q)

        out: List[Dict[str, Any]] = []

        for b in builtin_rules:

            aliases = [_n(x) for x in b.get("aliases", [])]

            hit = False

            if qn:

                for a in aliases:

                    if qn == a or (len(qn) >= 3 and len(a) >= 3 and (qn in a or a in qn)):

                        hit = True

                        break

            if (not hit) and t:

                for rg in b.get("regex", []):

                    try:

                        if re.search(rg, t):

                            hit = True

                            break

                    except Exception:

                        continue

            if hit:

                out.append(b)

        return out



    points: List[Dict[str, Any]] = []



    # 1) 内置规则：优先按指定 grammar 命中；无 grammar 时按 text 命中

    if grammar:

        for b in _match_builtin(grammar, ""):

            points.append({

                "title": b["title"],

                "jlpt": b["jlpt"],

                "definition": b["definition"],

                "register": b["register"],

                "rules": b["rules"],

                "examples": b["examples"],

                "errors": b["errors"],

                "tips": b["tips"],

            })

    if text:

        for b in _match_builtin("", text):

            points.append({

                "title": b["title"],

                "jlpt": b["jlpt"],

                "definition": b["definition"],

                "register": b["register"],

                "rules": b["rules"],

                "examples": b["examples"],

                "errors": b["errors"],

                "tips": b["tips"],

            })



    # 2) 叠加语法库条目（若有）

    targets: List[Dict[str, Any]] = []

    if grammar:

        q = _n(grammar)

        for g in GRAMMAR_EXPLAINERS:

            title = _n(g.get("title", ""))

            gid = _n(g.get("id", ""))

            patt = _n(g.get("pattern", ""))

            if q and (q in title or q == gid or (patt and q in patt)):

                if g not in targets:

                    targets.append(g)

    if text:

        for g in detect_grammar_points(text):

            if g not in targets:

                targets.append(g)



    for g in targets:

        title = str(g.get("title", "(unknown)"))

        jlpt = str(g.get("jlpt", "-"))

        meaning = str(g.get("meaning", "")).strip()

        structure = str(g.get("structure", "")).strip()

        pitfall = str(g.get("pitfall", "")).strip()

        ex = str(g.get("example", "")).strip()



        examples: List[str] = []

        if ex:

            examples.append(ex)

        if len(examples) < 3:

            if "より" in (title + structure):

                examples.extend([

                    "A: この店はあの店より安いです。",

                    "B: 今日は昨日より寒くないです。",

                    "C: 日本語は去年より上手になりました。",

                ])

            elif "ない" in (title + structure):

                examples.extend([

                    "A: 今日は忙しくないです。",

                    "B: 明日は学校に行かない。",

                    "C: この料理は辛くない。",

                ])

            else:

                examples.extend([

                    "会議では資料などで要点を説明する。",

                    "今日は雨が降らないように早めに帰る。",

                    "この課題を終えることは難しくない。",

                ])



        points.append({

            "title": title,

            "jlpt": jlpt,

            "definition": meaning or "请结合上下文理解该语法在句中的作用。",

            "register": "视句型而定（口语/书面）",

            "rules": [structure] if structure else ["请参考标准接续表。"],

            "examples": examples[:5],

            "errors": [pitfall] if pitfall else ["注意接续与语体一致。"],

            "tips": [f"{jlpt}常见考点：语义辨析 + 接续判断 + 改写造句。"],

        })



    # 3) 去重，并避免“指定复杂语法时被泛化到 〜ない”

    def _canonical_grammar_key(title: str, jlpt: str) -> str:

        t = _n(title)

        t = re.sub(r"[（(].*?[)）]", "", t)

        t = t.replace("〜", "").replace("~", "").replace(" ", "")



        if ("とは限らない" in t) or ("とはかぎらない" in t) or ("とわかぎらない" in t):

            t = "とは限らない"

        elif ("に違いない" in t) or ("にちがいない" in t):

            t = "に違いない"

        elif ("ないことはない" in t) or ("なくはない" in t):

            t = "ないことはない"

        elif ("わけではない" in t) or ("訳ではない" in t):

            t = "わけではない"

        elif ("ば" in t and "ほど" in t):

            t = "ばほど"

        elif ("ない" in t and "否定" in t):

            t = "ない(否定形)"



        return f"{t}|{_n(jlpt)}"



    uniq: List[Dict[str, Any]] = []

    seen = set()

    for p in points:

        key = _canonical_grammar_key(str(p.get("title", "")), str(p.get("jlpt", "")))

        if key and key not in seen:

            uniq.append(p)

            seen.add(key)

    points = uniq



    if grammar:

        qn = _n(grammar)

        complex_markers = ["とは限らない", "に違いない", "ないことはない", "なくはない", "わけではない", "ばほど", "ば〜ほど"]

        if any(m in qn for m in complex_markers):

            points = [p for p in points if _n(str(p.get("title", ""))) != _n("〜ない（否定形）")] or points



    if not points:

        return "未命中可讲解语法点。"



    lines = ["### 语法深度解析（Deep）"]

    if text:

        lines.append(f"原句：{text}")

    if grammar:

        lines.append(f"指定语法：{grammar}")

    lines.append("")



    for i, p in enumerate(points, 1):

        lines.append(f"{i}. {p.get('title', '(unknown)')} [{p.get('jlpt', '-')}]")

        lines.append(f" - 语法点完整定义: {p.get('definition', '')}")

        lines.append(f" - 正式度: {p.get('register', '-')}")

        lines.append(" - 接续规则:")

        for idx, r in enumerate(p.get("rules", [])[:8], 1):

            lines.append(f"   {idx}) {r}")

        lines.append(" - 例句对比:")

        for idx, ex in enumerate(p.get("examples", [])[:5], 1):

            lines.append(f"   {idx}) {ex}")

        lines.append(" - 常见错误:")

        for idx, e in enumerate(p.get("errors", [])[:6], 1):

            lines.append(f"   {idx}) {e}")

        lines.append(" - JLPT考点提示:")

        for idx, t in enumerate(p.get("tips", [])[:5], 1):

            lines.append(f"   {idx}) {t}")

        lines.append("")



    return "\n".join(lines).rstrip()



def review_submit_v2(args: Dict[str, Any]) -> str:

    word = str(args.get("word") or "").strip()

    if not word:

        return "缺少 word 参数。"



    result_text = str(

        args.get("result")

        or args.get("review_result")

        or args.get("outcome")

        or ""

    ).strip()



    try:

        default_grade = int(args.get("grade", 3))

    except Exception:

        default_grade = 3

    default_grade = max(0, min(5, default_grade))



    grade = _result_to_grade(result_text, default_grade)



    state = _load_review_state()

    cards = state.get("cards", {})

    card = cards.get(word, {}) if isinstance(cards.get(word, {}), dict) else {}



    reps = int(card.get("reps", 0) or 0)

    interval = int(card.get("interval", 0) or 0)

    ease = float(card.get("ease", 2.5) or 2.5)



    if grade < 3:

        reps = 0

        interval = 1

    else:

        if reps == 0:

            interval = 1

        elif reps == 1:

            interval = 6

        else:

            interval = max(1, int(round(interval * ease)))

        reps += 1



    ease = ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02))

    if ease < 1.3:

        ease = 1.3



    now = datetime.now()

    due_dt = now + timedelta(days=interval)



    card["reps"] = reps

    card["interval"] = interval

    card["ease"] = round(ease, 4)

    card["last_grade"] = grade

    card["last_result"] = result_text

    card["last_review"] = now.isoformat(timespec="seconds")

    card["due_at"] = due_dt.isoformat(timespec="seconds")

    cards[word] = card

    state["cards"] = cards

    _save_review_state(state)



    logs = _load_review_log()

    logs.append({

        "word": word,

        "grade": grade,

        "result": result_text or f"grade:{grade}",

        "correct": bool(grade >= 3),

        "timestamp": now.isoformat(timespec="seconds"),

    })

    if len(logs) > 50000:

        logs = logs[-50000:]

    _save_review_log(logs)



    return "\n".join([

        "### 复习结果已提交",

        f"- word: {word}",

        f"- result: {result_text or '（未提供，按grade计）'}",

        f"- grade: {grade}",

        f"- reps: {reps}",

        f"- interval: {interval} 天",

        f"- ease: {ease:.2f}",

        f"- next_due: {due_dt.isoformat(timespec='seconds')}"

    ])



def review_stats_v2(args: Dict[str, Any]) -> str:

    state = _load_review_state()

    cards = state.get("cards", {})

    now = datetime.now()

    in_1d = now + timedelta(days=1)

    in_7d = now + timedelta(days=7)



    total = 0

    due_now = 0

    due_1d = 0

    due_7d = 0



    for _, card in cards.items():

        if not isinstance(card, dict):

            continue

        total += 1

        due_at = str(card.get("due_at", "")).strip()

        try:

            d = datetime.fromisoformat(due_at) if due_at else now

        except Exception:

            d = now

        if d <= now:

            due_now += 1

        if d <= in_1d:

            due_1d += 1

        if d <= in_7d:

            due_7d += 1



    logs = _load_review_log()

    today = now.date().isoformat()

    done_today = 0

    correct_today = 0

    fuzzy_today = 0

    forgot_today = 0



    for it in logs:

        ts = str(it.get("timestamp", ""))

        if not ts or ts.split("T")[0] != today:

            continue

        done_today += 1

        g = int(it.get("grade", 0) or 0)

        if g >= 4:

            correct_today += 1

        elif g >= 3:

            fuzzy_today += 1

        else:

            forgot_today += 1



    accuracy = (correct_today / done_today * 100.0) if done_today > 0 else 0.0



    return "\n".join([

        "### 复习统计",

        f"- total_cards: {total}",

        f"- due_now: {due_now}",

        f"- due_within_1d: {due_1d}",

        f"- due_within_7d: {due_7d}",

        "",

        "#### 今日统计",

        f"- reviewed_today: {done_today}",

        f"- remembered_today: {correct_today}",

        f"- fuzzy_today: {fuzzy_today}",

        f"- forgot_today: {forgot_today}",

        f"- accuracy_today: {accuracy:.1f}%"

    ])



# === PHASE2_UNIFIED_SCHEMA_BEGIN ===

PHASE2_SCHEMA_VERSION = "2.14.2"



def _phase5_meta(extra: Dict[str, Any] = None, debug: Dict[str, Any] = None) -> Dict[str, Any]:

    m = {

        "phase": "phase5",

        "schema_family": "JapaneseHelper.Structured",

        "timestamp": datetime.now().isoformat(timespec="seconds")

    }

    if isinstance(extra, dict):

        m.update(extra)

    if isinstance(debug, dict):

        m["debug"] = debug

    return m



def _mk_phase2_payload(command: str, ok: bool, data: Dict[str, Any] = None, error: str = "", meta: Dict[str, Any] = None, debug: Dict[str, Any] = None) -> str:

    payload = {

        "ok": bool(ok),

        "schema_version": PHASE2_SCHEMA_VERSION,

        "command": command,

        "data": data or {},

        "meta": _phase5_meta(meta or {}, debug=debug or {})

    }

    if error:

        payload["error"] = str(error)

    return json.dumps(payload, ensure_ascii=False)



def _phase5_db_path(args: Dict[str, Any]) -> str:

    db_path = str(

        (args or {}).get("db_path")

        or os.environ.get("JMDICT_FULL_DB_PATH")

        or os.path.join(PLUGIN_DIR, "data", "db", "jdict_full.sqlite")

    ).strip()

    if db_path and (not os.path.isabs(db_path)):

        db_path = os.path.normpath(os.path.join(PLUGIN_DIR, db_path))

    return db_path



def _phase5_query_kanji_db(ch: str, args: Dict[str, Any]) -> Dict[str, Any]:

    c = str(ch or "").strip()

    if not c:

        return {}

    db_path = _phase5_db_path(args)

    if (not db_path) or (not os.path.exists(db_path)):

        return {}



    conn = None

    try:

        conn = sqlite3.connect(db_path, timeout=2.0)

        cur = conn.cursor()

        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='kd_lex' LIMIT 1")

        if cur.fetchone() is None:

            return {}



        row = conn.execute(

            "SELECT literal, onyomi, kunyomi, meaning, jlpt, grade, stroke_count, radical FROM kd_lex WHERE literal=? LIMIT 1",

            (c[0],)

        ).fetchone()

        if not row:

            return {}



        def _split(v: Any, pattern: str) -> List[str]:

            vv = str(v or "").strip()

            if not vv:

                return []

            return [x.strip() for x in re.split(pattern, vv) if x.strip()]



        return {

            "kanji": str(row[0] or c[0]),

            "onyomi": _split(row[1], r"[,;\s]+"),

            "kunyomi": _split(row[2], r"[,;\s]+"),

            "meaning": _split(row[3], r"[;,/]+"),

            "jlpt": str(row[4] or "").strip(),

            "grade": str(row[5] or "").strip(),

            "strokes": str(row[6] or "").strip(),

            "radical": str(row[7] or "").strip(),

            "source": "KANJIDIC2(full-db)",

            "db_path": db_path

        }

    except Exception:

        return {}

    finally:

        try:

            if conn is not None:

                conn.close()

        except Exception:

            pass



def _jlpt_rank(level: str) -> int:

    lv = str(level or "").strip().upper()

    return {"N5": 1, "N4": 2, "N3": 3, "N2": 4, "N1": 5}.get(lv, 99)



def _safe_int(v: Any, default: int = 20) -> int:

    try:

        return int(v)

    except Exception:

        return int(default)



def _phase5_card_limit(args: Dict[str, Any], compact_default: int = 8, normal_default: int = 20, hard_max: int = 50) -> Tuple[bool, int]:

    compact = as_bool(args.get("compact"), False)

    lim = _safe_int(args.get("max_cards") or args.get("limit") or (compact_default if compact else normal_default), normal_default)

    lim = max(1, min(lim, hard_max))

    if compact:

        lim = min(lim, compact_default)

    return compact, lim



def lookup_structured(args: Dict[str, Any]) -> str:

    t0 = _now_ts()

    q = str(args.get("word") or args.get("keyword") or args.get("text") or "").strip()

    if not q:

        return _mk_phase2_payload("Lookup", False, error="缺少 word/keyword 参数。", meta={"elapsed_ms": int((_now_ts() - t0) * 1000)})



    obj = lookup_word_json(args)

    if not isinstance(obj, dict):

        return _mk_phase2_payload("Lookup", False, error="lookup_word_json 返回异常。", meta={"elapsed_ms": int((_now_ts() - t0) * 1000)})



    cards = []

    for c in (obj.get("cards") or []):

        cards.append({

            "word": str(c.get("word", "")),

            "reading": str(c.get("reading", "")),

            "pos": str(c.get("pos", "")),

            "jlpt": str(c.get("jlpt", "")),

            "meanings": list(c.get("meanings", []) or []),

            "sources": list(c.get("sources", []) or []),

            "score": float(c.get("score", 0.0)),

        })



    compact, max_cards = _phase5_card_limit(args, compact_default=8, normal_default=20, hard_max=50)

    cards = cards[:max_cards]



    stats = obj.get("stats", {}) if isinstance(obj.get("stats", {}), dict) else {}

    data = {"query": q, "context": str(obj.get("context", "")), "stats": stats, "cards": cards}

    debug = {

        "local_hit": int(stats.get("local_hit", 0) or 0),

        "online_hit": int(stats.get("online_hit", 0) or 0),

        "merged_hit": int(stats.get("merged_hit", 0) or 0),

        "compact": bool(compact),

        "max_cards": int(max_cards)

    }

    meta = {"elapsed_ms": int((_now_ts() - t0) * 1000), "hit_count": len(cards)}

    return _mk_phase2_payload("Lookup", bool(obj.get("ok", True)), data=data, meta=meta, debug=debug)



def kanji_info_structured(args: Dict[str, Any]) -> str:

    t0 = _now_ts()

    txt = str(args.get("kanji") or args.get("word") or args.get("text") or "").strip()

    if not txt:

        return _mk_phase2_payload("KanjiInfo", False, error="缺少 kanji/word 参数。", meta={"elapsed_ms": int((_now_ts() - t0) * 1000)})



    ch = txt[0]

    item = KANJIDIC_MINI.get(ch, {}) if isinstance(KANJIDIC_MINI, dict) else {}

    source_used = "KANJIDIC_MINI"



    def _listify(v: Any) -> List[str]:

        if isinstance(v, list):

            return [str(x).strip() for x in v if str(x).strip()]

        vv = str(v or "").strip()

        if not vv:

            return []

        return [x.strip() for x in re.split(r"[,;/\s]+", vv) if x.strip()]



    data = {

        "kanji": ch,

        "exists": bool(item),

        "is_kanji": bool(re.match(r"[一-龯]", ch)),

        "onyomi": _listify(item.get("onyomi", [])) if isinstance(item, dict) else [],

        "kunyomi": _listify(item.get("kunyomi", [])) if isinstance(item, dict) else [],

        "meaning": _listify(item.get("meaning", [])) if isinstance(item, dict) else [],

        "jlpt": str(item.get("jlpt", "")) if isinstance(item, dict) else "",

        "strokes": str(item.get("strokes", "")) if isinstance(item, dict) else "",

        "radical": str(item.get("radical", "")) if isinstance(item, dict) else "",

        "grade": str(item.get("grade", "")) if isinstance(item, dict) else "",

        "source": source_used

    }



    if not data["exists"]:

        db_item = _phase5_query_kanji_db(ch, args)

        if db_item:

            source_used = str(db_item.get("source", "KANJIDIC2(full-db)"))

            data.update({

                "exists": True,

                "onyomi": list(db_item.get("onyomi", [])),

                "kunyomi": list(db_item.get("kunyomi", [])),

                "meaning": list(db_item.get("meaning", [])),

                "jlpt": str(db_item.get("jlpt", "")),

                "strokes": str(db_item.get("strokes", "")),

                "radical": str(db_item.get("radical", "")),

                "grade": str(db_item.get("grade", "")),

                "source": source_used,

                "db_path": str(db_item.get("db_path", ""))

            })

        else:

            source_used = "none"

            data["note"] = "未命中 KANJIDIC_MINI 与 kd_lex。"



    return _mk_phase2_payload("KanjiInfo", True, data=data, meta={"elapsed_ms": int((_now_ts() - t0) * 1000)}, debug={"source_used": source_used})



def jlpt_check_structured(args: Dict[str, Any]) -> str:

    t0 = _now_ts()

    text = str(args.get("text") or args.get("sentence") or args.get("word") or "").strip()

    if not text:

        return _mk_phase2_payload("JLPTCheck", False, error="缺少 text/sentence/word 参数。", meta={"elapsed_ms": int((_now_ts() - t0) * 1000)})



    rows = sudachi_rows(text)

    source_mode = "sudachi"

    if not rows:

        source_mode = "fallback_segment"

        rows = []

        for w in fallback_segment(text):

            info = lexicon_lookup(w)

            rows.append({"surface": w, "lemma": w, "normalized": w, "pos": info.get("pos", "未知"), "reading": info.get("reading", ""), "meaning": info.get("meaning", "")})



    counts = {"N1": 0, "N2": 0, "N3": 0, "N4": 0, "N5": 0, "未知": 0}

    tokens = []

    compact_tokens, token_limit = _phase5_card_limit(args, compact_default=12, normal_default=80, hard_max=200)



    for r in rows:

        if is_noise_token(r):

            continue

        lv = jlpt_level_for_token(r) or "未知"

        if lv not in counts:

            lv = "未知"

        counts[lv] += 1

        tk = {

            "surface": str(r.get("surface", "")),

            "lemma": str(r.get("lemma", "")),

            "reading": str(r.get("reading", "")),

            "pos": str(r.get("pos", "")),

            "jlpt": lv

        }

        tokens.append(tk)



    if compact_tokens:

        tokens = tokens[:token_limit]



    data = {"text": text, "token_count": len(tokens), "counts": counts, "tokens": tokens}

    return _mk_phase2_payload(

        "JLPTCheck", True, data=data,

        meta={"elapsed_ms": int((_now_ts() - t0) * 1000)},

        debug={"levels_present": [k for k, v in counts.items() if int(v) > 0], "token_mode": "compact" if compact_tokens else "full", "source_mode": source_mode}

    )



def reading_aid(args: Dict[str, Any]) -> str:

    t0 = _now_ts()

    text = str(args.get("text") or args.get("sentence") or "").strip()

    if not text:

        return _mk_phase2_payload("ReadingAid", False, error="缺少 text/sentence 参数。", meta={"elapsed_ms": int((_now_ts() - t0) * 1000)})



    target_level = str(args.get("target_level") or args.get("level") or "N3").strip().upper()

    target_rank = _jlpt_rank(target_level)

    level_color = as_bool(args.get("level_color"), True)

    compact_tokens = as_bool(args.get("compact_tokens"), False)

    _, token_limit = _phase5_card_limit(args, compact_default=16, normal_default=200, hard_max=300)



    rows = sudachi_rows(text)

    source_mode = "sudachi"

    if not rows:

        source_mode = "fallback_segment"

        rows = []

        for w in fallback_segment(text):

            info = lexicon_lookup(w)

            rows.append({"surface": w, "lemma": w, "normalized": w, "pos": info.get("pos", "未知"), "reading": info.get("reading", ""), "meaning": info.get("meaning", "")})



    tokens = []

    oov_words = []

    html_parts = []

    for r in rows:

        surf = str(r.get("surface", ""))

        if not surf:

            continue

        if is_noise_token(r):

            html_parts.append(surf)

            continue



        reading = str(r.get("reading", ""))

        lemma = str(r.get("lemma", "")) or surf

        pos = str(r.get("pos", ""))

        jlpt = (jlpt_level_for_token(r) or "未知").upper()

        rank = _jlpt_rank(jlpt)

        out_of_scope = (rank > target_rank) if rank < 99 else True



        core = surf

        if reading and re.search(r"[一-龯]", surf):

            core = f"<ruby>{surf}<rt>{reading}</rt></ruby>"



        classes = []

        if level_color:

            classes.append(f"jlpt-{jlpt.lower()}" if jlpt in ("N1", "N2", "N3", "N4", "N5") else "jlpt-unknown")

        if out_of_scope:

            classes.append("oov")

            oov_words.append(surf)

        if classes:

            core = f'<span class="{" ".join(classes)}">{core}</span>'



        html_parts.append(core)



        if compact_tokens:

            tokens.append({

                "surface": surf,

                "jlpt": jlpt,

                "oov": bool(out_of_scope)

            })

        else:

            tokens.append({

                "surface": surf,

                "lemma": lemma,

                "reading": reading,

                "pos": pos,

                "jlpt": jlpt,

                "out_of_scope": out_of_scope

            })



    if compact_tokens:

        tokens = tokens[:token_limit]



    furigana_html = (

        '<div class="jh-reading-aid">'

        '<style>'

        '.jh-reading-aid{line-height:2;font-size:18px;}'

        '.jh-reading-aid ruby rt{font-size:11px;color:#667;}'

        '.jh-reading-aid .oov{border:1px solid #f3d08a;box-shadow:inset 0 0 0 999px rgba(255,243,205,.45);}'

        '.jh-reading-aid .jlpt-n5{color:#2e7d32;}'

        '.jh-reading-aid .jlpt-n4{color:#1565c0;}'

        '.jh-reading-aid .jlpt-n3{color:#6a1b9a;}'

        '.jh-reading-aid .jlpt-n2{color:#ef6c00;}'

        '.jh-reading-aid .jlpt-n1{color:#b71c1c;font-weight:600;}'

        '.jh-reading-aid .jlpt-unknown{color:#37474f;}'

        '</style>'

        + "".join(html_parts) +

        '</div>'

    )



    data = {

        "text": text,

        "target_level": target_level,

        "token_count": len(tokens),

        "oov_count": len(oov_words),

        "oov_words": list(dict.fromkeys(oov_words)),

        "tokens": tokens,

        "furigana_html": furigana_html

    }

    return _mk_phase2_payload(

        "ReadingAid", True, data=data,

        meta={"elapsed_ms": int((_now_ts() - t0) * 1000)},

        debug={"level_color": bool(level_color), "target_rank": int(target_rank), "token_mode": "compact" if compact_tokens else "full", "source_mode": source_mode}

    )



def _reading_aid_build_oov_drill(text: str, oov_words: List[str], limit: int = 8) -> List[Dict[str, Any]]:

    out: List[Dict[str, Any]] = []

    seen = set()

    lim = max(1, min(int(limit or 8), 50))



    # 建立 surface -> lemma 映射，避免把「走っ」这类活用中间形直接当词条

    surface_to_lemma: Dict[str, str] = {}

    try:

        rows, _src = _get_morph_rows(str(text or ""), analyzer="auto")

        for r in rows:

            surf = str(r.get("surface", "")).strip()

            lemma = str(r.get("lemma", "")).strip() or surf

            if surf:

                surface_to_lemma[surf] = lemma

    except Exception:

        pass



    for w in list(oov_words or []):

        ww = str(w or "").strip()

        if not ww:

            continue



        # 优先映射到 lemma

        cand = surface_to_lemma.get(ww, ww)



        # 再做一次动词词形还原兜底（如 走っ -> 走る）

        try:

            cand2 = _verb_lemma_from_sudachi(cand)

            if str(cand2 or "").strip():

                cand = str(cand2).strip()

        except Exception:

            pass



        key = normalize_text(cand)

        if (not key) or key in seen:

            continue

        seen.add(key)



        if len(out) >= lim:

            break



        info = lexicon_lookup(cand) or lexicon_lookup(ww) or {}

        reading = str(info.get("reading", "") or "")

        meaning = str(info.get("meaning", "") or "")

        jlpt = lookup_jlpt_for_word(cand) or lookup_jlpt_for_word(ww) or "未知"



        # 如果仍然是明显中间形，降低教学噪声：跳过单字活用残片

        if len(cand) == 1 and not meaning and jlpt == "未知":

            continue



        out.append({

            "word": cand,

            "source_surface": ww,

            "reading": reading,

            "jlpt": jlpt,

            "hint": meaning,

            "drill_prompt": f"请用「{cand}」造一个自然句。"

        })



    return out



def reading_aid_v2(args: Dict[str, Any]) -> str:

    t0 = _now_ts()

    # 基于已有 ReadingAid 结果做增强，保持兼容与稳定

    base_raw = reading_aid(args)

    try:

        base_obj = json.loads(base_raw)

    except Exception:

        return _mk_phase2_payload(

            "ReadingAidV2", False,

            error="ReadingAid 基础结果不是合法JSON。",

            meta={"elapsed_ms": int((_now_ts() - t0) * 1000)},

            debug={"base_preview": str(base_raw)[:120]}

        )



    if not isinstance(base_obj, dict):

        return _mk_phase2_payload(

            "ReadingAidV2", False,

            error="ReadingAid 基础结果结构异常。",

            meta={"elapsed_ms": int((_now_ts() - t0) * 1000)}

        )



    if not bool(base_obj.get("ok")):

        return _mk_phase2_payload(

            "ReadingAidV2", False,

            error=str(base_obj.get("error") or "ReadingAid 失败"),

            data={"base": base_obj},

            meta={"elapsed_ms": int((_now_ts() - t0) * 1000)}

        )



    data = base_obj.get("data", {})

    if not isinstance(data, dict):

        data = {}



    text = str(data.get("text") or args.get("text") or args.get("sentence") or "").strip()

    oov_words = list(data.get("oov_words", []) or [])



    try:

        oov_limit = int(args.get("oov_limit", 8))

    except Exception:

        oov_limit = 8

    oov_limit = max(1, min(oov_limit, 50))



    oov_drill = _reading_aid_build_oov_drill(text, oov_words, limit=oov_limit)

    data["oov_drill"] = oov_drill

    data["oov_drill_count"] = len(oov_drill)

    data["command_suggestions"] = [

        "tool_name=JapaneseHelper, command=lookup_word, word=<oov_word>",

        "tool_name=JapaneseHelper, command=quiz_generate, text=<sentence>, count=5",

        "tool_name=JapaneseHelper, command=style_shift, text=<sentence>, target=polite"

    ]



    return _mk_phase2_payload(

        "ReadingAidV2", True, data=data,

        meta={"elapsed_ms": int((_now_ts() - t0) * 1000)},

        debug={"oov_drill_limit": int(oov_limit), "oov_drill_count": len(oov_drill)}

    )



def _phase5_group_for_pos(pos: str) -> str:

    p = str(pos or "")

    if p.startswith("助詞"):

        return "PP"

    if p.startswith("動詞") or p.startswith("形容詞") or p.startswith("形状詞") or p.startswith("助動詞"):

        return "VP"

    if p.startswith("名詞") or p.startswith("代名詞") or p.startswith("連体詞"):

        return "NP"

    if p.startswith("副詞") or p.startswith("接続詞"):

        return "ADVP"

    return "XP"



def _get_ginza_nlp():

    global _GINZA_NLP, _GINZA_LAST_ERROR

    if _GINZA_NLP is not None:

        return _GINZA_NLP

    if spacy is None:

        _GINZA_LAST_ERROR = "spacy_import_missing"

        return None

    try:

        # prefer ja_ginza package model

        _GINZA_NLP = spacy.load("ja_ginza")

        _GINZA_LAST_ERROR = ""

        return _GINZA_NLP

    except Exception as e:

        _GINZA_LAST_ERROR = str(e)

        return None



def _escape_mermaid_label(x: str) -> str:

    t = str(x or "")

    t = t.replace('"', "'").replace("[", "(").replace("]", ")")

    return t



def parse_tree_mermaid(args: Dict[str, Any]) -> str:

    t0 = _now_ts()

    text = str(args.get("text") or args.get("sentence") or "").strip()

    if not text:

        return "缺少 text/sentence 参数。"



    parser = str(args.get("parser") or "auto").strip().lower()

    fmt = str(args.get("format") or "").strip().lower()

    include_mermaid = as_bool(args.get("include_mermaid"), True)



    # A) Try real dependency parse via GiNZA

    if parser in ("auto", "ginza"):

        nlp = _get_ginza_nlp()

        if nlp is not None:

            try:

                doc = nlp(text)

                tokens = []

                edges = []

                lines = ["### ParseTree（Mermaid Phase5）", f"原句：{text}", "", "```mermaid", "graph TD", "ROOT([ROOT])"]



                for t in doc:

                    idx = int(t.i)

                    tid = f"T{idx}"

                    surf = str(t.text)

                    lemma = str(t.lemma_) if getattr(t, "lemma_", None) else surf

                    pos = str(t.pos_) if getattr(t, "pos_", None) else ""

                    dep = str(t.dep_) if getattr(t, "dep_", None) else ""

                    head_i = int(t.head.i) if getattr(t, "head", None) is not None else idx



                    label = _escape_mermaid_label(f"{surf}｜{pos}｜{dep}")

                    lines.append(f'{tid}["{label}"]')



                    if dep == "ROOT" or head_i == idx:

                        lines.append(f"ROOT --> {tid}")

                        edges.append({"from": "ROOT", "to": tid, "dep": dep})

                    else:

                        hid = f"T{head_i}"

                        lines.append(f"{hid} --> {tid}")

                        edges.append({"from": hid, "to": tid, "dep": dep})



                    tokens.append({

                        "i": idx,

                        "surface": surf,

                        "lemma": lemma,

                        "pos": pos,

                        "dep": dep,

                        "head_i": head_i

                    })



                lines.append("```")

                mermaid = "\\n".join(lines)



                if fmt == "json":

                    data = {

                        "text": text,

                        "parser_used": "ginza",

                        "token_count": len(tokens),

                        "tokens": tokens,

                        "edges": edges

                    }

                    if include_mermaid:

                        data["mermaid"] = mermaid

                    return _mk_phase2_payload(

                        "ParseTree",

                        True,

                        data=data,

                        meta={"elapsed_ms": int((_now_ts() - t0) * 1000)},

                        debug={"parser_requested": parser, "parser_used": "ginza"}

                    )

                return mermaid

            except Exception as e:

                # keep fallback path below

                ginza_err = str(e)

            else:

                ginza_err = ""

        else:

            ginza_err = _GINZA_LAST_ERROR

    else:

        ginza_err = ""



    # B) Fallback heuristic parse

    rows = sudachi_rows(text)

    source_mode = "sudachi"

    if not rows:

        source_mode = "fallback_segment"

        rows = []

        for w in fallback_segment(text):

            info = lexicon_lookup(w)

            rows.append({"surface": w, "lemma": w, "pos": info.get("pos", "未知"), "reading": info.get("reading", "")})



    vis_rows = [r for r in rows if not is_noise_token(r)]

    chunks: List[Dict[str, Any]] = []

    for r in vis_rows:

        grp = _phase5_group_for_pos(str(r.get("pos", "")))

        token = {

            "surface": str(r.get("surface", "")),

            "lemma": str(r.get("lemma", "")),

            "pos": str(r.get("pos", "")),

            "reading": str(r.get("reading", "")),

            "jlpt": jlpt_level_for_token(r) or "未知"

        }

        if (not chunks) or (chunks[-1]["group"] != grp):

            chunks.append({"group": grp, "tokens": [token]})

        else:

            chunks[-1]["tokens"].append(token)



    lines = ["### ParseTree（Mermaid Phase5）", f"原句：{text}", "", "```mermaid", "graph TD", "S([Sentence])"]

    for ci, ch in enumerate(chunks, 1):

        cid = f"C{ci}"

        lines.append(f'{cid}["{ch["group"]}"]')

        lines.append(f"S --> {cid}")

        for ti, tk in enumerate(ch["tokens"], 1):

            label = _escape_mermaid_label(f'{tk["surface"]}｜{tk["pos"]}｜{tk["jlpt"]}')

            nid = f"{cid}T{ti}"

            lines.append(f'{nid}["{label}"]')

            lines.append(f"{cid} --> {nid}")

    lines.append("```")

    mermaid = "\\n".join(lines)



    if fmt == "json":

        data = {"text": text, "chunk_count": len(chunks), "chunks": chunks, "parser_used": "heuristic"}

        if include_mermaid:

            data["mermaid"] = mermaid

        return _mk_phase2_payload(

            "ParseTree",

            True,

            data=data,

            meta={"elapsed_ms": int((_now_ts() - t0) * 1000)},

            debug={

                "format": "json",

                "chunk_count": len(chunks),

                "include_mermaid": bool(include_mermaid),

                "source_mode": source_mode,

                "parser_requested": parser,

                "parser_used": "heuristic",

                "ginza_error": ginza_err

            }

        )



    return mermaid



def schema_probe(args: Dict[str, Any]) -> str:

    t0 = _now_ts()

    data = {

        "schema_version": PHASE2_SCHEMA_VERSION,

        "structured_commands": {

            "Lookup": {"aliases": ["lookup_struct", "lookup_v2", "lookup_json_v2"], "options": ["compact", "max_cards", "limit"]},

            "KanjiInfo": {"aliases": ["kanji_info", "kanjiinfo"], "options": ["db_path"]},

            "JLPTCheck": {"aliases": ["jlpt_check", "jlptcheck"], "options": ["compact", "limit"]},

            "ReadingAid": {"aliases": ["reading_aid", "readingaid"], "options": ["level_color", "compact_tokens", "limit", "target_level"]},

            "ParseTree": {"aliases": ["parse_tree", "parsetree", "parse_tree_json"], "options": ["format=json", "include_mermaid"]},

            "StyleShift": {"aliases": ["style_shift", "register_shift", "styleshift_json", "styleshift"], "options": ["target=polite/plain/formal/sonkei/kenjou(轻量分流)"]},

            "SentimentV2": {"aliases": ["sentiment_v2", "emotion_v2", "sentiment_hybrid", "sentiment"], "options": ["analyzer=janome/auto"]},

            "ConjugateV2": {"aliases": ["conjugate_v2", "verb_v2", "conjugate_hybrid"], "options": ["verb"]},

            "SentenceSplit": {"aliases": ["sentence_split", "sentencesplit"], "options": ["text", "split_backend=auto|ja_sentence_segmenter|budoux|regex"]},

            "ReadingEnhance": {"aliases": ["reading_enhance", "readingenhance"], "options": ["text/word", "romaji_engine=auto|pykakasi|cutlet"]},

            "SyntaxEnhance": {"aliases": ["syntax_enhance", "syntaxenhance"], "options": ["text", "parser=auto|ginza|heuristic"]},

            "SemanticEnhance": {"aliases": ["semantic_enhance", "semanticenhance"], "options": ["text", "style_backend=auto|rule|analyze-desumasu-dearu"]},

            "TeachingAssetsStatus": {"aliases": ["teaching_assets_status", "teachingassetsstatus"], "options": []},

            "OOVDrill": {"aliases": ["oov_drill", "oovdrill"], "options": ["text", "target_level", "oov_limit"]},

            "PitchAccent": {"aliases": ["pitch_accent", "accent", "pitch"], "options": ["word/text"]},

            "SchemaProbe": {"aliases": ["schema_probe", "probe_schema"], "options": []}

        }

    }

    return _mk_phase2_payload("SchemaProbe", True, data=data, meta={"elapsed_ms": int((_now_ts() - t0) * 1000)}, debug={"probe": "ok"})

# === PHASE2_UNIFIED_SCHEMA_END ===



def _hira_to_kata(text: str) -> str:

    out = []

    for ch in str(text or ""):

        c = ord(ch)

        if 0x3041 <= c <= 0x3096:

            out.append(chr(c + 0x60))

        else:

            out.append(ch)

    return "".join(out)



def _to_hankaku_ascii(text: str) -> str:

    s = str(text or "")

    try:

        return unicodedata.normalize("NFKC", s)

    except Exception:

        return s



def _safe_kana2alphabet(text: str) -> str:

    s = str(text or "")

    try:

        if jaconv is not None and hasattr(jaconv, "kana2alphabet"):

            return jaconv.kana2alphabet(s)

    except Exception:

        pass

    return s



_PYKAKASI_CONVERTER = None

_CUTLET_TRANSLATOR = None

_JANOME_TOKENIZER = None

_GINZA_NLP = None

_GINZA_LAST_ERROR = ""



def _get_pykakasi_converter():

    global _PYKAKASI_CONVERTER

    if pykakasi_kakasi is None:

        return None

    if _PYKAKASI_CONVERTER is not None:

        return _PYKAKASI_CONVERTER

    try:

        # New API holder (avoid deprecated getConverter/do)

        _PYKAKASI_CONVERTER = pykakasi_kakasi()

        return _PYKAKASI_CONVERTER

    except Exception:

        return None



def _get_cutlet_translator():

    global _CUTLET_TRANSLATOR

    if cutlet_pkg is None:

        return None

    if _CUTLET_TRANSLATOR is not None:

        return _CUTLET_TRANSLATOR

    try:

        _CUTLET_TRANSLATOR = cutlet_pkg.Cutlet()

        return _CUTLET_TRANSLATOR

    except Exception:

        return None



def _romanize_text_with_backend(text: str, engine: str = "auto") -> Tuple[str, str]:

    src = str(text or "")

    eng = str(engine or "auto").strip().lower()



    if eng in ("auto", "cutlet"):

        tr = _get_cutlet_translator()

        if tr is not None:

            try:

                out = str(tr.romaji(src) or "").strip()

                if out:

                    return out, "cutlet"

            except Exception:

                pass

        if eng == "cutlet":

            eng = "pykakasi"



    if eng in ("auto", "pykakasi"):

        conv = _get_pykakasi_converter()

        if conv is not None:

            try:

                arr = conv.convert(src)

                romaji_parts = []

                for it in arr:

                    if isinstance(it, dict):

                        v = str(it.get("hepburn") or it.get("kunrei") or it.get("passport") or it.get("orig") or "")

                        if v:

                            romaji_parts.append(v)

                out = " ".join([x for x in romaji_parts if x]).strip()

                if out:

                    return out, "pykakasi"

            except Exception:

                pass



    out = _safe_kana2alphabet(src)

    return out, "jaconv"



def _romanize_text_safe(text: str) -> str:

    out, _backend = _romanize_text_with_backend(text, engine="auto")

    return out



def _get_janome_tokenizer():

    global _JANOME_TOKENIZER

    if janome_tokenizer_cls is None:

        return None

    if _JANOME_TOKENIZER is not None:

        return _JANOME_TOKENIZER

    try:

        _JANOME_TOKENIZER = janome_tokenizer_cls()

        return _JANOME_TOKENIZER

    except Exception:

        return None



def janome_rows(text: str) -> List[Dict[str, str]]:

    tk = _get_janome_tokenizer()

    if tk is None:

        return []

    out: List[Dict[str, str]] = []

    try:

        for t in tk.tokenize(str(text or "")):

            surf = str(getattr(t, "surface", "") or "")

            if not surf:

                continue

            base = str(getattr(t, "base_form", "") or "")

            if (not base) or base == "*":

                base = surf

            reading = str(getattr(t, "reading", "") or "")

            if reading == "*":

                reading = ""

            reading = kata_to_hira(reading) if reading else ""

            pos = str(getattr(t, "part_of_speech", "") or "")

            pos = pos.replace(",", "-") if pos else "未知"

            out.append({

                "surface": surf,

                "lemma": base,

                "normalized": base,

                "pos": pos,

                "reading": reading,

                "meaning": ""

            })

    except Exception:

        return []

    return out



def _get_morph_rows(text: str, analyzer: str = "auto") -> Tuple[List[Dict[str, str]], str]:

    t = str(text or "")

    mode = str(analyzer or "auto").strip().lower()



    if mode in ("sudachi", "sudachipy"):

        r = sudachi_rows(t)

        return (r, "sudachi") if r else ([], "sudachi_failed")



    if mode in ("janome",):

        r = janome_rows(t)

        return (r, "janome") if r else ([], "janome_failed")



    # auto route

    r = sudachi_rows(t)

    if r:

        return r, "sudachi"

    r = janome_rows(t)

    if r:

        return r, "janome"



    # hard fallback

    fb: List[Dict[str, str]] = []

    for w in fallback_segment(t):

        info = lexicon_lookup(w) or {}

        fb.append({

            "surface": w,

            "lemma": w,

            "normalized": w,

            "pos": str(info.get("pos", "未知")),

            "reading": str(info.get("reading", "")),

            "meaning": str(info.get("meaning", "")),

        })

    return fb, "fallback_segment"



def _merge_kana_continuation_units(rows: List[Dict[str, str]]) -> List[Dict[str, str]]:

    merged: List[Dict[str, str]] = []

    i = 0

    while i < len(rows):

        cur = dict(rows[i] or {})

        surf = str(cur.get("surface", "")).strip()

        reading = str(cur.get("reading", "")).strip()

        if i + 1 < len(rows):

            nxt = dict(rows[i + 1] or {})

            nsurf = str(nxt.get("surface", "")).strip()

            nreading = str(nxt.get("reading", "")).strip()

            if surf and reading and reading.endswith("っ") and nsurf and nreading:

                if nsurf in ("て", "た", "で"):

                    cur["surface"] = surf + nsurf

                    cur["reading"] = reading + nreading

                    merged.append(cur)

                    i += 2

                    continue

        merged.append(cur)

        i += 1

    return merged



def tokenize_command(args: Dict[str, Any]) -> str:

    text = str(args.get("text") or args.get("sentence") or "").strip()

    if not text:

        return _mk_phase2_payload("tokenize", False, error="缺少参数：text")

    split_mode = str(args.get("split_mode") or "C").upper()

    analyzer = str(args.get("analyzer") or args.get("engine") or args.get("tokenizer") or "auto")



    rows, source_mode = _get_morph_rows(text, analyzer=analyzer)



    tokens = []

    for r in rows:

        tokens.append({

            "surface": str(r.get("surface", "")),

            "dictionary_form": str(r.get("lemma", "")),

            "reading": str(r.get("reading", "")),

            "pos": str(r.get("pos", "")),

            "conjugation": str(r.get("normalized", "")),

        })

    data = {"text": text, "split_mode": split_mode, "tokens": tokens}

    return _mk_phase2_payload(

        "tokenize",

        True,

        data=data,

        meta={"token_count": len(tokens), "elapsed_ms": 0},

        debug={"source_mode": source_mode, "requested_analyzer": analyzer}

    )



def romanize_command(args: Dict[str, Any]) -> str:

    text = str(args.get("text") or args.get("sentence") or "").strip()

    if not text:

        return _mk_phase2_payload("romanize", False, error="缺少参数：text")

    split_mode = str(args.get("split_mode") or "C").upper()

    analyzer = str(args.get("analyzer") or args.get("engine") or args.get("tokenizer") or "auto")

    romaji_engine = str(args.get("romaji_engine") or "auto").strip().lower()



    rows, source_mode = _get_morph_rows(text, analyzer=analyzer)

    merged_rows = _merge_kana_continuation_units(rows)



    parts = []

    backend_used = "unknown"

    if merged_rows:

        for r in merged_rows:

            reading = str(r.get("reading", "")).strip()

            surf = str(r.get("surface", "")).strip()

            if reading:

                out, backend_used = _romanize_text_with_backend(reading, engine=romaji_engine)

                parts.append(out)

            elif surf:

                out, backend_used = _romanize_text_with_backend(surf, engine=romaji_engine)

                parts.append(out)

    else:

        out, backend_used = _romanize_text_with_backend(text, engine=romaji_engine)

        parts.append(out)



    romanized = " ".join([p for p in parts if p]).strip()

    data = {"text": text, "split_mode": split_mode, "romanized": romanized, "romaji_engine": backend_used}

    return _mk_phase2_payload(

        "romanize",

        True,

        data=data,

        meta={"token_count": len(merged_rows), "elapsed_ms": 0},

        debug={"source_mode": source_mode, "requested_analyzer": analyzer, "requested_romaji_engine": romaji_engine, "backend_used": backend_used}

    )



def convert_command(args: Dict[str, Any]) -> str:

    text = str(args.get("text") or args.get("sentence") or "")

    mode = str(args.get("mode") or "normalize").strip().lower()

    if not text:

        return _mk_phase2_payload("convert", False, error="缺少参数：text")

    out = text

    if mode == "normalize":

        out = normalize_text(text)

    elif mode == "h2z":

        try:

            if jaconv is not None:

                out = jaconv.h2z(text, kana=True, ascii=False, digit=False)

        except Exception:

            out = text

    elif mode == "z2h":

        out = _to_hankaku_ascii(text)

    elif mode == "hira2kata":

        out = _hira_to_kata(text)

    elif mode == "kata2hira":

        out = kata_to_hira(text)

    elif mode == "kana2alphabet":

        out = _safe_kana2alphabet(text)

    else:

        return _mk_phase2_payload("convert", False, error=f"不支持的 mode: {mode}")

    return _mk_phase2_payload("convert", True, data={"text": text, "mode": mode, "value": out}, meta={"elapsed_ms": 0})



def normalize_command(args: Dict[str, Any]) -> str:

    text = str(args.get("text") or args.get("sentence") or "")

    if not text:

        return _mk_phase2_payload("normalize", False, error="缺少参数：text")

    norm = normalize_text(text)

    segs = split_sentences(norm)

    rows = sudachi_rows(norm)

    tokens_preview = []

    for r in rows[:10]:

        tokens_preview.append({

            "surface": str(r.get("surface", "")),

            "dictionary_form": str(r.get("lemma", "")),

            "reading": str(r.get("reading", "")),

            "pos": str(r.get("pos", "")),

            "conjugation": str(r.get("normalized", "")),

        })

    data = {"text": text, "normalized": norm, "segments": segs, "token_count": len(rows), "tokens_preview": tokens_preview}

    return _mk_phase2_payload("normalize", True, data=data, meta={"elapsed_ms": 0})



def _detect_style_register(text: str) -> Dict[str, Any]:

    t = str(text or "").strip()

    polite_patterns = [r"です", r"ます", r"でした", r"ました", r"ません", r"でしょう", r"ください"]

    plain_patterns = [r"である", r"\bだ\b", r"ない。?$", r"だ。?$", r"と思う", r"じゃない", r"ではない"]

    formal_markers = [r"である", r"ものとする", r"べきである", r"と考えられる", r"ございます", r"いたします"]



    polite_hits = sum(1 for p in polite_patterns if re.search(p, t))

    plain_hits = sum(1 for p in plain_patterns if re.search(p, t))

    formal_hits = sum(1 for p in formal_markers if re.search(p, t))



    # 形态素补强：补捉「来る/行く/〜い形容词」等普通体终止

    morph_plain_hits = 0

    try:

        rows, _src = _get_morph_rows(t, analyzer="auto")

        for r in rows:

            if is_noise_token(r):

                continue

            pos = str(r.get("pos", ""))

            surf = str(r.get("surface", ""))

            if not surf:

                continue



            if pos.startswith("動詞"):

                # 已是敬体则跳过

                if re.search(r"(ます|ません|ました|ましょう)$", surf):

                    continue

                if surf.endswith(("る", "う", "く", "ぐ", "す", "つ", "ぬ", "ぶ", "む", "た", "だ", "ない")):

                    morph_plain_hits += 1

            elif pos.startswith("形容詞"):

                # い形容词终止（非です结尾）

                if surf.endswith("い") and (not surf.endswith("です")):

                    morph_plain_hits += 1

    except Exception:

        pass



    if morph_plain_hits > 0 and polite_hits == 0:

        plain_hits += 1



    if polite_hits > 0 and plain_hits == 0:

        style_id = "polite"

        style = "polite(です/ます体)"

    elif plain_hits > 0 and polite_hits == 0:

        style_id = "plain"

        style = "plain(普通体)"

    elif polite_hits > 0 and plain_hits > 0:

        style_id = "mixed"

        style = "mixed(语体混用)"

    else:

        style_id = "neutral"

        style = "neutral/undetermined"



    register = "formal" if formal_hits > 0 else "normal"

    return {

        "style_id": style_id,

        "style": style,

        "register": register,

        "polite_hits": polite_hits,

        "plain_hits": plain_hits,

        "formal_hits": formal_hits,

        "morph_plain_hits": morph_plain_hits

    }



def _detect_style_register_sentencewise(text: str) -> Dict[str, Any]:

    t = str(text or "").strip()

    if not t:

        return {

            "style_id": "neutral",

            "style": "neutral/undetermined",

            "register": "normal",

            "polite_hits": 0,

            "plain_hits": 0,

            "formal_hits": 0,

            "morph_plain_hits": 0

        }



    sentences = split_sentences(t)

    if not sentences:

        sentences = [t]



    polite_sentence_hits = 0

    plain_sentence_hits = 0

    formal_hits = 0

    morph_plain_hits = 0



    polite_terminal = re.compile(r"(です|ます|でした|ました|ません|ましょう|でしょう|ください|下さい)([。！？!?]*)$")

    formal_terminal = re.compile(r"(である|ものとする|べきである|と考えられる|でございます|ございます|いたします|いたしました)([。！？!?]*)$")

    plain_terminal = re.compile(r"(だ|だった|である|ではない|じゃない|と思う|かもしれない|に違いない|はずだ|つもりだ|ようだ|らしい|ない|なかった)([。！？!?]*)$")



    for sent in sentences:

        s = str(sent or "").strip()

        if not s:

            continue



        if polite_terminal.search(s):

            polite_sentence_hits += 1

            continue



        if formal_terminal.search(s):

            formal_hits += 1

            plain_sentence_hits += 1

            continue



        if plain_terminal.search(s):

            plain_sentence_hits += 1

            continue



        try:

            rows, _src = _get_morph_rows(s, analyzer="auto")

        except Exception:

            rows = []



        vis_rows = [r for r in rows if not is_noise_token(r)]

        if not vis_rows:

            continue



        last = vis_rows[-1]

        surf = str(last.get("surface", "")).strip()

        pos = str(last.get("pos", "")).strip()



        if re.search(r"(です|ます|でした|ました|ません|ましょう|でしょう)$", surf):

            polite_sentence_hits += 1

            continue



        if pos.startswith("動詞"):

            plain_sentence_hits += 1

            morph_plain_hits += 1

            continue



        if pos.startswith("形容詞") and surf.endswith("い"):

            plain_sentence_hits += 1

            morph_plain_hits += 1

            continue



        if surf in ("だ", "だった", "である", "ではない", "じゃない"):

            plain_sentence_hits += 1

            morph_plain_hits += 1



    if polite_sentence_hits > 0 and plain_sentence_hits == 0:

        style_id = "polite"

        style = "polite(です/ます体)"

    elif plain_sentence_hits > 0 and polite_sentence_hits == 0:

        style_id = "plain"

        style = "plain(普通体)"

    elif polite_sentence_hits > 0 and plain_sentence_hits > 0:

        style_id = "mixed"

        style = "mixed(语体混用)"

    else:

        style_id = "neutral"

        style = "neutral/undetermined"



    register = "formal" if formal_hits > 0 else "normal"

    return {

        "style_id": style_id,

        "style": style,

        "register": register,

        "polite_hits": polite_sentence_hits,

        "plain_hits": plain_sentence_hits,

        "formal_hits": formal_hits,

        "morph_plain_hits": morph_plain_hits

    }



def style_check(text: str) -> str:

    text = str(text or "").strip()

    if not text:

        return "缺少 text/sentence 参数。"



    det = _detect_style_register_sentencewise(text)



    lines = [

        "### 文体检查（Style Check）",

        f"- 原文: {text}",

        f"- style: {det.get('style')}",

        f"- register: {det.get('register')}",

        f"- polite_hits: {det.get('polite_hits')}",

        f"- plain_hits: {det.get('plain_hits')}",

        f"- formal_markers: {det.get('formal_hits')}",

        f"- morph_plain_hits: {det.get('morph_plain_hits')}",

        "",

        "#### 建议"

    ]



    if det.get("style_id") == "mixed":

        lines.append("- 当前句子可能存在敬体与常体混用，建议统一为一种语体。")

    elif det.get("style_id") == "plain":

        lines.append("- 当前偏普通体，正式场景可改为 です/ます 体。")

    elif det.get("style_id") == "polite":

        lines.append("- 当前敬体一致性良好。")

    else:

        lines.append("- 未识别到明显语体标记，可结合上下文复核。")



    return "\n".join(lines)

def _apply_style_rules(text: str, rules: List[Tuple[str, str, str]], changes: List[Dict[str, Any]], ctype: str) -> str:

    out = str(text or "")

    for patt, repl, note in rules:

        try:

            out2, n = re.subn(patt, repl, out)

            if n > 0:

                changes.append({

                    "type": ctype,

                    "from": patt,

                    "to": repl,

                    "count": int(n),

                    "note": note

                })

                out = out2

        except Exception:

            continue

    return out



def style_shift(args: Dict[str, Any]) -> str:

    text = str(args.get("text") or args.get("sentence") or "").strip()

    target = str(args.get("target") or "polite").strip().lower()

    source_hint = str(args.get("source") or "auto").strip().lower()



    if not text:

        return "缺少参数：text/sentence。"

    if target not in ("polite", "plain", "formal", "sonkei", "sonkeigo", "kenjou", "kenjougo"):

        return "不支持的 target。可用：polite | plain | formal | sonkei | kenjou"



    det = _detect_style_register(text)

    detected_source = det.get("style_id", "neutral")

    source = detected_source if source_hint in ("", "auto") else source_hint



    changes: List[Dict[str, Any]] = []

    risks: List[str] = []

    out = text



    if detected_source == "mixed":

        risks.append("输入检测为 mixed(语体混用)，转换后建议人工复核语体一致性。")



    polite_rules = [

        (r"である", "です", "断定体 -> 敬体"),

        (r"だ。?$", "です。", "句末断定 -> 敬体"),

        (r"する", "します", "动词敬体化"),

        (r"した", "しました", "过去式敬体化"),

        (r"いる", "います", "存在动词敬体化"),

        (r"ある", "あります", "存在动词敬体化"),

        (r"行く", "行きます", "动词敬体化"),

        (r"来る", "来ます", "动词敬体化"),

        (r"食べる", "食べます", "动词敬体化"),

        (r"見る", "見ます", "动词敬体化"),

        (r"読む", "読みます", "动词敬体化"),

    ]

    plain_rules = [

        (r"でございます", "です", "过敬体回落"),

        (r"です。?$", "だ。", "敬体 -> 断定体"),

        (r"でした", "だった", "过去式普通体"),

        (r"します", "する", "动词普通体化"),

        (r"しました", "した", "过去式普通体"),

        (r"います", "いる", "存在动词普通体"),

        (r"ありました", "あった", "过去存在普通体"),

        (r"あります", "ある", "存在普通体"),

        (r"行きます", "行く", "动词普通体化"),

        (r"来ます", "来る", "动词普通体化"),

        (r"食べます", "食べる", "动词普通体化"),

        (r"見ます", "見る", "动词普通体化"),

        (r"読みます", "読む", "动词普通体化"),

    ]

    formal_rules = [

        (r"します", "いたします", "谦逊敬语"),

        (r"しました", "いたしました", "谦逊敬语过去"),

        (r"する", "いたします", "普通体 -> 谦逊敬语"),

        (r"です", "でございます", "郑重敬语"),

        (r"でした", "でございました", "郑重敬语过去"),

        (r"あります", "ございます", "郑重表达"),

        (r"ある", "ございます", "普通体 -> 郑重表达"),

    ]



    if target == "polite":

        out = _apply_style_rules(out, polite_rules, changes, "polite")

    elif target == "plain":

        out = _apply_style_rules(out, plain_rules, changes, "plain")

    else:

        out = _apply_style_rules(out, polite_rules, changes, "polite_pre")

        if target in ("sonkei", "sonkeigo"):

            out = _apply_style_rules(out, formal_rules, changes, "sonkei")

            out = out.replace("来ます", "いらっしゃいます").replace("行きます", "いらっしゃいます")

        elif target in ("kenjou", "kenjougo"):

            out = _apply_style_rules(out, formal_rules, changes, "kenjou")

            out = out.replace("来ます", "参ります").replace("行きます", "参ります")

        else:

            out = _apply_style_rules(out, formal_rules, changes, "formal")



    if not changes:

        risks.append("未检测到可安全替换的显式语体标记，可能已接近目标语体。")



    if target == "formal" and re.search(r"[！!？?]|(ぞ|ぜ|わ|っす)\b", text):

        risks.append("原句含口语语气词/强情绪标记，formal 转换可能不自然。")

    if len(changes) >= 8:

        risks.append("替换项较多，建议人工复核语义是否偏移。")

    if re.search(r"(でございますます|いたしますます|ございますです)", out):

        risks.append("检测到潜在不自然连缀，请人工润色。")



    lines = [

        "### 文体转换（style_shift / register_shift）",

        f"- source: {source}",

        f"- detected_source: {det.get('style')}",

        f"- target: {target}",

        f"- rewritten: {out}",

        "",

        "#### 变化点"

    ]



    if changes:

        for i, c in enumerate(changes, 1):

            lines.append(

                f"{i}. [{c.get('type')}] {c.get('from')} -> {c.get('to')} ×{c.get('count')} ({c.get('note')})"

            )

    else:

        lines.append("- 无显式变换。")



    lines.append("")

    lines.append("#### 风险提示")

    if risks:

        for r in risks:

            lines.append(f"- {r}")

    else:

        lines.append("- 未发现明显风险。")



    return "\n".join(lines)



def style_shift_json(args: Dict[str, Any]) -> str:

    rendered = style_shift(args)

    rewritten = ""

    detected_source = ""

    target = str(args.get("target") or "polite").strip().lower()

    rendered_norm = rendered.replace("\\n", "\n")



    for _line in rendered_norm.splitlines():

        _line = _line.strip()

        if _line.startswith("- rewritten:"):

            rewritten = _line.split(":", 1)[1].strip()

        elif _line.startswith("- detected_source:"):

            detected_source = _line.split(":", 1)[1].strip()



    ok = True

    if rendered.startswith("缺少参数") or rendered.startswith("不支持的 target"):

        ok = False



    payload = {

        "ok": ok,

        "schema_version": PHASE2_SCHEMA_VERSION,

        "command": "StyleShift",

        "data": {

            "text": str(args.get("text") or args.get("sentence") or ""),

            "target": target,

            "detected_source": detected_source,

            "rewritten": rewritten,

            "rendered": rendered

        }

    }

    if not ok:

        payload["error"] = {"code": "INVALID_ARGUMENT", "message": rendered}

    return json.dumps(payload, ensure_ascii=False)



def sentiment_hybrid_json(args: Dict[str, Any]) -> str:

    t = str(args.get("text") or args.get("sentence") or "").strip()

    if not t:

        return json.dumps({

            "ok": False,

            "schema_version": PHASE2_SCHEMA_VERSION,

            "command": "SentimentV2",

            "error": {"code": "MISSING_TEXT", "message": "缺少参数：text"}

        }, ensure_ascii=False)

    # Hybrid: token + lexicon + rule

    req_analyzer = str(args.get("analyzer") or "auto")

    rows, source_mode = _get_morph_rows(t, analyzer=req_analyzer)



    pos_words = {"嬉しい","楽しい","最高","好き","良い","よい","助かる","ありがとう","安心","幸せ","素晴らしい","成功","満足"}

    neg_words = {"悲しい","つらい","辛い","嫌い","最悪","不安","怒り","腹立つ","疲れた","怖い","失敗","不満","面倒"}



    pos_hits = 0

    neg_hits = 0



    for r in rows:

        surf = str(r.get("surface", ""))

        lemma = str(r.get("lemma", ""))

        cand = {surf, lemma}

        if cand & pos_words:

            pos_hits += 1

        if cand & neg_words:

            neg_hits += 1



    # rule boost

    pos_rule = sum(1 for w in pos_words if w in t)

    neg_rule = sum(1 for w in neg_words if w in t)



    raw = (pos_hits - neg_hits) + 0.8 * (pos_rule - neg_rule)

    denom = max(1.0, min(8.0, float(len(rows) if rows else 1)))

    score_raw = raw / denom



    label = "neutral"

    if score_raw > 0.12:

        label = "positive"

    elif score_raw < -0.12:

        label = "negative"



    score = max(0.0, min(1.0, round((score_raw + 1.0) / 2.0, 3)))



    return json.dumps({

        "ok": True,

        "schema_version": PHASE2_SCHEMA_VERSION,

        "command": "SentimentV2",

        "data": {

            "text": t,

            "label": label,

            "score": score,

            "raw_score": round(score_raw, 3),

            "pos_hits": int(pos_hits + pos_rule),

            "neg_hits": int(neg_hits + neg_rule),

            "source": f"hybrid({source_mode})",

            "requested_analyzer": req_analyzer

        }

    }, ensure_ascii=False)



def _module_available(module_name: str) -> bool:

    name = str(module_name or "").strip()

    if not name:

        return False

    try:

        import importlib.util as _iu

        return _iu.find_spec(name) is not None

    except Exception:

        return False



def sentence_split_command(args: Dict[str, Any]) -> str:

    t0 = _now_ts()

    text = str(args.get("text") or args.get("sentence") or "").strip()

    if not text:

        return _mk_phase2_payload("SentenceSplit", False, error="缺少参数：text/sentence")



    split_backend = str(args.get("split_backend") or "auto").strip().lower()



    segs = []

    source_mode = "regex"



    if split_backend in ("auto", "ja_sentence_segmenter", "segmenter") and ja_sentence_segmenter_pkg is not None:

        try:

            out = []

            if hasattr(ja_sentence_segmenter_pkg, "split"):

                out = list(ja_sentence_segmenter_pkg.split(text))

            elif hasattr(ja_sentence_segmenter_pkg, "segment"):

                out = list(ja_sentence_segmenter_pkg.segment(text))

            elif hasattr(ja_sentence_segmenter_pkg, "SentenceSegmenter"):

                seg = ja_sentence_segmenter_pkg.SentenceSegmenter()

                if hasattr(seg, "split"):

                    out = list(seg.split(text))

            out = [x for x in out if str(x).strip()]

            if out:

                segs = out

                source_mode = "ja_sentence_segmenter"

        except Exception:

            pass



    if not segs:

        segs = split_sentences(text)

        source_mode = "budoux" if (_get_budoux_parser() is not None) else "regex"



    if not segs:

        segs = [x for x in re.split(r"(?<=[。！？!?])", text) if x and x.strip()]

        source_mode = "regex"



    data = {"text": text, "sentence_count": len(segs), "sentences": segs}

    return _mk_phase2_payload(

        "SentenceSplit", True, data=data,

        meta={"elapsed_ms": int((_now_ts() - t0) * 1000)},

        debug={"source_mode": source_mode, "split_backend_requested": split_backend}

    )



def reading_enhance_command(args: Dict[str, Any]) -> str:

    t0 = _now_ts()

    text = str(args.get("text") or args.get("sentence") or args.get("word") or "").strip()

    if not text:

        return _mk_phase2_payload("ReadingEnhance", False, error="缺少参数：text/sentence/word")

    romaji_engine = str(args.get("romaji_engine") or "auto").strip().lower()

    rows, source_mode = _get_morph_rows(text, analyzer="auto")

    merged_rows = _merge_kana_continuation_units(rows)

    items = []

    backend_used = "unknown"

    for r in merged_rows:

        if is_noise_token(r):

            continue

        surf = str(r.get("surface", "")).strip()

        if not surf:

            continue

        lemma = str(r.get("lemma", "")).strip() or surf

        reading = str(r.get("reading", "")).strip()

        if not reading:

            info = lexicon_lookup(lemma) or lexicon_lookup(surf) or {}

            reading = str(info.get("reading", "")).strip()

        romaji, backend_used = _romanize_text_with_backend(reading or surf, engine=romaji_engine)

        items.append({

            "surface": surf,

            "lemma": lemma,

            "reading": reading,

            "romaji": romaji,

            "pos": str(r.get("pos", "")),

            "jlpt": jlpt_level_for_token(r) or "未知"

        })

    data = {

        "text": text,

        "token_count": len(items),

        "items": items,

        "reading_text": "".join([str(x.get("reading", "")) for x in items if str(x.get("reading", ""))]),

        "romaji_text": " ".join([str(x.get("romaji", "")) for x in items if str(x.get("romaji", ""))]).strip(),

        "romaji_engine": backend_used,

        "optional_packages": {

            "cutlet": _module_available("cutlet"),

            "marine": _module_available("marine")

        }

    }

    return _mk_phase2_payload(

        "ReadingEnhance", True, data=data,

        meta={"elapsed_ms": int((_now_ts() - t0) * 1000)},

        debug={"source_mode": source_mode, "requested_romaji_engine": romaji_engine, "backend_used": backend_used}

    )



def syntax_enhance_command(args: Dict[str, Any]) -> str:

    t0 = _now_ts()

    text = str(args.get("text") or args.get("sentence") or "").strip()

    if not text:

        return _mk_phase2_payload("SyntaxEnhance", False, error="缺少参数：text/sentence")



    parser = str(args.get("parser") or "auto").strip().lower()



    if parser in ("auto", "ginza"):

        nlp = _get_ginza_nlp()

        if nlp is not None:

            try:

                doc = nlp(text)

                tokens = []

                edges = []

                for t in doc:

                    idx = int(t.i)

                    head_i = int(t.head.i) if getattr(t, "head", None) is not None else idx

                    dep = str(t.dep_) if getattr(t, "dep_", None) else ""

                    pos = str(t.pos_) if getattr(t, "pos_", None) else ""

                    lemma = str(t.lemma_) if getattr(t, "lemma_", None) else str(t.text)

                    tokens.append({

                        "i": idx,

                        "surface": str(t.text),

                        "lemma": lemma,

                        "pos": pos,

                        "dep": dep,

                        "head_i": head_i

                    })

                    if dep != "ROOT" and head_i != idx:

                        edges.append({"from": head_i, "to": idx, "dep": dep})



                data = {

                    "text": text,

                    "parser_used": "ginza",

                    "token_count": len(tokens),

                    "tokens": tokens,

                    "dependency_edges": edges,

                    "optional_packages": {

                        "ginza": bool(ginza_pkg is not None),

                        "spacy": bool(spacy is not None),

                        "esupar": _module_available("esupar"),

                        "kwja": _module_available("kwja"),

                        "unidic2ud": _module_available("unidic2ud")

                    }

                }

                return _mk_phase2_payload(

                    "SyntaxEnhance", True, data=data,

                    meta={"elapsed_ms": int((_now_ts() - t0) * 1000)},

                    debug={"parser_requested": parser, "parser_used": "ginza"}

                )

            except Exception as e:

                if parser == "ginza":

                    return _mk_phase2_payload(

                        "SyntaxEnhance", False,

                        error=f"GiNZA 解析失败: {e}",

                        meta={"elapsed_ms": int((_now_ts() - t0) * 1000)}

                    )



    rows, source_mode = _get_morph_rows(text, analyzer="auto")

    chunks = []

    for r in rows:

        if is_noise_token(r):

            continue

        grp = _phase5_group_for_pos(str(r.get("pos", "")))

        tk = {

            "surface": str(r.get("surface", "")),

            "lemma": str(r.get("lemma", "")),

            "pos": str(r.get("pos", "")),

            "reading": str(r.get("reading", "")),

            "jlpt": jlpt_level_for_token(r) or "未知"

        }

        if (not chunks) or (chunks[-1].get("group") != grp):

            chunks.append({"group": grp, "tokens": [tk]})

        else:

            chunks[-1]["tokens"].append(tk)

    data = {

        "text": text,

        "parser_used": "heuristic",

        "chunk_count": len(chunks),

        "chunks": chunks,

        "optional_packages": {

            "ginza": bool(ginza_pkg is not None),

            "spacy": bool(spacy is not None),

            "esupar": _module_available("esupar"),

            "kwja": _module_available("kwja"),

            "unidic2ud": _module_available("unidic2ud")

        }

    }

    return _mk_phase2_payload(

        "SyntaxEnhance", True, data=data,

        meta={"elapsed_ms": int((_now_ts() - t0) * 1000)},

        debug={"parser_requested": parser, "parser_used": "heuristic", "source_mode": source_mode}

    )



def _detect_style_register_with_backend(text: str, backend: str = "auto") -> Dict[str, Any]:

    t = str(text or "").strip()

    b = str(backend or "auto").strip().lower()



    if b in ("auto", "analyze-desumasu-dearu", "analyze_desumasu_dearu", "desumasu"):

        if add_style_pkg is not None:

            try:

                result = None

                if hasattr(add_style_pkg, "analyze"):

                    result = add_style_pkg.analyze(t)

                elif hasattr(add_style_pkg, "detect"):

                    result = add_style_pkg.detect(t)



                if isinstance(result, dict):

                    style_raw = str(result.get("style") or result.get("label") or "").strip().lower()

                    if ("mixed" in style_raw) or ("mix" in style_raw):

                        style_id = "mixed"

                        style = "mixed(语体混用)"

                    elif ("desu" in style_raw) or ("masu" in style_raw) or ("polite" in style_raw):

                        style_id = "polite"

                        style = "polite(です/ます体)"

                    elif ("dearu" in style_raw) or ("plain" in style_raw) or ("casual" in style_raw):

                        style_id = "plain"

                        style = "plain(普通体)"

                    else:

                        style_id = "neutral"

                        style = "neutral/undetermined"



                    return {

                        "style_id": style_id,

                        "style": style,

                        "register": "normal",

                        "polite_hits": 0,

                        "plain_hits": 0,

                        "formal_hits": 0,

                        "morph_plain_hits": 0,

                        "backend_used": "analyze-desumasu-dearu"

                    }

            except Exception:

                pass



    if b != "auto":

        det = _detect_style_register_sentencewise(t)

        det["backend_used"] = "rule-fallback"

        return det



    det = _detect_style_register_sentencewise(t)

    det["backend_used"] = "rule"

    return det



def semantic_enhance_command(args: Dict[str, Any]) -> str:

    t0 = _now_ts()

    text = str(args.get("text") or args.get("sentence") or "").strip()

    if not text:

        return _mk_phase2_payload("SemanticEnhance", False, error="缺少参数：text/sentence")

    senti = {}

    try:

        sraw = sentiment_hybrid_json({"text": text, "analyzer": str(args.get("analyzer") or "auto")})

        sobj = json.loads(sraw)

        if isinstance(sobj, dict):

            senti = sobj.get("data", {}) if isinstance(sobj.get("data", {}), dict) else {}

    except Exception:

        senti = {}

    # 默认使用 rule，避免 optional style backend 对单句礼貌体的 mixed 误判

    style_backend = str(args.get("style_backend") or "rule").strip().lower()

    reg = _detect_style_register_with_backend(text, backend=style_backend)

    data = {

        "text": text,

        "sentiment": {

            "label": str(senti.get("label", "neutral")),

            "score": float(senti.get("score", 0.5)) if str(senti.get("score", "")).strip() != "" else 0.5,

            "raw_score": senti.get("raw_score", 0.0),

            "source": str(senti.get("source", "hybrid"))

        },

        "register": {

            "style_id": str(reg.get("style_id", "neutral")),

            "style": str(reg.get("style", "neutral/undetermined")),

            "register": str(reg.get("register", "normal")),

            "polite_hits": int(reg.get("polite_hits", 0)),

            "plain_hits": int(reg.get("plain_hits", 0)),

            "formal_hits": int(reg.get("formal_hits", 0)),

            "backend_used": str(reg.get("backend_used", "rule"))

        },

        "optional_packages": {

            "chikkarpy": _module_available("chikkarpy"),

            "analyze_desumasu_dearu": _module_available("analyze_desumasu_dearu"),

            "oseti": _module_available("oseti")

        }

    }

    return _mk_phase2_payload(

        "SemanticEnhance", True, data=data,

        meta={"elapsed_ms": int((_now_ts() - t0) * 1000)},

        debug={"source_mode": "hybrid_semantic", "style_backend_requested": style_backend, "style_backend_used": str(reg.get("backend_used", "rule"))}

    )



def teaching_assets_status_command(args: Dict[str, Any]) -> str:

    t0 = _now_ts()

    base = PLUGIN_DIR

    def _ok(rel: str) -> bool:

        try:

            return os.path.exists(os.path.join(base, rel))

        except Exception:

            return False

    files = {

        "JapaneseHelper.py": _ok("JapaneseHelper.py"),

        "plugin-manifest.json": _ok("plugin-manifest.json"),

        "README.md": _ok("README.md"),

        "config.env": _ok("config.env"),

        "config.env.example": _ok("config.env.example"),

        "requirements.txt": _ok("requirements.txt"),

        "requirements.optional.txt": _ok("requirements.optional.txt")

    }

    optional_packages = {

        "cutlet": _module_available("cutlet"),

        "marine": _module_available("marine"),

        "esupar": _module_available("esupar"),

        "kwja": _module_available("kwja"),

        "unidic2ud": _module_available("unidic2ud"),

        "chikkarpy": _module_available("chikkarpy"),

        "yurenizer": _module_available("yurenizer"),

        "pykatsuyou": _module_available("pykatsuyou"),

        "analyze_desumasu_dearu": _module_available("analyze_desumasu_dearu"),

        "kanjize": _module_available("kanjize")

    }

    data_assets = {

        "jdict_full_sqlite": {"path": str(os.environ.get("JMDICT_FULL_DB_PATH") or "./data/db/jdict_full.sqlite"), "exists": _ok("data/db/jdict_full.sqlite")},

        "grammar_explainers_ext": {"path": "./grammar_explainers_ext.json", "exists": _ok("grammar_explainers_ext.json")},

        "pitch_accent_ext": {"path": "./pitch_accent_ext.json", "exists": _ok("pitch_accent_ext.json")},

        "data_provenance": {"path": "./DATA_PROVENANCE.md", "exists": _ok("DATA_PROVENANCE.md")}

    }

    data = {"files": files, "optional_packages": optional_packages, "data_assets": data_assets}

    return _mk_phase2_payload(

        "TeachingAssetsStatus", True, data=data,

        meta={"elapsed_ms": int((_now_ts() - t0) * 1000)},

        debug={}

    )



def oov_drill_command(args: Dict[str, Any]) -> str:

    t0 = _now_ts()

    text = str(args.get("text") or args.get("sentence") or "").strip()

    if not text:

        return _mk_phase2_payload("OOVDrill", False, error="缺少参数：text/sentence")

    raw = reading_aid_v2(args)

    try:

        obj = json.loads(raw)

    except Exception:

        return _mk_phase2_payload("OOVDrill", False, error="ReadingAidV2 非JSON输出", meta={"elapsed_ms": int((_now_ts() - t0) * 1000)})

    if not isinstance(obj, dict) or (not bool(obj.get("ok"))):

        msg = str(obj.get("error", "ReadingAidV2失败")) if isinstance(obj, dict) else "ReadingAidV2失败"

        return _mk_phase2_payload("OOVDrill", False, error=msg, data={"base": obj if isinstance(obj, dict) else {}}, meta={"elapsed_ms": int((_now_ts() - t0) * 1000)})

    d = obj.get("data", {}) if isinstance(obj.get("data", {}), dict) else {}

    data = {

        "text": str(d.get("text") or text),

        "target_level": str(d.get("target_level") or args.get("target_level") or "N3"),

        "oov_count": int(d.get("oov_count", 0) or 0),

        "oov_words": list(d.get("oov_words", []) or []),

        "oov_drill_count": int(d.get("oov_drill_count", 0) or 0),

        "oov_drill": list(d.get("oov_drill", []) or [])

    }

    return _mk_phase2_payload(

        "OOVDrill", True, data=data,

        meta={"elapsed_ms": int((_now_ts() - t0) * 1000)},

        debug={"source_mode": "reading_aid_v2"}

    )



def process_request(args: Dict[str, Any]) -> str:

    raw_cmd = str(args.get("command") or args.get("action") or "analyze_sentence").strip()

    cmd = raw_cmd.lower()



    # Phase2: 结构化JSON规范（新命令 + CamelCase别名）

    if raw_cmd == "Lookup" or cmd in ("lookup_struct", "lookup_v2", "lookup_json_v2"):

        return lookup_structured(args)

    if raw_cmd == "KanjiInfo" or cmd in ("kanji_info", "kanjiinfo"):

        return kanji_info_structured(args)

    if raw_cmd == "JLPTCheck" or cmd in ("jlpt_check", "jlptcheck"):

        return jlpt_check_structured(args)

    if raw_cmd == "ReadingAid" or cmd in ("reading_aid", "readingaid"):

        return reading_aid(args)

    if raw_cmd == "ReadingAidV2" or cmd in ("reading_aid_v2", "readingaid_v2", "reading_aid_hybrid"):

        return reading_aid_v2(args)

    if raw_cmd == "ParseTree" or cmd in ("parse_tree", "parsetree"):

        return parse_tree_mermaid(args)

    if cmd in ("parse_tree_json",):

        _a = dict(args or {})

        _a["format"] = "json"

        return parse_tree_mermaid(_a)



    if raw_cmd == "SchemaProbe" or cmd in ("schema_probe", "probe_schema"):

        return schema_probe(args)



    if raw_cmd == "Tokenize" or cmd == "tokenize":

        return tokenize_command(args)

    if raw_cmd == "Romanize" or cmd == "romanize":

        return romanize_command(args)

    if raw_cmd == "Convert" or cmd == "convert":

        return convert_command(args)

    if raw_cmd == "Normalize" or cmd == "normalize":

        return normalize_command(args)

    if raw_cmd == "SentenceSplit" or cmd in ("sentence_split", "sentencesplit"):

        return sentence_split_command(args)

    if raw_cmd == "ReadingEnhance" or cmd in ("reading_enhance", "readingenhance"):

        return reading_enhance_command(args)

    if raw_cmd == "SyntaxEnhance" or cmd in ("syntax_enhance", "syntaxenhance"):

        return syntax_enhance_command(args)

    if raw_cmd == "SemanticEnhance" or cmd in ("semantic_enhance", "semanticenhance"):

        return semantic_enhance_command(args)

    if raw_cmd == "TeachingAssetsStatus" or cmd in ("teaching_assets_status", "teachingassetsstatus"):

        return teaching_assets_status_command(args)

    if raw_cmd == "OOVDrill" or cmd in ("oov_drill", "oovdrill"):

        return oov_drill_command(args)

    if cmd in ("analyze_sentence", "analyze", "parse"):

        return analyze_sentence(
            str(args.get("text") or args.get("sentence") or ""),
            strict_grammar=as_bool(args.get("strict_grammar"), False)
        )

    if cmd in ("lookup_word", "lookup", "dict", "dictionary"):

        return lookup_word(

            str(args.get("word") or args.get("keyword") or args.get("text") or ""),

            online_mode=str(args.get("online_mode") or ""),

            use_parallel_online=as_bool(args.get("use_parallel_online"), True),

            force_online=as_bool(args.get("force_online"), False),

            context_text=str(args.get("context") or args.get("context_text") or args.get("sentence") or "")

        )

    if cmd in ("lookup_word_json", "lookup_json", "dict_json"):

        obj = lookup_word_json(args)

        return json.dumps(obj, ensure_ascii=False)

    if cmd in ("add_furigana", "furigana", "ruby", "kana"):

        return add_furigana(

            str(args.get("text") or args.get("sentence") or ""),

            str(args.get("mode") or "ruby")

        )

    if cmd in ("conjugate_verb", "conjugate", "verb"):

        return conjugate_verb(str(args.get("verb") or args.get("word") or args.get("text") or ""))

    if raw_cmd == "ConjugateV2" or cmd in ("conjugate_v2", "verb_v2", "conjugate_hybrid", "conjugatev2"):

        return conjugate_verb_v2(args)

    if cmd in ("srs_schedule", "srs", "schedule"):

        return srs_schedule(args)

    if cmd in ("fsrs_schedule", "fsrs"):

        return fsrs_schedule(args)

    if cmd in ("extract_vocab", "vocab", "extract"):

        return extract_vocab(str(args.get("text") or args.get("sentence") or ""))

    if cmd in ("quiz_generate", "quiz", "generate_quiz", "quizgen", "quiz_gen"):

        return generate_quiz(

            str(args.get("text") or args.get("sentence") or ""),

            str(args.get("quiz_mode") or "meaning_to_word"),

            args.get("count", 3),

            as_bool(args.get("adaptive"), ENABLE_ADAPTIVE_SESSION)

        )

    if cmd in ("quiz_check", "check_quiz"):

        return quiz_check(args)

    if cmd in ("quiz_check_batch", "check_quiz_batch", "batch_quiz_check"):

        return quiz_check_batch(args)



    if cmd in ("wrongbook_add", "add_wrongbook", "wrong_add"):

        return wrongbook_add(args)

    if cmd in ("wrongbook_list", "list_wrongbook", "wrong_list"):

        return wrongbook_list(args.get("limit", 20), str(args.get("error_type") or ""))

    if cmd in ("wrongbook_stats", "stats_wrongbook", "wrong_stats"):

        return wrongbook_stats()

    if cmd in ("wrongbook_analyze", "analyze_wrongbook", "wrong_analyze"):

        return wrongbook_analyze(args)

    if cmd in ("wrongbook_recommend", "recommend_wrongbook", "wrong_recommend"):

        return wrongbook_recommend(args)

    if cmd in ("wrongbook_clear", "clear_wrongbook", "wrong_clear"):

        return wrongbook_clear(str(args.get("confirm") or ""))



    if cmd in ("study_session_start", "session_start", "study_start"):

        return study_session_start(args)

    if cmd in ("study_session_submit", "session_submit", "study_submit"):

        return study_session_submit(args)



    if cmd in ("lexicon_add", "dictionary_add", "upsert_lexicon_entry", "upsert_lexicon"):

        return lexicon_add(args)

    if cmd in ("lexicon_list", "dictionary_list"):

        return lexicon_list(args)

    if cmd in ("lexicon_reload", "dictionary_reload"):

        return lexicon_reload()



    if cmd in ("jlpt_tag", "jlpt", "jlpt_level"):

        return jlpt_tag(str(args.get("text") or args.get("sentence") or ""))

    if cmd in ("grammar_explain", "grammar_detail", "explain_grammar"):

        return grammar_explain(

            str(args.get("text") or args.get("sentence") or ""),

            str(args.get("grammar") or "")

        )

    if cmd in ("grammar_explain_deep", "grammar_deep", "explain_grammar_deep"):

        return grammar_explain_deep_v2(args)

    if cmd in ("kanji_lookup", "kanji"):

        return kanji_lookup(str(args.get("kanji") or args.get("word") or args.get("text") or ""))

    if cmd in ("review_due_list", "review_due", "due_list"):

        return review_due_list(args)

    if cmd in ("review_submit", "review_update", "review_grade"):

        return review_submit_v2(args)

    if cmd in ("review_stats", "review_report"):

        return review_stats_v2(args)



    if cmd in ("particle_check", "particle", "particle_fix"):

        return particle_check(str(args.get("text") or args.get("sentence") or ""))

    if cmd in ("style_check", "style", "register_check"):

        return style_check(str(args.get("text") or args.get("sentence") or ""))

    if raw_cmd == "StyleShift" or cmd in ("styleshift_json",):

        return style_shift_json(args)

    if cmd in ("style_shift", "register_shift", "styleshift"):

        return style_shift(args)

    if cmd in ("rewrite_sentence", "rewrite", "paraphrase"):

        return rewrite_sentence(

            str(args.get("text") or args.get("sentence") or ""),

            str(args.get("style") or "polite")

        )

    if cmd in ("phrase_pattern", "collocation", "phrase"):

        return phrase_pattern(str(args.get("word") or args.get("text") or args.get("keyword") or ""))

    if raw_cmd == "PitchAccent" or cmd in ("pitch_accent", "accent", "pitch"):

        return pitch_accent(str(args.get("word") or args.get("text") or args.get("keyword") or ""))

    if cmd in ("minimal_pair_quiz", "minimal_pair", "confusion_quiz"):

        return minimal_pair_quiz(args)

    if cmd in ("error_explain", "explain_error"):

        return error_explain(args)

    if cmd in ("progress_report", "report", "study_report"):

        return progress_report(args)

    if cmd in ("import_export_data", "data_io", "backup_data"):

        return import_export_data(args)



    if cmd in ("resource_status", "res_status", "db_status"):

        return resource_status(args)

    if cmd in ("resource_update", "res_update", "update_resources"):

        return resource_update(args)

    if cmd in ("health_check", "health"):

        return health_check()

    if cmd in ("jlpt_stats", "jlpt_status", "jlpt_health"):

        return jlpt_stats()



    if raw_cmd == "SentimentV2" or cmd in ("sentiment_v2", "emotion_v2", "sentiment_hybrid", "sentimentv2"):

        return sentiment_hybrid_json(args)

    if raw_cmd == "Sentiment" or cmd in ("sentiment", "emotion", "sentiment_analysis"):

        t = str(args.get("text") or args.get("sentence") or "").strip()

        if not t:

            return json.dumps({

                "ok": False,

                "schema_version": PHASE2_SCHEMA_VERSION,

                "command": "Sentiment",

                "error": {"code": "MISSING_TEXT", "message": "缺少参数：text"}

            }, ensure_ascii=False)

        used = "rule"



        pos_words = ["嬉しい","楽しい","最高","好き","良い","よい","助かる","ありがとう","安心","幸せ"]

        neg_words = ["悲しい","つらい","辛い","嫌い","最悪","不安","怒り","腹立つ","疲れた","怖い"]

        pos = sum(1 for w in pos_words if w in t)

        neg = sum(1 for w in neg_words if w in t)

        label = "neutral"

        if pos > neg:

            label = "positive"

        elif neg > pos:

            label = "negative"

        score = 0.5 if (pos + neg) == 0 else round(pos / (pos + neg), 3)

        return json.dumps({

            "ok": True,

            "schema_version": PHASE2_SCHEMA_VERSION,

            "command": "Sentiment",

            "data": {"text": t, "label": label, "score": score, "pos_hits": pos, "neg_hits": neg, "source": used}

        }, ensure_ascii=False)



    return (

        "未知 command。可用: "

        "analyze_sentence | lookup_word | add_furigana | conjugate_verb | conjugate_v2 | srs_schedule | fsrs_schedule | health_check | jlpt_stats | "

        "jlpt_tag | grammar_explain | particle_check | style_check | style_shift | register_shift | rewrite_sentence | phrase_pattern | pitch_accent | minimal_pair_quiz | error_explain | progress_report | import_export_data | resource_status | resource_update | "

        "extract_vocab | quiz_generate | quiz_check | quiz_check_batch | "

        "wrongbook_add | wrongbook_list | wrongbook_stats | wrongbook_analyze | wrongbook_recommend | wrongbook_clear | "

        "study_session_start | study_session_submit | "

        "lexicon_add | lexicon_list | lexicon_reload | "

        "tokenize | romanize | convert | normalize | sentence_split | reading_enhance | syntax_enhance | semantic_enhance | teaching_assets_status | oov_drill | sentiment | lookup_word_json | grammar_explain_deep | kanji_lookup | review_due_list | review_submit | review_stats | lookup_struct | kanji_info | jlpt_check | reading_aid | reading_aid_v2 | parse_tree | parse_tree_json | schema_probe | pitch_accent"

    )



def main():

    try:

        args = safe_read_input()

        result = process_request(args)

        safe_write_output({"status": "success", "result": result}, code=0)

    except Exception as e:

        safe_write_output({"status": "error", "error": str(e)}, code=1)



if __name__ == "__main__":

    main()



