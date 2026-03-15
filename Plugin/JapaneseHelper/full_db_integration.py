#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import re
import sqlite3
import atexit
from typing import Any, Dict, List, Tuple


def apply_full_db_integration(ns: Dict[str, Any]) -> None:
    """
    Monkey-patch JapaneseHelper runtime with full SQLite dictionary support.

    Existing tables:
      - jm_lex(word, reading, pos, gloss, seq, pri)
      - kd_lex(literal, onyomi, kunyomi, meaning, jlpt, grade, stroke_count, radical)

    Extended tables:
      - grammar_lex(pattern, reading, level, meaning_zh, meaning_en, register, connect_rule, notes, source)
      - wadoku_lex(lemma, reading, pos, gloss_de, gloss_en, tags, source)
      - ojad_pitch(surface, reading, accent_pattern, mora_count, audio_ref, source)
    """
    plugin_dir = ns.get("PLUGIN_DIR", ".")
    normalize_variants = ns["normalize_variants"]
    kata_to_hira = ns["kata_to_hira"]
    compose_rank = ns["_compose_rank_score"]
    log_observation = ns.get("log_observation", lambda *a, **k: None)

    orig_local_lookup = ns["local_lookup_candidates"]
    orig_lexicon_lookup = ns["lexicon_lookup"]
    orig_lookup_jlpt_for_word = ns.get("lookup_jlpt_for_word")
    orig_kanji_lookup = ns["kanji_lookup"]
    orig_health_check = ns["health_check"]
    orig_pitch_accent = ns.get("pitch_accent")
    orig_grammar_deep = ns.get("grammar_explain_deep_v2") or ns.get("grammar_explain_deep")

    # source credibility extension
    sw = ns.get("SOURCE_CREDIBILITY_WEIGHTS")
    if isinstance(sw, dict):
        sw["jmdictdb"] = max(float(sw.get("jmdictdb", 0.0)), 0.26)
        sw["wadoku"] = max(float(sw.get("wadoku", 0.0)), 0.20)
        sw["ojad"] = max(float(sw.get("ojad", 0.0)), 0.18)
        sw["grammar_db"] = max(float(sw.get("grammar_db", 0.0)), 0.22)

    # base full-db env
    db_path_env = os.environ.get("JMDICT_FULL_DB_PATH", os.path.join(plugin_dir, "data", "db", "jdict_full.sqlite"))
    kd_path_env = os.environ.get("KANJIDIC_FULL_DB_PATH", db_path_env)
    full_db_enabled = str(os.environ.get("FULL_DB_ENABLED", "true")).strip().lower() == "true"
    sqlite_timeout = float(os.environ.get("FULL_DB_SQLITE_TIMEOUT", "2.0"))

    # new env toggles
    grammar_db_enabled = str(os.environ.get("GRAMMAR_FULL_DB_ENABLED", "true")).strip().lower() == "true"
    wadoku_db_enabled = str(os.environ.get("WADOKU_DB_ENABLED", "true")).strip().lower() == "true"
    ojad_db_enabled = str(os.environ.get("OJAD_DB_ENABLED", "true")).strip().lower() == "true"

    # 性能保护：默认不在 token 级调用链中触发 full-db 词条检索（避免 reading_aid 等热路径超时）
    full_db_lexicon_lookup_enabled = str(
        os.environ.get("FULL_DB_LEXICON_LOOKUP_ENABLED", "false")
    ).strip().lower() == "true"

    default_full_path = db_path_env
    grammar_db_path = os.environ.get("GRAMMAR_FULL_DB_PATH", default_full_path)
    wadoku_db_path = os.environ.get("WADOKU_DB_PATH", grammar_db_path or default_full_path)
    ojad_db_path = os.environ.get("OJAD_DB_PATH", grammar_db_path or default_full_path)

    ojad_api_endpoint = str(os.environ.get("OJAD_API_ENDPOINT", "")).strip()

    holder = {"conn": None, "last_err": ""}
    jlpt_cache: Dict[str, str] = {}
    jlpt_cache_max = 4096

    def _norm_path(p: str) -> str:
        v = str(p or "").strip()
        if not v:
            return ""
        if not os.path.isabs(v):
            v = os.path.normpath(os.path.join(plugin_dir, v))
        return v

    def _path_candidates() -> List[str]:
        cands: List[str] = []
        for p in (db_path_env, kd_path_env, grammar_db_path, wadoku_db_path, ojad_db_path):
            v = _norm_path(p)
            if v and v not in cands:
                cands.append(v)
        return cands

    def _ensure_parent_dir(path: str) -> None:
        parent = os.path.dirname(path)
        if parent and (not os.path.exists(parent)):
            os.makedirs(parent, exist_ok=True)

    def _ensure_ext_schema_on_path(path: str) -> None:
        if not path:
            return
        try:
            _ensure_parent_dir(path)
            conn = sqlite3.connect(path, timeout=max(0.2, float(sqlite_timeout)))
            try:
                cur = conn.cursor()
                if grammar_db_enabled:
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS grammar_lex (
                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                          pattern TEXT NOT NULL,
                          reading TEXT DEFAULT '',
                          level TEXT DEFAULT '',
                          meaning_zh TEXT DEFAULT '',
                          meaning_en TEXT DEFAULT '',
                          register TEXT DEFAULT '',
                          connect_rule TEXT DEFAULT '',
                          notes TEXT DEFAULT '',
                          source TEXT DEFAULT 'nihon_bunpou_jiten'
                        )
                        """
                    )
                    cur.execute("CREATE INDEX IF NOT EXISTS idx_grammar_pattern ON grammar_lex(pattern)")
                if wadoku_db_enabled:
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS wadoku_lex (
                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                          lemma TEXT NOT NULL,
                          reading TEXT DEFAULT '',
                          pos TEXT DEFAULT '',
                          gloss_de TEXT DEFAULT '',
                          gloss_en TEXT DEFAULT '',
                          tags TEXT DEFAULT '',
                          source TEXT DEFAULT 'wadoku'
                        )
                        """
                    )
                    cur.execute("CREATE INDEX IF NOT EXISTS idx_wadoku_lemma ON wadoku_lex(lemma)")
                    cur.execute("CREATE INDEX IF NOT EXISTS idx_wadoku_reading ON wadoku_lex(reading)")
                if ojad_db_enabled:
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS ojad_pitch (
                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                          surface TEXT NOT NULL,
                          reading TEXT DEFAULT '',
                          accent_pattern TEXT DEFAULT '',
                          mora_count INTEGER DEFAULT 0,
                          audio_ref TEXT DEFAULT '',
                          source TEXT DEFAULT 'ojad'
                        )
                        """
                    )
                    cur.execute("CREATE INDEX IF NOT EXISTS idx_ojad_surface ON ojad_pitch(surface)")
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            log_observation("full_db_ext_schema_ensure_failed", path=path, error=str(e))

    # Ensure ext schema in configured db files
    for _p in {_norm_path(grammar_db_path), _norm_path(wadoku_db_path), _norm_path(ojad_db_path)}:
        if _p:
            _ensure_ext_schema_on_path(_p)

    def _open_db():
        if not full_db_enabled:
            return None
        if holder["conn"] is not None:
            return holder["conn"]
        for p in _path_candidates():
            if not os.path.exists(p):
                continue
            try:
                conn = sqlite3.connect(
                    p,
                    timeout=max(0.2, float(sqlite_timeout)),
                    check_same_thread=False
                )
                conn.row_factory = sqlite3.Row
                try:
                    conn.execute("PRAGMA journal_mode=WAL;")
                    conn.execute("PRAGMA synchronous=NORMAL;")
                except Exception:
                    pass
                holder["conn"] = conn
                holder["last_err"] = ""
                return conn
            except Exception as e:
                holder["last_err"] = str(e)
        return None

    def _close_db():
        try:
            if holder["conn"] is not None:
                holder["conn"].close()
        except Exception:
            pass
        holder["conn"] = None

    atexit.register(_close_db)

    def _table_exists(conn, name: str) -> bool:
        try:
            row = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
                (name,)
            ).fetchone()
            return row is not None
        except Exception:
            return False

    def _count_rows(path: str, table: str) -> int:
        p = _norm_path(path)
        if (not p) or (not os.path.exists(p)):
            return 0
        try:
            conn = sqlite3.connect(p, timeout=max(0.2, float(sqlite_timeout)))
            try:
                cur = conn.cursor()
                cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", (table,))
                if cur.fetchone() is None:
                    return 0
                cur.execute(f"SELECT COUNT(1) FROM {table}")
                row = cur.fetchone()
                return int(row[0]) if row and row[0] is not None else 0
            finally:
                conn.close()
        except Exception:
            return 0

    def _query_jmdict_rows(word: str, limit: int = 12) -> List[Dict[str, Any]]:
        w = str(word or "").strip()
        if not w:
            return []

        conn = _open_db()
        if conn is None or (not _table_exists(conn, "jm_lex")):
            return []

        forms: List[str] = []
        for x in (w, normalize_variants(w), kata_to_hira(w)):
            x = str(x or "").strip()
            if x and x not in forms:
                forms.append(x)

        out: List[Dict[str, Any]] = []
        seen = set()

        def _push(row, hit_type: str):
            wd = str(row["word"] or "").strip()
            rd = str(row["reading"] or "").strip()
            pos = str(row["pos"] or "").strip()
            gls = str(row["gloss"] or "").strip()
            if not wd:
                return
            k = (wd, rd, pos, gls)
            if k in seen:
                return
            seen.add(k)
            out.append({
                "word": wd,
                "reading": rd,
                "pos": pos,
                "gloss": gls,
                "seq": int(row["seq"]) if row["seq"] is not None else 0,
                "pri": int(row["pri"]) if row["pri"] is not None else 0,
                "hit_type": hit_type
            })

        try:
            for f in forms:
                cur = conn.execute(
                    "SELECT word, reading, pos, gloss, seq, pri FROM jm_lex WHERE word=? ORDER BY pri DESC, seq ASC LIMIT ?",
                    (f, int(limit))
                )
                for r in cur.fetchall():
                    _push(r, "word_exact")

            if len(out) < limit:
                for f in forms:
                    cur = conn.execute(
                        "SELECT word, reading, pos, gloss, seq, pri FROM jm_lex WHERE reading=? ORDER BY pri DESC, seq ASC LIMIT ?",
                        (f, int(limit))
                    )
                    for r in cur.fetchall():
                        _push(r, "reading_exact")
                        if len(out) >= limit:
                            break
                    if len(out) >= limit:
                        break

            if len(out) < limit:
                for f in forms:
                    cur = conn.execute(
                        "SELECT word, reading, pos, gloss, seq, pri FROM jm_lex WHERE word LIKE ? OR reading LIKE ? ORDER BY pri DESC, seq ASC LIMIT ?",
                        (f + "%", f + "%", int(limit))
                    )
                    for r in cur.fetchall():
                        _push(r, "prefix")
                        if len(out) >= limit:
                            break
                    if len(out) >= limit:
                        break
        except Exception as e:
            log_observation("jmdict_db_query_failed", error=str(e))

        return out[:limit]

    def _query_wadoku_rows(word: str, limit: int = 10) -> List[Dict[str, Any]]:
        if not wadoku_db_enabled:
            return []
        w = str(word or "").strip()
        if not w:
            return []

        p = _norm_path(wadoku_db_path)
        if (not p) or (not os.path.exists(p)):
            return []

        forms: List[str] = []
        for x in (w, normalize_variants(w), kata_to_hira(w)):
            x = str(x or "").strip()
            if x and x not in forms:
                forms.append(x)

        out: List[Dict[str, Any]] = []
        seen = set()
        try:
            conn = sqlite3.connect(p, timeout=max(0.2, float(sqlite_timeout)))
            conn.row_factory = sqlite3.Row
            try:
                cur = conn.cursor()
                cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='wadoku_lex' LIMIT 1")
                if cur.fetchone() is None:
                    return []

                def _push(row, hit_type: str):
                    lemma = str(row["lemma"] or "").strip()
                    reading = str(row["reading"] or "").strip()
                    pos = str(row["pos"] or "").strip()
                    de = str(row["gloss_de"] or "").strip()
                    en = str(row["gloss_en"] or "").strip()
                    tags = str(row["tags"] or "").strip()
                    src = str(row["source"] or "wadoku").strip() or "wadoku"
                    if not lemma:
                        return
                    k = (lemma, reading, pos, de, en, tags)
                    if k in seen:
                        return
                    seen.add(k)
                    out.append({
                        "lemma": lemma,
                        "reading": reading,
                        "pos": pos,
                        "gloss_de": de,
                        "gloss_en": en,
                        "tags": tags,
                        "source": src,
                        "hit_type": hit_type
                    })

                for f in forms:
                    cur = conn.execute(
                        "SELECT lemma, reading, pos, gloss_de, gloss_en, tags, source FROM wadoku_lex WHERE lemma=? ORDER BY id ASC LIMIT ?",
                        (f, int(limit))
                    )
                    for r in cur.fetchall():
                        _push(r, "lemma_exact")

                if len(out) < limit:
                    for f in forms:
                        cur = conn.execute(
                            "SELECT lemma, reading, pos, gloss_de, gloss_en, tags, source FROM wadoku_lex WHERE reading=? ORDER BY id ASC LIMIT ?",
                            (f, int(limit))
                        )
                        for r in cur.fetchall():
                            _push(r, "reading_exact")
                            if len(out) >= limit:
                                break
                        if len(out) >= limit:
                            break

                if len(out) < limit:
                    for f in forms:
                        cur = conn.execute(
                            "SELECT lemma, reading, pos, gloss_de, gloss_en, tags, source FROM wadoku_lex WHERE lemma LIKE ? OR reading LIKE ? ORDER BY id ASC LIMIT ?",
                            (f + "%", f + "%", int(limit))
                        )
                        for r in cur.fetchall():
                            _push(r, "prefix")
                            if len(out) >= limit:
                                break
                        if len(out) >= limit:
                            break
            finally:
                conn.close()
        except Exception as e:
            log_observation("wadoku_db_query_failed", error=str(e))

        return out[:limit]

    def _query_grammar_rows(text: str = "", grammar: str = "", limit: int = 12) -> List[Dict[str, Any]]:
        if not grammar_db_enabled:
            return []
        p = _norm_path(grammar_db_path)
        if (not p) or (not os.path.exists(p)):
            return []

        t = str(text or "").strip()
        g = str(grammar or "").strip()

        out: List[Dict[str, Any]] = []
        seen = set()

        try:
            conn = sqlite3.connect(p, timeout=max(0.2, float(sqlite_timeout)))
            conn.row_factory = sqlite3.Row
            try:
                cur = conn.cursor()
                cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='grammar_lex' LIMIT 1")
                if cur.fetchone() is None:
                    return []

                def _push(row, hit_type: str):
                    pattern = str(row["pattern"] or "").strip()
                    if not pattern:
                        return
                    k = (pattern, str(row["level"] or ""), str(row["meaning_zh"] or ""), str(row["meaning_en"] or ""))
                    if k in seen:
                        return
                    seen.add(k)
                    out.append({
                        "pattern": pattern,
                        "reading": str(row["reading"] or "").strip(),
                        "level": str(row["level"] or "").strip(),
                        "meaning_zh": str(row["meaning_zh"] or "").strip(),
                        "meaning_en": str(row["meaning_en"] or "").strip(),
                        "register": str(row["register"] or "").strip(),
                        "connect_rule": str(row["connect_rule"] or "").strip(),
                        "notes": str(row["notes"] or "").strip(),
                        "source": str(row["source"] or "nihon_bunpou_jiten").strip() or "nihon_bunpou_jiten",
                        "hit_type": hit_type
                    })

                if g:
                    q_forms = []
                    for x in (g, normalize_variants(g), kata_to_hira(g)):
                        x = str(x or "").strip()
                        if x and x not in q_forms:
                            q_forms.append(x)

                    for q in q_forms:
                        cur = conn.execute(
                            """
                            SELECT pattern, reading, level, meaning_zh, meaning_en, register, connect_rule, notes, source
                            FROM grammar_lex
                            WHERE pattern = ? OR pattern LIKE ?
                            ORDER BY LENGTH(pattern) DESC, id ASC
                            LIMIT ?
                            """,
                            (q, "%" + q + "%", int(limit))
                        )
                        for r in cur.fetchall():
                            _push(r, "grammar_query")
                        if len(out) >= limit:
                            break

                if t and len(out) < limit:
                    cur = conn.execute(
                        """
                        SELECT pattern, reading, level, meaning_zh, meaning_en, register, connect_rule, notes, source
                        FROM grammar_lex
                        WHERE LENGTH(pattern) > 1 AND INSTR(?, pattern) > 0
                        ORDER BY LENGTH(pattern) DESC, id ASC
                        LIMIT ?
                        """,
                        (t, int(limit))
                    )
                    for r in cur.fetchall():
                        _push(r, "text_match")
            finally:
                conn.close()
        except Exception as e:
            log_observation("grammar_db_query_failed", error=str(e))

        return out[:limit]

    def _query_ojad_row(word: str) -> Dict[str, Any]:
        if not ojad_db_enabled:
            return {}
        w = str(word or "").strip()
        if not w:
            return {}
        p = _norm_path(ojad_db_path)
        if (not p) or (not os.path.exists(p)):
            return {}

        forms: List[str] = []
        for x in (w, normalize_variants(w), kata_to_hira(w)):
            x = str(x or "").strip()
            if x and x not in forms:
                forms.append(x)

        try:
            conn = sqlite3.connect(p, timeout=max(0.2, float(sqlite_timeout)))
            conn.row_factory = sqlite3.Row
            try:
                cur = conn.cursor()
                cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ojad_pitch' LIMIT 1")
                if cur.fetchone() is None:
                    return {}

                for f in forms:
                    row = conn.execute(
                        """
                        SELECT surface, reading, accent_pattern, mora_count, audio_ref, source
                        FROM ojad_pitch
                        WHERE surface = ? OR reading = ?
                        ORDER BY id ASC
                        LIMIT 1
                        """,
                        (f, f)
                    ).fetchone()
                    if row is not None:
                        return {
                            "surface": str(row["surface"] or "").strip(),
                            "reading": str(row["reading"] or "").strip(),
                            "accent_pattern": str(row["accent_pattern"] or "").strip(),
                            "mora_count": int(row["mora_count"]) if row["mora_count"] is not None else 0,
                            "audio_ref": str(row["audio_ref"] or "").strip(),
                            "source": str(row["source"] or "ojad").strip() or "ojad"
                        }
            finally:
                conn.close()
        except Exception as e:
            log_observation("ojad_db_query_failed", error=str(e))

        return {}

    def _db_rows_to_candidates(rows: List[Dict[str, Any]], context_text: str = "") -> List[Tuple[str, str, Dict[str, Any], float]]:
        out: List[Tuple[str, str, Dict[str, Any], float]] = []
        for r in rows:
            hit = str(r.get("hit_type", ""))
            base = 0.82
            if hit == "word_exact":
                base = 0.96
            elif hit == "reading_exact":
                base = 0.90

            entry = {
                "reading": str(r.get("reading", "")),
                "meaning": str(r.get("gloss", "")),
                "pos": str(r.get("pos", "")),
                "jlpt": "",
                "tags": ["jmdictdb", hit]
            }
            wd = str(r.get("word", ""))
            score = compose_rank(
                base_match_score=base,
                source="jmdictdb",
                word=wd,
                reading=str(entry.get("reading", "")),
                pos=str(entry.get("pos", "")),
                context_text=context_text
            )
            out.append(("jmdictdb", wd, entry, score))
        return out

    def _wadoku_rows_to_candidates(rows: List[Dict[str, Any]], context_text: str = "") -> List[Tuple[str, str, Dict[str, Any], float]]:
        out: List[Tuple[str, str, Dict[str, Any], float]] = []
        for r in rows:
            hit = str(r.get("hit_type", ""))
            base = 0.78
            if hit == "lemma_exact":
                base = 0.92
            elif hit == "reading_exact":
                base = 0.86

            meaning_parts = []
            if str(r.get("gloss_en", "")).strip():
                meaning_parts.append(str(r.get("gloss_en", "")).strip())
            if str(r.get("gloss_de", "")).strip():
                meaning_parts.append("[de] " + str(r.get("gloss_de", "")).strip())

            entry = {
                "reading": str(r.get("reading", "")),
                "meaning": " | ".join(meaning_parts),
                "pos": str(r.get("pos", "")),
                "jlpt": "",
                "tags": ["wadoku", hit] + ([str(r.get("tags", "")).strip()] if str(r.get("tags", "")).strip() else [])
            }

            wd = str(r.get("lemma", ""))
            score = compose_rank(
                base_match_score=base,
                source="wadoku",
                word=wd,
                reading=str(entry.get("reading", "")),
                pos=str(entry.get("pos", "")),
                context_text=context_text
            )
            out.append(("wadoku", wd, entry, score))
        return out

    def local_lookup_candidates_patched(word: str, context_text: str = ""):
        base = list(orig_local_lookup(word, context_text=context_text))

        # JMdict full-db
        db_rows = _query_jmdict_rows(word, limit=12)
        base.extend(_db_rows_to_candidates(db_rows, context_text=context_text))

        # Wadoku full-db
        wd_rows = _query_wadoku_rows(word, limit=10)
        base.extend(_wadoku_rows_to_candidates(wd_rows, context_text=context_text))

        uniq: Dict[Tuple[str, str, str, str, str], Tuple[str, str, Dict[str, Any], float]] = {}
        for src, kw, entry, score in base:
            rd = str(entry.get("reading", ""))
            me = str(entry.get("meaning", ""))
            pos = str(entry.get("pos", ""))
            k = (str(src), str(kw), rd, me, pos)
            if (k not in uniq) or (float(score) > float(uniq[k][3])):
                uniq[k] = (src, kw, entry, score)

        out = list(uniq.values())
        out.sort(key=lambda x: float(x[3]), reverse=True)
        return out

    def lexicon_lookup_patched(word: str) -> Dict[str, Any]:
        # 先走“未打补丁前”的本地候选函数，避免经由全局名再次回到 patched 路径
        local_cands = orig_local_lookup(word, context_text="")
        if local_cands:
            return local_cands[0][2]

        # 默认关闭 full-db token 级补查，避免在 sudachi_rows/reading_aid 热路径反复命中重查询
        if not full_db_lexicon_lookup_enabled:
            return {}

        w = str(word or "").strip()
        if (not w) or len(w) <= 1:
            return {}

        cands = local_lookup_candidates_patched(w)
        if not cands:
            return {}
        return cands[0][2]

    def _query_kanjidic_row(ch: str) -> Dict[str, Any]:
        c = str(ch or "").strip()
        if not c:
            return {}
        conn = _open_db()
        if conn is None or (not _table_exists(conn, "kd_lex")):
            return {}
        try:
            row = conn.execute(
                "SELECT literal, onyomi, kunyomi, meaning, jlpt, grade, stroke_count, radical FROM kd_lex WHERE literal=? LIMIT 1",
                (c[0],)
            ).fetchone()
            if row is None:
                return {}
            return {
                "literal": str(row["literal"] or ""),
                "onyomi": str(row["onyomi"] or ""),
                "kunyomi": str(row["kunyomi"] or ""),
                "meaning": str(row["meaning"] or ""),
                "jlpt": str(row["jlpt"] or ""),
                "grade": str(row["grade"] or ""),
                "strokes": str(row["stroke_count"] or ""),
                "radical": str(row["radical"] or "")
            }
        except Exception as e:
            log_observation("kanjidic_db_query_failed", error=str(e))
            return {}

    def lookup_jlpt_for_word_patched(word: str) -> str:
        w = str(word or "").strip()
        if not w:
            return ""
        if callable(orig_lookup_jlpt_for_word):
            try:
                lv0 = str(orig_lookup_jlpt_for_word(w) or "").strip().upper()
                if lv0:
                    return lv0
            except Exception:
                pass

        ck = re.sub(r"\s+", "", w).lower()
        if ck in jlpt_cache:
            return jlpt_cache.get(ck, "")

        conn = _open_db()
        if conn is None or (not _table_exists(conn, "jlpt_lex")):
            if len(jlpt_cache) >= jlpt_cache_max:
                try:
                    jlpt_cache.pop(next(iter(jlpt_cache)))
                except Exception:
                    jlpt_cache.clear()
            jlpt_cache[ck] = ""
            return ""

        forms: List[str] = []
        for x in (w, normalize_variants(w), kata_to_hira(w)):
            x = str(x or "").strip()
            if x and x not in forms:
                forms.append(x)

        found = ""
        try:
            for f in forms:
                row = conn.execute(
                    "SELECT level FROM jlpt_lex WHERE expression=? AND COALESCE(level,'')<>'' LIMIT 1",
                    (f,)
                ).fetchone()
                if row is not None and row[0]:
                    found = str(row[0]).strip().upper()
                    break
            if not found:
                for f in forms:
                    row = conn.execute(
                        "SELECT level FROM jlpt_lex WHERE reading=? AND COALESCE(level,'')<>'' LIMIT 1",
                        (f,)
                    ).fetchone()
                    if row is not None and row[0]:
                        found = str(row[0]).strip().upper()
                        break
        except Exception as e:
            log_observation("jlpt_db_lookup_failed", word=w, error=str(e))
            found = ""

        if len(jlpt_cache) >= jlpt_cache_max:
            try:
                jlpt_cache.pop(next(iter(jlpt_cache)))
            except Exception:
                jlpt_cache.clear()
        jlpt_cache[ck] = found or ""
        return found or ""

    def kanji_lookup_patched(kanji: str) -> str:
        text = str(kanji or "").strip()
        if not text:
            return "缺少 kanji 参数。"
        ch = text[0]

        row = _query_kanjidic_row(ch)
        if row:
            ony = [x for x in re.split(r"[,\\s]+", row.get("onyomi", "")) if x]
            kun = [x for x in re.split(r"[,\\s]+", row.get("kunyomi", "")) if x]
            mean = [x for x in re.split(r"[;,/]+", row.get("meaning", "")) if x]
            lines = ["### 汉字查询", f"- 字: {ch}"]
            lines.append(f"- 音读: {', '.join(ony) if ony else '-'}")
            lines.append(f"- 训读: {', '.join(kun) if kun else '-'}")
            lines.append(f"- 含义: {', '.join(mean) if mean else '-'}")
            if row.get("jlpt"):
                lines.append(f"- JLPT: {row.get('jlpt')}")
            if row.get("grade"):
                lines.append(f"- 学年: {row.get('grade')}")
            if row.get("strokes"):
                lines.append(f"- 笔画: {row.get('strokes')}")
            if row.get("radical"):
                lines.append(f"- 部首: {row.get('radical')}")
            lines.append("- source: KANJIDIC2(full-db)")
            return "\n".join(lines)

        return orig_kanji_lookup(kanji)

    def grammar_explain_deep_patched(args: Dict[str, Any]) -> str:
        text = str(args.get("text") or args.get("sentence") or "").strip()
        grammar = str(args.get("grammar") or "").strip()

        rows = _query_grammar_rows(text=text, grammar=grammar, limit=12)
        if not rows:
            if callable(orig_grammar_deep):
                return orig_grammar_deep(args)
            return "未命中可讲解语法点。"

        lines = ["### 语法深度解析（DB优先）"]
        if text:
            lines.append(f"原句：{text}")
        if grammar:
            lines.append(f"指定语法：{grammar}")
        lines.append("")
        lines.append("- source: grammar_lex(DB)")
        lines.append("")

        for i, r in enumerate(rows, 1):
            level = str(r.get("level", "")).strip() or "-"
            meaning_zh = str(r.get("meaning_zh", "")).strip()
            meaning_en = str(r.get("meaning_en", "")).strip()
            reg = str(r.get("register", "")).strip() or "-"
            conn_rule = str(r.get("connect_rule", "")).strip() or "-"
            notes = str(r.get("notes", "")).strip()

            lines.append(f"{i}. {r.get('pattern', '(unknown)')} [{level}]")
            if r.get("reading"):
                lines.append(f" - 读法: {r.get('reading')}")
            if meaning_zh:
                lines.append(f" - 含义(zh): {meaning_zh}")
            if meaning_en:
                lines.append(f" - 含义(en): {meaning_en}")
            lines.append(f" - 正式度: {reg}")
            lines.append(f" - 接续规则: {conn_rule}")
            if notes:
                lines.append(f" - 备注: {notes}")
            lines.append(f" - 词条来源: {r.get('source', 'nihon_bunpou_jiten')}")
            lines.append("")

        return "\n".join(lines).rstrip()

    def pitch_accent_patched(word: str) -> str:
        w = str(word or "").strip()
        if not w:
            return "缺少 word/text 参数。"

        db_item = _query_ojad_row(w)
        if db_item:
            lines = [
                "### 声调/重音",
                f"- 词条: {db_item.get('surface') or w}",
                f"- 读音: {db_item.get('reading', '')}",
                f"- 类型: {'未知' if not db_item.get('accent_pattern') else 'DB'}",
                f"- 标记: {db_item.get('accent_pattern', '-') or '-'}",
                f"- 拍数: {db_item.get('mora_count', 0)}",
            ]
            if db_item.get("audio_ref"):
                lines.append(f"- 音频: {db_item.get('audio_ref')}")
            lines.append(f"- 来源: {db_item.get('source', 'ojad')} (ojad_pitch DB)")
            return "\n".join(lines)

        if callable(orig_pitch_accent):
            return orig_pitch_accent(word)
        return "未命中声调数据。"

    def health_check_patched() -> str:
        base = orig_health_check()
        lines = [base, "", "#### Full SQLite Dict"]
        lines.append(f"- FULL_DB_ENABLED: {full_db_enabled}")
        lines.append(f"- JMDICT_FULL_DB_PATH: {db_path_env}")
        lines.append(f"- KANJIDIC_FULL_DB_PATH: {kd_path_env}")

        conn = _open_db()
        if conn is None:
            lines.append("- db_open: FAILED")
            if holder["last_err"]:
                lines.append(f"- db_error: {holder['last_err']}")
        else:
            lines.append("- db_open: OK")
            try:
                jm_cnt = conn.execute("SELECT count(1) FROM jm_lex").fetchone()[0] if _table_exists(conn, "jm_lex") else 0
            except Exception:
                jm_cnt = 0
            try:
                kd_cnt = conn.execute("SELECT count(1) FROM kd_lex").fetchone()[0] if _table_exists(conn, "kd_lex") else 0
            except Exception:
                kd_cnt = 0
            lines.append(f"- jm_lex_rows: {jm_cnt}")
            lines.append(f"- kd_lex_rows: {kd_cnt}")

        lines.append("")
        lines.append("#### Extended DB (grammar/wadoku/ojad)")
        lines.append(f"- grammar_db_enabled: {grammar_db_enabled}")
        lines.append(f"- wadoku_db_enabled: {wadoku_db_enabled}")
        lines.append(f"- ojad_db_enabled: {ojad_db_enabled}")
        lines.append(f"- full_db_lexicon_lookup_enabled: {full_db_lexicon_lookup_enabled}")
        lines.append(f"- grammar_db_path: {grammar_db_path}")
        lines.append(f"- wadoku_db_path: {wadoku_db_path}")
        lines.append(f"- ojad_db_path: {ojad_db_path}")

        grammar_rows = _count_rows(grammar_db_path, "grammar_lex") if grammar_db_enabled else -1
        wadoku_rows = _count_rows(wadoku_db_path, "wadoku_lex") if wadoku_db_enabled else -1
        ojad_rows = _count_rows(ojad_db_path, "ojad_pitch") if ojad_db_enabled else -1
        jlpt_rows = _count_rows(grammar_db_path, "jlpt_lex") if grammar_db_enabled else -1

        lines.append(f"- grammar_rows: {grammar_rows}")
        lines.append(f"- wadoku_rows: {wadoku_rows}")
        lines.append(f"- ojad_rows: {ojad_rows}")
        lines.append(f"- jlpt_rows: {jlpt_rows}")

        try:
            _jp = _norm_path(grammar_db_path)
            if _jp and os.path.exists(_jp):
                _c2 = sqlite3.connect(_jp, timeout=max(0.2, float(sqlite_timeout)))
                try:
                    _cur2 = _c2.cursor()
                    _cur2.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='jlpt_lex' LIMIT 1")
                    if _cur2.fetchone() is not None:
                        lines.append("")
                        lines.append("#### jlpt_license_summary")
                        _rows = _cur2.execute(
                            """
                            SELECT COALESCE(source_repo,''), COALESCE(license,''), COALESCE(confidence,''), COUNT(1)
                            FROM jlpt_lex
                            GROUP BY 1,2,3
                            ORDER BY COUNT(1) DESC
                            """
                        ).fetchall()
                        for _r in _rows:
                            lines.append(f"- source_repo={_r[0]} | license={_r[1]} | confidence={_r[2]} | rows={_r[3]}")
                finally:
                    _c2.close()
        except Exception as _e:
            lines.append(f"- jlpt_license_summary_error: {_e}")

        if ojad_api_endpoint:
            lines.append(f"- ojad_api_status: {'READY' if ns.get('requests') is not None else 'REQUESTS_MISSING'}")
            lines.append(f"- ojad_api_endpoint: {ojad_api_endpoint}")
        else:
            lines.append("- ojad_api_status: DISABLED")

        return "\n".join(lines)

    # patch namespace
    ns["local_lookup_candidates"] = local_lookup_candidates_patched
    ns["lexicon_lookup"] = lexicon_lookup_patched
    if callable(orig_lookup_jlpt_for_word):
        ns["lookup_jlpt_for_word"] = lookup_jlpt_for_word_patched
    ns["kanji_lookup"] = kanji_lookup_patched
    ns["health_check"] = health_check_patched
    if callable(orig_pitch_accent):
        ns["pitch_accent"] = pitch_accent_patched
    if callable(orig_grammar_deep):
        ns["grammar_explain_deep_v2"] = grammar_explain_deep_patched
        ns["grammar_explain_deep"] = grammar_explain_deep_patched