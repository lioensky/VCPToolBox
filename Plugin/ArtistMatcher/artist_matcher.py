# -*- coding: utf-8 -*-
import sys
import json
import csv
import os
import random
from rapidfuzz import process, fuzz

# 全局变量缓存CSV数据
ARTIST_DATA = None
ARTIST_CHOICES = None

def load_artist_data():
    """
    加载艺术家数据。优先从缓存加载，如果缓存不存在则创建缓存。
    """
    global ARTIST_DATA, ARTIST_CHOICES
    if ARTIST_DATA is not None:
        return

    script_dir = os.path.dirname(__file__)
    cache_path = os.path.join(script_dir, 'artist_cache.json')
    
    try:
        # 优先从缓存加载
        if os.path.exists(cache_path):
            with open(cache_path, 'r', encoding='utf-8') as f:
                ARTIST_DATA = json.load(f)
        else:
            # 如果缓存不存在，则从原始CSV创建
            csv_path = os.path.join(script_dir, 'danbooru_artist.csv')
            if not os.path.exists(csv_path):
                raise FileNotFoundError(f"错误：原始数据文件未找到，路径：{csv_path}")

            temp_data = []
            with open(csv_path, mode='r', encoding='utf-8', errors='replace') as infile:
                reader = csv.DictReader(infile)
                for row in reader:
                    # 筛选 count > 100 的画师
                    count_str = row.get('count', '0')
                    if count_str.isdigit() and int(count_str) > 100:
                        temp_data.append(row)
            
            ARTIST_DATA = temp_data
            # 将筛选后的数据写入缓存
            with open(cache_path, 'w', encoding='utf-8') as f:
                json.dump(ARTIST_DATA, f, ensure_ascii=False, indent=2)

        # 为模糊搜索准备选择列表
        ARTIST_CHOICES = [row['trigger'] for row in ARTIST_DATA]

    except Exception as e:
        raise RuntimeError(f"加载或创建艺术家数据缓存时出错: {e}")


def find_best_match(query_name, score_cutoff=75):
    """
    在缓存的数据中查找最佳匹配项。
    """
    if ARTIST_CHOICES is None:
        load_artist_data()

    match = process.extractOne(query_name, ARTIST_CHOICES, scorer=fuzz.token_sort_ratio, score_cutoff=score_cutoff)

    if not match:
        return None

    best_trigger, score, _ = match
    
    for artist in ARTIST_DATA:
        if artist['trigger'] == best_trigger:
            return artist, score
    
    return None

def get_fitting_level(count_str):
    """
    根据count值返回拟合度描述。
    """
    try:
        count = int(count_str)
        if count > 5000: return f"{count} (极高)"
        elif count > 2000: return f"{count} (非常高)"
        elif count > 1000: return f"{count} (高)"
        elif count > 500: return f"{count} (中等)"
        else: return f"{count} (一般)"
    except (ValueError, TypeError):
        return f"{count_str} (未知)"

def get_random_artist_string():
    """
    生成一个随机的、带权重的画师组合字符串。
    """
    load_artist_data()

    if not ARTIST_DATA or len(ARTIST_DATA) < 6:
        return {"status": "error", "error": "符合条件的优质画师数量不足，无法生成画师串。"}

    num_artists = random.randint(3, 6)
    selected_artists = random.sample(ARTIST_DATA, num_artists)

    max_total_weight = 2 + (num_artists - 3) / 3.0
    
    weights = [random.uniform(0.3, 0.9) for _ in range(num_artists)]
    
    current_total_weight = sum(weights)
    if current_total_weight > max_total_weight:
        scale_factor = max_total_weight / current_total_weight
        weights = [w * scale_factor for w in weights]

    weights = [min(w, 0.9) for w in weights]

    artist_string_parts = [f"{artist['trigger']}:{weight:.2f}" for artist, weight in zip(selected_artists, weights)]
    final_string = ", ".join(artist_string_parts)

    result_text = (
        f"✨ **随机画师串已生成 ({num_artists}位)** ✨\n"
        f"----------------------------------------\n"
        f"请将以下内容直接复制到你的提示词中，体验不同风格的融合：\n\n"
        f"`{final_string}`\n\n"
        f"----------------------------------------\n"
        f"💡 **提示:** 你可以微调每个画师后面的权重值来改变其风格影响强度。"
    )
    
    return {"status": "success", "result": result_text}

def find_artist_by_name(artist_name):
    """
    根据名称查找单个画师。
    """
    match_result = find_best_match(artist_name)

    if match_result:
        artist_info, score = match_result
        fitting_level = get_fitting_level(artist_info.get('count'))
        
        result_text = (
            f"查询画师「{artist_name}」的匹配结果如下 (匹配度: {score}%):\n"
            f"----------------------------------------\n"
            f"🎨 **最佳匹配画师名 (Artist):** `{artist_info.get('artist', 'N/A')}`\n"
            f"🏷️ **最佳匹配触发词 (Trigger):** `{artist_info.get('trigger', 'N/A')}`\n"
            f"📈 **模型拟合值 (Count):** {fitting_level}\n"
            f"----------------------------------------\n"
            f"**建议:** 请使用 **触发词 (Trigger)** 作为你的主要artist tag以获得最佳效果。拟合值越高，模型对该画师风格的还原度通常越好。"
        )
        return {"status": "success", "result": result_text}
    else:
        result_text = f"很抱歉，未能为「{artist_name}」找到足够匹配的画师。请尝试更常见的画师名或检查拼写。"
        return {"status": "success", "result": result_text}

def main():
    output = {}
    try:
        input_str = sys.stdin.readline()
        if not input_str:
            raise ValueError("未从stdin接收到任何输入。")
            
        input_data = json.loads(input_str)
        command = input_data.get('command')

        # 确保数据已加载
        load_artist_data()

        if command == 'FindArtist':
            artist_name = input_data.get('artist_name')
            if not artist_name:
                raise ValueError("请求 'FindArtist' 命令时缺少 'artist_name' 参数。")
            output = find_artist_by_name(artist_name)
        
        elif command == 'GetRandomArtistString':
            output = get_random_artist_string()

        else:
            # 为兼容旧版（不带command的调用），将其视为FindArtist
            artist_name = input_data.get('artist_name')
            if artist_name:
                output = find_artist_by_name(artist_name)
            else:
                raise ValueError(f"未知的命令或缺少参数: {command}")

    except Exception as e:
        output = {"status": "error", "error": f"插件执行时发生错误: {str(e)}"}
    
    print(json.dumps(output, ensure_ascii=False))
    sys.stdout.flush()

if __name__ == "__main__":
    main()