import sys
import json
import random
import os
import re
import secrets
import time
from datetime import datetime, timezone

from dice_roller import roll_dice, format_dice_results

# --- 全局状态 ---
ACTIVE_DECKS = {}
ACTIVE_DECKS_FILE = os.path.join(os.getenv('PROJECT_BASE_PATH', '.'), 'Plugin/Randomness/data/active_decks.json')

# --- 命名规范转换辅助函数 ---
def snake_to_camel(snake_str):
    components = snake_str.split('_')
    return components[0] + ''.join(x.title() for x in components[1:])

def camel_to_snake(camel_str):
    return re.sub(r'(?<!^)(?=[A-Z])', '_', camel_str).lower()

def convert_keys(data, converter):
    if isinstance(data, dict):
        return {converter(k): convert_keys(v, converter) for k, v in data.items()}
    if isinstance(data, list):
        return [convert_keys(i, converter) for i in data]
    return data

keys_to_snake_case = lambda data: convert_keys(data, camel_to_snake)
keys_to_camel_case = lambda data: convert_keys(data, snake_to_camel)

# --- 数据加载 ---
def load_data_from_env(env_var, default_path):
    base_path = os.getenv('PROJECT_BASE_PATH', '.')
    file_path = os.path.join(base_path, os.getenv(env_var, default_path))
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        raise ValueError(f"文件加载失败: {file_path}. 错误: {e}")

try:
    TAROT_DECK = load_data_from_env('TAROT_DECK_PATH', 'Plugin/Randomness/data/tarot_deck.json')
    RUNE_SET = load_data_from_env('RUNE_SET_PATH', 'Plugin/Randomness/data/rune_set.json')
    POKER_DECK = load_data_from_env('POKER_DECK_PATH', 'Plugin/Randomness/data/poker_deck.json')
    TAROT_SPREADS = load_data_from_env('TAROT_SPREADS_PATH', 'Plugin/Randomness/data/tarot_spreads.json')
    
    AVAILABLE_DECKS = {"poker": POKER_DECK, "tarot": TAROT_DECK}
except ValueError as e:
    sys.stdout.write(json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False))
    sys.exit(1)

# --- 有状态的牌堆管理函数 ---
def create_deck(params):
    deck_name = params.get('deck_name')
    deck_count = params.get('deck_count', 1)
    if not deck_name or deck_name not in AVAILABLE_DECKS:
        raise ValueError(f"无效的牌堆名称: '{deck_name}'。可用牌堆: {list(AVAILABLE_DECKS.keys())}")
    
    initial_cards = AVAILABLE_DECKS[deck_name] * deck_count
    random.shuffle(initial_cards)
    deck_id = secrets.token_hex(16)
    ACTIVE_DECKS[deck_id] = {
        "initial_cards": initial_cards[:], "cards": initial_cards[:],
        "drawn_cards": [], "last_accessed": time.time()
    }
    return {"deck_id": deck_id, "deck_name": deck_name, "total_cards": len(initial_cards), "remaining_cards": len(initial_cards)}

def create_custom_deck(params):
    cards = params.get('cards', [])
    if not isinstance(cards, list): raise ValueError("'cards' 参数必须是一个列表。")
    
    deck_name = params.get('deck_name', 'custom')
    initial_cards = cards[:]
    random.shuffle(initial_cards)
    deck_id = secrets.token_hex(16)
    ACTIVE_DECKS[deck_id] = {
        "initial_cards": initial_cards[:], "cards": initial_cards[:],
        "drawn_cards": [], "last_accessed": time.time()
    }
    return {"deck_id": deck_id, "deck_name": deck_name, "total_cards": len(initial_cards), "remaining_cards": len(initial_cards)}

def draw_from_deck(params):
    deck_id = params.get('deck_id')
    count = int(params.get('count', 1))
    if not deck_id or deck_id not in ACTIVE_DECKS: raise ValueError(f"无效的 'deck_id': {deck_id}。")
    
    ACTIVE_DECKS[deck_id]['last_accessed'] = time.time()
    deck = ACTIVE_DECKS[deck_id]["cards"]
    if count > len(deck): raise ValueError(f"抽牌数量 ({count}) 超过了牌堆剩余牌数 ({len(deck)})。")
        
    drawn_cards = [deck.pop() for _ in range(count)]
    ACTIVE_DECKS[deck_id]["drawn_cards"].extend(drawn_cards)
    return {"deck_id": deck_id, "drawn_cards": drawn_cards, "remaining_cards": len(deck)}

def reset_deck(params):
    deck_id = params.get('deck_id')
    if not deck_id or deck_id not in ACTIVE_DECKS: raise ValueError(f"无效的 'deck_id': {deck_id}。")
    
    deck_info = ACTIVE_DECKS[deck_id]
    deck_info['last_accessed'] = time.time()
    new_cards = deck_info["initial_cards"][:]
    random.shuffle(new_cards)
    deck_info["cards"] = new_cards
    deck_info["drawn_cards"] = []
    return {"deck_id": deck_id, "status": "reset_success", "remaining_cards": len(new_cards)}

def destroy_deck(params):
    deck_id = params.get('deck_id')
    if deck_id in ACTIVE_DECKS:
        del ACTIVE_DECKS[deck_id]
        return {"deck_id": deck_id, "status": "destroyed"}
    return {"deck_id": deck_id, "status": "not_found_or_already_destroyed"}

def query_deck(params):
    deck_id = params.get('deck_id')
    if not deck_id or deck_id not in ACTIVE_DECKS: raise ValueError(f"无效的 'deck_id': {deck_id}。")
    
    deck_info = ACTIVE_DECKS[deck_id]
    deck_info['last_accessed'] = time.time()
    return {
        "deck_id": deck_id, "remaining_cards": len(deck_info["cards"]),
        "drawn_cards_count": len(deck_info["drawn_cards"]),
        "total_cards": len(deck_info["initial_cards"])
    }

# --- 无状态的随机函数 ---
def get_cards(params):
    deck_name = params.get('deck_name')
    count = int(params.get('count', 1))
    if not deck_name or deck_name not in AVAILABLE_DECKS:
        raise ValueError(f"无效的牌堆名称: '{deck_name}'。")
    if count <= 0: raise ValueError("'count' 参数必须是正整数。")
    
    deck = AVAILABLE_DECKS[deck_name][:]
    if count > len(deck): raise ValueError(f"抽牌数量 ({count}) 不能超过牌堆总数 ({len(deck)})。")
        
    random.shuffle(deck)
    return {"cards": [deck.pop() for _ in range(count)]}

def draw_tarot(params):
    spread = params.get('spread')
    allow_reversed = params.get('allow_reversed', True)

    if spread and spread not in TAROT_SPREADS:
        raise ValueError(f"无效的牌阵名称: '{spread}'。可用牌阵: {list(TAROT_SPREADS.keys())}")

    count = len(TAROT_SPREADS[spread]) if spread else int(params.get('count', 3))
    spread_info = TAROT_SPREADS.get(spread, [{"position": f"Card {i+1}", "description": ""} for i in range(count)])
    
    deck_copy = TAROT_DECK[:]
    random.shuffle(deck_copy)
    
    drawn_cards = []
    for i in range(count):
        card_name = deck_copy.pop()
        is_upright = random.choice([True, False]) if allow_reversed else True
        drawn_cards.append({
            "name": card_name, "upright": is_upright,
            "position": spread_info[i]["position"], "description": spread_info[i]["description"]
        })
    return {"type": "tarot_draw", "spread_name": spread or "custom", "cards": drawn_cards}

def cast_runes(params):
    count = int(params.get('count', 1))
    if count <= 0 or count > len(RUNE_SET):
        raise ValueError(f"抽取的卢恩符文数量 ({count}) 无效。")
    set_copy = RUNE_SET[:]
    random.shuffle(set_copy)
    return {"type": "rune_cast", "runes": [set_copy.pop() for _ in range(count)]}

def select_from_list(params):
    items = params.get('items', [])
    count = int(params.get('count', 1))
    with_replacement = params.get('with_replacement', False)
    
    if not isinstance(items, list) or not items: raise ValueError("'items' 参数必须是一个非空列表。")
    if count <= 0: raise ValueError("'count' 参数必须是正整数。")

    if with_replacement:
        result = random.choices(items, k=count)
    else:
        if count > len(items): raise ValueError(f"选择数量 ({count}) 不能超过列表项目总数 ({len(items)})。")
        result = random.sample(items, k=count)
    return {"selection": result}

def get_random_date_time(params):
    start_str = params.get('start')
    end_str = params.get('end')
    format_str = params.get('format', '%Y-%m-%d %H:%M:%S')

    start_dt = datetime.fromisoformat(start_str) if start_str else datetime(1970, 1, 1, tzinfo=timezone.utc)
    end_dt = datetime.fromisoformat(end_str) if end_str else datetime.now(timezone.utc)
    
    if start_dt.tzinfo is None: start_dt = start_dt.astimezone()
    if end_dt.tzinfo is None: end_dt = end_dt.astimezone()
    
    start_ts = start_dt.timestamp()
    end_ts = end_dt.timestamp()
    
    if start_ts > end_ts: raise ValueError("起始时间不能晚于结束时间。")
    
    random_ts = random.uniform(start_ts, end_ts)
    random_dt = datetime.fromtimestamp(random_ts, tz=start_dt.tzinfo)
    
    return {"datetime_str": random_dt.strftime(format_str)}

# --- 结果格式化函数 ---
def format_get_cards_results(data): return f"为您从牌堆中抽到了: {', '.join(map(str, data.get('cards', [])))}。"
def format_create_deck_results(data): return f"已成功创建牌堆 '{data.get('deck_name')}' (共 {data.get('total_cards')} 张)。\n请使用此ID进行后续操作: `{data.get('deck_id')}`"
def format_create_custom_deck_results(data): return f"已成功创建名为 '{data.get('deck_name')}' 的自定义牌堆 (共 {data.get('total_cards')} 张)。\n请使用此ID进行后续操作: `{data.get('deck_id')}`"
def format_draw_from_deck_results(data): return f"从牌堆 `{data['deck_id']}` 中抽到了: {', '.join(map(str, data.get('drawn_cards', [])))}。\n剩余牌数: {data['remaining_cards']}。"
def format_reset_deck_results(data): return f"牌堆 `{data['deck_id']}` 已重置。剩余牌数: {data['remaining_cards']}。"
def format_destroy_deck_results(data): return f"牌堆 `{data['deck_id']}` 已销毁。"
def format_query_deck_results(data): return f"牌堆 `{data['deck_id']}` 状态查询:\n- 剩余牌数: {data['remaining_cards']}\n- 已抽牌数: {data['drawn_cards_count']}\n- 总牌数: {data['total_cards']}"
def format_tarot_results(data):
    lines = [f"为您使用 **{data.get('spread_name', 'custom')}** 牌阵抽到的塔罗牌是："]
    for card in data.get('cards', []):
        status = "正位" if card.get('upright') else "逆位"
        pos = f"**{card.get('position')}**: " if card.get('position') else ""
        lines.append(f"- {pos}「{card.get('name')}」({status})")
    return "\n".join(lines)
def format_rune_results(data): return f"为您抽取的卢恩符文是：{', '.join(data['runes'])}。"
def format_select_from_list_results(data): return f"从列表中随机选择的结果是：**{', '.join(map(str, data.get('selection', [])))}**"
def format_get_random_date_time_results(data): return f"在指定范围内生成的随机时间是：**{data.get('datetime_str')}**"

# --- 状态管理 ---
def cleanup_old_decks():
    now = time.time()
    expiration_time = 24 * 60 * 60
    decks_to_delete = [
        deck_id for deck_id, deck_data in ACTIVE_DECKS.items()
        if now - deck_data.get('last_accessed', 0) > expiration_time
    ]
    for deck_id in decks_to_delete:
        if deck_id in ACTIVE_DECKS:
            del ACTIVE_DECKS[deck_id]

# --- 主函数 ---
def main():
    command = None
    try:
        # 加载并清理旧牌堆
        if os.path.exists(ACTIVE_DECKS_FILE):
            with open(ACTIVE_DECKS_FILE, 'r', encoding='utf-8') as f:
                content = f.read()
                if content: ACTIVE_DECKS.update(json.loads(content))
        cleanup_old_decks()

        # 处理输入
        input_json = sys.stdin.read()
        args = keys_to_snake_case(json.loads(input_json)) if input_json else {}
        command = args.get("command")
        if not command: raise ValueError("缺少必需的 'command' 字段。")

        # 映射和执行命令
        command_map = {
            "getCards": get_cards, "rollDice": roll_dice, "drawTarot": draw_tarot, "castRunes": cast_runes,
            "createDeck": create_deck, "createCustomDeck": create_custom_deck,
            "drawFromDeck": draw_from_deck, "resetDeck": reset_deck,
            "destroyDeck": destroy_deck, "queryDeck": query_deck,
            "selectFromList": select_from_list, "getRandomDateTime": get_random_date_time
        }
        
        if command not in command_map:
            raise ValueError(f"无效的命令：'{command}'")
        
        result_data = command_map[command](args)
        
        # 格式化结果
        formatter_map = {
            "getCards": format_get_cards_results, "rollDice": lambda d, p=args: format_dice_results(d, p),
            "drawTarot": format_tarot_results, "castRunes": format_rune_results,
            "createDeck": format_create_deck_results, "createCustomDeck": format_create_custom_deck_results,
            "drawFromDeck": format_draw_from_deck_results, "resetDeck": format_reset_deck_results,
            "destroyDeck": format_destroy_deck_results, "queryDeck": format_query_deck_results,
            "selectFromList": format_select_from_list_results, "getRandomDateTime": format_get_random_date_time_results
        }
        
        formatter = formatter_map.get(command)
        message = formatter(result_data) if formatter else f"已成功执行命令 '{command}'。"
        
        # 构造最终响应
        response = {"status": "success", "result": result_data, "message_for_ai": message}
    
    except Exception as e:
        error_cmd_str = f" '{command}'" if command else ""
        error_message = f"执行命令{error_cmd_str}时发生错误: {str(e)}"
        response = {"status": "error", "error": str(e), "message_for_ai": error_message}
        
    finally:
        # 始终尝试保存状态
        try:
            with open(ACTIVE_DECKS_FILE, 'w', encoding='utf-8') as f:
                json.dump(ACTIVE_DECKS, f, ensure_ascii=False, indent=4)
        except Exception:
            pass # 保存失败不应覆盖原始响应

    # VCPToolbox 要求输出包装，并且是驼峰命名法
    final_output = f"<<<RandomnessStart>>>\n{json.dumps(keys_to_camel_case(response), ensure_ascii=False)}\n<<<RandomnessEnd>>>"
    sys.stdout.write(final_output)

if __name__ == "__main__":
    main()