import zipfile
import re
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def extract_epub_intro(epub_path):
    try:
        with zipfile.ZipFile(epub_path, 'r') as z:
            namelist = z.namelist()

            # 1. 提取简介
            intro_content = "暂无详细简介"
            intro_files = [f for f in namelist if "aux_" in f]
            if intro_files:
                try:
                    with z.open(intro_files[0]) as f:
                        html = f.read().decode('utf-8')
                        # 去除标签与样式
                        text = re.sub(r'<[^>]+>', '', html).strip()
                        lines = [l.strip() for l in text.split('\n') if l.strip()]
                        # 过滤掉重复的“简介”标题
                        clean_lines = []
                        for line in lines:
                            if line == "简介" and len(clean_lines) < 2:
                                continue
                            clean_lines.append(line)
                        intro_content = "\n".join(clean_lines)
                except Exception:
                    pass

            # 2. 提取目录
            chapters = []
            chapter_files = sorted([f for f in namelist if "chapter_" in f])
            total_chapters = len(chapter_files)

            def get_title(filepath):
                try:
                    with z.open(filepath) as f:
                        html = f.read().decode('utf-8')
                        title_match = re.search(r'<title>(.*?)</title>', html, re.IGNORECASE)
                        if title_match:
                            return title_match.group(1).strip()
                        text = re.sub(r'<[^>]+>', '', html).strip()
                        lines = [l.strip() for l in text.split('\n') if l.strip()]
                        return lines[0] if lines else "未知章节"
                except Exception:
                    return "章节读取失败"

            if total_chapters == 0:
                chapters.append("(未检测到章节)")
            elif total_chapters <= 30:
                for f in chapter_files:
                    chapters.append(get_title(f))
            else:
                for f in chapter_files[:15]:
                    chapters.append(get_title(f))
                chapters.append(f"... (中间省略 {total_chapters - 20} 章) ...")
                for f in chapter_files[-5:]:
                    chapters.append(get_title(f))

            # 3. 组织为精美的 Markdown
            md = []
            md.append(f"## 📖 小说大纲简介\n\n{intro_content}\n")
            md.append(f"## 🗂️ 小说目录大纲 (共 {total_chapters} 章)\n")
            for title in chapters:
                if "中间省略" in title:
                    md.append(f"\n{title}\n")
                else:
                    md.append(f"- {title}")
            return "\n".join(md)

    except Exception as e:
        return f"Error reading EPUB: {e}"

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python extract_intro.py <path_to_epub>")
        sys.exit(1)
    epub_path = sys.argv[1]
    report = extract_epub_intro(epub_path)
    print(report)
