import sys
import json
import os
import requests
import base64
import time
import random
from io import BytesIO
from PIL import Image
from dotenv import load_dotenv
from datetime import datetime

# --- 配置和常量 ---
LOG_FILE = "VideoGenHistory.log"
# 支持的分辨率 (用于图片处理)
SUPPORTED_RESOLUTIONS_MAP = {
    "1280x720": (1280, 720),
    "720x1280": (720, 1280),
    "960x960": (960, 960)
}
SILICONFLOW_API_BASE = "https://api.siliconflow.cn/v1"

# --- 日志记录 ---
def log_event(level, message, data=None):
    """记录事件到日志文件"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    log_entry = f"[{timestamp}] [{level.upper()}] {message}"
    if data:
        # 避免记录过长的 base64 字符串
        if isinstance(data, dict):
            log_data = {k: (v[:50] + '...' if isinstance(v, str) and len(v) > 100 and k == 'image' else v) for k, v in data.items()}
        else:
            log_data = data
        try:
            log_entry += f" | Data: {json.dumps(log_data, ensure_ascii=False)}"
        except Exception:
            log_entry += f" | Data: [Unserializable Data]" # Fallback
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(log_entry + "\n")
    except Exception as e:
        print(f"Error writing to log file: {e}", file=sys.stderr) # Log error to stderr

# --- 结果输出 ---
def print_json_output(status, result=None, error=None, ai_message=None):
    """将结果格式化为 JSON 并输出到 stdout"""
    output = {"status": status}
    if status == "success":
        if result is not None:
            output["result"] = result
        if ai_message:
            output["messageForAI"] = ai_message # Add message for AI
    elif status == "error":
        if error is not None:
            output["error"] = error
        # Optionally add ai_message for errors too if needed
        # if ai_message:
        #    output["messageForAI"] = ai_message
    print(json.dumps(output, ensure_ascii=False))
    log_event("debug", "Output sent to stdout", output)

# --- 图片处理 (复用 wan2.1post.py 逻辑) ---
def get_closest_allowed_resolution(width, height):
    """计算最接近的 *允许* 分辨率 (返回字符串键)"""
    aspect_ratio = width / height
    allowed_ratios = {
        "1280x720": 1280/720,
        "720x1280": 720/1280,
        "960x960": 1
    }
    closest_ratio_key = min(allowed_ratios.keys(), key=lambda k: abs(allowed_ratios[k] - aspect_ratio))
    return closest_ratio_key

def resize_and_crop_image(img, target_resolution_tuple):
    """调整图片大小并裁切到目标分辨率"""
    original_width, original_height = img.size
    target_width, target_height = target_resolution_tuple

    # 先按比例缩放，使短边匹配目标分辨率
    if original_width / original_height > target_width / target_height:
        new_height = target_height
        new_width = int(original_width * (new_height / original_height))
    else:
        new_width = target_width
        new_height = int(original_height * (new_width / original_width))

    img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)

    # 居中裁切
    left = (new_width - target_width) // 2
    top = (new_height - target_height) // 2
    right = left + target_width
    bottom = top + target_height
    img = img.crop((left, top, right, bottom))
    return img

def image_to_webp_base64(img):
    """将图片转换为 webp 格式并编码为 base64"""
    buffer = BytesIO()
    img.save(buffer, format="WEBP", quality=90) # 调整 quality 以平衡大小和质量
    img_bytes = buffer.getvalue()
    base64_encoded = base64.b64encode(img_bytes).decode('utf-8')
    return f"data:image/webp;base64,{base64_encoded}"

def process_image_from_url(image_url):
    """下载、处理图片并返回 base64 编码和目标分辨率字符串"""
    try:
        log_event("info", f"Downloading image from URL: {image_url}")
        response = requests.get(image_url, stream=True, timeout=30)
        response.raise_for_status() # Raise HTTPError for bad responses (4xx or 5xx)

        img = Image.open(response.raw)
        img = img.convert("RGB") # 确保是 RGB 格式

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
    except Exception as e:
        log_event("error", f"Failed to process image from URL: {image_url}", {"error": str(e)})
        raise ValueError(f"图片处理失败: {e}")


# --- API 调用 ---
def submit_video_request_api(api_key, model, prompt, negative_prompt, image_size, image_base64=None):
    """调用 SiliconFlow 提交任务 API"""
    url = f"{SILICONFLOW_API_BASE}/video/submit"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model,
        "prompt": prompt,
        "negative_prompt": negative_prompt or "", # API 可能需要空字符串而不是 null
        "image_size": image_size,
        "seed": random.randint(0, 2**32 - 1) # 内部生成随机种子
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
        log_event("success", "Video request submitted successfully", {"requestId": request_id})
        return request_id
    except requests.exceptions.RequestException as e:
        log_event("error", "API request failed (submit)", {"status_code": getattr(e.response, 'status_code', None), "response_text": getattr(e.response, 'text', None), "error": str(e)})
        raise ConnectionError(f"API 请求失败: {e}")
    except Exception as e:
        log_event("error", "Error processing API response (submit)", {"error": str(e)})
        raise ValueError(f"处理 API 响应时出错: {e}")

def query_video_status_api(api_key, request_id):
    """调用 SiliconFlow 查询状态 API"""
    url = f"{SILICONFLOW_API_BASE}/video/status"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {"requestId": request_id}

    log_event("info", "Querying video status from API", {"url": url, "requestId": request_id})
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        response.raise_for_status()
        response_data = response.json()
        log_event("success", "Video status queried successfully", {"requestId": request_id, "status": response_data.get("status")})
        return response_data # 返回整个响应体，包含 status, results, reason 等
    except requests.exceptions.RequestException as e:
        log_event("error", "API request failed (query)", {"requestId": request_id, "status_code": getattr(e.response, 'status_code', None), "response_text": getattr(e.response, 'text', None), "error": str(e)})
        raise ConnectionError(f"API 请求失败: {e}")
    except Exception as e:
        log_event("error", "Error processing API response (query)", {"requestId": request_id, "error": str(e)})
        raise ValueError(f"处理 API 响应时出错: {e}")

# --- 主逻辑 ---
def main():
    # 加载环境变量 (显式指定 config.env)
    dotenv_path = os.path.join(os.path.dirname(__file__), 'config.env')
    load_dotenv(dotenv_path=dotenv_path)
    # Use the new environment variable name for the API key
    api_key = os.getenv("SILICONFLOW_API_KEY")
    t2v_model = os.getenv("Text2VideoModelName")
    i2v_model = os.getenv("Image2VideoModelName")
    debug_mode = os.getenv("DebugMode", "False").lower() == "true"

    if not api_key:
        print_json_output("error", error="API_Key not found in environment variables.")
        sys.exit(1)
    if not t2v_model:
        log_event("warning", "Text2VideoModelName not found in environment variables.")
        # 允许继续，但 T2V 会失败
    if not i2v_model:
        log_event("warning", "Image2VideoModelName not found in environment variables.")
        # 允许继续，但 I2V 会失败

    # 读取 stdin 输入
    try:
        input_str = sys.stdin.read()
        # Log the raw input string received
        log_event("debug", "[Input Debug] Raw string received from stdin", {"raw_input": input_str})
        input_data = json.loads(input_str)
        # Log the dictionary after JSON parsing
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
    mode = input_data.get("mode") # 仅在 submit 时相关
    request_id = input_data.get("request_id") # 仅在 query 时相关
    prompt = input_data.get("prompt")
    negative_prompt = input_data.get("negative_prompt")
    resolution = input_data.get("resolution") # 仅在 submit + t2v 时相关
    image_url = input_data.get("image_url") # 仅在 submit + i2v 时相关

    try:
        if command == "submit":
            log_event("info", f"Processing 'submit' command, mode: {mode}")
            if mode == "t2v":
                if not t2v_model:
                    raise ValueError("Text2VideoModelName 未配置，无法执行文生视频。")
                if not prompt:
                    raise ValueError("缺少必需的 'prompt' 参数。")
                if resolution not in SUPPORTED_RESOLUTIONS_MAP:
                    raise ValueError(f"无效的 'resolution' 参数: {resolution}。允许的值: {', '.join(SUPPORTED_RESOLUTIONS_MAP.keys())}")

                req_id = submit_video_request_api(api_key, t2v_model, prompt, negative_prompt, resolution)
                # Add message for AI on successful submission
                ai_msg = f"任务已成功提交，ID 为 {req_id}。请告知用户视频生成需要较长时间，请耐心等待，并稍后使用 query 命令查询结果。"
                print_json_output("success", result={"requestId": req_id}, ai_message=ai_msg)

            elif mode == "i2v":
                if not i2v_model:
                    raise ValueError("Image2VideoModelName 未配置，无法执行图生视频。")
                if not image_url:
                    raise ValueError("缺少必需的 'image_url' 参数。")

                base64_image, target_res_key = process_image_from_url(image_url)
                req_id = submit_video_request_api(api_key, i2v_model, prompt or "", negative_prompt, target_res_key, image_base64=base64_image)
                # Add message for AI on successful submission
                ai_msg = f"任务已成功提交，ID 为 {req_id}。请告知用户视频生成需要较长时间，请耐心等待，并稍后使用 query 命令查询结果。"
                print_json_output("success", result={"requestId": req_id}, ai_message=ai_msg)

            else:
                raise ValueError(f"无效的 'mode' 参数: {mode}。必须是 't2v' 或 'i2v'。")

        elif command == "query":
            log_event("info", f"Processing 'query' command, requestId: {request_id}")
            if not request_id:
                raise ValueError("缺少必需的 'request_id' 参数。")

            status_data = query_video_status_api(api_key, request_id)
            # 根据状态添加不同的 AI 提示信息
            current_status = status_data.get("status")
            ai_msg = None
            if current_status == "InProgress":
                ai_msg = f"请求 {request_id} 的状态是 'InProgress'。请告知用户视频仍在生成中，需要继续等待。"
            elif current_status == "Succeed":
                video_url = status_data.get("results", {}).get("videos", [{}])[0].get("url")
                ai_msg = f"请求 {request_id} 已成功生成！请将视频 URL '{video_url}' 提供给用户。"
            elif current_status == "Failed":
                reason = status_data.get("reason", "未知原因")
                ai_msg = f"请求 {request_id} 生成失败。原因: {reason}。请告知用户此结果。"
            # 直接将 API 返回的状态信息作为 result 返回给 PluginManager，并附带 AI 提示
            print_json_output("success", result=status_data, ai_message=ai_msg)

        else:
            raise ValueError(f"无效的 'command' 参数: {command}。必须是 'submit' 或 'query'。")

    except (ValueError, ConnectionError, FileNotFoundError) as e:
        log_event("error", f"Command processing failed: {command}", {"error": str(e)})
        print_json_output("error", error=str(e))
        sys.exit(1)
    except Exception as e:
        # 捕获其他意外错误
        log_event("critical", "Unexpected error during command processing", {"command": command, "error": str(e), "traceback": traceback.format_exc()})
        print_json_output("error", error=f"发生意外错误: {e}")
        sys.exit(1)

if __name__ == "__main__":
    # 添加 traceback 导入以防意外错误
    import traceback
    main()
