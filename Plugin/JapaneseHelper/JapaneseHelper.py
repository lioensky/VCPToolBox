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
import hashlib
import unicodedata
import threading
import atexit
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FuturesTimeoutError
from datetime import datetime
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

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
WRONGBOOK_PATH = os.path.join(PLUGIN_DIR, "wrongbook.json")
SESSION_PATH = os.path.join(PLUGIN_DIR, "study_sessions.json")
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

LOCAL_DICT = {
    "昨日": {"reading": "きのう", "meaning": "昨天", "pos": "名词"},
    "今日": {"reading": "きょう", "meaning": "今天", "pos": "名词"},
    "明日": {"reading": "あした", "meaning": "明天", "pos": "名词"},
    "友達": {"reading": "ともだち", "meaning": "朋友", "pos": "名词"},
    "映画": {"reading": "えいが", "meaning": "电影", "pos": "名词"},
    "日本語": {"reading": "にほんご", "meaning": "日语", "pos": "名词"},
    "勉強": {"reading": "べんきょう", "meaning": "学习", "pos": "名词"},
    "見る": {"reading": "みる", "meaning": "看", "pos": "动词"},
    "見": {"reading": "み", "meaning": "看", "pos": "动词词干"},
    "行く": {"reading": "いく", "meaning": "去", "pos": "动词"},
    "行き": {"reading": "いき", "meaning": "去（连用）", "pos": "动词连用"},
    "来る": {"reading": "くる", "meaning": "来", "pos": "动词"},
    "する": {"reading": "する", "meaning": "做", "pos": "动词"},
    "食べる": {"reading": "たべる", "meaning": "吃", "pos": "动词"},
    "私": {"reading": "わたし", "meaning": "我", "pos": "代词"},
    "毎日": {"reading": "まいにち", "meaning": "每天", "pos": "名词"},
    "は": {"reading": "は", "meaning": "主题助词", "pos": "助词"},
    "が": {"reading": "が", "meaning": "主格助词", "pos": "助词"},
    "を": {"reading": "を", "meaning": "宾格助词", "pos": "助词"},
    "に": {"reading": "に", "meaning": "方向/时间助词", "pos": "助词"},
    "で": {"reading": "で", "meaning": "场所/手段助词", "pos": "助词"},
    "と": {"reading": "と", "meaning": "并列/引用助词", "pos": "助词"},
    "も": {"reading": "も", "meaning": "也", "pos": "助词"},
    "ました": {"reading": "ました", "meaning": "礼貌过去时", "pos": "助动词"},
    "ます": {"reading": "ます", "meaning": "礼貌体", "pos": "助动词"},
}

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

PHRASE_PATTERNS = {
    "影響": ["影響を与える", "影響を受ける", "影響が出る", "影響を及ぼす"],
    "責任": ["責任を負う", "責任を取る", "責任を持つ", "責任を果たす"],
    "興味": ["興味がある", "興味を持つ", "興味を引く", "興味を示す"],
    "関心": ["関心がある", "関心を持つ", "関心を寄せる", "関心が高い"],
    "努力": ["努力する", "努力を重ねる", "努力を続ける", "努力が実る"],
    "経験": ["経験を積む", "経験がある", "経験を生かす", "経験を共有する"],
    "理解": ["理解する", "理解が深まる", "理解を深める", "理解を得る"],
    "確認": ["確認する", "確認を取る", "内容を確認する", "事実を確認する"],
    "連絡": ["連絡する", "連絡を取る", "連絡が来る", "連絡を待つ"],
    "約束": ["約束する", "約束を守る", "約束を破る", "約束を取り付ける"],
    "勉強": ["勉強する", "勉強になる", "勉強を続ける", "勉強に励む"],
    "日本語": ["日本語を勉強する", "日本語を話す", "日本語を読む", "日本語を書く"],
    "雨": ["雨が降る", "雨が降りそうだ", "雨が強くなる", "雨が止む"]
}

PITCH_ACCENT_DICT = {
    "雨": {"reading": "あめ", "accent_type": "頭高", "accent": "①", "note": "首拍高，后续下降"},
    "飴": {"reading": "あめ", "accent_type": "平板", "accent": "⓪", "note": "首拍低，后续上扬并维持"},
    "橋": {"reading": "はし", "accent_type": "頭高", "accent": "①", "note": "与「箸(⓪)」「端(⓪)」区分"},
    "箸": {"reading": "はし", "accent_type": "平板", "accent": "⓪", "note": "常见易混词"},
    "端": {"reading": "はし", "accent_type": "平板", "accent": "⓪", "note": "常见易混词"},
    "日本": {"reading": "にほん", "accent_type": "中高", "accent": "②", "note": "地区存在读法差异"},
    "学生": {"reading": "がくせい", "accent_type": "尾高", "accent": "③", "note": "常见基础词"},
    "先生": {"reading": "せんせい", "accent_type": "平板", "accent": "⓪", "note": "常见基础词"},
    "今日": {"reading": "きょう", "accent_type": "平板", "accent": "⓪", "note": "常见基础词"},
    "明日": {"reading": "あした", "accent_type": "平板", "accent": "⓪", "note": "口语常见"}
}

MINIMAL_PAIR_BANK = [
    {
        "id": "youni_tameni",
        "topic": "grammar",
        "a": "ように",
        "b": "ために",
        "question": "表达“为了达成意志性目标（例如合格、成功）”时通常选哪一个？",
        "answer": "ために",
        "explain": "「ために」多接意志性目标；「ように」多接能力变化/状态目标。"
    },
    {
        "id": "rashii_souda",
        "topic": "modality",
        "a": "らしい",
        "b": "そうだ",
        "question": "表达“听说（传闻来源明确）”更常用哪一个？",
        "answer": "そうだ",
        "explain": "传闻「そうだ」= 听说；「らしい」常是推测/典型特征。"
    },
    {
        "id": "ageru_kureru_morau",
        "topic": "giving",
        "a": "あげる",
        "b": "くれる",
        "question": "动作方向是“别人给我（我方受益）”时应优先哪一个？",
        "answer": "くれる",
        "explain": "给出者是他人、受益者是我方时用「くれる」。"
    },
    {
        "id": "ni_de_place",
        "topic": "particle",
        "a": "に",
        "b": "で",
        "question": "表示“动作发生场所”（例如在图书馆学习）一般用哪一个？",
        "answer": "で",
        "explain": "动作发生场所多用「で」；存在状态多用「に」。"
    },
    {
        "id": "wa_ga",
        "topic": "particle",
        "a": "は",
        "b": "が",
        "question": "在中性描述“新信息主语”时更常出现哪一个？",
        "answer": "が",
        "explain": "「が」常标新信息主语；「は」偏主题对比。"
    }
]

JLPT_WORD_LEVELS = {
    "税金": "N2", "運営": "N2", "公立": "N2", "図書館": "N4", "存在": "N3", "意義": "N2",
    "学問": "N2", "学問的": "N1", "価値": "N3", "本": "N5", "手": "N5", "入る": "N4",
    "にくい": "N3", "種類": "N3", "一冊": "N5", "冊": "N5", "多い": "N5", "揃える": "N2",
    "こと": "N5",
    "する": "N5", "いる": "N5", "ある": "N5", "れる": "N4", "られる": "N4",
    "です": "N5", "だ": "N5", "ます": "N5", "ない": "N5", "て": "N5", "で": "N5",
    "は": "N5", "が": "N5", "を": "N5", "に": "N5", "の": "N5", "も": "N5", "や": "N5",
    "など": "N5", "一": "N5", "さまざま": "N3", "様々": "N3",
    "政府": "N2", "景気": "N2", "回復": "N2", "景気回復": "N1",
    "経済": "N2", "政策": "N2", "経済政策": "N1", "変更": "N3",
    "企業": "N2", "設備": "N2", "投資": "N2", "設備投資": "N1", "拡大": "N3",
    "結果": "N3", "失業率": "N1", "減少": "N3", "消費者": "N2", "不安": "N3", "改善": "N3", "改善策": "N2",
    "専門家": "N2", "今後": "N2", "傾向": "N3", "慎重": "N3", "分析": "N2", "必要": "N4", "指摘": "N2",
    "課題": "N3", "抽出": "N2", "優先順位": "N2", "策定": "N2", "利害関係者": "N1",
    "標準化": "N2", "実装": "N2", "実装計画": "N1", "検証": "N2", "検証結果": "N1",
    "再現性": "N1", "担保": "N1", "評価指標": "N1", "監査": "N1", "手続き": "N3", "明文化": "N1",
    "制度": "N2", "設計": "N2", "制度設計": "N1", "合意形成": "N1", "再発防止策": "N1"
}

GRAMMAR_EXPLAINERS = [
    {
        "id": "teiru",
        "pattern": r"ている|でいる|ています|でいます",
        "title": "〜ている",
        "jlpt": "N4",
        "meaning": "表示动作进行中，或结果状态持续。",
        "structure": "Vて + いる",
        "pitfall": "并非总是“正在做”，很多场景表示“处于某状态”。",
        "example": "図書館は税金で運営されている。"
    },
    {
        "id": "nikui",
        "pattern": r"にくい",
        "title": "〜にくい",
        "jlpt": "N3",
        "meaning": "难以……，不容易……",
        "structure": "Vます词干 + にくい",
        "pitfall": "表示客观难度，不等同于说话人“讨厌做”。",
        "example": "この本は手に入りにくい。"
    },
    {
        "id": "ya_nado",
        "pattern": r"や.+など|や.+とか",
        "title": "〜や〜など",
        "jlpt": "N4",
        "meaning": "列举代表项，表示“……啦、……之类”。",
        "structure": "NやNなど",
        "pitfall": "是非穷尽列举；若要完整列举常用「と」。",
        "example": "本や雑誌などを読む。"
    },
    {
        "id": "demo_min",
        "pattern": r"でも",
        "title": "〜でも（最低限强调）",
        "jlpt": "N3",
        "meaning": "哪怕……也；至少……",
        "structure": "数量词 + でも",
        "pitfall": "也可能表示转折“但是”，需结合语境判断。",
        "example": "一冊でも多くそろえる。"
    },
    {
        "id": "koto_da",
        "pattern": r"ことだ。?$",
        "title": "〜ことだ（定义/结论）",
        "jlpt": "N2",
        "meaning": "用于下定义、给结论，书面感较强。",
        "structure": "〜ことだ",
        "pitfall": "与建议句型「V辞書形ことだ」不要混淆。",
        "example": "存在意義は本を集めることだ。"
    }
]

SPLIT_MARKERS = sorted([
    "しています", "ています", "でいます", "ている", "でいる",
    "では", "には", "へは", "とは",
    "から", "まで", "より", "だけ", "しか", "など", "ので", "のに",
    "でも", "ても", "たり", "だり",
    "ました", "ません", "ます", "です", "ない", "たい",
    "と", "に", "へ", "で", "を", "は", "が", "も", "や", "か", "ね", "よ"
], key=len, reverse=True)

_SUDACHI_TAGGER = None

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
    s = s.strip().lower()
    s = s.replace("　", " ")
    s = re.sub(r"\s+", "", s)
    s = normalize_variants(s)
    s = kata_to_hira(s)
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


USER_LEXICON = _load_lexicon_file(USER_LEXICON_PATH)
DOMAIN_LEXICON = _load_lexicon_file(DOMAIN_LEXICON_PATH)

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

            info = lexicon_lookup(lemma) or lexicon_lookup(norm) or lexicon_lookup(surf) or {}
            if not reading:
                reading = str(info.get("reading", ""))
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
        if r.get("meaning"):
            row_text += f" ｜释义:{r.get('meaning')}"
        lines.append(row_text)
        i += 1

    lines.append("\n#### 统计")
    for k in ["N1","N2","N3","N4","N5","未知"]:
        lines.append(f"- {k}: {stat.get(k,0)}")
    return "\n".join(lines)

def analyze_sentence(text: str) -> str:
    text = (text or "").strip()
    if not text:
        return "缺少 text 参数。"

    lines = [f"### 日语句子解析\n原句：{text}\n", "#### 1) 分词"]
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


def add_furigana(text: str) -> str:
    text = (text or "").strip()
    if not text:
        return "缺少 text 参数。"

    rows = sudachi_rows(text)
    if not rows:
        parts = []
        for tok in fallback_segment(text):
            info = lexicon_lookup(tok)
            rd = info.get("reading", "")
            if rd and re.search(r"[一-龯]", tok):
                parts.append(f"{tok}({rd})")
            else:
                parts.append(tok)
        return "### 假名标注\n原文：" + text + "\n\n标注结果（fallback）：\n" + "".join(parts)

    parts = []
    for r in rows:
        surf = r["surface"]
        rd = r.get("reading", "")
        if rd and re.search(r"[一-龯]", surf):
            parts.append(f"{surf}({rd})")
        else:
            parts.append(surf)

    return "### 假名标注\n原文：" + text + "\n\n标注结果：\n" + "".join(parts)


def conjugate_verb(verb: str) -> str:
    verb = (verb or "").strip()
    if not verb:
        return "缺少 verb 参数。"

    base = _verb_lemma_from_sudachi(verb) if sudachi_dictionary is not None else verb
    lines = [f"### 动词活用\n输入：{verb}"]
    if base != verb:
        lines.append(f"- 已自动词形还原: {base}")
    lines.append("")

    if base == "する":
        lines += ["- ます形: します", "- て形: して", "- ない形: しない", "- 过去形: した", "- 可能形: できる"]
        return "\n".join(lines)
    if base in ("来る", "くる"):
        lines += ["- ます形: きます", "- て形: きて", "- ない形: こない", "- 过去形: きた", "- 可能形: こられる"]
        return "\n".join(lines)

    if re.search(r"[いきぎしじちぢにひびぴみりえけげせぜてでねへべぺめれ]る$", base):
        stem = base[:-1]
        lines += [f"- ます形: {stem}ます", f"- て形: {stem}て", f"- ない形: {stem}ない", f"- 过去形: {stem}た", f"- 可能形: {stem}られる"]
        return "\n".join(lines)

    if base in ("行く", "いく"):
        pre = base[:-1]
        lines += [
            f"- ます形: {pre}きます",
            f"- て形: {pre}って",
            f"- ない形: {pre}かない",
            f"- 过去形: {pre}った",
            f"- 可能形: {pre}ける",
        ]
        return "\n".join(lines)

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
        irow, te, nai, ta, can = godan[end]
        lines += [
            f"- ます形: {pre}{irow}ます",
            f"- て形: {pre}{te}",
            f"- ない形: {pre}{nai}",
            f"- 过去形: {pre}{ta}",
            f"- 可能形: {pre}{can}",
        ]
    else:
        lines.append("- 未识别词尾，请输入辞书形（如 書く / 食べる）。")

    return "\n".join(lines)


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
    return "\\n".join(lines)

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
    lines = [f"### 学习会话提交结果", f"- session_id: {session_id}", ""]

    for idx, item in enumerate(items, 1):
        expected = str(item.get("word") or "").strip()
        reading = str(item.get("reading") or "").strip()
        meaning = str(item.get("meaning") or "").strip()
        ua = user_answers[idx - 1] if idx - 1 < len(user_answers) else ""

        ok = normalize_text(ua) == normalize_text(expected)
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

    lines.append("")
    lines.append(f"总分: {score}/{total}")
    lines.append(f"错题数: {wrong_count}")
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


def health_check() -> str:
    req_ok = requests is not None
    sudachi_import_ok = sudachi_dictionary is not None and sudachi_tokenizer is not None
    sudachi_tagger_ok = _get_sudachi_tagger() is not None
    user_lex_exists = os.path.exists(USER_LEXICON_PATH)
    domain_lex_exists = os.path.exists(DOMAIN_LEXICON_PATH)
    wrongbook_exists = os.path.exists(WRONGBOOK_PATH)
    session_exists = os.path.exists(SESSION_PATH)

    lines = [
        "### JapaneseHelper 健康检查",
        f"- requests: {'OK' if req_ok else 'MISSING'}",
        f"- SudachiPy import: {'OK' if sudachi_import_ok else 'MISSING'}",
        f"- Sudachi tokenizer init: {'OK' if sudachi_tagger_ok else 'FAILED'}",
        f"- Sudachi split mode: {SUDACHI_SPLIT_MODE}",
        f"- USER_LEXICON: {USER_LEXICON_PATH} ({len(USER_LEXICON)} entries, exists={user_lex_exists})",
        f"- DOMAIN_LEXICON: {DOMAIN_LEXICON_PATH} ({len(DOMAIN_LEXICON)} entries, exists={domain_lex_exists})",
        f"- WRONGBOOK: {WRONGBOOK_PATH} (exists={wrongbook_exists})",
        f"- STUDY_SESSION: {SESSION_PATH} (exists={session_exists})",
        f"- Adaptive session: {ENABLE_ADAPTIVE_SESSION}",
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
    word = (word or "").strip()
    if not word:
        return "缺少 word/text 参数。"

    exact = PHRASE_PATTERNS.get(word)
    if exact:
        lines = [f"### 固定搭配 / 惯用句", f"关键词：{word}", "", "常见搭配："]
        for i, p in enumerate(exact, 1):
            lines.append(f"{i}. {p}")
        return "\n".join(lines)

    # 模糊匹配：关键词出现在词条key里
    hits: List[Tuple[str, List[str]]] = []
    for k, vals in PHRASE_PATTERNS.items():
        if word in k or k in word:
            hits.append((k, vals))

    if not hits:
        return f"未收录「{word}」的常见固定搭配。可用 lexicon_add 扩充后再查。"

    lines = [f"### 固定搭配 / 惯用句", f"关键词：{word}", ""]
    for k, vals in hits[:5]:
        lines.append(f"- {k}:")
        for p in vals[:6]:
            lines.append(f"  - {p}")
    return "\n".join(lines)


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
            f"- 说明: {item.get('note','')}"
        ])

    # 模糊匹配：输入可能包含词条
    for k, v in PITCH_ACCENT_DICT.items():
        if word in k or k in word:
            return "\n".join([
                "### 声调/重音",
                f"- 词条: {k}",
                f"- 读音: {v.get('reading','')}",
                f"- 类型: {v.get('accent_type','未知')}",
                f"- 标记: {v.get('accent','-')}",
                f"- 说明: {v.get('note','')}",
                "- 备注: 基于模糊匹配命中。"
            ])

    return "\n".join([
        "### 声调/重音",
        f"- 词条: {word}",
        "- 当前词典未收录该词重音（有则显示，无则略过）。"
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


def process_request(args: Dict[str, Any]) -> str:
    cmd = str(args.get("command") or args.get("action") or "analyze_sentence").strip().lower()

    if cmd in ("analyze_sentence", "analyze", "parse"):
        return analyze_sentence(str(args.get("text") or args.get("sentence") or ""))
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
        return add_furigana(str(args.get("text") or args.get("sentence") or ""))
    if cmd in ("conjugate_verb", "conjugate", "verb"):
        return conjugate_verb(str(args.get("verb") or args.get("word") or args.get("text") or ""))
    if cmd in ("srs_schedule", "srs", "schedule"):
        return srs_schedule(args)
    if cmd in ("fsrs_schedule", "fsrs"):
        return fsrs_schedule(args)
    if cmd in ("extract_vocab", "vocab", "extract"):
        return extract_vocab(str(args.get("text") or args.get("sentence") or ""))
    if cmd in ("quiz_generate", "quiz", "generate_quiz"):
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

    if cmd in ("particle_check", "particle", "particle_fix"):
        return particle_check(str(args.get("text") or args.get("sentence") or ""))
    if cmd in ("rewrite_sentence", "rewrite", "paraphrase"):
        return rewrite_sentence(
            str(args.get("text") or args.get("sentence") or ""),
            str(args.get("style") or "polite")
        )
    if cmd in ("phrase_pattern", "collocation", "phrase"):
        return phrase_pattern(str(args.get("word") or args.get("text") or args.get("keyword") or ""))
    if cmd in ("pitch_accent", "accent", "pitch"):
        return pitch_accent(str(args.get("word") or args.get("text") or args.get("keyword") or ""))
    if cmd in ("minimal_pair_quiz", "minimal_pair", "confusion_quiz"):
        return minimal_pair_quiz(args)
    if cmd in ("error_explain", "explain_error"):
        return error_explain(args)
    if cmd in ("progress_report", "report", "study_report"):
        return progress_report(args)
    if cmd in ("import_export_data", "data_io", "backup_data"):
        return import_export_data(args)

    if cmd in ("health_check", "health"):
        return health_check()

    return (
        "未知 command。可用: "
        "analyze_sentence | lookup_word | add_furigana | conjugate_verb | srs_schedule | fsrs_schedule | health_check | "
        "jlpt_tag | grammar_explain | particle_check | rewrite_sentence | phrase_pattern | pitch_accent | minimal_pair_quiz | error_explain | progress_report | import_export_data | "
        "extract_vocab | quiz_generate | quiz_check | quiz_check_batch | "
        "wrongbook_add | wrongbook_list | wrongbook_stats | wrongbook_clear | "
        "study_session_start | study_session_submit | "
        "lexicon_add | lexicon_list | lexicon_reload | "
        "lookup_word_json"
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

