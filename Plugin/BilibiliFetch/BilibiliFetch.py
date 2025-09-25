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

def get_subtitle_json_string(bvid: str, user_cookie: str | None) -> str:
    """
    Fetches the first available subtitle JSON for a given BVID.
    Returns the subtitle content as a JSON string or '{"body":[]}' if none found or error.
    Uses user_cookie if provided.
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
                first_subtitle = subtitles[0]
                subtitle_url = first_subtitle.get('subtitle_url')
                lan_doc = first_subtitle.get('lan_doc', 'Unknown Language')
                if subtitle_url:
                    if subtitle_url.startswith('//'):
                        subtitle_url = "https:" + subtitle_url
                    logging.info(f"Step 3: Found subtitle URL ({lan_doc}): {subtitle_url}")
                else:
                    logging.warning("Step 3: First subtitle entry found but is missing 'subtitle_url'.")
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


# --- Main execution for VCP Synchronous Plugin ---

def process_bilibili_url(video_input: str) -> str:
    """
    Processes a Bilibili URL or BV ID to fetch and return subtitle text.
    Reads cookie from BILIBILI_COOKIE environment variable.
    Returns plain text subtitle content or an empty string on failure.
    """
    user_cookie = os.environ.get('BILIBILI_COOKIE')
    if user_cookie:
        logging.info("Using cookie from BILIBILI_COOKIE environment variable.")

    bvid = extract_bvid(video_input)
    if not bvid:
        logging.error(f"Invalid input: Could not extract BV ID from '{video_input}'.")
        return "" # Return empty string on invalid input

    try:
        subtitle_json_string = get_subtitle_json_string(bvid, user_cookie)

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

        if not url:
            raise ValueError("Missing required argument: url")

        # Call the new processing function
        result_text = process_bilibili_url(url)

        output = {"status": "success", "result": result_text}

    except (json.JSONDecodeError, ValueError) as e:
        output = {"status": "error", "error": f"Input Error: {e}"}
    except Exception as e:
        logging.exception("An unexpected error occurred during plugin execution.")
        output = {"status": "error", "error": f"An unexpected error occurred: {e}"}

    # Output JSON to stdout
    print(json.dumps(output, indent=2))
    sys.stdout.flush() # Ensure output is sent immediately

# Removed main() function definition as it's replaced by the __main__ block
