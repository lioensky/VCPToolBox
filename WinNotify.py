# 文件名: windows_notifier.py
import websocket
import json
import threading
import time
from win10toast import ToastNotifier # 导入win10toast库

# --- 配置信息 (请根据您的VCP工具箱设置进行修改) ---
VCP_KEY = '164522' # 请与您NAS上VCP工具箱的VCP_Key保持一致
WS_SERVER_URL = 'ws://192.168.2.179:5890' # 您NAS上VCP工具箱的WebSocket地址
WS_URL = f"{WS_SERVER_URL}/VCPlog/VCP_Key={VCP_KEY}" # 完整的WebSocket连接URL
APP_ID = "Ryan.VCP.Toolbox.Notifier" # Windows通知的应用程序ID，建议设置为您的应用名，以便在通知中心识别

# 初始化ToastNotifier对象，用于发送通知
notifier = ToastNotifier()

def show_notification(title, message):
    """
    显示Windows Toast通知。
    参数:
        title (str): 通知标题。
        message (str): 通知内容。
    """
    try:
        print(f"尝试显示通知: 标题='{title}', 内容='{message}'")
        notifier.show_toast(
            title,
            message,
            icon_path=None, # 您可以在这里指定一个.ico文件路径作为通知图标，例如 'D:\\path\\to\\your\\icon.ico'
            duration=5,     # 通知显示时长（秒）
            threaded=True   # 在单独的线程中显示通知，防止阻塞主程序
        )
    except Exception as e:
        print(f"显示通知失败: {e}")

def on_message(ws_app, message):
    """
    处理从WebSocket接收到的消息。
    当VCP工具箱发送日志时，会在这里接收到。
    """
    print(f"收到原始消息: {message}")
    try:
        data = json.loads(message)
        
        # 判断消息类型，只处理 'vcp_log' 类型的消息
        if data.get('type') == 'vcp_log' and data.get('data'):
            log_data = data['data']

            # 如果 log_data 是一个字符串, 尝试将其作为JSON解析
            if isinstance(log_data, str):
                try:
                    log_data = json.loads(log_data)
                except json.JSONDecodeError:
                    # 解析失败，保持其为字符串
                    pass
            
            notification_title = "VCP工具箱通知" # 默认通知标题
            notification_content = ""             # 默认通知内容

            # 提取通知内容
            if isinstance(log_data, dict):
                # 优先处理AI Agent消息 (e.g., {"type": "agent_message", "message": "..."})
                if log_data.get('type') == 'agent_message' and 'message' in log_data:
                    notification_content = log_data['message']
                    # 如果消息中也提供了标题，则使用它
                    if 'title' in log_data:
                        notification_title = log_data['title']
                # 其次，处理标准的 title/content 格式
                elif 'content' in log_data:
                    notification_title = log_data.get('title', notification_title)
                    notification_content = log_data['content']
                # 如果是其他类型的字典，则显示完整的JSON内容以便调试
                else:
                    notification_content = json.dumps(log_data, ensure_ascii=False, indent=2)
            else:
                # 如果 log_data 不是字典 (例如，一个纯字符串), 直接显示
                notification_content = str(log_data)
            
            # 限制通知内容长度，避免过长导致显示不全
            if len(notification_content) > 200:
                notification_content = notification_content[:197] + "..."

            show_notification(notification_title, notification_content)
            
        elif data.get('type') == 'connection_ack':
            # 这是连接成功时的确认消息，可以打印到控制台，不发通知
            print(f"连接确认: {data.get('message')}")
            
        else:
            # 收到其他类型的消息
            print(f"收到未知类型的消息: {message}")
            
    except json.JSONDecodeError:
        print(f"无法解析JSON消息: {message}")
    except Exception as e:
        print(f"处理消息时发生未知错误: {e}")

def on_error(ws_app, error):
    """处理WebSocket连接错误。"""
    print(f"WebSocket 错误: {error}")

def on_close(ws_app, close_status_code, close_msg):
    """
    处理WebSocket连接关闭事件。
    连接关闭后，会尝试重新连接。
    """
    print(f"WebSocket 已关闭. 状态码: {close_status_code}, 消息: {close_msg}")
    print("尝试在 5 秒后重新连接...")
    time.sleep(5) # 等待一段时间再尝试重连
    start_websocket_client() # 递归调用，尝试重连

def on_open(ws_app):
    """WebSocket连接成功打开时调用。"""
    print("WebSocket 连接已打开!")
    # 连接成功时，可以发一个通知提醒主人
    show_notification("VCP工具箱通知", "Windows通知监听已连接，准备接收消息！")

def start_websocket_client():
    """启动WebSocket客户端，并保持连接。"""
    print(f"尝试连接到: {WS_URL}")
    # websocket.enableTrace(True) # 调试模式，会输出大量连接信息，平时可以注释掉
    
    # 创建WebSocketApp实例
    ws_app = websocket.WebSocketApp(
        WS_URL,
        on_open=on_open,    # 连接打开时调用
        on_message=on_message,  # 接收到消息时调用
        on_error=on_error,  # 发生错误时调用
        on_close=on_close   # 连接关闭时调用
    )
    
    # 循环运行WebSocket连接，如果断开会自动尝试重连
    while True:
        try:
            # ping_interval 和 ping_timeout 用于维持连接的活跃性
            ws_app.run_forever(ping_interval=10, ping_timeout=5) 
        except Exception as e:
            print(f"WebSocket run_forever 异常: {e}")
            time.sleep(5) # 异常发生时也等待一段时间再重试

if __name__ == "__main__":
    start_websocket_client()
