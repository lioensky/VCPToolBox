#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
JapaneseHelper Wadoku Dictionary Setup Script
自动下载 wadoku.xml 并导入 SQLite 数据库
"""

import os
import sys
import sqlite3
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

# Wadoku 下载地址（可通过环境变量覆盖）
WADOKU_DOWNLOAD_URL = os.environ.get(
    "WADOKU_DOWNLOAD_URL",
    "https://www.wadoku.de/downloads/xml-export.xml.gz"  # 默认地址，可能需要更新
)

class WadokuImporter:
    def __init__(self, plugin_dir: str):
        self.plugin_dir = Path(plugin_dir)
        self.data_dir = self.plugin_dir / "data"
        self.wadoku_dir = self.data_dir / "wadoku-xml"
        self.db_dir = self.data_dir / "db"
        self.db_path = self.db_dir / "jdict_full.sqlite"
        
        # 创建目录
        self.wadoku_dir.mkdir(parents=True, exist_ok=True)
        # 查找或设置 wadoku.xml 路径
        self.wadoku_xml = None
        for pattern in ["wadoku-xml-*/wadoku.xml", "wadoku-xml/wadoku.xml", "wadoku.xml"]:
            matches = list(self.data_dir.glob(pattern))
            if matches:
                self.wadoku_xml = matches[0]
                break
        
        if not self.wadoku_xml:
            self.wadoku_xml = self.wadoku_dir / "wadoku.xml"
    
    def download_wadoku(self) -> bool:
        """下载Wadoku XML 文件"""
        if self.wadoku_xml.exists():
            print(f"✓ Wadoku 文件已存在，跳过下载")
            print(f"  路径: {self.wadoku_xml}")
            print(f"  大小: {self.wadoku_xml.stat().st_size / 1024 / 1024:.1f} MB")
            return True
        
        print(f"⬇ 下载 Wadoku 词典...")
        print(f"  URL: {WADOKU_DOWNLOAD_URL}")
        print(f"  目标: {self.wadoku_xml}")
        print()
        
        try:
            def progress(block_num, block_size, total_size):
                downloaded = block_num * block_size
                percent = min(100, downloaded * 100 / total_size) if total_size > 0 else 0
                mb_downloaded = downloaded / 1024 / 1024
                mb_total = total_size / 1024 / 1024
                print(f"\r  进度: {percent:.1f}% ({mb_downloaded:.1f}/{mb_total:.1f} MB)", end="")
            
            urllib.request.urlretrieve(WADOKU_DOWNLOAD_URL, self.wadoku_xml, reporthook=progress)
            print()
            print(f"✓ Wadoku 下载完成")
            return True
        except Exception as e:
            print(f"\n✗ Wadoku 下载失败: {e}")
            print()
            print("请尝试以下方法：")
            print("1. 手动从https://www.wadoku.de 下载 wadoku.xml")
            print(f"2. 将文件放置在: {self.wadoku_xml}")
            print("3. 或设置环境变量 WADOKU_DOWNLOAD_URL 指定镜像地址")
            return False
    
    def import_wadoku(self) -> int:
        if not self.wadoku_xml.exists():
            print("✗ wadoku.xml 文件不存在")
            return 0
        
        if not self.db_path.exists():
            print("✗ 数据库文件不存在，请先运行 setup_database.py")
            return 0
        
        print(f"\n📖 解析 Wadoku: {self.wadoku_xml.name}")
        print(f"  文件大小: {self.wadoku_xml.stat().st_size / 1024 / 1024:.1f} MB")
        
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        try:
            conn.execute("DELETE FROM wadoku_lex")
            
            tree = ET.parse(self.wadoku_xml)
            root = tree.getroot()
            
            # Strip namespace from all elements for easier querying
            for elem in root.iter():
                if '}' in elem.tag:
                    elem.tag = elem.tag.split('}', 1)[1]
            entries = root.findall('.//entry')
            total = len(entries)
            print(f"  找到 {total} 个词条")
            
            batch = []
            for i, entry in enumerate(entries, 1):
                if i % 2000 == 0:
                    print(f"\r  进度: {i}/{total} ({i*100//total}%)", end="")
                
                lemma = ''
                reading = ''
                pos = ''
                gloss_de = ''
                gloss_en = ''
                tags = ''
                
                form = entry.find('.//form')
                if form is not None:
                    orth = form.find('orth')
                    if orth is not None and orth.text:
                        lemma = orth.text.strip()
                    
                    pron = form.find('.//hira')
                    if pron is not None and pron.text:
                        reading = pron.text.strip()
                
                gramGrp = entry.find('.//gramGrp')
                if gramGrp is not None:
                    pos_children = list(gramGrp)
                    if pos_children:
                        pos = pos_children[0].tag
                senses = entry.findall('.//sense')
                de_glosses = []
                en_glosses = []
                
                for sense in senses:
                    for trans in sense.findall('.//trans'):
                        lang = trans.get('{http://www.w3.org/XML/1998/namespace}lang', 'de')
                        text = ''.join(trans.itertext()).strip()
                        if text:
                            if lang == 'de':
                                de_glosses.append(text)
                            elif lang == 'en':
                                en_glosses.append(text)
                
                gloss_de = '; '.join(de_glosses) if de_glosses else ''
                gloss_en = '; '.join(en_glosses) if en_glosses else ''
                
                tag_list = []
                for usg in entry.findall('.//usg'):
                    if usg.text:
                        tag_list.append(usg.text.strip())
                tags = ', '.join(tag_list) if tag_list else ''
                
                if lemma:
                    batch.append((lemma, reading, pos, gloss_de, gloss_en, tags,'wadoku'))
                
                if len(batch) >= 5000:
                    conn.executemany(
                        "INSERT INTO wadoku_lex (lemma, reading, pos, gloss_de, gloss_en, tags, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        batch
                    )
                    batch = []
            
            if batch:
                conn.executemany(
                    "INSERT INTO wadoku_lex (lemma, reading, pos, gloss_de, gloss_en, tags, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    batch
                )
            
            print(f"\r  进度: {total}/{total} (100%)")
            conn.commit()
            count = conn.execute("SELECT COUNT(*) FROM wadoku_lex").fetchone()[0]
            print(f"✓ Wadoku 导入完成: {count} 条记录")
            return count
        except Exception as e:
            print(f"\n✗ Wadoku 导入失败: {e}")
            import traceback
            traceback.print_exc()
            return 0
        finally:
            conn.close()
    
    def run(self):
        print("=" * 60)
        print("JapaneseHelper Wadoku 词典自动安装工具")
        print("=" * 60)
        print()
        
        # 1. 下载 Wadoku
        if not self.download_wadoku():
            return False
        
        # 2. 导入数据库
        try:
            count = self.import_wadoku()
            if count > 0:
                print("\n" + "=" * 60)
                print("✓ Wadoku 安装完成！")
                print(f"  数据库: {self.db_path}")
                print(f"  词条数: {count}")
                print("=" * 60)
                return True
            else:
                return False
        except Exception as e:
            print(f"\n✗ 安装失败: {e}")
            import traceback
            traceback.print_exc()
            return False

def main():
    script_dir = Path(__file__).parent
    plugin_root = script_dir.parent
    importer = WadokuImporter(str(plugin_root))
    try:
        success = importer.run()
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n\n✗ 用户中断")
        sys.exit(1)
    except Exception as e:
        print(f"\n✗ 安装失败: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()