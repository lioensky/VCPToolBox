import sys
import json
import os
import requests
import base64
import time
import uuid
import re
import subprocess
from io import BytesIO
from PIL import Image
from dotenv import load_dotenv
from datetime import datetime
import traceback
from urllib.parse import urlparse, urljoin
from urllib.request import url2pathname

# --- 自定义异常 (用于超栈追踪) ---
class LocalFileNotFoundError(Exception):
    def __init__(self, message, file_url):
        super().__init__(message)
        self.file_url = file_url

# --- 配置和常量 ---
LOG_FILE = "GrokVideoHistory.log"

# --- 日志记录 ---
def log_event(level, message, data=None):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    log_entry = f"[{timestamp}] [{level.upper()}] {message}"
    if data:
        try:
            log_entry += f" | Data: {json.dumps(data, ensure_ascii=False)}"
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
def image_to_base64(img):
    buffer = BytesIO()
    img.save(buffer, format="JPEG", quality=90)
    img_bytes = buffer.getvalue()
    base64_encoded = base64.b64encode(img_bytes).decode('utf-8')
    return f"data:image/jpeg;base64,{base64_encoded}"

def process_image_from_base64(base64_str):
    try:
        log_event("info", f"Processing image from base64 string (length: {len(base64_str)})")
        if ',' in base64_str:
            header, encoded = base64_str.split(',', 1)
        else:
            encoded = base64_str
        
        img_data = base64.b64decode(encoded)
        img = Image.open(BytesIO(img_data))
        img = img.convert("RGB")
        return image_to_base64(img)
    except Exception as e:
        log_event("error", "Failed to process base64 image", {"error": str(e)})
        raise ValueError(f"处理 base64 图片失败: {e}")

def process_image_from_url(image_url):
    try:
        parsed_url = urlparse(image_url)
        img = None
        if parsed_url.scheme == 'file':
            log_event("info", f"Processing local file URL: {image_url}")
            # 处理 Windows 下不规范的 file:// 路径
            path = parsed_url.path
            if not path and parsed_url.netloc: # 处理 file://C:/path 这种 netloc 误判
                path = parsed_url.netloc + parsed_url.path
            
            file_path = url2pathname(path)
            if os.name == 'nt':
                # 移除开头的斜杠，例如 /C:/... -> C:/...
                file_path = re.sub(r'^/([a-zA-Z]:)', r'\1', file_path)
            
            log_event("info", f"Resolved local file path: {file_path}")

            try:
                with open(file_path, 'rb') as f:
                    img = Image.open(f)
                    img.load()
                log_event("info", f"Successfully opened local file: {file_path}")
            except FileNotFoundError:
                log_event("error", f"Local file not found: {file_path}. Signaling for remote fetch.")
                raise LocalFileNotFoundError("本地文件未找到，需要远程获取。", image_url)
        elif parsed_url.scheme in ['http', 'https']:
            log_event("info", f"Downloading image from URL: {image_url}")
            response = requests.get(image_url, stream=True, timeout=30)
            response.raise_for_status()
            img = Image.open(response.raw)
        else:
            raise ValueError(f"不支持的 URL 协议: {parsed_url.scheme}")

        if img is None:
            raise ValueError("未能加载图片。")
            
        img = img.convert("RGB")
        base64_image = image_to_base64(img)
        return base64_image
    except Exception as e:
        if isinstance(e, LocalFileNotFoundError):
            raise
        log_event("error", f"Failed to process image: {image_url}", {"error": str(e)})
        raise ValueError(f"图片处理失败: {e}")

def download_video_sync(url, task_id, save_dir):
    try:
        os.makedirs(save_dir, exist_ok=True)
        ext = "mp4"
        path_part = url.split('?')[0]
        if '.' in path_part:
            potential_ext = path_part.split('.')[-1].lower()
            if potential_ext in ['mp4', 'webp', 'png', 'jpg', 'jpeg', 'gif']:
                ext = potential_ext

        filename = f"grok_{task_id}.{ext}"
        filepath = os.path.join(save_dir, filename)

        log_event("info", f"Downloading video synchronously: {url} -> {filepath}")
        
        response = requests.get(url, stream=True, timeout=60)
        response.raise_for_status()
        with open(filepath, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
        
        return filename
    except Exception as e:
        log_event("error", f"Failed to download video: {e}")
        return None

# --- 主逻辑 ---
def main():
    dotenv_path = os.path.join(os.path.dirname(__file__), 'config.env')
    load_dotenv(dotenv_path=dotenv_path)
    
    api_key = os.getenv("GROK_API_KEY")
    api_base = os.getenv("GROK_API_BASE", "https://api.x.ai")
    model = os.getenv("GrokVideoModelName", "grok-imagine-0.9")
    
    # 从环境变量获取 VCP 配置 (由 Plugin.js 注入)
    project_base_path = os.getenv("PROJECT_BASE_PATH")
    server_port = os.getenv("SERVER_PORT")
    imageserver_file_key = os.getenv("IMAGESERVER_FILE_KEY") # 视频应该使用 File_Key
    var_http_url = os.getenv("VarHttpUrl")

    if not api_key:
        print_json_output("error", error="GROK_API_KEY not found in config.env.")
        sys.exit(1)

    try:
        input_str = sys.stdin.read()
        if not input_str:
            sys.exit(0)
        input_data = json.loads(input_str)
    except Exception as e:
        print_json_output("error", error=f"Invalid JSON input: {e}")
        sys.exit(1)

    image_url = input_data.get("image_url")
    image_base64_input = input_data.get("image_base64")
    prompt = input_data.get("prompt")
    task_id = str(uuid.uuid4())[:8]

    try:
        if not prompt:
            raise ValueError("Missing prompt")
        # 1. 处理图片 (可选)
        image_base64 = None
        if image_base64_input:
            image_base64 = process_image_from_base64(image_base64_input)
        elif image_url and isinstance(image_url, str) and image_url.strip():
            image_base64 = process_image_from_url(image_url)

        # 2. 调用 Grok API (同步等待)
        # 自动处理 URL 拼接，确保包含 v1/chat/completions
        base_url = api_base.rstrip('/')
        if not base_url.endswith('/v1'):
            if not base_url.endswith('/v1/chat/completions'):
                api_url = f"{base_url}/v1/chat/completions"
            else:
                api_url = base_url
        else:
            api_url = f"{base_url}/chat/completions"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        content_list = [{"type": "text", "text": prompt}]
        if image_base64:
            content_list.append({"type": "image_url", "image_url": {"url": image_base64}})

        payload = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": content_list
                }
            ]
        }

        log_event("info", f"[{task_id}] Calling Grok API (Synchronous)", {"url": api_url, "model": model})
        response = requests.post(api_url, json=payload, headers=headers, timeout=300)
        
        if response.status_code != 200:
            log_event("error", f"[{task_id}] API request failed with status {response.status_code}", {"text": response.text[:1000]})
            response.raise_for_status()

        response_text = response.text
        video_url = None
        content = ""
        
        try:
            # 1. 优先尝试标准 JSON 解析
            result = response.json()
            content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
            if not video_url:
                video_url = result.get("video_url") # 备选方案
        except json.JSONDecodeError:
            # 2. 尝试解析 SSE 流式响应
            log_event("info", f"[{task_id}] Failed to parse as standard JSON, trying SSE stream parsing")
            lines = response_text.split('\n')
            for line in lines:
                line = line.strip()
                if line.startswith("data: "):
                    content_str = line[6:].strip()
                    if content_str == "[DONE]":
                        break
                    try:
                        chunk = json.loads(content_str)
                        if "choices" in chunk and chunk["choices"]:
                            delta = chunk["choices"][0].get("delta", {})
                            if "content" in delta:
                                content += delta["content"]
                    except:
                        continue

        # 3. 如果通过JSON或SSE获取到了内容，提取其中的URL
        if content and not video_url:
            url_match = re.search(r'(https?://[^\s<>"\']+\.(mp4|webp|png|jpg|jpeg)[^\s<>"\']*)', content, re.IGNORECASE)
            if url_match:
                video_url = url_match.group(1)
            
            if not video_url:
                # HTML 标签提取
                html_match = re.search(r'src=["\']([^"\'>]+\.(mp4|webp|png|jpg|jpeg)[^"\'>]*)["\']', content, re.IGNORECASE)
                if html_match:
                    video_url = html_match.group(1)
                    
            if not video_url:
                # Markdown 链接提取
                md_match = re.search(r'!?\[[^\]]*\]\(([^\)]+\.(mp4|webp|png|jpg|jpeg)[^\)]*)\)', content, re.IGNORECASE)
                if md_match:
                    video_url = md_match.group(1)

        # 4. 最后一道防线：对整个原始文本进行暴力正则提取
        if not video_url:
            log_event("info", f"[{task_id}] Fallback to regex extraction directly from response text")
            url_match = re.search(r'(https?://[^\s<>"\']+\.(mp4|webp|png|jpg|jpeg)[^\s<>"\']*)', response_text, re.IGNORECASE)
            if url_match:
                video_url = url_match.group(1)

        if video_url:
            log_event("success", f"[{task_id}] Video URL obtained: {video_url}")
            
            # 4. 同步下载并转化为本地 URL
            local_filename = None
            accessible_url = video_url
            
            if project_base_path and server_port and imageserver_file_key and var_http_url:
                video_save_dir = os.path.join(project_base_path, 'file', 'video')
                local_filename = download_video_sync(video_url, task_id, video_save_dir)
                
                if local_filename:
                    # 构建本地局域网 URL
                    # 根据 image-server.js 的逻辑：
                    # app.use('/:pathSegmentWithKey/files', ...) 映射到 projectBasePath/file
                    # 所以访问 file/video/xxx.mp4 应该是 /pw=KEY/files/video/xxx.mp4
                    
                    accessible_url = f"{var_http_url}:{server_port}/pw={imageserver_file_key}/files/video/{local_filename}"
                    log_event("info", f"[{task_id}] Local accessible URL: {accessible_url}")

            ai_msg = f"Grok 视频生成成功！\n视频已下载并转化为本地 URL: {accessible_url}"
            if accessible_url != video_url:
                ai_msg += f"\n原始 URL: {video_url}"
                
            print_json_output("success", result={
                "video_url": accessible_url,
                "original_url": video_url,
                "local_path": f"file/video/{local_filename}" if local_filename else None,
                "requestId": task_id
            }, ai_message=ai_msg)
        else:
            raise ValueError(f"未能从 API 响应中提取视频 URL。内容: {content[:200]}")

    except LocalFileNotFoundError as e:
        # 超栈追踪：抛出特定格式的 JSON 引导主服务处理
        error_payload = {
            "status": "error",
            "code": "FILE_NOT_FOUND_LOCALLY",
            "error": str(e),
            "fileUrl": e.file_url
        }
        # 确保这是标准输出的唯一内容
        print(json.dumps(error_payload, ensure_ascii=False))
        sys.exit(1) # 使用非零状态码表示需要主服务介入
    except Exception as e:
        log_event("error", f"[{task_id}] Processing failed", {"error": str(e), "traceback": traceback.format_exc()})
        print_json_output("error", error=str(e))
        sys.exit(1)

if __name__ == "__main__":
    main()