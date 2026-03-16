import websocket
import json
import subprocess
import threading
import time
import os
import sys

# --- 配置信息 ---
VCP_KEY = '164522'
WS_SERVER_URL = 'ws://192.168.2.179:5890'
WS_URL = f"{WS_SERVER_URL}/VCPlog/VCP_Key={VCP_KEY}"

def detect_notifier():
    """检测当前 Linux 环境活跃的通知组件"""
    try:
        # 优先检测 Quickshell
        if subprocess.run(['pgrep', '-x', 'quickshell'], capture_output=True).returncode == 0:
            return "quickshell"
        # 次选 Dunst
        if subprocess.run(['pgrep', '-x', 'dunst'], capture_output=True).returncode == 0:
            return "dunst"
    except:
        pass
    return "generic"

def show_notification(title, message):
    """
    智能路由通知函数
    通过 notify-send (D-Bus 封装) 实现对不同守护进程的适配
    """
    notifier_type = detect_notifier()
    
    # 基础命令
    cmd = ["notify-send"]
    
    # 针对不同组件的魔改参数
    if notifier_type == "quickshell":
        cmd += ["-a", "VCP-Quickshell", "--hint=string:x-canonical-private-synchronous:vcp-notif"]
    elif notifier_type == "dunst":
        cmd += ["-a", "VCP-Dunst", "-u", "normal"]
    else:
        cmd += ["-a", "VCP-Linux"]
        
    cmd += [title, message]
    
    try:
        subprocess.run(cmd, check=False)
    except Exception as e:
        print(f"通知发送失败: {e}", file=sys.stderr)

def on_message(ws_app, message):
    try:
        data = json.loads(message)
        if data.get('type') == 'vcp_log' and data.get('data'):
            log_data = data['data']
            if isinstance(log_data, str):
                try: log_data = json.loads(log_data)
                except: pass
            
            title = "VCP工具箱通知"
            content = ""

            if isinstance(log_data, dict):
                if log_data.get('type') == 'agent_message':
                    content = log_data.get('message', '')
                    title = log_data.get('title', title)
                elif 'content' in log_data:
                    title = log_data.get('title', title)
                    content = log_data['content']
                else:
                    content = json.dumps(log_data, ensure_ascii=False)
            else:
                content = str(log_data)
            
            if len(content) > 200: content = content[:197] + "..."
            show_notification(title, content)
    except Exception as e:
        print(f"消息处理错误: {e}")

def on_error(ws_app, error):
    print(f"WebSocket 错误: {error}")

def on_close(ws_app, code, msg):
    print(f"连接关闭，5秒后重连... ({code}: {msg})")
    time.sleep(5)
    start_websocket_client()

def on_open(ws_app):
    print(f"WebSocket 已连接! 探测到通知环境: {detect_notifier()}")
    show_notification("VCP工具箱", "Linux 通知监听已就绪，魔改成功！")

def start_websocket_client():
    ws_app = websocket.WebSocketApp(
        WS_URL,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close
    )
    while True:
        try:
            ws_app.run_forever(ping_interval=10, ping_timeout=5)
        except:
            time.sleep(5)

if __name__ == "__main__":
    start_websocket_client()