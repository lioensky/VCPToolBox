#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import json
import os
import time
import requests
import logging
import re
# Removed FastMCP import
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
import io

# --- Logging Setup ---
# Log to stderr to avoid interfering with stdout communication
logging.basicConfig(level=logging.INFO, stream=sys.stderr, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Constants ---
BILIBILI_VIDEO_BASE_URL = "https://www.bilibili.com/video/"
PAGELIST_API_URL = "https://api.bilibili.com/x/player/pagelist"
PLAYER_WBI_API_URL = "https://api.bilibili.com/x/player/wbi/v2"
# Removed SERVER_NAME

# --- Helper Functions ---

def extract_bvid(video_input: str) -> str | None:
    """Extracts BV ID from URL or direct input."""
    match = re.search(r'bilibili\.com/video/(BV[a-zA-Z0-9]+)', video_input, re.IGNORECASE)
    if match:
        return match.group(1)
    match = re.match(r'^(BV[a-zA-Z0-9]+)$', video_input, re.IGNORECASE)
    if match:
        return match.group(1)
    return None

def get_subtitle_json_string(bvid: str, user_cookie: str | None, lang_code: str | None = None) -> str:
    """
    Fetches subtitle JSON for a given BVID, allowing language selection.
    Returns the subtitle content as a JSON string or '{"body":[]}' if none found or error.
    Uses user_cookie if provided.
    Selects subtitle based on lang_code, with 'ai-zh' as a preferred default.
    """
    logging.info(f"Attempting to fetch subtitles for BVID: {bvid}")
    # --- Headers ---
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': f'{BILIBILI_VIDEO_BASE_URL}{bvid}/',
        'Origin': 'https://www.bilibili.com',
        'Connection': 'keep-alive',
    }

    # --- Cookie Handling ---
    if user_cookie:
        logging.info("Using user-provided cookie.")
        headers['Cookie'] = user_cookie
    else:
        logging.warning("User cookie not provided. Access may be limited or fail.")

    # --- Step 1: Get AID (Attempt from video page) ---
    aid = None
    try:
        logging.info(f"Step 1: Fetching video page for AID: {BILIBILI_VIDEO_BASE_URL}{bvid}/")
        resp = requests.get(f'{BILIBILI_VIDEO_BASE_URL}{bvid}/', headers=headers, timeout=10)
        resp.raise_for_status()
        text = resp.text
        aid_match = re.search(r'"aid"\s*:\s*(\d+)', text)
        if aid_match:
            aid = aid_match.group(1)
            logging.info(f"Step 1: Found AID via regex: {aid}")
        else:
            state_match = re.search(r'window\.__INITIAL_STATE__\s*=\s*(\{.*?\});?', text)
            if state_match:
                try:
                    initial_state = json.loads(state_match.group(1))
                    aid = initial_state.get('videoData', {}).get('aid')
                    if aid:
                        aid = str(aid)
                        logging.info(f"Step 1: Found AID in __INITIAL_STATE__: {aid}")
                    else:
                        logging.warning("Step 1: Could not find AID in __INITIAL_STATE__.")
                except json.JSONDecodeError:
                    logging.warning("Step 1: Failed to parse __INITIAL_STATE__ for AID.")
            else:
                 logging.warning("Step 1: Could not find AID in page HTML using regex or __INITIAL_STATE__.")
    except requests.exceptions.RequestException as e:
        logging.warning(f"Step 1: Error fetching video page for AID: {e}. Proceeding without AID.")
    except Exception as e:
         logging.warning(f"Step 1: Unexpected error fetching AID: {e}. Proceeding without AID.")


    # --- Step 2: Get CID (from pagelist API) ---
    cid = None
    try:
        logging.info(f"Step 2: Fetching CID from pagelist API: {PAGELIST_API_URL}?bvid={bvid}")
        pagelist_headers = headers.copy()
        cid_back = requests.get(PAGELIST_API_URL, params={'bvid': bvid}, headers=pagelist_headers, timeout=10)
        cid_back.raise_for_status()
        cid_json = cid_back.json()
        if cid_json.get('code') == 0 and cid_json.get('data') and len(cid_json['data']) > 0:
            cid = cid_json['data'][0]['cid']
            part_title = cid_json['data'][0]['part']
            logging.info(f"Step 2: Found CID: {cid} for part: {part_title}")
        else:
            logging.error(f"Step 2: Failed to get CID from pagelist. Code: {cid_json.get('code')}, Message: {cid_json.get('message')}")
            return json.dumps({"body":[]}) # Cannot proceed without CID
    except requests.exceptions.RequestException as e:
        logging.error(f"Step 2: Error fetching pagelist: {e}")
        return json.dumps({"body":[]})
    except (json.JSONDecodeError, KeyError, IndexError) as e:
         logging.error(f"Step 2: Error parsing pagelist response: {e}")
         return json.dumps({"body":[]})


    # --- Step 3: Get Subtitle List (using WBI API) ---
    subtitle_url = None
    try:
        logging.info("Step 3: Fetching subtitle list using WBI Player API...")
        wbi_params = {
            'cid': cid,
            'bvid': bvid,
            'isGaiaAvoided': 'false',
            'web_location': '1315873',
            'w_rid': '364cdf378b75ef6a0cee77484ce29dbb', # Hardcoded - might break
            'wts': int(time.time()),
        }
        if aid:
             wbi_params['aid'] = aid

        wbi_resp = requests.get(PLAYER_WBI_API_URL, params=wbi_params, headers=headers, timeout=15)
        logging.info(f"Step 3: WBI API Status Code: {wbi_resp.status_code}")

        wbi_data = wbi_resp.json()
        logging.debug(f"Step 3: WBI API Response Data: {json.dumps(wbi_data)}")

        if wbi_data.get('code') == 0:
            subtitles = wbi_data.get('data', {}).get('subtitle', {}).get('subtitles', [])
            if subtitles:
                # --- Language Selection Logic ---
                subtitle_map = {sub['lan']: sub for sub in subtitles if 'lan' in sub}
                logging.info(f"Available subtitle languages: {list(subtitle_map.keys())}")

                selected_subtitle = None
                # 1. Try user-specified language
                if lang_code and lang_code in subtitle_map:
                    selected_subtitle = subtitle_map[lang_code]
                    logging.info(f"Found user-specified language subtitle: {lang_code}")
                # 2. If not found/specified, try Chinese as default
                elif 'ai-zh' in subtitle_map:
                    selected_subtitle = subtitle_map['ai-zh']
                    logging.info("User language not found or specified. Defaulting to Chinese ('ai-zh').")
                # 3. Fallback to the first available subtitle
                else:
                    selected_subtitle = subtitles[0]
                    logging.warning("Neither user-specified language nor Chinese found. Falling back to first available.")

                subtitle_url = selected_subtitle.get('subtitle_url')
                lan_doc = selected_subtitle.get('lan_doc', 'Unknown Language')
                if subtitle_url:
                    if subtitle_url.startswith('//'):
                        subtitle_url = "https:" + subtitle_url
                    logging.info(f"Step 3: Selected subtitle URL ({lan_doc}): {subtitle_url}")
                else:
                    logging.warning("Step 3: Selected subtitle entry found but is missing 'subtitle_url'.")
            else:
                logging.warning("Step 3: WBI API successful but no subtitles listed in response.")
        else:
            logging.warning(f"Step 3: WBI API returned error code {wbi_data.get('code')}: {wbi_data.get('message', 'Unknown error')}")
            if not wbi_resp.ok:
                 wbi_resp.raise_for_status()


    except requests.exceptions.RequestException as e:
        logging.error(f"Step 3: Error fetching subtitle list from WBI API: {e}")
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        logging.error(f"Step 3: Error parsing WBI API response: {e}")
    except Exception as e:
        logging.error(f"Step 3: Unexpected error during WBI API call: {e}")

    # --- Step 4: Fetch Subtitle Content ---
    if subtitle_url:
        try:
            logging.info(f"Step 4: Fetching subtitle content from: {subtitle_url}")
            subtitle_resp = requests.get(subtitle_url, headers=headers, timeout=15)
            subtitle_resp.raise_for_status()
            subtitle_text = subtitle_resp.text
            try:
                parsed_subtitle = json.loads(subtitle_text)
                if isinstance(parsed_subtitle, dict) and 'body' in parsed_subtitle:
                    logging.info(f"Step 4: Successfully fetched and validated subtitle content (Length: {len(subtitle_text)}).")
                    return subtitle_text # Return the raw JSON string
                else:
                    logging.error("Step 4: Fetched content is valid JSON but missing 'body' key.")
                    return json.dumps({"body":[]})
            except json.JSONDecodeError:
                 logging.error("Step 4: Fetched content is not valid JSON.")
                 return json.dumps({"body":[]})
        except requests.exceptions.RequestException as e:
            logging.error(f"Step 4: Error fetching subtitle content: {e}")
    else:
        logging.warning("Step 4: No subtitle URL found in Step 3.")

    # --- Fallback: Return empty if no subtitle found/fetched ---
    logging.info("Returning empty subtitle list.")
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

def sanitize_filename(name: str) -> str:
    """Sanitizes a string to be used as a filename/directory name."""
    # Replace invalid characters with underscores
    return re.sub(r'[\\/*?:"<>|]', '_', name).strip()

def get_accessible_url(local_path: str) -> str:
    """Constructs an accessible URL for the image server."""
    # VCP Image Server environment variables
    var_http_url = os.environ.get('VarHttpUrl')
    server_port = os.environ.get('SERVER_PORT')
    image_key = os.environ.get('IMAGESERVER_IMAGE_KEY')
    project_base_path = os.environ.get('PROJECT_BASE_PATH')
    
    if all([var_http_url, server_port, image_key, project_base_path]):
        # Calculate relative path from PROJECT_BASE_PATH/image/
        try:
            # Ensure the path separator is consistent for relpath
            norm_local = os.path.normpath(local_path)
            norm_base = os.path.normpath(os.path.join(project_base_path, 'image'))
            
            rel_path = os.path.relpath(norm_local, norm_base)
            rel_path = rel_path.replace('\\', '/')
            
            # Construct the final URL with password key
            return f"{var_http_url}:{server_port}/pw={image_key}/images/{rel_path}"
        except Exception as e:
            logging.error(f"Error calculating relative path for URL: {e}")
    
    # Fallback to file URI if env vars are missing or error occurs
    return "file:///" + local_path.replace("\\", "/")

def process_bilibili_enhanced(video_input: str, lang_code: str | None = None, danmaku_num: int = 0, comment_num: int = 0, snapshot_at_times: list | None = None, need_subs: bool = True) -> dict:
    """
    Enhanced version of process_bilibili_url that handles short URLs, fetches danmaku/comments, and snapshots.
    Returns a dictionary suitable for VCP multimodal output.
    """
    # 1. Resolve short URL
    resolved_url = resolve_short_url(video_input)
    
    # 2. Extract BVID
    bvid = extract_bvid(resolved_url)
    if not bvid:
        return {
            "text": f"无法从输入提取 BV 号: {video_input}",
            "image_urls": []
        }

    user_cookie = os.environ.get('BILIBILI_COOKIE')
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
    except Exception as e:
        logging.error(f"Error getting video info: {e}")

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
        
        results['subs'] = future_subs.result() if future_subs else ""
        results['danmaku'] = future_danmaku.result() if future_danmaku else []
        results['comments'] = future_comments.result() if future_comments else []
        results['shot'] = future_shot.result() if future_shot else {}

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
            
            # Sub-directory based on video title for better organization
            safe_title = sanitize_filename(video_title) if video_title else bvid
            img_dir = os.path.join(project_base_path, "image", "bilibili", safe_title)
            
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
                        
                        # Download and crop
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
                        
                        # Save cropped image
                        img_filename = f"snapshot_{bvid}_{actual_timestamp}s.jpg"
                        img_path = os.path.join(img_dir, img_filename)
                        cropped_img.save(img_path, "JPEG")
                        
                        # Use file:// URI for local path
                        file_uri = "file:///" + img_path.replace("\\", "/")
                        
                        accessible_url = get_accessible_url(img_path)
                        
                        images_to_add.append({
                            "type": "image_url",
                            "image_url": {"url": accessible_url}
                        })
                        snapshot_text += f"- 时间点 {t_val}s (实际匹配 {actual_timestamp}s) 的快照已保存并附加: {img_filename}\n"
                except Exception as e:
                    logging.error(f"Error processing snapshot time {t}: {e}")
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
    
    if snapshot_text:
        text_parts.append(snapshot_text)
        
    full_text = "\n".join(text_parts).strip()
    
    # Append HTML <img> tags for images to ensure they are rendered in the AI's response
    # This follows the pattern in the provided Node.js example
    if images_to_add:
        full_text += "\n\n请务必使用以下 HTML <img> 标签将视频快照直接展示给用户：\n"
        for img_obj in images_to_add:
            img_url = img_obj["image_url"]["url"]
            full_text += f'<img src="{img_url}" width="400" alt="Bilibili Snapshot">\n'
    
    return {
        "text": full_text,
        "image_urls": [img["image_url"]["url"] for img in images_to_add]
    }

# --- Main execution for VCP Synchronous Plugin ---

def process_bilibili_url(video_input: str, lang_code: str | None = None) -> str:
    """
    Processes a Bilibili URL or BV ID to fetch and return subtitle text.
    Reads cookie from BILIBILI_COOKIE environment variable.
    Accepts a language code for subtitle selection.
    Returns plain text subtitle content or an empty string on failure.
    """
    user_cookie = os.environ.get('BILIBILI_COOKIE')

    if user_cookie:
        logging.info("Using cookie from BILIBILI_COOKIE environment variable.")
    if lang_code:
        logging.info(f"Subtitle language preference passed as argument: {lang_code}")


    bvid = extract_bvid(video_input)
    if not bvid:
        logging.error(f"Invalid input: Could not extract BV ID from '{video_input}'.")
        return "" # Return empty string on invalid input

    try:
        subtitle_json_string = get_subtitle_json_string(bvid, user_cookie, lang_code)

        # Process the subtitle JSON string to extract plain text
        try:
            subtitle_data = json.loads(subtitle_json_string)
            if isinstance(subtitle_data, dict) and 'body' in subtitle_data and isinstance(subtitle_data['body'], list):
                # Extract content with timestamp
                lines = [f"[{item.get('from', 0):.2f}] {item.get('content', '')}" for item in subtitle_data['body'] if isinstance(item, dict)]
                processed_text = "\n".join(lines).strip()
                logging.info(f"Successfully processed subtitle text for BVID {bvid}. Length: {len(processed_text)}")
                if processed_text:
                    processed_text += "\n\n——以上内容来自VCP-STT语音识别转文本，可能存在谐音错别字内容，请自行甄别"
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


if __name__ == "__main__":
    input_data_raw = sys.stdin.read()
    output = {}

    try:
        if not input_data_raw.strip():
            raise ValueError("No input data received from stdin.")

        input_data = json.loads(input_data_raw)
        url = input_data.get('url')
        lang = input_data.get('lang')
        danmaku_num = int(input_data.get('danmaku_num', 0))
        comment_num = int(input_data.get('comment_num', 0))
        
        # Parse snapshot_at_times if provided (comma separated string or list)
        snapshots_raw = input_data.get('snapshots')
        snapshot_at_times = []
        if isinstance(snapshots_raw, list):
            snapshot_at_times = snapshots_raw
        elif isinstance(snapshots_raw, str) and snapshots_raw.strip():
            snapshot_at_times = [s.strip() for s in snapshots_raw.split(',')]

        if not url:
            raise ValueError("Missing required argument: url")

        need_subs = input_data.get('need_subs', True)
        if isinstance(need_subs, str):
            need_subs = need_subs.lower() != 'false'

        # Call the enhanced processing function
        result_data = process_bilibili_enhanced(url, lang_code=lang, danmaku_num=danmaku_num, comment_num=comment_num, snapshot_at_times=snapshot_at_times, need_subs=need_subs)

        output = {
            "status": "success",
            "result": result_data["text"],
            "imageurl": result_data["image_urls"]
        }

    except (json.JSONDecodeError, ValueError) as e:
        output = {"status": "error", "error": f"Input Error: {e}"}
    except Exception as e:
        logging.exception("An unexpected error occurred during plugin execution.")
        output = {"status": "error", "error": f"An unexpected error occurred: {e}"}

    # Output JSON to stdout
    print(json.dumps(output, indent=2))
    sys.stdout.flush() # Ensure output is sent immediately

# Removed main() function definition as it's replaced by the __main__ block