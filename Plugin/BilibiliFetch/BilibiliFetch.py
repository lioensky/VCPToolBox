#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import json
import os
import time
# --- Bilibili 域定向直连与代理友好协调 ---
# 国内用户挂全局/系统代理（如 Clash 7890 端口）常导致 B站 API 误走海外节点触发 412 风控。
# 通过规范注入 NO_PROXY，让发往 B站 域名的请求在代理环境下优先直连，同时保留海内外用户的自定义代理规则。
bili_target_domains = ("bilibili.com", "bilivideo.com", "hdslb.com", "bvc.bilivideo.com")
current_no_proxy = os.environ.get('NO_PROXY', os.environ.get('no_proxy', ''))
if '*' not in current_no_proxy:
    needed_domains = [d for d in bili_target_domains if d not in current_no_proxy]
    if needed_domains:
        new_no_proxy = f"{current_no_proxy},{','.join(needed_domains)}".strip(',')
        os.environ['NO_PROXY'] = new_no_proxy
        os.environ['no_proxy'] = new_no_proxy
# ----------------------------------------------------
import requests
import logging
import re
# Removed FastMCP import
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
import io
from functools import reduce
from hashlib import md5
import urllib.parse
import subprocess
import shutil
# --- Logging Setup ---
# Log to stderr to avoid interfering with stdout communication
# Use a custom handler to ensure UTF-8 output even on Windows
def get_ffmpeg_path():
    """查找 ffmpeg：项目内置 → 系统 PATH"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    # BilibiliFetch.py 在 Plugin/BilibiliFetch/ 下，往上3层到项目根
    project_root = os.path.join(script_dir, '..', '..', '..')
    ext = '.exe' if os.name == 'nt' else ''
    candidates = [
        os.path.join(project_root, 'VCPChat', 'bin', f'ffmpeg{ext}'),
        os.path.join(project_root, 'VCPToolBox', 'bin', f'ffmpeg{ext}'),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return os.path.abspath(path)
    return 'ffmpeg'

class UTF8StreamHandler(logging.StreamHandler):
    def emit(self, record):
        try:
            msg = self.format(record)
            stream = self.stream
            if hasattr(stream, 'buffer'):
                stream.buffer.write((msg + self.terminator).encode('utf-8'))
                stream.buffer.flush()
            else:
                stream.write(msg + self.terminator)
                self.flush()
        except Exception:
            self.handleError(record)

handler = UTF8StreamHandler(sys.stderr)
handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
logging.getLogger().addHandler(handler)
logging.getLogger().setLevel(logging.INFO)

# --- Constants ---
BILIBILI_VIDEO_BASE_URL = "https://www.bilibili.com/video/"
PAGELIST_API_URL = "https://api.bilibili.com/x/player/pagelist"
PLAYER_WBI_API_URL = "https://api.bilibili.com/x/player/wbi/v2"
SEARCH_WBI_API_URL = "https://api.bilibili.com/x/web-interface/wbi/search/type"
SPACE_ARC_WBI_API_URL = "https://api.bilibili.com/x/space/wbi/arc/search"
NAV_API_URL = "https://api.bilibili.com/x/web-interface/nav"
PBP_API_URL = "https://bvc.bilivideo.com/pbp/data"
VIEW_API_URL = "https://api.bilibili.com/x/web-interface/view"
SUMMARY_API_URL = "https://api.bilibili.com/x/web-interface/view/conclusion/get"

# --- WBI Signing Logic ---

mixinKeyEncTab = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
]

def getMixinKey(orig: str):
    """对 imgKey 和 subKey 进行字符顺序打乱编码"""
    return reduce(lambda s, i: s + orig[i], mixinKeyEncTab, '')[:32]

def encWbi(params: dict, img_key: str, sub_key: str):
    """为请求参数进行 wbi 签名"""
    mixin_key = getMixinKey(img_key + sub_key)
    curr_time = round(time.time())
    params['wts'] = curr_time                                   # 添加 wts 字段
    params = dict(sorted(params.items()))                       # 按照 key 重排参数
    # 过滤 value 中的 "!'()*" 字符
    params = {
        k : ''.join(filter(lambda chr: chr not in "!'()*", str(v)))
        for k, v
        in params.items()
    }
    query = urllib.parse.urlencode(params)                      # 序列化参数
    wbi_sign = md5((query + mixin_key).encode()).hexdigest()    # 计算 w_rid
    params['w_rid'] = wbi_sign
    return params

def getWbiKeys(headers: dict) -> tuple[str, str]:
    """获取最新的 img_key 和 sub_key"""
    try:
        resp = requests.get(NAV_API_URL, headers=headers, timeout=10)
        resp.raise_for_status()
        json_content = resp.json()
        wbi_img = json_content.get('data', {}).get('wbi_img', {})
        img_url = wbi_img.get('img_url')
        sub_url = wbi_img.get('sub_url')
        if not img_url or not sub_url:
            logging.error("Failed to get WBI keys from nav API.")
            return "", ""
        img_key = img_url.rsplit('/', 1)[1].split('.')[0]
        sub_key = sub_url.rsplit('/', 1)[1].split('.')[0]
        return img_key, sub_key
    except Exception as e:
        logging.error(f"Error getting WBI keys: {e}")
        return "", ""

# --- Cookie Management ---

def read_config_value(key: str, default: str = '', global_fallback: bool = True) -> str:
    """从 config.env 文件读取指定键的值。支持热重载，并可选回退至全局 config.env。"""
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        # 1. 优先尝试读取插件目录下的 config.env
        config_path = os.path.join(script_dir, 'config.env')
        if os.path.exists(config_path):
            with open(config_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('#') or not line:
                        continue
                    if line.startswith(f"{key}="):
                        return line[len(key)+1:].strip().strip('"')
        
        # 2. 回退尝试读取 VCP 根目录下的 config.env
        if global_fallback:
            global_path = os.path.abspath(os.path.join(script_dir, '..', '..', 'config.env'))
            if os.path.exists(global_path):
                with open(global_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith('#') or not line:
                            continue
                        if line.startswith(f"{key}="):
                            return line[len(key)+1:].strip().strip('"')
    except Exception as e:
        logging.warning(f"Failed to read {key} from config.env: {e}")
    return default

def get_config_priority(key: str, env_keys: list = None, default: str = '') -> str:
    """
    按照优先级获取配置项的值：
    1. 插件目录下的本地 config.env 文件（最高优先级）
    2. 系统环境变量（os.environ）
    3. 全局 VCP 根目录下的 config.env 文件（回退）
    4. 默认值
    """
    # 1. 尝试读取本地插件目录内的 config.env (关闭全局回退)
    local_val = read_config_value(key, default='', global_fallback=False)
    if local_val:
        return local_val
    if env_keys:
        for env_key in env_keys:
            local_val = read_config_value(env_key, default='', global_fallback=False)
            if local_val:
                return local_val

    # 2. 尝试读取系统环境变量
    if env_keys:
        for env_key in env_keys:
            env_val = os.environ.get(env_key)
            if env_val:
                return env_val
    else:
        env_val = os.environ.get(key)
        if env_val:
            return env_val

    # 3. 尝试读取全局根目录的 config.env (开启全局回退)
    global_val = read_config_value(key, default='', global_fallback=True)
    if global_val:
        return global_val
    if env_keys:
        for env_key in env_keys:
            global_val = read_config_value(env_key, default='', global_fallback=True)
            if global_val:
                return global_val

    return default

class BilibiliCookieManager:
    """
    内联凭据管理器：协调浏览器热扩展缓存、局部 config.env 与全局回退。
    实现原子读取、重试保护与 SESSDATA 优先动态合并。
    """
    def __init__(self):
        self.script_dir = os.path.dirname(os.path.abspath(__file__))
        self.cache_file = os.path.join(self.script_dir, '.cookies_cache')

    def get_fresh_cookie(self) -> str:
        """从本地隐藏缓存文件或 config.env 中构建最新的 Cookie 字符串。"""
        sessdata_from_cache = ""
        other_cookie = ""

        if os.path.exists(self.cache_file):
            for attempt in range(3):
                try:
                    with open(self.cache_file, "r", encoding="utf-8") as f:
                        cache_data = json.load(f)
                        sessdata_from_cache = cache_data.get("SESSDATA", "").strip()
                        other_cookie = cache_data.get("BILIBILI_COOKIE", "").strip()
                    break  # 读取成功
                except Exception as e:
                    if attempt < 2:
                        time.sleep(0.05)  # 避让可能的写锁冲突
                        continue
                    cache_size = os.path.getsize(self.cache_file) if os.path.exists(self.cache_file) else -1
                    logging.warning(
                        f"Failed to read .cookies_cache after 3 attempts (size={cache_size}B). "
                        f"Falling back to config.env. Error: {e}"
                    )

        # 若无缓存或缓存不全，多级回退到 config.env (优先局部，回退全局)
        if not other_cookie:
            other_cookie = get_config_priority('BILIBILI_COOKIE').strip().strip('"')

        cookie_dict = {}
        if other_cookie:
            for part in other_cookie.split(';'):
                part = part.strip()
                if '=' in part:
                    k, v = part.split('=', 1)
                    cookie_dict[k.strip()] = v.strip()

        # 浏览器扩展更新的 SESSDATA 具备最高优先级覆盖权
        if sessdata_from_cache:
            cookie_dict['SESSDATA'] = sessdata_from_cache

        return "; ".join(f"{k}={v}" for k, v in cookie_dict.items())


def build_bilibili_cookie() -> str:
    """
    构建完整的 B站 Cookie 字符串。
    自闭环调度内联 BilibiliCookieManager，实现无外部依赖的热加载。
    """
    try:
        manager = BilibiliCookieManager()
        full_cookie = manager.get_fresh_cookie()
        if "SESSDATA" in full_cookie:
            logging.info("Cookie contains SESSDATA. Login-required APIs (AI subtitles) should work.")
        else:
            logging.warning("Cookie does NOT contain SESSDATA. Login-required APIs (AI subtitles) will fail with -101. "
                            "Please ensure SESSDATA is included in BILIBILI_COOKIE.")
        return full_cookie
    except Exception as e:
        logging.warning(f"Error building cookie via manager, falling back to static config: {e}")
        other_cookie = get_config_priority('BILIBILI_COOKIE').strip().strip('"')
        cookie_dict = {}
        if other_cookie:
            for part in other_cookie.split(';'):
                part = part.strip()
                if '=' in part:
                    k, v = part.split('=', 1)
                    cookie_dict[k.strip()] = v.strip()
        return "; ".join(f"{k}={v}" for k, v in cookie_dict.items())

# --- Helper Functions ---


def extract_bvid_and_page(video_input: str) -> 'tuple[str | None, int]':
    """Extracts BV ID and page number from URL or direct input."""
    bvid = None
    page = 1
    match = re.search(r'bilibili\.com/video/(BV[a-zA-Z0-9]+)', video_input, re.IGNORECASE)
    if match:
        bvid = match.group(1)
        page_match = re.search(r'[?&]p=(\d+)', video_input)
        if page_match:
            page = int(page_match.group(1))
    else:
        match = re.match(r'^(BV[a-zA-Z0-9]+)$', video_input, re.IGNORECASE)
        if match:
            bvid = match.group(1)
    return bvid, page


def get_cid_for_page(bvid: str, page: int, headers: dict) -> str | None:
    """Fetches CID for a specific page of a multi-part video via pagelist API."""
    try:
        logging.info(f"Fetching CID for BVID: {bvid}, page: {page}")
        resp = requests.get(PAGELIST_API_URL, params={'bvid': bvid}, headers=headers, timeout=10)
        data = resp.json()
        if data.get('code') == 0 and data.get('data'):
            pl = data['data']
            idx = page - 1
            if 0 <= idx < len(pl):
                logging.info(f"Found CID {pl[idx]['cid']} for page {page}")
                return str(pl[idx]['cid'])
            else:
                logging.warning(f"Page {page} out of range, using page 1")
                return str(pl[0]['cid']) if pl else None
    except Exception as e:
        logging.error(f"Error fetching CID for page {page}: {e}")
    return None


def extract_bvid(video_input: str) -> str | None:
    """Legacy wrapper for backward compatibility."""
    bvid, _ = extract_bvid_and_page(video_input)
    return bvid

def get_subtitle_json_string(bvid: str, user_cookie: str | None, lang_code: str | None = None, target_cid: str | None = None) -> str:
    """
    Fetches subtitle JSON for a given BVID, allowing language selection.
    Tries multiple sources:
    1. View API (data.subtitle.list)
    2. Player WBI API (data.subtitle.subtitles)
    3. AI Summary API (data.model_result.subtitle) - Ultimate fallback
    Returns the subtitle content as a JSON string or '{"body":[]}' if none found or error.
    """
    if user_cookie and 'SESSDATA' not in user_cookie:
        logging.warning("BILIBILI_COOKIE does not contain 'SESSDATA'. AI Summary API (AI字幕) will likely fail with -101 (账号未登录).")

    logging.info(f"Attempting to fetch subtitles for BVID: {bvid}")
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
        'Accept': 'application/json, text/plain, */*',
        'Referer': f'{BILIBILI_VIDEO_BASE_URL}{bvid}/',
        'Origin': 'https://www.bilibili.com',
    }
    if user_cookie:
        headers['Cookie'] = user_cookie

    aid, cid = None, None
    subtitles_from_apis = [] # List of subtitle objects from various APIs

    wbi_keys_cached = None
    def get_cached_wbi_keys():
        nonlocal wbi_keys_cached
        if wbi_keys_cached is None:
            wbi_keys_cached = getWbiKeys(headers)
        return wbi_keys_cached

    # --- Step 1: Get Video Info & Subtitles from View API ---
    try:
        logging.info(f"Step 1: Fetching video info via View API: {bvid}")
        view_resp = requests.get(VIEW_API_URL, params={'bvid': bvid}, headers=headers, timeout=10)
        view_data = view_resp.json()
        if view_data.get('code') == 0:
            data = view_data.get('data', {})
            aid = str(data.get('aid'))
            cid = str(data.get('cid'))
            view_subs = data.get('subtitle', {}).get('list', [])
            if view_subs:
                subtitles_from_apis.extend(view_subs)
                logging.info(f"Step 1: Found {len(view_subs)} subtitles via View API.")
        else:
            logging.warning(f"Step 1: View API returned error {view_data.get('code')}: {view_data.get('message')}")
    except Exception as e:
        logging.warning(f"Step 1: Error fetching via View API: {e}")

   # --- Step 1.5: Override CID for multi-part video ---
    if target_cid:
        logging.info(f"Overriding CID with target_cid: {target_cid}")
        cid = target_cid
        subtitles_from_apis = []

    # --- Step 2: Get CID from Pagelist (if View API failed to provide CID) ---
    if not cid:
        try:
            logging.info(f"Step 2: Fetching CID from pagelist API for {bvid}")
            page_resp = requests.get(PAGELIST_API_URL, params={'bvid': bvid}, headers=headers, timeout=10)
            page_data = page_resp.json()
            if page_data.get('code') == 0 and page_data.get('data'):
                cid = str(page_data['data'][0]['cid'])
                logging.info(f"Step 2: Found CID via pagelist fallback: {cid}")
        except Exception as e:
            logging.error(f"Step 2: Error fetching pagelist: {e}")

    if not cid:
        logging.error("Could not obtain CID, cannot proceed with subtitle fetching.")
        return json.dumps({"body":[]})

    # --- Step 3: Get Subtitles from Player WBI API ---
    try:
        logging.info("Step 3: Fetching subtitle list using WBI Player API...")
        img_key, sub_key = get_cached_wbi_keys()
        # 精简参数，移除 isGaiaAvoided 等硬编码参数，避免触发新版风控
        wbi_params = {'cid': cid, 'bvid': bvid}
        if aid: wbi_params['aid'] = aid
        
        if img_key and sub_key:
            wbi_params = encWbi(wbi_params, img_key, sub_key)
        else:
            wbi_params['wts'] = int(time.time())

        wbi_resp = requests.get(PLAYER_WBI_API_URL, params=wbi_params, headers=headers, timeout=15)
        wbi_data = wbi_resp.json()
        if wbi_data.get('code') == 0:
            wbi_subs = wbi_data.get('data', {}).get('subtitle', {}).get('subtitles', [])
            if wbi_subs:
                subtitles_from_apis.extend(wbi_subs)
                logging.info(f"Step 3: Found {len(wbi_subs)} subtitles via Player WBI API.")
        else:
            logging.warning(f"Step 3: Player WBI API returned error {wbi_data.get('code')}: {wbi_data.get('message')}")
    except Exception as e:
        logging.warning(f"Step 3: Error fetching via Player WBI API: {e}")

    # --- Step 4: Language Selection & Fetch Content ---
    subtitle_url = None
    if subtitles_from_apis:
        subtitle_map = {}
        for sub in subtitles_from_apis:
            lan = sub.get('lan')
            url = sub.get('subtitle_url')
            if lan and url:
                if url.startswith('//'): url = "https:" + url
                subtitle_map[lan] = url

        logging.info(f"Collected subtitle languages: {list(subtitle_map.keys())}")

        selected_lan = None
        # 获取所有 ai 开头的字幕语言标识，增强泛化兼容性
        ai_lans = [l for l in subtitle_map.keys() if str(l).startswith('ai')]

        # 1. 如果用户明确指定了语言且精确匹配
        if lang_code and lang_code in subtitle_map:
            selected_lan = lang_code
        # 2. 如果用户指定了包含 ai 的语言，但没有精确匹配，则兜底给第一个找到的 ai 字幕
        elif lang_code and str(lang_code).startswith('ai') and ai_lans:
            selected_lan = ai_lans[0]
        # 3. 智能回退优先级：ai-zh > 其他任意AI > zh-CN > zh-Hans > 任意第一个
        elif not selected_lan:
            if 'ai-zh' in subtitle_map:
                selected_lan = 'ai-zh'
            elif ai_lans:
                selected_lan = ai_lans[0]
            elif 'zh-CN' in subtitle_map:
                selected_lan = 'zh-CN'
            elif 'zh-Hans' in subtitle_map:
                selected_lan = 'zh-Hans'
            elif subtitle_map:
                selected_lan = list(subtitle_map.keys())[0]

        if selected_lan:
            subtitle_url = subtitle_map[selected_lan]
            logging.info(f"Selected subtitle language: {selected_lan}")

    if subtitle_url:
        try:
            logging.info(f"Fetching subtitle content from: {subtitle_url}")
            # 关键修复：获取静态 json 文件时，剥离 Cookie，避免 CDN 节点报跨域或 403 错误
            static_headers = {
                'User-Agent': headers.get('User-Agent', 'Mozilla/5.0'),
                'Accept': 'application/json, text/plain, */*'
            }
            resp = requests.get(subtitle_url, headers=static_headers, timeout=15)
            if resp.ok:
                try:
                    json_data = resp.json()
                    if 'body' in json_data:
                        return resp.text
                except Exception as json_e:
                    logging.warning(f"Failed to parse subtitle JSON from URL, trying raw text: {json_e}")
                    return resp.text
        except Exception as e:
            logging.error(f"Error fetching subtitle content: {e}")

    # --- Step 5: Ultimate Fallback - AI Summary API ---
    logging.info("Step 5: No CC subtitles found, attempting AI Summary API...")
    try:
        img_key, sub_key = get_cached_wbi_keys()
        sum_params = {'cid': cid, 'bvid': bvid}
        if aid: sum_params['aid'] = aid
        
        if img_key and sub_key:
            sum_params = encWbi(sum_params, img_key, sub_key)
        else:
            sum_params['wts'] = int(time.time())

        sum_resp = requests.get(SUMMARY_API_URL, params=sum_params, headers=headers, timeout=15)
        sum_data = sum_resp.json()
        sum_code = sum_data.get('code')
        if sum_code == 0:
            inner_code = sum_data.get('data', {}).get('code')
            if inner_code == 1:
                logging.warning("Step 5: AI Summary API returned data.code=1 (no speech detected / not yet summarized).")
            elif inner_code == -1:
                logging.warning("Step 5: AI Summary API returned data.code=-1 (unsupported content or API error).")
            else:
                model_result = sum_data.get('data', {}).get('model_result', {})
                ai_subs_list = model_result.get('subtitle', [])
                if ai_subs_list and len(ai_subs_list) > 0:
                    part_subs = ai_subs_list[0].get('part_subtitle', [])
                    if part_subs:
                        logging.info(f"Step 5: Found {len(part_subs)} AI transcript segments.")
                        # Convert to standard CC format
                        standard_body = []
                        for item in part_subs:
                            standard_body.append({
                                'from': item.get('start_timestamp', 0),
                                'to': item.get('end_timestamp', 0),
                                'content': item.get('content', '')
                            })
                        return json.dumps({"body": standard_body}, ensure_ascii=False)
                logging.warning("Step 5: AI Summary API returned success but subtitle list is empty.")
        elif sum_code == -101:
            logging.warning("Step 5: AI Summary API returned -101 (account not logged in). SESSDATA credential required for AI transcript.")
            return json.dumps({"body": [], "_error": "SESSDATA_EXPIRED"})
        elif sum_code == -403:
            logging.error("Step 5: AI Summary API returned -403 (访问权限不足). WBI signing may be invalid or cookie is missing/expired.")
        else:
            logging.warning(f"Step 5: AI Summary API returned code={sum_code}: {sum_data.get('message')}")
    except Exception as e:
        logging.warning(f"Step 5: Error fetching via AI Summary API: {e}")

    logging.info("No subtitles found across all sources.")
    return json.dumps({"body":[]})


def resolve_short_url(url: str) -> str:
    """Resolves b23.tv short URLs to long ones."""
    if 'b23.tv' in url:
        try:
            # Use stream=True to follow redirects without downloading the body
            resp = requests.get(url, allow_redirects=True, timeout=5, stream=True)
            logging.info(f"Resolved short URL {url} to {resp.url}")
            return resp.url
        except Exception as e:
            logging.error(f"Error resolving short URL {url}: {e}")
    return url

def fetch_danmaku(cid: str, num: int, headers: dict) -> list:
    """Fetches danmaku (bullet comments) for a given cid."""
    if not cid or num <= 0:
        return []
    try:
        logging.info(f"Fetching up to {num} danmaku for CID: {cid}")
        params = {'oid': cid}
        resp = requests.get("https://api.bilibili.com/x/v1/dm/list.so", params=params, headers=headers, timeout=10)
        content = resp.content.decode('utf-8', errors='ignore')
        root = ET.fromstring(content)
        danmaku_list = [d.text for d in root.findall('d') if d.text]
        return danmaku_list[:num]
    except Exception as e:
        logging.error(f"Error fetching danmaku: {e}")
        return []

def fetch_comments(aid: str, num: int, headers: dict) -> list:
    """Fetches hot comments for a given aid."""
    if not aid or num <= 0:
        return []
    try:
        logging.info(f"Fetching up to {num} hot comments for AID: {aid}")
        params = {'type': 1, 'oid': aid, 'sort': 2}  # sort=2 fetches hot comments
        resp = requests.get("https://api.bilibili.com/x/v2/reply", params=params, headers=headers, timeout=10)
        data = resp.json()
        comments_list = []
        if data.get('code') == 0 and data.get('data', {}).get('replies'):
            for reply in data['data']['replies']:
                msg = reply.get('content', {}).get('message')
                user = reply.get('member', {}).get('uname', 'Unknown')
                likes = reply.get('like', 0)
                if msg:
                    comments_list.append(f"{user}(👍{likes}): {msg}")
                if len(comments_list) >= num:
                    break
        return comments_list
    except Exception as e:
        logging.error(f"Error fetching comments: {e}")
        return []

def fetch_videoshot(bvid: str, aid: str, cid: str, headers: dict) -> dict:
    """Fetches videoshot (snapshots) metadata for a given video."""
    try:
        logging.info(f"Fetching videoshot for BVID: {bvid}, AID: {aid}, CID: {cid}")
        params = {
            'bvid': bvid,
            'aid': aid,
            'cid': cid,
            'index': 1
        }
        resp = requests.get("https://api.bilibili.com/x/player/videoshot", params=params, headers=headers, timeout=10)
        data = resp.json()
        if data.get('code') == 0:
            return data.get('data', {})
        else:
            logging.warning(f"Videoshot API returned error {data.get('code')}: {data.get('message')}")
    except Exception as e:
        logging.error(f"Error fetching videoshot: {e}")
    return {}
    
def get_video_stream_url(bvid: str, cid: str, headers: dict) -> tuple:
    """通过 playurl API 获取视频流地址（取最高画质）"""
    try:
        params = {
            'bvid': bvid,
            'cid': cid,
            'fnval': 16,
            'qn': 127,
            'fourk': 1
        }
        resp = requests.get(
            "https://api.bilibili.com/x/player/playurl",
            params=params,
            headers=headers,
            timeout=10
        )
        data = resp.json()
        if data.get('code') == 0:
            dash = data.get('data', {}).get('dash', {})
            videos = dash.get('video', [])
            if videos:
                best = sorted(
                    videos,
                    key=lambda v: v.get('bandwidth', 0),
                    reverse=True
                )[0]
                url = best.get('baseUrl') or best.get('base_url')
                w = best.get('width', 0)
                h = best.get('height', 0)
                logging.info(f"Best stream: {w}x{h}, bw={best.get('bandwidth')}")
                return url, w, h
    except Exception as e:
        logging.error(f"Error getting video stream URL: {e}")
    return None, 0, 0


def fetch_hd_snapshot(bvid: str, cid: str, timestamp: float, img_dir: str, headers: dict) -> str | None:
    """用 ffmpeg 从视频流中抽取指定时间点的高清帧"""
    ffmpeg_cmd = get_ffmpeg_path()
    if ffmpeg_cmd == 'ffmpeg' and not shutil.which('ffmpeg'):
        logging.warning("ffmpeg not found, cannot fetch HD snapshot")
        return None

    stream_url, w, h = get_video_stream_url(bvid, cid, headers)
    if not stream_url:
        logging.warning("Failed to get video stream URL")
        return None

    out_path = os.path.join(
        img_dir,
        f"hd_snapshot_{bvid}_{int(timestamp)}s.jpg"
    )
    referer = f"https://www.bilibili.com/video/{bvid}/"
    user_agent = headers.get('User-Agent', 'Mozilla/5.0')

    cmd = [
        ffmpeg_cmd, '-y',
        '-headers', f"Referer: {referer}\r\nUser-Agent: {user_agent}\r\n",
        '-ss', str(timestamp),
        '-i', stream_url,
        '-frames:v', '1',
        '-q:v', '2',
        out_path
    ]

    try:
        kwargs = {
            'capture_output': True,
            'timeout': 30
        }
        if os.name == 'nt':
            kwargs['creationflags'] = 0x08000000 # subprocess.CREATE_NO_WINDOW
        result = subprocess.run(cmd, **kwargs)
        if result.returncode == 0 and os.path.exists(out_path):
            size = os.path.getsize(out_path)
            logging.info(f"HD snapshot saved: {out_path} ({w}x{h}, {size}B)")
            return out_path
        else:
            stderr = result.stderr.decode('utf-8', errors='ignore')[:300]
            logging.error(f"ffmpeg failed (rc={result.returncode}): {stderr}")
    except subprocess.TimeoutExpired:
        logging.error("ffmpeg timed out after 30s")
    except Exception as e:
        logging.error(f"Error running ffmpeg: {e}")
    return None


def fetch_pbp(cid: str, aid: str = None, bvid: str = None) -> str:
    """获取高能进度条数据并返回弹幕最集中的时间点"""
    try:
        logging.info(f"Fetching PBP data for CID: {cid}")
        params = {'cid': cid}
        if aid: params['aid'] = aid
        if bvid: params['bvid'] = bvid
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.bilibili.com/'
        }
        
        resp = requests.get(PBP_API_URL, params=params, headers=headers, timeout=10)
        data = resp.json()
        
        # 检查是否为有效数据（排除空壳响应）
        if not data or not data.get('events') or not data.get('events', {}).get('default'):
            logging.info("PBP data is empty or invalid, skipping.")
            return ""

        if data.get('events', {}).get('default'):
            events = data['events']['default']
            step = data.get('step_sec', 1)
            
            # 找出局部峰值并排序
            peaks = []
            for i in range(1, len(events) - 1):
                if events[i] > events[i-1] and events[i] > events[i+1] and events[i] > 0:
                    peaks.append((i * step, events[i]))
            
            # 如果没有局部峰值，退而求其次找最高点
            if not peaks:
                indexed_events = list(enumerate(events))
                sorted_events = sorted(indexed_events, key=lambda x: x[1], reverse=True)
                peaks = [(idx * step, val) for idx, val in sorted_events[:5] if val > 0]
            else:
                # 按热度排序并取前 5
                peaks = sorted(peaks, key=lambda x: x[1], reverse=True)[:5]
                # 按时间排序回原序
                peaks = sorted(peaks, key=lambda x: x[0])
            
            if peaks:
                points_str = ", ".join([f"{p[0]}s({int(p[1])})" for p in peaks])
                return f"\n【高能时刻(秒/热度)】: {points_str}"
        return ""
    except Exception as e:
        logging.error(f"Error fetching PBP: {e}")
        return ""

def sanitize_filename(name: str, max_length: int = 80) -> str:
    """
    将外部文本清洗为安全的 Windows 文件名/目录名。

    除 Windows 禁用字符外，同时移除控制字符、替换所有空白，并规避
    尾随点/空格、保留设备名和过长路径段。截断时附加摘要以降低重名风险。
    """
    import unicodedata
    original = unicodedata.normalize('NFC', str(name or ""))
    # Windows 禁止 ASCII 控制字符及 \ / : * ? " < > |。
    safe_name = re.sub(r'[\x00-\x1f\\/:*?"<>|]', '_', original)
    # 不让标题中的普通空格、制表符或换行进入目录名。
    safe_name = re.sub(r'\s+', '_', safe_name)
    safe_name = re.sub(r'_+', '_', safe_name).strip(' ._')

    # Windows 设备名即使带扩展名也不可作为文件或目录名。
    reserved_names = {
        'CON', 'PRN', 'AUX', 'NUL',
        *(f'COM{i}' for i in range(1, 10)),
        *(f'LPT{i}' for i in range(1, 10)),
    }
    if not safe_name or safe_name in {'.', '..'}:
        safe_name = 'untitled'
    if safe_name.split('.', 1)[0].upper() in reserved_names:
        safe_name = f'_{safe_name}'

    max_length = max(16, min(int(max_length), 120))
    if len(safe_name) > max_length:
        digest = md5(original.encode('utf-8', errors='replace')).hexdigest()[:10]
        safe_name = f"{safe_name[:max_length - len(digest) - 1].rstrip(' ._')}_{digest}"

    return safe_name.rstrip(' .') or 'untitled'

def get_accessible_url(local_path: str) -> str:
    """Constructs an accessible URL for the image server."""
    var_http_url = get_config_priority('VarHttpUrl', ['VAR_HTTP_URL', 'VarHttpUrl'], 'http://localhost')
    server_port = get_config_priority('PORT', ['SERVER_PORT', 'PORT'], '6005')
    image_key = get_config_priority('Image_Key', ['IMAGESERVER_IMAGE_KEY', 'Image_Key'])
    project_base_path = get_config_priority('PROJECT_BASE_PATH', ['PROJECT_BASE_PATH'])
    if not project_base_path:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        project_base_path = os.path.abspath(os.path.join(script_dir, '..', '..'))
    
    if all([var_http_url, server_port, image_key, project_base_path]):
        # Calculate relative path from PROJECT_BASE_PATH/image/
        try:
            norm_local = os.path.abspath(os.path.normpath(local_path))
            norm_base = os.path.abspath(os.path.normpath(os.path.join(project_base_path, 'image')))

            # 防止异常路径通过 ".." 逃逸图片根目录。
            if os.path.commonpath([norm_local, norm_base]) != norm_base:
                raise ValueError(f"Image path is outside image root: {norm_local}")

            rel_path = os.path.relpath(norm_local, norm_base).replace('\\', '/')
            # URL 路径必须按 UTF-8 百分号编码；仅保留目录分隔符。
            encoded_rel_path = urllib.parse.quote(rel_path, safe='/')
            encoded_image_key = urllib.parse.quote(str(image_key), safe='')
            base_url = str(var_http_url).rstrip('/')

            return f"{base_url}:{server_port}/pw={encoded_image_key}/images/{encoded_rel_path}"
        except Exception as e:
            logging.error(f"Error calculating relative path for URL: {e}")

    # Fallback URI 同样需要编码空格、Unicode 和 URL 保留字符。
    file_path = os.path.abspath(local_path).replace("\\", "/")
    prefix = "file://" if file_path.startswith('/') else "file:///"
    return prefix + urllib.parse.quote(file_path, safe='/:')

def process_bilibili_enhanced(video_input: str, lang_code: str | None = None, danmaku_num: int = 0, comment_num: int = 0, snapshot_at_times: list | None = None, need_subs: bool = True, need_pbp: bool = True, hd_snapshot: bool = False) -> str:
    """
    Enhanced version of process_bilibili_url that handles short URLs, fetches danmaku/comments, snapshots, and PBP.
    Returns a dictionary suitable for VCP multimodal output.
    """
    # 1. Resolve short URL
    resolved_url = resolve_short_url(video_input)
    
    # 2. Extract BVID
    bvid, page = extract_bvid_and_page(resolved_url)
    if not bvid:
        raise ValueError(f"无法从输入提取有效的 B站 视频/链接（BV号）: {video_input}")
    logging.info(f"Extracted BVID: {bvid}, Page: {page}")

    user_cookie = build_bilibili_cookie()
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': f'https://www.bilibili.com/video/{bvid}/',
    }
    if user_cookie:
        headers['Cookie'] = user_cookie

    # 3. Get Video Info (AID, CID, Title, Author)
    aid, cid = None, None
    video_title, video_author = None, None
    try:
        # We can use the view API to get both IDs and metadata
        view_resp = requests.get("https://api.bilibili.com/x/web-interface/view", params={'bvid': bvid}, headers=headers, timeout=10)
        view_data = view_resp.json()
        if view_data.get('code') == 0:
            data = view_data.get('data', {})
            aid = str(data.get('aid'))
            cid = str(data.get('cid'))
            video_title = data.get('title')
            video_author = data.get('owner', {}).get('name')
            logging.info(f"Found AID: {aid}, CID: {cid}, Title: {video_title}, Author: {video_author} via View API")
            # Override CID for multi-part videos
            if page > 1:
                page_cid = get_cid_for_page(bvid, page, headers)
                if page_cid:
                    cid = page_cid
                    logging.info(f"Overrode CID to {cid} for page {page}")
        else:
            # Fallback to pagelist for CID if view API fails
            logging.warning(f"View API failed (code {view_data.get('code')}), attempting pagelist for CID")
            page_resp = requests.get(PAGELIST_API_URL, params={'bvid': bvid}, headers=headers, timeout=10)
            page_data = page_resp.json()
            if page_data.get('code') == 0 and page_data.get('data'):
                idx = page - 1 if page > 0 else 0
                if idx < len(page_data['data']):
                    cid = str(page_data['data'][idx]['cid'])
                else:
                    cid = str(page_data['data'][0]['cid'])
                logging.info(f"Found CID via pagelist fallback: {cid} (page {page})")
    except Exception as e:
        logging.error(f"Error getting video info: {e}")

    if not cid:
        err_msg = "无法获取视频的 CID 标识符。可能是视频已被删除、链接有误，或遭到B站风控阻断。"
        if 'view_data' in locals() and view_data.get('code') != 0:
            err_msg += f" B站API错误码: {view_data.get('code')}, 信息: {view_data.get('message')}"
        raise ValueError(err_msg)

    # 4. Concurrent fetching
    results = {}
    with ThreadPoolExecutor(max_workers=4) as executor:
        # Fetch subtitles using the original function (passed the resolved long URL) if needed
        future_subs = executor.submit(process_bilibili_url, resolved_url, lang_code) if need_subs else None
        
        # Fetch danmaku if requested
        future_danmaku = executor.submit(fetch_danmaku, cid, danmaku_num, headers) if cid and danmaku_num > 0 else None
        
        # Fetch comments if requested
        future_comments = executor.submit(fetch_comments, aid, comment_num, headers) if aid and comment_num > 0 else None
        
        # Fetch videoshot metadata
        future_shot = executor.submit(fetch_videoshot, bvid, aid, cid, headers) if aid and cid else None
        
        # Fetch PBP (High Energy Bar)
        future_pbp = executor.submit(fetch_pbp, cid, aid, bvid) if cid and need_pbp else None

        results['subs'] = future_subs.result() if future_subs else ""
        results['danmaku'] = future_danmaku.result() if future_danmaku else []
        results['comments'] = future_comments.result() if future_comments else []
        results['shot'] = future_shot.result() if future_shot else {}
        results['pbp'] = future_pbp.result() if future_pbp else ""

    # 5. Process snapshots if requested
    images_to_add = []
    snapshot_text = ""
    if results['shot'] and results['shot'].get('image'):
        shot_data = results['shot']
        index_list = shot_data.get('index', [])
        image_urls = shot_data.get('image', [])
        
        if snapshot_at_times:
            # Prepare image directory in PROJECT_BASE_PATH
            project_base_path = os.environ.get('PROJECT_BASE_PATH', os.getcwd())
            
            # 公开图片 URL 使用纯 ASCII 的 BV 号目录，避免中文标题经过百分号编码后
            # 形成超长 URL，减少模型上下文开销和复述 URL 时的出错概率。
            safe_directory = sanitize_filename(bvid, max_length=64)

            # 纵深防御：即使未来清洗规则被修改，最终路径也不得逃逸 bilibili 根目录。
            bilibili_root = os.path.abspath(
                os.path.join(project_base_path, "image", "bilibili")
            )
            img_dir = os.path.abspath(os.path.join(bilibili_root, safe_directory))
            if os.path.commonpath([img_dir, bilibili_root]) != bilibili_root:
                logging.error(
                    f"Rejected unsafe snapshot directory derived from title: {video_title!r}"
                )
                img_dir = os.path.join(bilibili_root, bvid)

            try:
                if not os.path.exists(img_dir):
                    os.makedirs(img_dir)
            except Exception as e:
                logging.error(f"Error creating image directory {img_dir}: {e}")
                # Fallback to a simpler path
                img_dir = os.path.join(os.getcwd(), "image", "bilibili")
                if not os.path.exists(img_dir):
                    os.makedirs(img_dir)
            
            # Cache for sprite sheets
            sheet_cache = {}
            
            snapshot_text = "\n\n【请求的视频快照】\n"
            for t in snapshot_at_times:
                try:
                    t_val = float(t)
                    img_path = None

                    # 优先尝试 ffmpeg 高清抽帧
                    if hd_snapshot and cid:
                        img_path = fetch_hd_snapshot(bvid, cid, t_val, img_dir, headers)

                    # 降级到雪碧图裁切
                    if not img_path and shot_data and shot_data.get('image'):
                        # Find closest index
                        closest_idx = 0
                        min_diff = float('inf')
                        for i, timestamp in enumerate(index_list):
                            diff = abs(timestamp - t_val)
                            if diff < min_diff:
                                min_diff = diff
                                closest_idx = i

                        actual_timestamp = index_list[closest_idx]

                        # Calculate sprite sheet and position
                        img_x_len = shot_data.get('img_x_len', 10)
                        img_y_len = shot_data.get('img_y_len', 10)
                        img_x_size = shot_data.get('img_x_size', 160)
                        img_y_size = shot_data.get('img_y_size', 90)
                        per_sheet = img_x_len * img_y_len

                        sheet_idx = closest_idx // per_sheet
                        pos_in_sheet = closest_idx % per_sheet
                        row = pos_in_sheet // img_x_len
                        col = pos_in_sheet % img_x_len

                        if sheet_idx < len(image_urls):
                            img_url = image_urls[sheet_idx]
                            if img_url.startswith('//'):
                                img_url = 'https:' + img_url

                            if sheet_idx not in sheet_cache:
                                logging.info(f"Downloading sprite sheet: {img_url}")
                                img_resp = requests.get(img_url, timeout=15)
                                sheet_cache[sheet_idx] = Image.open(io.BytesIO(img_resp.content))

                            sheet_img = sheet_cache[sheet_idx]
                            left = col * img_x_size
                            top = row * img_y_size
                            right = left + img_x_size
                            bottom = top + img_y_size

                            cropped_img = sheet_img.crop((left, top, right, bottom))

                            img_filename = f"snapshot_{bvid}_{actual_timestamp}s.jpg"
                            img_path = os.path.join(img_dir, img_filename)
                            cropped_img.save(img_path, "JPEG")

                    if img_path:
                        accessible_url = get_accessible_url(img_path)
                        # 核心健壮性设计：将小体积快照编码为内联 Base64 Data URI，
                        # 彻底消除下游 API 网关（如 New-API/One-API）因将 localhost:6005 判定为非法内网端口而触发的 SSRF 500 报错，
                        # 同时使公网远端大模型真正具备免网络穿透的视觉读图能力。
                        b64_url = accessible_url
                        try:
                            import base64
                            with open(img_path, "rb") as f_img:
                                b64_data = base64.b64encode(f_img.read()).decode('ascii')
                                b64_url = f"data:image/jpeg;base64,{b64_data}"
                        except Exception as b64_err:
                            logging.warning(f"Failed to encode snapshot to base64: {b64_err}")

                        images_to_add.append({
                            "type": "image_url",
                            "image_url": {"url": b64_url},
                            "_snapshot_time": t_val,
                            "_display_url": accessible_url
                        })
                        mode_label = "HD" if hd_snapshot and "hd_snapshot" in os.path.basename(img_path) else "雪碧图"
                        snapshot_text += f"- 时间点 {t_val}s 的快照已保存 [{mode_label}]: {os.path.basename(img_path)}\n"
                    else:
                        snapshot_text += f"- 时间点 {t_val}s 的快照获取失败\n"

                except Exception as e:
                    logging.error(f"Error processing snapshot time {t}: {e}")
                    snapshot_text += f"- 时间点 {t}s 处理出错: {e}\n"
        else:
            # Provide info about available snapshots
            if index_list:
                duration = index_list[-1]
                count = len(index_list)
                snapshot_text = f"\n\n【视频快照信息】\n该视频共有 {count} 张快照，覆盖时长约 {duration}s。您可以指定时间点来获取对应的快照拼版图。"

    # 6. Combine outputs
    text_parts = []
    
    # Prepend Video Metadata
    metadata = []
    if video_title:
        metadata.append(f"视频标题：{video_title}")
    if video_author:
        metadata.append(f"视频作者：{video_author}")
    if metadata:
        text_parts.append("【视频信息】\n" + "\n".join(metadata))

    if need_subs:
        if results['subs']:
            text_parts.append("\n【字幕内容】\n" + results['subs'])
        else:
            text_parts.append("\n（未获取到字幕内容）")
    
    if results['danmaku']:
        text_parts.append("\n\n【热门弹幕】\n" + "\n".join(results['danmaku']))
    
    if results['comments']:
        text_parts.append("\n\n【热门评论】\n" + "\n".join(results['comments']))
    
    if results['pbp']:
        text_parts.append(results['pbp'])

    if snapshot_text:
        text_parts.append(snapshot_text)
        
    full_text = "\n".join(text_parts).strip()
    
    if not images_to_add:
        return full_text

    # 图片通过标准多模态 content 数组直接交给模型看图，不再仅依赖模型从文本中
    # 复制 URL。仍提供短 HTML 引用，让模型在认为画面有趣或精彩时自行决定是否分享。
    full_text += "\n\n【快照使用提示】\n以下快照已作为多模态图片提供，你可以直接结合画面理解视频。若你认为其中有有趣或精彩的画面，可在回复中酌情分享，不必逐张展示。"
    for img_obj in images_to_add:
        display_url = img_obj.pop("_display_url", img_obj["image_url"]["url"])
        snapshot_time = img_obj.pop("_snapshot_time", None)
        time_label = f"{snapshot_time:g}s" if isinstance(snapshot_time, (int, float)) else "未知时间"
        full_text += f'\n- {time_label}: <img src="{display_url}" width="400" alt="Bilibili Snapshot">'

    # 安全熔断器：多模态图片单次上限设为 10 张，防止过大请求体撑爆大模型上下文或触发网关体积超限
    MAX_MULTIMODAL_IMAGES = 10
    capped_images = images_to_add
    if len(images_to_add) > MAX_MULTIMODAL_IMAGES:
        logging.info(f"Multimodal images capped to top {MAX_MULTIMODAL_IMAGES} to prevent context overflow.")
        capped_images = images_to_add[:MAX_MULTIMODAL_IMAGES]

    return {
        "content": [
            {"type": "text", "text": full_text},
            *capped_images
        ]
    }

def search_bilibili(keyword: str, search_type: str = "video", page: int = 1) -> dict:
    """
    关键词搜索视频或 UP 主。
    search_type: 'video' 或 'bili_user'
    """
    logging.info(f"Searching Bilibili for '{keyword}' with type '{search_type}', page {page}")
    user_cookie = build_bilibili_cookie()
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/',
    }
    if user_cookie:
        headers['Cookie'] = user_cookie

    img_key, sub_key = getWbiKeys(headers)
    if not img_key or not sub_key:
        return {"error": "Failed to get WBI keys for search"}

    params = {
        'keyword': keyword,
        'search_type': search_type,
        'page': page
    }
    signed_params = encWbi(params, img_key, sub_key)

    try:
        resp = requests.get(SEARCH_WBI_API_URL, params=signed_params, headers=headers, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        
        if data.get('code') != 0:
            raise RuntimeError(f"搜索失败: {data.get('message', '未知错误')}")
        
        results = data.get('data', {}).get('result', [])
        if not results:
            return "未找到相关结果。"
        
        clean_results = []
        if search_type == "video":
            clean_results.append(f"--- 关键词 '{keyword}' 的视频搜索结果 (第 {page} 页) ---")
            for item in results:
                title = item.get('title', '').replace('<em class="keyword">', '').replace('</em>', '')
                author = item.get('author', '未知')
                bvid = item.get('bvid', '未知')
                play = item.get('play', 0)
                pubdate = time.strftime('%Y-%m-%d', time.localtime(item.get('pubdate', 0)))
                desc = item.get('description', '').strip()
                clean_results.append(f"【{title}】\n- UP主: {author} | BV号: {bvid}\n- 播放量: {play} | 发布日期: {pubdate}\n- 简介: {desc[:100]}...")
        
        elif search_type == "bili_user":
            clean_results.append(f"--- 关键词 '{keyword}' 的用户搜索结果 (第 {page} 页) ---")
            for item in results:
                uname = item.get('uname', '未知')
                mid_val = item.get('mid', '未知')
                fans = item.get('fans', 0)
                videos = item.get('videos', 0)
                usign = item.get('usign', '').strip()
                user_info = f"【{uname}】(MID: {mid_val})\n- 粉丝数: {fans} | 投稿数: {videos}\n- 签名: {usign}"
                
                # Extract recent videos if available
                recent_vids = item.get('res', [])
                if recent_vids:
                    vid_list = [f"  * {v.get('title')} ({v.get('bvid')})" for v in recent_vids[:3]]
                    user_info += "\n- 最近投稿:\n" + "\n".join(vid_list)
                
                clean_results.append(user_info)
        
        return "\n\n".join(clean_results)
    except Exception as e:
        logging.error(f"Error during Bilibili search: {e}")
        raise RuntimeError(f"搜索出错: {e}") from e

def get_up_videos(mid: str, pn: int = 1, ps: int = 30) -> dict:
    """获取指定 UP 主的所有投稿视频 BV 号"""
    mid_str = str(mid).strip()
    if not mid_str.isdigit():
        raise ValueError(f"获取 UP 主视频失败: UP主ID(mid) 必须是纯数字字符串，您输入的是: '{mid}'")

    logging.info(f"Fetching videos for UP mid: {mid_str}, page {pn}")
    user_cookie = build_bilibili_cookie()
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': f'https://space.bilibili.com/{mid_str}/video',
    }
    if user_cookie:
        headers['Cookie'] = user_cookie

    img_key, sub_key = getWbiKeys(headers)
    if not img_key or not sub_key:
        return {"error": "Failed to get WBI keys for space search"}

    params = {
        'mid': mid_str,
        'pn': pn,
        'ps': ps,
        'order': 'pubdate'
    }
    signed_params = encWbi(params, img_key, sub_key)

    try:
        resp = requests.get(SPACE_ARC_WBI_API_URL, params=signed_params, headers=headers, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        
        if data.get('code') != 0:
            raise RuntimeError(f"获取 UP 主视频失败: {data.get('message', '未知错误')}")
        
        vlist = data.get('data', {}).get('list', {}).get('vlist', [])
        if not vlist:
            return "该 UP 主暂无投稿视频。"
        
        clean_results = [f"--- UP主 (MID: {mid_str}) 的投稿视频 (第 {pn} 页) ---"]
        for item in vlist:
            title = item.get('title', '无标题')
            bvid = item.get('bvid', '未知')
            play = item.get('play', 0)
            created = time.strftime('%Y-%m-%d', time.localtime(item.get('created', 0)))
            length = item.get('length', '00:00')
            desc = item.get('description', '').strip()
            clean_results.append(f"【{title}】\n- BV号: {bvid} | 时长: {length}\n- 播放量: {play} | 发布日期: {created}\n- 简介: {desc[:100]}...")
            
        return "\n\n".join(clean_results)
    except Exception as e:
        logging.error(f"Error fetching UP videos: {e}")
        raise RuntimeError(f"获取视频列表出错: {e}") from e

# --- Main execution for VCP Synchronous Plugin ---

def process_bilibili_url(video_input: str, lang_code: str | None = None) -> str:
    """
    Processes a Bilibili URL or BV ID to fetch and return subtitle text.
    Reads cookie from BILIBILI_COOKIE environment variable.
    Accepts a language code for subtitle selection.
    Returns plain text subtitle content or an empty string on failure.
    """
    user_cookie = build_bilibili_cookie()

    if user_cookie:
        logging.info("Using cookie from BILIBILI_COOKIE environment variable.")
    if lang_code:
        logging.info(f"Subtitle language preference passed as argument: {lang_code}")


    bvid, page = extract_bvid_and_page(video_input)
    if not bvid:
        logging.error(f"Invalid input: Could not extract BV ID from '{video_input}'.")
        return ""

    target_cid = None
    if page > 1:
        _h = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': f'{BILIBILI_VIDEO_BASE_URL}{bvid}/',
        }
        if user_cookie:
            _h['Cookie'] = user_cookie
        target_cid = get_cid_for_page(bvid, page, _h)

    try:
        subtitle_json_string = get_subtitle_json_string(bvid, user_cookie, lang_code, target_cid=target_cid)

        # Process the subtitle JSON string to extract plain text
        try:
            subtitle_data = json.loads(subtitle_json_string)
            if isinstance(subtitle_data, dict) and 'body' in subtitle_data and isinstance(subtitle_data['body'], list):
                # Check for login credential expiration error
                if '_error' in subtitle_data and subtitle_data['_error'] == 'SESSDATA_EXPIRED':
                    error_msg = "【字幕获取失败】B站登录凭证未配置或已失效（-101）。请在 config.env 或环境变量中配置有效的 BILIBILI_COOKIE（需包含 SESSDATA）。"
                    logging.warning(error_msg)
                    return error_msg
                # Extract content with timestamp
                lines = [f"[{item.get('from', 0):.2f}] {item.get('content', '')}" for item in subtitle_data['body'] if isinstance(item, dict)]
                processed_text = "\n".join(lines).strip()
                logging.info(f"Successfully processed subtitle text for BVID {bvid}. Length: {len(processed_text)}")
                if processed_text:
                    processed_text += "\n\n——以上内容来自Bilibili视频字幕（CC/AI生成），可能存在谐音或错别字，请自行甄别"
                return processed_text
            else:
                logging.warning(f"Subtitle JSON for BVID {bvid} has unexpected structure or is missing 'body'. Raw: {subtitle_json_string[:100]}...")
                return "" # Return empty string if structure is wrong
        except json.JSONDecodeError:
            logging.error(f"Failed to decode subtitle JSON for BVID {bvid}. Raw: {subtitle_json_string[:100]}...")
            return "" # Return empty string on decode error
        except Exception as parse_e:
             logging.exception(f"Unexpected error processing subtitle JSON for BVID {bvid}: {parse_e}")
             return "" # Return empty string on other processing errors

    except Exception as e:
        logging.exception(f"Error processing Bilibili URL {video_input}: {e}")
        return "" # Return empty string on any other error during the process


def handle_single_request(data: dict):
    """Handles a single request dictionary and returns the result data."""
    action = data.get('action', 'fetch_video')
    
    valid_actions = {'fetch_video', 'search', 'get_up_videos'}
    if action not in valid_actions:
        raise ValueError(f"不支持的 action 参数: '{action}'。可用的 actions 包含: {sorted(list(valid_actions))}")
    
    if action == 'search':
        keyword = data.get('keyword')
        if not keyword:
            raise ValueError("Missing required argument: keyword for search")
        search_type = data.get('search_type', 'video')
        page = int(data.get('page', 1))
        return search_bilibili(keyword, search_type, page)
    
    elif action == 'get_up_videos':
        mid = data.get('mid')
        if not mid:
            raise ValueError("Missing required argument: mid for get_up_videos")
        pn = int(data.get('pn', 1))
        ps = int(data.get('ps', 30))
        return get_up_videos(str(mid), pn, ps)

    else: # Default: fetch_video
        url = data.get('url')
        lang = data.get('lang')
        if not lang:
            lang = read_config_value('BILIBILI_SUB_LANG') or None
        # Robust integer parsing with default fallbacks and sensible upper/lower bounds
        try:
            danmaku_num = int(data.get('danmaku_num', 0))
            danmaku_num = max(0, min(danmaku_num, 1000))
        except (ValueError, TypeError):
            danmaku_num = 0

        try:
            comment_num = int(data.get('comment_num', 0))
            comment_num = max(0, min(comment_num, 100))
        except (ValueError, TypeError):
            comment_num = 0
        
        # Parse snapshot_at_times if provided (comma separated string or list)
        snapshots_raw = data.get('snapshots')
        snapshot_at_times = []
        if isinstance(snapshots_raw, list):
            snapshot_at_times = snapshots_raw
        elif isinstance(snapshots_raw, str) and snapshots_raw.strip():
            snapshot_at_times = [s.strip() for s in snapshots_raw.split(',')]

        if not url:
            raise ValueError("Missing required argument: url")

        # Robust boolean parsing
        need_subs = data.get('need_subs', True)
        if isinstance(need_subs, str):
            need_subs = need_subs.lower() != 'false'
        else:
            need_subs = bool(need_subs)

        need_pbp = data.get('need_pbp', True)
        if isinstance(need_pbp, str):
            need_pbp = need_pbp.lower() != 'false'
        else:
            need_pbp = bool(need_pbp)
            
        hd_snapshot = data.get('hd_snapshot', False)
        if isinstance(hd_snapshot, str):
            hd_snapshot = hd_snapshot.lower() in ('true', '1', 'yes')
        else:
            hd_snapshot = bool(hd_snapshot)

        return process_bilibili_enhanced(url, lang_code=lang, danmaku_num=danmaku_num, comment_num=comment_num, snapshot_at_times=snapshot_at_times, need_subs=need_subs, need_pbp=need_pbp, hd_snapshot=hd_snapshot)

if __name__ == "__main__":
    input_data_raw = sys.stdin.read()
    output = {}

    try:
        if not input_data_raw.strip():
            raise ValueError("No input data received from stdin.")

        input_data = json.loads(input_data_raw)
        
        # Check for serial/batch calls (command1, command2, etc.)
        # Note: If single request contains keys with digits like danmaku_num, they shouldn't trigger misdetection.
        is_serial = any(
            (key.startswith('command') and key[len('command'):].isdigit()) or 
            (key.startswith('url') and key[len('url'):].isdigit()) 
            for key in input_data
        )
        
        if is_serial:
            logging.info("Detected serial/batch request.")
            results = []
            # Find all indices
            indices = sorted(list(set([re.findall(r'\d+', k)[0] for k in input_data.keys() if re.findall(r'\d+', k)])))
            if not indices: # Fallback if no digits found but suspected serial
                indices = ['']

            for idx in indices:
                # Extract parameters for this index
                sub_data = {k.replace(idx, ''): v for k, v in input_data.items() if k.endswith(idx)}
                # Map 'urlX' to 'url' etc. if needed, handle_single_request expects clean keys
                try:
                    res = handle_single_request(sub_data)
                    results.append(f"--- 任务 {idx} 结果 ---\n{res if isinstance(res, str) else json.dumps(res, indent=2, ensure_ascii=False)}")
                except Exception as e:
                    results.append(f"--- 任务 {idx} 失败 ---\n错误: {e}")
            
            combined_res = "\n\n".join(results)
            output = {"status": "success", "result": combined_res}
        else:
            result_data = handle_single_request(input_data)
            output = {"status": "success", "result": result_data}

    except (json.JSONDecodeError, ValueError) as e:
        output = {"status": "error", "error": f"Input Error: {e}"}
    except Exception as e:
        logging.exception("An unexpected error occurred during plugin execution.")
        output = {"status": "error", "error": f"An unexpected error occurred: {e}"}

    # Output JSON to stdout
    # Use sys.stdout.buffer to write UTF-8 encoded bytes directly, avoiding Windows console encoding issues
    sys.stdout.buffer.write(json.dumps(output, indent=2, ensure_ascii=False).encode('utf-8'))
    sys.stdout.buffer.write(b'\n')
    sys.stdout.buffer.flush()

# Removed main() function definition as it's replaced by the __main__ block
