#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
JapaneseHelper Database Setup Script
自动下载源数据并构建 SQLite 数据库
"""

import os
import sys
import gzip
import json
import sqlite3
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional

def configure_stdio():
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream and hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass

configure_stdio()

# 数据源URL
SOURCES = {
    "jmdict": "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz",
    "kanjidic": "http://ftp.edrdg.org/pub/Nihongo/kanjidic2.xml.gz",
    "wadoku": os.environ.get("WADOKU_MIRROR_URL", "")
}

class DatabaseBuilder:
    def __init__(self, plugin_dir: str):
        self.plugin_dir = Path(plugin_dir)
        self.data_dir = self.plugin_dir / "data"
        self.raw_dir = self.data_dir / "raw"
        self.db_dir = self.data_dir / "db"
        self.db_path = self.db_dir / "jdict_full.sqlite"
        
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        self.db_dir.mkdir(parents=True, exist_ok=True)
    
    def download_file(self, url: str, dest: Path, desc: str = "") -> bool:
        if dest.exists():
            print(f"✓ {desc} 已存在，跳过下载")
            return True
        
        print(f"⬇ 下载 {desc}...")
        print(f"  URL: {url}")
        
        try:
            def progress(block_num, block_size, total_size):
                downloaded = block_num * block_size
                percent = min(100, downloaded * 100 / total_size) if total_size > 0 else 0
                mb_downloaded = downloaded / 1024 / 1024
                mb_total = total_size / 1024 / 1024
                print(f"\r  进度: {percent:.1f}% ({mb_downloaded:.1f}/{mb_total:.1f} MB)", end="")
            
            urllib.request.urlretrieve(url, dest, reporthook=progress)
            print()
            print(f"✓ {desc} 下载完成")
            return True
        except Exception as e:
            print(f"\n✗ {desc} 下载失败: {e}")
            return False
    
    def parse_jmdict(self, gz_path: Path) -> int:
        print("\n📖 解析 JMdict...")
        
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        try:
            conn.execute("DROP TABLE IF EXISTS jm_lex")
            conn.execute("""
                CREATE TABLE jm_lex (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    word TEXT NOT NULL,
                    reading TEXT DEFAULT '',
                    pos TEXT DEFAULT '',
                    gloss TEXT DEFAULT '',
                    seq INTEGER DEFAULT 0,
                    pri INTEGER DEFAULT 0
                )
            """)
            
            with gzip.open(gz_path, 'rt', encoding='utf-8') as f:
                tree = ET.parse(f)
                root = tree.getroot()
                
                entries = root.findall('entry')
                total = len(entries)
                print(f"  找到 {total} 个词条")
                
                batch = []
                for i, entry in enumerate(entries, 1):
                    if i % 1000 == 0:
                        print(f"\r  进度: {i}/{total} ({i*100//total}%)", end="")
                    
                    seq = entry.find('ent_seq')
                    seq_num = int(seq.text) if seq is not None and seq.text else 0
                    
                    kanjis = [k.find('keb').text for k in entry.findall('k_ele') if k.find('keb') is not None]
                    readings = [r.find('reb').text for r in entry.findall('r_ele') if r.find('reb') is not None]
                    
                    pri = 0
                    for k_ele in entry.findall('k_ele'):
                        if k_ele.find('ke_pri') is not None:
                            pri = max(pri,2)
                    for r_ele in entry.findall('r_ele'):
                        if r_ele.find('re_pri') is not None:
                            pri = max(pri, 1)
                    
                    for sense in entry.findall('sense'):
                        pos_tags = [p.text for p in sense.findall('pos')]
                        pos_str = ','.join(pos_tags) if pos_tags else ''
                        
                        glosses = [g.text for g in sense.findall('gloss') if g.text]
                        gloss_str = '; '.join(glosses) if glosses else ''
                        
                        for kanji in (kanjis or ['']):
                            for reading in (readings or ['']):
                                batch.append((kanji or reading, reading, pos_str, gloss_str, seq_num, pri))
                    if len(batch) >= 5000:
                        conn.executemany(
                            "INSERT INTO jm_lex (word, reading, pos, gloss, seq, pri) VALUES (?, ?, ?, ?, ?, ?)",
                            batch
                        )
                        batch = []
                
                if batch:
                    conn.executemany(
                        "INSERT INTO jm_lex (word, reading, pos, gloss, seq, pri) VALUES (?, ?, ?, ?, ?, ?)",
                        batch
                    )
                
                print(f"\r  进度: {total}/{total} (100%)")
                
                print("  创建索引...")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_jm_word ON jm_lex(word)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_jm_reading ON jm_lex(reading)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_jm_seq ON jm_lex(seq)")
                
                conn.commit()
                count = conn.execute("SELECT COUNT(*) FROM jm_lex").fetchone()[0]
                print(f"✓ JMdict 导入完成: {count} 条记录")
                return count
        finally:
            conn.close()
    
    def parse_kanjidic(self, gz_path: Path) -> int:
        print("\n📖 解析 KANJIDIC2...")
        
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        try:
            conn.execute("DROP TABLE IF EXISTS kd_lex")
            conn.execute("""
                CREATE TABLE kd_lex (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    literal TEXT NOT NULL UNIQUE,
                    onyomi TEXT DEFAULT '',
                    kunyomi TEXT DEFAULT '',
                    meaning TEXT DEFAULT '',
                    jlpt TEXT DEFAULT '',
                    grade TEXT DEFAULT '',
                    stroke_count INTEGER DEFAULT 0,
                    radical TEXT DEFAULT ''
                )
            """)
            
            with gzip.open(gz_path, 'rt', encoding='utf-8') as f:
                tree = ET.parse(f)
                root = tree.getroot()
                
                characters = root.findall('character')
                total = len(characters)
                print(f"  找到 {total} 个汉字")
                
                batch = []
                for i, char in enumerate(characters, 1):
                    if i % 500 == 0:
                        print(f"\r  进度: {i}/{total} ({i*100//total}%)", end="")
                    
                    literal = char.find('literal')
                    if literal is None or not literal.text:
                        continue
                    
                    lit = literal.text
                    
                    onyomi = []
                    kunyomi = []
                    for reading in char.findall('.//reading'):
                        r_type = reading.get('r_type', '')
                        if r_type == 'ja_on' and reading.text:
                            onyomi.append(reading.text)
                        elif r_type == 'ja_kun' and reading.text:
                            kunyomi.append(reading.text)
                    
                    meanings = [m.text for m in char.findall('.//meaning') if m.text and not m.get('m_lang')]
                    
                    jlpt = ''
                    jlpt_elem = char.find('.//jlpt')
                    if jlpt_elem is not None and jlpt_elem.text:
                        jlpt = f"N{jlpt_elem.text}"
                    
                    grade = ''
                    grade_elem = char.find('.//grade')
                    if grade_elem is not None and grade_elem.text:
                        grade = grade_elem.text
                    
                    stroke =0
                    stroke_elem = char.find('.//stroke_count')
                    if stroke_elem is not None and stroke_elem.text:
                        try:
                            stroke = int(stroke_elem.text)
                        except:
                            pass
                    
                    radical = ''
                    rad_elem = char.find('.//rad_value[@rad_type="classical"]')
                    if rad_elem is not None and rad_elem.text:
                        radical = rad_elem.text
                    
                    batch.append((
                        lit,
                        ', '.join(onyomi),
                        ', '.join(kunyomi),
                        '; '.join(meanings),
                        jlpt,
                        grade,
                        stroke,
                        radical
                    ))
                
                    if len(batch) >= 1000:
                        conn.executemany(
                            "INSERT OR REPLACE INTO kd_lex (literal, onyomi, kunyomi, meaning, jlpt, grade, stroke_count, radical) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            batch
                        )
                        batch = []
                
                if batch:
                    conn.executemany(
                        "INSERT OR REPLACE INTO kd_lex (literal, onyomi, kunyomi, meaning, jlpt, grade, stroke_count, radical) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        batch
                    )
                
                print(f"\r  进度: {total}/{total} (100%)")
                
                print("  创建索引...")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_kd_literal ON kd_lex(literal)")
                
                conn.commit()
                
                count = conn.execute("SELECT COUNT(*) FROM kd_lex").fetchone()[0]
                print(f"✓ KANJIDIC2 导入完成: {count} 条记录")
                return count
        finally:
            conn.close()
    
    def setup_extended_tables(self):
        print("\n📋 创建扩展表结构...")
        
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        try:
            conn.execute("""
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
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_grammar_pattern ON grammar_lex(pattern)")
            conn.execute("""
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
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_wadoku_lemma ON wadoku_lex(lemma)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_wadoku_reading ON wadoku_lex(reading)")
            
            conn.execute("""
                CREATE TABLE IF NOT EXISTS ojad_pitch (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    surface TEXT NOT NULL,
                    reading TEXT DEFAULT '',
                    accent_pattern TEXT DEFAULT '',
                    mora_count INTEGER DEFAULT 0,
                    audio_ref TEXT DEFAULT '',
                    source TEXT DEFAULT 'ojad'
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_ojad_surface ON ojad_pitch(surface)")
            conn.execute("""
                CREATE TABLE IF NOT EXISTS jlpt_lex (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    expression TEXT NOT NULL,
                    reading TEXT DEFAULT '',
                    level TEXT DEFAULT '',
                    source_repo TEXT DEFAULT '',
                    license TEXT DEFAULT '',
                    confidence TEXT DEFAULT ''
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_jlpt_expression ON jlpt_lex(expression)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_jlpt_reading ON jlpt_lex(reading)")
            
            conn.commit()
            print("✓ 扩展表结构创建完成")
        finally:
            conn.close()
    
    def run(self):
        print("=" * 60)
        print("JapaneseHelper 数据库自动构建工具")
        print("=" * 60)
        
        jmdict_gz = self.raw_dir / "JMdict_e.gz"
        if not self.download_file(SOURCES["jmdict"], jmdict_gz, "JMdict_e.gz"):
            print("\n✗ JMdict 下载失败，无法继续")
            return False
        
        kanjidic_gz = self.raw_dir / "kanjidic2.xml.gz"
        if not self.download_file(SOURCES["kanjidic"], kanjidic_gz, "kanjidic2.xml.gz"):
            print("\n✗ KANJIDIC2 下载失败，无法继续")
            return False
        
        try:
            self.parse_jmdict(jmdict_gz)
        except Exception as e:
            print(f"\n✗ JMdict 解析失败: {e}")
            import traceback
            traceback.print_exc()
            return False
        
        try:
            self.parse_kanjidic(kanjidic_gz)
        except Exception as e:
            print(f"\n✗ KANJIDIC2 解析失败: {e}")
            import traceback
            traceback.print_exc()
            return False
        
        try:
            self.setup_extended_tables()
        except Exception as e:
            print(f"\n✗ 扩展表创建失败: {e}")
            return False
        
        if SOURCES["wadoku"]:
            print(f"\n⚠ Wadoku 镜像地址已配置，但导入功能尚未实现")
            print(f"  URL: {SOURCES['wadoku']}")
        else:
            print(f"\n⚠ Wadoku 未配置（可选功能）")
            print(f"  如需启用，请设置环境变量: WADOKU_MIRROR_URL")
        
        print("\n" + "=" * 60)
        print("✓ 数据库构建完成！")
        print(f"  位置: {self.db_path}")
        print(f"  大小: {self.db_path.stat().st_size / 1024 / 1024:.1f} MB")
        print("=" * 60)
        
        return True

def main():
    script_dir = Path(__file__).parent
    plugin_root = script_dir.parent
    builder = DatabaseBuilder(str(plugin_root))
    try:
        success = builder.run()
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n\n✗ 用户中断")
        sys.exit(1)
    except Exception as e:
        print(f"\n✗ 构建失败: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()