#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
XiaohongshuFetch - 小红书笔记解析插件 v4.0
策略：Cookie + xsec_token HTML降级解析（纯 requests，无外部签名依赖）
作者：Nova (2026-02-28)
"""

import sys
import json
import os
import re
import logging
import requests
from urllib.parse import urlencode

# --- 最优先：手动加载本插件目录下的 config.env ---
_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
_CONFIG_PATH = os.path.join(_PLUGIN_DIR, 'config.env')
if os.path.exists(_CONFIG_PATH):
    with open(_CONFIG_PATH, 'r', encoding='utf-8') as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith('#') and '=' in _line:
                _k, _v = _line.split('=', 1)
                os.environ.setdefault(_k.strip(), _v.strip())

# --- 日志配置 ---
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

TIMEOUT = int(os.environ.get('REQUEST_TIMEOUT', 20))

BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Origin': 'https://www.xiaohongshu.com',
    'Referer': 'https://www.xiaohongshu.com/',
    'Connection': 'keep-alive',
}

# ───────────────────────────────────────────────
# 工具函数
# ───────────────────────────────────────────────

def extract_note_id(url):
    match = re.search(r'/(?:discovery/item|explore)/([a-f0-9]{24})', url)
    if match:
        return match.group(1)
    match = re.search(r'/(?:discovery/item|explore)/([a-f0-9]+)', url)
    if match:
        return match.group(1)
    match = re.search(r'[?&]source_note_id=([a-f0-9]+)', url)
    if match:
        return match.group(1)
    return None

def extract_xsec_token(url):
    match = re.search(r'[?&]xsec_token=([^&]+)', url)
    if match:
        return match.group(1)
    return ''

def resolve_short_url(url):
    if 'xhslink.com' not in url:
        return url
    try:
        resp = requests.get(url, allow_redirects=True, timeout=TIMEOUT,
                            headers={'User-Agent': BASE_HEADERS['User-Agent']})
        logging.info('短链解析: %s -> %s', url, resp.url)
        return resp.url
    except Exception as e:
        logging.error('短链解析失败: %s', e)
        return url

def build_cookies_dict(a1, web_session, web_id):
    full = os.environ.get('XHS_COOKIE_FULL', '').strip()
    if full:
        cookie_dict = {}
        for part in full.split(';'):
            part = part.strip()
            if '=' in part:
                k, v = part.split('=', 1)
                cookie_dict[k.strip()] = v.strip()
        return cookie_dict
    cookie_dict = {}
    if a1:
        cookie_dict['a1'] = a1
    if web_session:
        cookie_dict['web_session'] = web_session
    if web_id:
        cookie_dict['webId'] = web_id
    return cookie_dict

def bracket_balance_extract(html, marker):
    """
    从 html 中找到 marker 后的第一个完整 JSON 对象。
    正确处理转义字符：i+=2 跳过转义序列，避免 \" 误翻转 in_str。
    """
    idx = html.find(marker)
    if idx < 0:
        return None
    brace_start = html.find('{', idx)
    if brace_start < 0:
        return None
    depth = 0
    in_str = False
    i = brace_start
    limit = min(brace_start + 500000, len(html))
    while i < limit:
        ch = html[i]
        if in_str:
            if ch == '\\':
                i += 2
                continue
            if ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    raw_json = html[brace_start:i + 1]
                    raw_json = re.sub(r'\bundefined\b', 'null', raw_json)
                    try:
                        state = json.loads(raw_json)
                        logging.info('bracket-balance OK, len=%d', len(raw_json))
                        return state
                    except json.JSONDecodeError as e:
                        logging.error('JSON parse fail: %s', str(e)[:100])
                        return None
        i += 1
    logging.error('bracket-balance: 未找到匹配闭合括号')
    return None

# ───────────────────────────────────────────────
# HTML 解析策略
# ───────────────────────────────────────────────

def fetch_html(url, cookies_dict):
    headers = dict(BASE_HEADERS)
    headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    headers['Upgrade-Insecure-Requests'] = '1'
    headers['Sec-Fetch-Dest'] = 'document'
    headers['Sec-Fetch-Mode'] = 'navigate'
    headers['Sec-Fetch-Site'] = 'none'
    cookie_str = '; '.join(f'{k}={v}' for k, v in cookies_dict.items())
    if cookie_str:
        headers['Cookie'] = cookie_str
    try:
        resp = requests.get(url, headers=headers, timeout=TIMEOUT, allow_redirects=True)
        resp.raise_for_status()
        logging.info('HTML GET %s -> %d, len=%d', url, resp.status_code, len(resp.text))
        return resp.text
    except Exception as e:
        logging.error('HTML 请求失败 %s: %s', url, e)
        return None

def parse_state_from_html(html):
    state = bracket_balance_extract(html, 'window.__INITIAL_STATE__')
    if state:
        return state
    fb_m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if fb_m:
        try:
            state = json.loads(fb_m.group(1))
            logging.info('NEXT_DATA fallback OK')
            return state
        except json.JSONDecodeError:
            pass
    return None

def extract_note_from_state(state, note_id):
    note = None
    note_map = state.get('note', {}).get('noteDetailMap', {})
    if note_id in note_map:
        note = note_map[note_id].get('note', note_map[note_id])
    if not note and note_map:
        first_key = list(note_map.keys())[0]
        first_val = note_map[first_key]
        if isinstance(first_val, dict):
            note = first_val.get('note', first_val)
            logging.info('NDM fallback: key=%s', first_key)
    if not note:
        for key in ['noteDetail', 'detail']:
            if state.get(key):
                note = state[key]
                break
    return note

def fetch_note(note_id, cookies_dict, original_url=None, xsec_token=''):
    """
    带 xsec_token 的 HTML 请求，优先用原始路径，fallback /discovery/item/。
    xsec_token 必须透传，否则小红书返回纯 JS 壳页面。
    """
    def build_url(base_path):
        params = {'xsec_source': 'pc_feed'}
        if xsec_token:
            params['xsec_token'] = xsec_token
        return base_path + '?' + urlencode(params)

    candidate_urls = []
    if original_url:
        q_idx = original_url.find('?')
        base = original_url[:q_idx] if q_idx >= 0 else original_url
        candidate_urls.append(build_url(base))
    candidate_urls.append(build_url('https://www.xiaohongshu.com/discovery/item/' + note_id))

    seen = set()
    unique_urls = []
    for u in candidate_urls:
        if u not in seen:
            seen.add(u)
            unique_urls.append(u)

    for url in unique_urls:
        logging.info('尝试: %s', url)
        html = fetch_html(url, cookies_dict)
        if not html:
            continue
        state = parse_state_from_html(html)
        if not state:
            logging.warning('state 解析失败: %s', url)
            continue
        note = extract_note_from_state(state, note_id)
        if note:
            return format_note(note, note_id)
        logging.warning('state 中未找到笔记数据: %s', url)

    return '❌ 未能在页面数据中定位笔记，请确认链接有效或更新 Cookie。'

# ───────────────────────────────────────────────
# 统一格式化输出
# ───────────────────────────────────────────────

def format_note(note, note_id):
    title = (note.get('display_title') or note.get('title') or '').strip()
    desc = (note.get('desc') or note.get('description') or note.get('note_text') or '').strip()
    if not title:
        title = desc[:30] + ('…' if len(desc) > 30 else '')
    note_type = note.get('type', 'normal')

    user = note.get('user', note.get('author', {})) or {}
    author = (user.get('nickname') or user.get('nick_name') or '未知作者').strip()
    author_id = (user.get('user_id') or user.get('userId') or user.get('userid') or '').strip()

    interact = note.get('interact_info', note.get('interactInfo', {})) or {}
    likes = str(interact.get('liked_count') or interact.get('likedCount') or '0')
    collects = str(interact.get('collected_count') or interact.get('collectedCount') or interact.get('collect_count') or '0')
    comments = str(interact.get('comment_count') or interact.get('commentCount') or '0')

    lines = []
    lines.append('### 📕 ' + (title or '（无标题）'))
    lines.append('**作者**: ' + author + '（ID: ' + str(author_id) + '）')
    lines.append('**互动**: ❤️ ' + likes + ' ⭐ ' + collects + ' 💬 ' + comments)
    lines.append('\n**正文**:\n' + desc + '\n')

    if note_type == 'video':
        video = note.get('video', {}) or {}
        video_url = None
        try:
            h264_list = video.get('media', {}).get('stream', {}).get('h264', [])
            if h264_list:
                video_url = h264_list[0].get('masterUrl') or h264_list[0].get('master_url')
        except Exception:
            pass
        if not video_url:
            video_url = (video.get('consumer', {}) or {}).get('originVideoKey') or video.get('url')
        if video_url:
            lines.append('#### 🎬 无水印视频:')
            lines.append('<video src="' + video_url + '" controls style="max-width:100%;border-radius:8px;"></video>')
            lines.append('\n[📥 视频直链](' + video_url + ')')
        else:
            lines.append('⚠️ 视频直链获取失败（请更新 Cookie）')

    image_list = note.get('imageList', note.get('image_list', note.get('images', []))) or []
    if image_list:
        lines.append('#### 🖼️ 无水印图片（共 ' + str(len(image_list)) + ' 张）:')
        for idx, img in enumerate(image_list):
            info_list = img.get('info_list', [])
            img_url = ''
            for info in info_list:
                if info.get('image_scene') == 'WB_DFT':
                    img_url = info.get('url', '')
                    break
            if not img_url and info_list:
                img_url = info_list[0].get('url', '')
            if not img_url:
                img_url = img.get('urlDefault') or img.get('url_default') or img.get('url', '')
            clean_url = img_url.split('?')[0] if img_url else ''
            if clean_url:
                lines.append('<img src="' + clean_url + '" alt="图片' + str(idx + 1) + '" style="max-width:100%;margin:4px 0;border-radius:8px;">')

    tag_list = note.get('tagList', note.get('tag_list', note.get('tags', []))) or []
    if tag_list:
        tags = ' '.join(['#' + t.get('name', t.get('tag', '')) for t in tag_list if t])
        if tags.strip():
            lines.append('\n**标签**: ' + tags)

    lines.append('\n---\n*数据来源：小红书 | 笔记ID: ' + note_id + '*')
    return '\n'.join(lines)

# ───────────────────────────────────────────────
# 主入口
# ───────────────────────────────────────────────

def main():
    output = {}
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            raise ValueError('没有接收到标准输入数据')

        input_data = json.loads(raw)
        raw_url = input_data.get('url', '').strip()
        if not raw_url:
            raise ValueError('缺少必需参数: url')

        a1 = os.environ.get('XHS_COOKIE_A1', '') or input_data.get('a1', '')
        web_session = os.environ.get('XHS_COOKIE_WEB_SESSION', '') or input_data.get('web_session', '')
        web_id = os.environ.get('XHS_COOKIE_WEB_ID', '') or input_data.get('web_id', '')

        logging.info('原始 URL: %s', raw_url)
        logging.info('Cookie a1:%s web_session:%s webId:%s',
                     '已配置' if a1 else '未配置',
                     '已配置' if web_session else '未配置',
                     '已配置' if web_id else '未配置')

        resolved_url = resolve_short_url(raw_url)
        note_id = extract_note_id(resolved_url)
        if not note_id:
            raise ValueError('无法从链接中提取笔记 ID: ' + resolved_url)

        xsec_token = extract_xsec_token(resolved_url)
        logging.info('笔记 ID: %s', note_id)
        logging.info('xsec_token: %s', xsec_token[:20] + '...' if len(xsec_token) > 20 else xsec_token)

        cookies_dict = build_cookies_dict(a1, web_session, web_id)
        result_text = fetch_note(note_id, cookies_dict, original_url=resolved_url, xsec_token=xsec_token)
        output = {'status': 'success', 'result': result_text}

    except Exception as e:
        logging.error('主流程异常: %s', e)
        output = {'status': 'error', 'error': str(e)}

    sys.stdout.buffer.write(json.dumps(output, ensure_ascii=False).encode('utf-8'))
    sys.stdout.buffer.write(b'\n')
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()