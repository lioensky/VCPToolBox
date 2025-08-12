import sys
import json
import os
import requests
import base64
import time
import random
import threading
from io import BytesIO
from PIL import Image
from dotenv import load_dotenv
from datetime import datetime
import traceback
from urllib.parse import urlparse
from urllib.request import url2pathname

# --- 自定义异常 ---
class LocalFileNotFoundError(Exception):
    def __init__(self, message, file_url):
        super().__init__(message)
        self.file_url = file_url

# --- 配置和常量 ---
LOG_FILE = "VideoGenHistory.log"
SUPPORTED_RESOLUTIONS_MAP = {
    "1280x720": (1280, 720),
    "720x1280": (720, 1280),
    "960x960": (960, 960)
}
SILICONFLOW_API_BASE = "https://api.siliconflow.cn/v1"
PLUGIN_NAME_FOR_CALLBACK = "Wan2.1VideoGen"

# --- 日志记录 ---
def log_event(level, message, data=None):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    log_entry = f"[{timestamp}] [{level.upper()}] {message}"
    if data:
        if isinstance(data, dict):
            log_data = {k: (v[:50] + '...' if isinstance(v, str) and len(v) > 100 and k == 'image' else v) for k, v in data.items()}
        else:
            log_data = data
        try:
            log_entry += f" | Data: {json.dumps(log_data, ensure_ascii=False)}"
        except Exception:
            log_entry += f" | Data: [Unserializable Data]"
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(log_entry + "\n")
    except Exception as e:
        print(f"Error writing to log file: {e}", file=sys.stderr)

# --- 结果输出 ---
def print_json_output(status, result=None, error=None, ai_message=None):
    output = {"status": status}
    if status == "success":
        if result is not None:
            output["result"] = result
        if ai_message:
            output["messageForAI"] = ai_message
    elif status == "error":
        if error is not None:
            output["error"] = error
    print(json.dumps(output, ensure_ascii=False))
    log_event("debug", "Output sent to stdout", output)

# --- 图片处理 ---
def get_closest_allowed_resolution(width, height):
    aspect_ratio = width / height
    allowed_ratios = {
        "1280x720": 1280/720,
        "720x1280": 720/1280,
        "960x960": 1
    }
    closest_ratio_key = min(allowed_ratios.keys(), key=lambda k: abs(allowed_ratios[k] - aspect_ratio))
    return closest_ratio_key

def resize_and_crop_image(img, target_resolution_tuple):
    original_width, original_height = img.size
    target_width, target_height = target_resolution_tuple
    if original_width / original_height > target_width / target_height:
        new_height = target_height
        new_width = int(original_width * (new_height / original_height))
    else:
        new_width = target_width
        new_height = int(original_height * (new_width / original_width))
    img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
    left = (new_width - target_width) // 2
    top = (new_height - target_height) // 2
    right = left + target_width
    bottom = top + target_height
    img = img.crop((left, top, right, bottom))
    return img

def image_to_webp_base64(img):
    buffer = BytesIO()
    img.save(buffer, format="WEBP", quality=90)
    img_bytes = buffer.getvalue()
    base64_encoded = base64.b64encode(img_bytes).decode('utf-8')
    return f"data:image/webp;base64,{base64_encoded}"

def process_image_from_base64(base64_str):
    try:
        log_event("info", f"Processing image from base64 string (length: {len(base64_str)})")
        # Expecting data URI format: data:image/jpeg;base64,....
        header, encoded = base64_str.split(',', 1)
        img_data = base64.b64decode(encoded)
        img = Image.open(BytesIO(img_data))
        
        img = img.convert("RGB")
        width, height = img.size
        target_resolution_key = get_closest_allowed_resolution(width, height)
        target_resolution_tuple = SUPPORTED_RESOLUTIONS_MAP[target_resolution_key]
        log_event("info", f"Original size from base64: {width}x{height}. Target resolution: {target_resolution_key}")
        
        processed_img = resize_and_crop_image(img, target_resolution_tuple)
        final_base64_image = image_to_webp_base64(processed_img)
        
        log_event("info", f"Image from base64 processed and re-encoded to base64 (length: {len(final_base64_image)})")
        return final_base64_image, target_resolution_key
    except Exception as e:
        log_event("error", "Failed to process image from base64 string", {"error": str(e)})
        raise ValueError(f"处理 base64 图片失败: {e}")

def process_image_from_url(image_url):
    try:
        parsed_url = urlparse(image_url)
        img = None
        if parsed_url.scheme == 'file':
            log_event("info", f"Processing local file URL: {image_url}")
            
            # Correctly convert file URL to path, handling Windows drive letters
            file_path = url2pathname(parsed_url.path)
            if os.name == 'nt' and parsed_url.path.startswith('/'):
                # Strips leading '/' from '/C:/...' to get 'C:/...'
                file_path = url2pathname(parsed_url.path[1:])

            try:
                # Open the file in binary read mode and pass the file object to Pillow
                # This is safer and avoids potential issues with path string formats
                with open(file_path, 'rb') as f:
                    img = Image.open(f)
                    # img.load() copies the image data into a core memory block,
                    # allowing us to close the file handle.
                    img.load()
                log_event("info", f"Successfully opened and loaded local file: {file_path}")
            except FileNotFoundError:
                log_event("error", f"Local file not found: {file_path}. Signaling for remote fetch.")
                raise LocalFileNotFoundError("本地文件未找到，需要远程获取。", image_url)
        elif parsed_url.scheme in ['http', 'https']:
            log_event("info", f"Downloading image from URL: {image_url}")
            response = requests.get(image_url, stream=True, timeout=30)
            response.raise_for_status()
            img = Image.open(response.raw)
        else:
            raise ValueError(f"不支持的 URL 协议: {parsed_url.scheme}。请使用 http, https, 或 file://。")

        # Common image processing part
        if img is None:
            raise ValueError("未能加载图片。")
            
        img = img.convert("RGB")
        width, height = img.size
        target_resolution_key = get_closest_allowed_resolution(width, height)
        target_resolution_tuple = SUPPORTED_RESOLUTIONS_MAP[target_resolution_key]
        log_event("info", f"Original size: {width}x{height}. Target resolution: {target_resolution_key}")
        processed_img = resize_and_crop_image(img, target_resolution_tuple)
        base64_image = image_to_webp_base64(processed_img)
        log_event("info", f"Image processed and encoded to base64 (length: {len(base64_image)})")
        return base64_image, target_resolution_key
    except requests.exceptions.RequestException as e:
        log_event("error", f"Failed to download image URL: {image_url}", {"error": str(e)})
        raise ValueError(f"图片下载失败: {e}")
    except LocalFileNotFoundError:
        # Re-raise to be caught by the main handler
        raise
    except Exception as e:
        # Catch other potential errors like PIL errors, etc.
        log_event("error", f"Failed to process image from URL: {image_url}", {"error": str(e), "traceback": traceback.format_exc()})
        raise ValueError(f"图片处理失败: {e}")

# --- 视频文件持久化 ---
def download_video(video_url, request_id):
    try:
        # 获取当前脚本的目录
        script_dir = os.path.dirname(os.path.abspath(__file__))
        # 定义相对于项目根目录的目标目录
        video_dir = os.path.join(script_dir, '..', '..', 'file', 'video')

        # 确保目录存在
        os.makedirs(video_dir, exist_ok=True)

        # 定义文件名和文件路径
        filename = f"{request_id}.mp4"
        filepath = os.path.join(video_dir, filename)

        # 下载文件
        log_event("info", f"[{request_id}] Downloading video from {video_url} to {filepath}")
        response = requests.get(video_url, stream=True, timeout=180) # 为视频下载增加超时
        response.raise_for_status()

        # 保存文件
        with open(filepath, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        
        log_event("success", f"[{request_id}] Video downloaded and saved successfully to {filepath}")
        return filepath

    except Exception as e:
        log_event("error", f"[{request_id}] Failed to download or save video.", {"error": str(e)})
        return None

# --- 后台轮询与回调 ---
def poll_and_callback(api_key, request_id, callback_base_url, plugin_name, debug_mode):
    log_event("info", f"[{request_id}] Entering poll_and_callback function.", {
        "request_id": request_id,
        "callback_base_url": callback_base_url,
        "plugin_name": plugin_name,
        "debug_mode": debug_mode
    })
    log_event("info", f"[{request_id}] Starting background polling.", {"callback_url_base": callback_base_url, "plugin_name": plugin_name})
    
    initial_poll_delay = 30
    poll_interval = 10
    max_poll_attempts = 600
    
    log_event("debug", f"[{request_id}] Initial poll delay: {initial_poll_delay}s. Max poll attempts: {max_poll_attempts}.")
    log_event("debug", f"[{request_id}] About to sleep for initial_poll_delay.")
    time.sleep(initial_poll_delay)
    log_event("debug", f"[{request_id}] Woke up after initial_poll_delay.")
    
    log_event("debug", f"[{request_id}] Starting polling loop. max_poll_attempts = {max_poll_attempts}")
    for attempt in range(max_poll_attempts):
        try:
            log_event("debug", f"[{request_id}] Polling loop iteration: attempt {attempt + 1}/{max_poll_attempts}")
            status_data = query_video_status_api(api_key, request_id)
            current_status = status_data.get("status")

            if current_status in ["Succeed", "Failed"]:
                log_event("info", f"[{request_id}] Final status '{current_status}' received. Attempting callback.")
                callback_url = f"{callback_base_url}/{plugin_name}/{request_id}"
                
                ws_notification_data = {
                    "requestId": request_id,
                    "status": current_status,
                    "pluginName": plugin_name
                }
                if current_status == "Succeed":
                    video_url = status_data.get("results", {}).get("videos", [{}])[0].get("url")
                    ws_notification_data["videoUrl"] = video_url
                    
                    # 在后台线程中开始下载视频，不阻塞回调
                    download_thread = threading.Thread(target=download_video, args=(video_url, request_id))
                    download_thread.start()
                    
                    message = f"视频 (ID: {request_id}) 生成成功！URL: {video_url}\n文件正在后台下载中。"
                    ws_notification_data["message"] = message
                else: # Failed
                    reason = status_data.get("reason", "未知原因")
                    ws_notification_data["reason"] = reason
                    ws_notification_data["message"] = f"视频 (ID: {request_id}) 生成失败。原因: {reason}"

                try:
                    callback_payload = ws_notification_data 

                    callback_response = requests.post(callback_url, json=callback_payload, timeout=30)
                    callback_response.raise_for_status()
                    log_event("success", f"[{request_id}] Callback to {callback_url} successful with simplified data.", {"status_code": callback_response.status_code})
                except requests.exceptions.RequestException as cb_e:
                    log_event("error", f"[{request_id}] Callback to {callback_url} failed.", {"error": str(cb_e), "response_text": getattr(cb_e.response, 'text', None)})
                except Exception as cb_gen_e:
                    log_event("error", f"[{request_id}] Unexpected error during callback to {callback_url}.", {"error": str(cb_gen_e)})
                return 
            
            elif current_status == "InProgress":
                log_event("info", f"[{request_id}] Status is 'InProgress'. Continuing to poll.")
            else: 
                log_event("warning", f"[{request_id}] Unknown status '{current_status}' received. Continuing to poll.", {"response_data": status_data})

        except ConnectionError as e: 
            log_event("error", f"[{request_id}] API connection error during polling attempt {attempt + 1}.", {"error": str(e)})
        except ValueError as e: 
            log_event("error", f"[{request_id}] API value error during polling attempt {attempt + 1}.", {"error": str(e)})
        except Exception as e:
            log_event("critical", f"[{request_id}] Unexpected error during polling attempt {attempt + 1}.", {"error": str(e), "traceback": traceback.format_exc()})

        if attempt < max_poll_attempts - 1: 
            log_event("debug", f"[{request_id}] Waiting {poll_interval} seconds before next poll.")
            time.sleep(poll_interval)
        else:
            log_event("warning", f"[{request_id}] Max poll attempts reached. Stopping polling.")
            try:
                timeout_notification_data = {
                    "requestId": request_id,
                    "status": "PollingTimeout",
                    "pluginName": plugin_name,
                    "reason": f"Max poll attempts ({max_poll_attempts}) reached.",
                    "message": f"视频 (ID: {request_id}) 轮询超时。"
                }
                callback_url = f"{callback_base_url}/{plugin_name}/{request_id}"
                requests.post(callback_url, json=timeout_notification_data, timeout=10)
                log_event("info", f"[{request_id}] Sent PollingTimeout callback to {callback_url} with simplified data.")
            except Exception as cb_timeout_e:
                log_event("error", f"[{request_id}] Failed to send PollingTimeout callback.", {"error": str(cb_timeout_e)})

# --- API 调用 ---
def submit_video_request_api(api_key, model, prompt, negative_prompt, image_size, image_base64=None, 
                             callback_base_url=None, plugin_name_for_callback=None, debug_mode_for_polling=False):
    url = f"{SILICONFLOW_API_BASE}/video/submit"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model,
        "prompt": prompt,
        "negative_prompt": negative_prompt or "",
        "image_size": image_size,
        "seed": random.randint(0, 2**32 - 1)
    }
    if image_base64:
        payload["image"] = image_base64

    log_event("info", "Submitting video request to API", {"url": url, "model": model, "image_size": image_size, "prompt_length": len(prompt), "has_image": bool(image_base64)})
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=60)
        response.raise_for_status()
        response_data = response.json()
        request_id = response_data.get("requestId")
        if not request_id:
            raise ValueError("API response missing requestId")
        log_event("success", "Video request submitted successfully to API", {"requestId": request_id})

        if callback_base_url and plugin_name_for_callback:
            polling_thread = threading.Thread(target=poll_and_callback, args=(
                api_key, request_id, callback_base_url, plugin_name_for_callback, debug_mode_for_polling
            ))
            # polling_thread.daemon = True # Threads are non-daemon by default
            polling_thread.start()
            log_event("info", f"[{request_id}] Background polling thread (non-daemon) started.")
            print(f"DEBUG: Polling thread started log_event CALLED for {request_id}", file=sys.stderr) # DEBUG
        else:
            print(f"DEBUG: Condition (callback_base_url and plugin_name_for_callback) is FALSE for {request_id}", file=sys.stderr) # DEBUG
            log_event("warning", f"[{request_id}] Callback URL or plugin name not provided. Background polling will not be started by the plugin.")
            print(f"DEBUG: Callback URL not provided log_event CALLED for {request_id}", file=sys.stderr) # DEBUG

        return request_id
    except requests.exceptions.RequestException as e:
        log_event("error", "API request failed (submit)", {"status_code": getattr(e.response, 'status_code', None), "response_text": getattr(e.response, 'text', None), "error": str(e)})
        raise ConnectionError(f"API 请求失败: {e}")
    except Exception as e:
        log_event("error", "Error processing API response (submit)", {"error": str(e)})
        raise ValueError(f"处理 API 响应时出错: {e}")

def query_video_status_api(api_key, request_id):
    url = f"{SILICONFLOW_API_BASE}/video/status"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {"requestId": request_id}
    log_event("info", f"Querying video status from API for {request_id}", {"url": url})
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        response.raise_for_status()
        response_data = response.json()
        log_event("success", "Video status queried successfully", {"requestId": request_id, "status": response_data.get("status")})
        return response_data
    except requests.exceptions.RequestException as e:
        log_event("error", "API request failed (query)", {"requestId": request_id, "status_code": getattr(e.response, 'status_code', None), "response_text": getattr(e.response, 'text', None), "error": str(e)})
        raise ConnectionError(f"API 请求失败: {e}")
    except Exception as e:
        log_event("error", "Error processing API response (query)", {"requestId": request_id, "error": str(e)})
        raise ValueError(f"处理 API 响应时出错: {e}")

# --- 主逻辑 ---
def main():
    dotenv_path = os.path.join(os.path.dirname(__file__), 'config.env')
    load_dotenv(dotenv_path=dotenv_path)
    
    api_key = os.getenv("SILICONFLOW_API_KEY")
    t2v_model = os.getenv("Text2VideoModelName")
    i2v_model = os.getenv("Image2VideoModelName")
    debug_mode = os.getenv("DebugMode", "False").lower() == "true"
    # 确保从环境变量中读取时使用大写键名
    callback_base_url_env = os.getenv("CALLBACK_BASE_URL") 

    if not api_key:
        print_json_output("error", error="SILICONFLOW_API_KEY not found in environment variables.")
        sys.exit(1)
    if not t2v_model:
        log_event("warning", "Text2VideoModelName not found in environment variables.")
    if not i2v_model:
        log_event("warning", "Image2VideoModelName not found in environment variables.")
    if not callback_base_url_env: 
        log_event("warning", "CALLBACK_BASE_URL not found in environment variables. Plugin-initiated polling and callback will be disabled.")

    try:
        input_str = sys.stdin.read()
        log_event("debug", "[Input Debug] Raw string received from stdin", {"raw_input": input_str})
        input_data = json.loads(input_str)
        log_event("debug", "[Input Debug] Parsed input data (dictionary)", {"parsed_data": input_data})
    except json.JSONDecodeError:
        log_event("error", "Failed to decode JSON input from stdin", {"raw_input": input_str})
        print_json_output("error", error="Invalid JSON input.")
        sys.exit(1)
    except Exception as e:
        log_event("error", "Error reading stdin", {"error": str(e)})
        print_json_output("error", error=f"Error reading input: {e}")
        sys.exit(1)

    command = input_data.get("command")
    mode = input_data.get("mode")
    request_id_query = input_data.get("request_id") 
    prompt = input_data.get("prompt")
    negative_prompt = input_data.get("negative_prompt")
    resolution = input_data.get("resolution")
    image_url = input_data.get("image_url")
    image_base64_input = input_data.get("image_base64")

    try:
        if command == "submit":
            log_event("info", f"Processing 'submit' command, mode: {mode}")
            req_id_submit = None 
            if mode == "t2v":
                if not t2v_model:
                    raise ValueError("Text2VideoModelName 未配置，无法执行文生视频。")
                if not prompt:
                    raise ValueError("缺少必需的 'prompt' 参数。")
                if resolution not in SUPPORTED_RESOLUTIONS_MAP:
                    raise ValueError(f"无效的 'resolution' 参数: {resolution}。允许的值: {', '.join(SUPPORTED_RESOLUTIONS_MAP.keys())}")
                
                req_id_submit = submit_video_request_api(api_key, t2v_model, prompt, negative_prompt, resolution,
                                                         callback_base_url=callback_base_url_env, 
                                                         plugin_name_for_callback=PLUGIN_NAME_FOR_CALLBACK,
                                                         debug_mode_for_polling=debug_mode)
                result_string_for_ai = (
                    f"文生视频任务 (ID: {req_id_submit}) 已成功提交。\n"
                    f"这是一个动态上下文占位符，当任务完成时，它会被自动替换为实际结果。\n"
                    f"请在你的回复中包含以下占位符原文：{{{{VCP_ASYNC_RESULT::Wan2.1VideoGen::{req_id_submit}}}}}"
                )
                print_json_output(status="success", result=result_string_for_ai)

            elif mode == "i2v":
                if not i2v_model:
                    raise ValueError("Image2VideoModelName 未配置，无法执行图生视频。")
                if not image_url and not image_base64_input:
                    raise ValueError("缺少必需的 'image_url' 或 'image_base64' 参数。")

                base64_image = None
                target_res_key = None

                if image_base64_input:
                    base64_image, target_res_key = process_image_from_base64(image_base64_input)
                elif image_url:
                    base64_image, target_res_key = process_image_from_url(image_url)

                req_id_submit = submit_video_request_api(api_key, i2v_model, prompt or "", negative_prompt, target_res_key, image_base64=base64_image,
                                                         callback_base_url=callback_base_url_env,
                                                         plugin_name_for_callback=PLUGIN_NAME_FOR_CALLBACK,
                                                         debug_mode_for_polling=debug_mode)
                result_string_for_ai = (
                    f"图生视频任务 (ID: {req_id_submit}) 已成功提交。\n"
                    f"这是一个动态上下文占位符，当任务完成时，它会被自动替换为实际结果。\n"
                    f"请在你的回复中包含以下占位符原文：{{{{VCP_ASYNC_RESULT::Wan2.1VideoGen::{req_id_submit}}}}}"
                )
                print_json_output(status="success", result=result_string_for_ai)
            else:
                raise ValueError(f"无效的 'mode' 参数: {mode}。必须是 't2v' 或 'i2v'。")

        elif command == "query":
            log_event("info", f"Processing 'query' command, requestId: {request_id_query}")
            if not request_id_query:
                raise ValueError("缺少必需的 'request_id' 参数。")
            
            status_data = query_video_status_api(api_key, request_id_query)
            current_status = status_data.get("status")
            ai_msg = None
            if current_status == "InProgress":
                ai_msg = f"请求 {request_id_query} 的状态是 'InProgress'。请告知用户视频仍在生成中，需要继续等待。"
            elif current_status == "Succeed":
                video_url = status_data.get("results", {}).get("videos", [{}])[0].get("url")
                
                # 在后台线程中开始下载视频，不阻塞响应
                download_thread = threading.Thread(target=download_video, args=(video_url, request_id_query))
                download_thread.start()
                
                ai_msg = f"请求 {request_id_query} 已成功生成！视频 URL: '{video_url}'。\n文件正在后台下载中。"
            elif current_status == "Failed":
                reason = status_data.get("reason", "未知原因")
                ai_msg = f"请求 {request_id_query} 生成失败。原因: {reason}。请告知用户此结果。"
            print_json_output("success", result=status_data, ai_message=ai_msg)
        else:
            raise ValueError(f"无效的 'command' 参数: {command}。必须是 'submit' 或 'query'。")

    except LocalFileNotFoundError as e:
        log_event("error", "Local file not found, signaling for remote fetch.", {"file_url": e.file_url})
        # Manually construct and print the JSON to match the exact format expected by the server's generic handler.
        # This format is based on the GeminiImageGen plugin's implementation.
        error_payload = {
            "status": "error",
            "code": "FILE_NOT_FOUND_LOCALLY",
            "error": str(e), # Use "error" key for the message string, matching JS version
            "fileUrl": e.file_url
        }
        print(json.dumps(error_payload, ensure_ascii=False))
        sys.exit(0) # 正常退出，因为这是一个预期的信令，而不是一个硬性错误
    except (ValueError, ConnectionError, FileNotFoundError) as e:
        log_event("error", f"Command processing failed: {command}", {"error": str(e)})
        print_json_output("error", error=str(e))
        sys.exit(1)
    except Exception as e:
        log_event("critical", "Unexpected error during command processing", {"command": command, "error": str(e), "traceback": traceback.format_exc()})
        print_json_output("error", error=f"发生意外错误: {e}")
        sys.exit(2) 

if __name__ == "__main__":
    main()