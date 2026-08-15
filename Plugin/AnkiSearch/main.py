import sys
import json
import os
import urllib.request
import urllib.error
import time

# Force UTF-8 output for VCP compatibility
sys.stdout.reconfigure(encoding='utf-8')

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))


def load_plugin_env():
    config_path = os.path.join(PLUGIN_DIR, 'config.env')
    if not os.path.exists(config_path):
        return

    try:
        with open(config_path, 'r', encoding='utf-8') as config_file:
            for raw_line in config_file:
                line = raw_line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip())
    except OSError:
        pass


def positive_int(value, fallback):
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return fallback


load_plugin_env()
ANKI_CONNECT_URL = os.environ.get('ANKI_CONNECT_URL', 'http://127.0.0.1:8765').rstrip('/')
ANKI_CONNECT_TIMEOUT_SECONDS = positive_int(os.environ.get('ANKI_CONNECT_TIMEOUT_SECONDS'), 5)
ANKI_CONNECT_RETRIES = positive_int(os.environ.get('ANKI_CONNECT_RETRIES'), 3)


def request_anki(action, params=None, retries=ANKI_CONNECT_RETRIES):
    payload = {
        'action': action,
        'version': 6,
        'params': params or {}
    }
    data = json.dumps(payload).encode('utf-8')

    last_error = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(ANKI_CONNECT_URL, data=data, method='POST')
            with urllib.request.urlopen(req, timeout=ANKI_CONNECT_TIMEOUT_SECONDS) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.URLError as e:
            last_error = f"连接失败: {e.reason}。请确保 Anki 已打开并安装了 AnkiConnect (端口 8765)。"
            time.sleep(1)
        except Exception as e:
            last_error = str(e)
            time.sleep(1)

    return {'error': last_error}

def main():
    try:
        input_data = sys.stdin.read()
        if not input_data:
            return

        try:
            request = json.loads(input_data)
        except json.JSONDecodeError:
             return

        command = request.get('command')
        # Optimization: Fallback for flattened arguments
        args = request.get('args', {})
        if not args and request:
             # If args is empty, try to use the request object itself (excluding command)
             args = {k: v for k, v in request.items() if k != 'command'}

        result = {}

        if command == 'anki_search_cards':
            query = args.get('query', '')
            resp = request_anki('findCards', {'query': query})

            if resp.get('error'):
                result = {"status": "error", "error": resp['error']}
            else:
                card_ids = resp.get('result', [])
                info_resp = request_anki('cardsInfo', {'cards': card_ids[:15]})

                simplified_cards = []
                for c in info_resp.get('result', []):
                    fields_data = c.get('fields', {})
                    safe_fields = {k: v.get('value', '')[:100] for k, v in fields_data.items()}

                    simplified_cards.append({
                        "cardId": c.get('cardId'),
                        "deck": c.get('deckName', 'Unknown'),
                        "model": c.get('modelName', 'Unknown'),
                        "fields": safe_fields,
                        "tags": c.get('tags', []),
                        "interval": c.get('interval', 0),
                        "due": c.get('due', 0)
                    })

                result = {
                    "status": "success",
                    "result": {
                        "totalFound": len(card_ids),
                        "cards": simplified_cards
                    },
                    "messageForAI": f"找到 {len(card_ids)} 张匹配查询 '{query}' 的卡片。"
                }

        elif command == 'anki_get_decks':
            resp = request_anki('deckNamesAndIds')
            if resp.get('error'):
                 result = {"status": "error", "error": resp['error']}
            else:
                decks = resp.get('result', {})
                stats_resp = request_anki('getDeckStats', {'decks': list(decks.keys())})

                result = {
                    "status": "success",
                    "result": stats_resp.get('result', {}),
                    "messageForAI": "成功获取牌组列表及学习统计。"
                }

        elif command == 'anki_get_models':
            resp = request_anki('modelNames')
            if resp.get('error'):
                 result = {"status": "error", "error": resp['error']}
            else:
                model_names = resp.get('result', [])
                models_info = []
                # 获取每个 Model 的字段
                for name in model_names[:10]: # 限制前10个避免超时
                    f_resp = request_anki('modelFieldNames', {'modelName': name})
                    models_info.append({
                        "name": name,
                        "fields": f_resp.get('result', [])
                    })

                result = {
                    "status": "success",
                    "result": models_info,
                    "messageForAI": f"获取到 {len(model_names)} 个笔记类型。"
                }

        else:
             result = {"status": "error", "error": f"未知指令: {command}"}

        print(json.dumps(result, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({"status": "error", "error": f"插件执行错误: {str(e)}"}, ensure_ascii=False))

if __name__ == '__main__':
    main()
