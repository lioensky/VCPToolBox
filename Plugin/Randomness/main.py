import sys
import json
import random
import os
import re

import secrets
import time

# --- 全局状态 ---
# 用于存储所有活动牌堆的实例
# 结构: { "deck_id_1": {"cards": [...], "drawn_cards": [...]}, "deck_id_2": ... }
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

def keys_to_snake_case(data):
    return convert_keys(data, camel_to_snake)

def keys_to_camel_case(data):
    return convert_keys(data, snake_to_camel)

# --- 数据加载 ---
def load_data_from_env(env_var, default_path):
    base_path = os.getenv('PROJECT_BASE_PATH', '.')
    file_path = os.path.join(base_path, os.getenv(env_var, default_path))
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        raise ValueError(f"文件加载失败: {file_path}. 错误: {e}")

# --- 插件启动时加载所有数据 ---
try:
    TAROT_DECK = load_data_from_env('TAROT_DECK_PATH', 'Plugin/Randomness/data/tarot_deck.json')
    RUNE_SET = load_data_from_env('RUNE_SET_PATH', 'Plugin/Randomness/data/rune_set.json')
    POKER_DECK = load_data_from_env('POKER_DECK_PATH', 'Plugin/Randomness/data/poker_deck.json')
    
    AVAILABLE_DECKS = {
        "poker": POKER_DECK,
        "tarot": TAROT_DECK
    }
except ValueError as e:
    error_message = f"插件 'Randomness' 初始化失败: {e}"
    final_message = f"<<<RandomnessStart>>>\n\n```\n{error_message}\n```\n\n<<<RandomnessEnd>>>"
    sys.stdout.write(json.dumps({"status": "error", "error": str(e), "messageForAI": final_message}, ensure_ascii=False))
    sys.exit(1)

# --- 有状态的牌堆管理函数 ---

def create_deck(params):
    """创建一个新的、有状态的牌堆实例，并返回其唯一ID。"""
    deck_name = params.get('deck_name') or params.get('deck_type')
    deck_count = params.get('deck_count') or params.get('decks_count', 1)

    if not deck_name or deck_name not in AVAILABLE_DECKS:
        raise ValueError(f"无效的牌堆名称: '{deck_name}'。可用牌堆: {list(AVAILABLE_DECKS.keys())}")
    
    try:
        deck_count = int(deck_count)
        if deck_count <= 0:
            raise ValueError
    except (ValueError, TypeError):
        raise ValueError(f"'deck_count' 参数 ('{deck_count}') 必须是一个正整数。")

    # 创建牌堆
    initial_cards = AVAILABLE_DECKS[deck_name] * deck_count
    random.shuffle(initial_cards)
    
    deck_id = secrets.token_hex(16)
    
    ACTIVE_DECKS[deck_id] = {
        "initial_cards": initial_cards[:],
        "cards": initial_cards[:],
        "drawn_cards": [],
        "last_accessed": time.time()
    }
    
    return {
        "deck_id": deck_id,
        "deck_name": deck_name,
        "total_cards": len(initial_cards),
        "remaining_cards": len(initial_cards),
    }

def create_custom_deck(params):
    """根据用户提供的卡牌列表创建一个新的、有状态的牌堆实例。"""
    cards_param = params.get('cards')
    cards = []
    if isinstance(cards_param, str):
        try:
            cards = json.loads(cards_param)
        except json.JSONDecodeError:
            raise ValueError("'cards' 参数必须是一个有效的JSON格式的列表。")
    elif isinstance(cards_param, list):
        cards = cards_param
    deck_name = params.get('deck_name', 'custom')


    initial_cards = cards[:]
    random.shuffle(initial_cards)
    
    deck_id = secrets.token_hex(16)
    
    ACTIVE_DECKS[deck_id] = {
        "initial_cards": initial_cards[:],
        "cards": initial_cards[:],
        "drawn_cards": [],
        "last_accessed": time.time()
    }
    
    return {
        "deck_id": deck_id,
        "deck_name": deck_name,
        "total_cards": len(initial_cards),
        "remaining_cards": len(initial_cards)
    }

def draw_from_deck(params):
    """从指定的牌堆实例中抽牌。"""
    deck_id = params.get('deck_id')
    count = params.get('count') or params.get('num_cards') or params.get('number_of_cards', 1)

    if not deck_id or deck_id not in ACTIVE_DECKS:
        raise ValueError(f"无效的 'deck_id': {deck_id}。")
    
    ACTIVE_DECKS[deck_id]['last_accessed'] = time.time()
        
    try:
        count = int(count)
    except (ValueError, TypeError):
        raise ValueError(f"'count' 参数 ('{count}') 必须是一个可以转换为整数的值。")

    deck = ACTIVE_DECKS[deck_id]["cards"]
    
    if count > len(deck):
        raise ValueError(f"抽牌数量 ({count}) 超过了牌堆剩余牌数 ({len(deck)})。")
        
    drawn_cards = [deck.pop() for _ in range(count)]
    ACTIVE_DECKS[deck_id]["drawn_cards"].extend(drawn_cards)
    
    return {
        "deck_id": deck_id,
        "drawn_cards": drawn_cards,
        "remaining_cards": len(deck)
    }

def reset_deck(params):
    """重置指定的牌堆，将所有牌放回并重新洗牌。"""
    deck_id = params.get('deck_id')
    if not deck_id or deck_id not in ACTIVE_DECKS:
        raise ValueError(f"无效的 'deck_id': {deck_id}。")
    
    deck_info = ACTIVE_DECKS[deck_id]
    deck_info['last_accessed'] = time.time()
    new_cards = deck_info["initial_cards"][:]
    random.shuffle(new_cards)
    
    deck_info["cards"] = new_cards
    deck_info["drawn_cards"] = []
    
    return {
        "deck_id": deck_id,
        "status": "reset_success",
        "remaining_cards": len(new_cards)
    }

def destroy_deck(params):
    """销毁一个牌堆实例，释放资源。"""
    deck_id = params.get('deck_id')
    if deck_id in ACTIVE_DECKS:
        del ACTIVE_DECKS[deck_id]
        return {"deck_id": deck_id, "status": "destroyed"}
    else:
        # 即使ID不存在，也返回成功，因为最终状态是一致的
        return {"deck_id": deck_id, "status": "not_found_or_already_destroyed"}

def query_deck(params):
    """查询指定牌堆的状态。"""
    deck_id = params.get('deck_id')
    if not deck_id or deck_id not in ACTIVE_DECKS:
        raise ValueError(f"无效的 'deck_id': {deck_id}。")
    
    deck_info = ACTIVE_DECKS[deck_id]
    deck_info['last_accessed'] = time.time()
    return {
        "deck_id": deck_id,
        "remaining_cards": len(deck_info["cards"]),
        "drawn_cards_count": len(deck_info["drawn_cards"]),
        "total_cards": len(deck_info["initial_cards"])
    }


# --- 无状态的随机函数 ---

def get_cards(params):
    """从指定的完整牌堆中，洗牌并抽取指定数量的牌。这是一个无状态的操作。"""
    # 增加对常见别名的兼容性，提高鲁棒性
    deck_name = params.get('deck_name') or params.get('deck_type')
    count = params.get('count') or params.get('number', 1)

    try:
        count = int(count)
    except (ValueError, TypeError):
        raise ValueError(f"'count' 参数 ('{count}') 必须是一个可以转换为整数的值。")

    if not deck_name or deck_name not in AVAILABLE_DECKS:
        raise ValueError(f"无效的牌堆名称: '{deck_name}'。可用牌堆: {list(AVAILABLE_DECKS.keys())}")
    
    if count <= 0:
        raise ValueError("'count' 参数必须是一个正整数。")

    deck = AVAILABLE_DECKS[deck_name][:] # 获取一个完整的副本
    
    if count > len(deck):
        raise ValueError(f"抽牌数量 ({count}) 不能超过牌堆总数 ({len(deck)})。")
        
    random.shuffle(deck)
    
    drawn_cards = [deck.pop() for _ in range(count)]
    
    return {"cards": drawn_cards}

def drawTarot(params):
    count = params.get('count', 3)
    try:
        count = int(count)
    except (ValueError, TypeError):
        raise ValueError(f"'count' 参数 ('{count}') 必须是一个可以转换为整数的值。")
    
    allow_reversed = params.get('allow_reversed', True)
    if count > len(TAROT_DECK):
        raise ValueError(f"抽牌数量 ({count}) 不能超过牌库总数 ({len(TAROT_DECK)})。")
    deck_copy = TAROT_DECK[:]
    random.shuffle(deck_copy)
    drawn_cards = []
    for _ in range(count):
        card_name = deck_copy.pop()
        is_upright = random.choice([True, False]) if allow_reversed else True
        drawn_cards.append({"name": card_name, "upright": is_upright})
    return {"type": "tarot_draw", "cards": drawn_cards}

def rollDice(params):
    count = params.get('count', 1)
    sides = params.get('sides', 6)

    try:
        count = int(count)
        sides = int(sides)
    except (ValueError, TypeError):
        raise ValueError(f"参数 'count' ('{count}') 和 'sides' ('{sides}') 必须是可以转换为整数的值。")

    if count <= 0:
        raise ValueError(f"骰子数量 ({count}) 必须是一个正整数。")
    if sides <= 0:
        raise ValueError(f"骰子面数 ({sides}) 必须是一个正整数。")
    rolls = [random.randint(1, sides) for _ in range(count)]
    return {"type": "dice_roll", "rolls": rolls, "total": sum(rolls)}

def castRunes(params):
    count = params.get('count', 1)
    try:
        count = int(count)
    except (ValueError, TypeError):
        raise ValueError(f"'count' 参数 ('{count}') 必须是一个可以转换为整数的值。")

    if count <= 0:
        raise ValueError(f"卢恩符文数量 ({count}) 必须是一个正整数。")
    if count > len(RUNE_SET):
        raise ValueError(f"抽取的卢恩符文数量 ({count}) 不能超过符文总数 ({len(RUNE_SET)})。")
    set_copy = RUNE_SET[:]
    random.shuffle(set_copy)
    drawn_runes = [set_copy.pop() for _ in range(count)]
    return {"type": "rune_cast", "runes": drawn_runes}

# --- 结果格式化函数 ---
def format_get_cards_results(data):
    cards_str = ', '.join(map(str, data.get('cards', [])))
    return f"为您从牌堆中抽到了: {cards_str}。"

def format_create_deck_results(data):
    return f"已成功创建牌堆 '{data.get('deck_name')}' (共 {data.get('total_cards')} 张)。\n请使用此ID进行后续操作: `{data.get('deck_id')}`"

def format_create_custom_deck_results(data):
    return f"已成功创建名为 '{data.get('deck_name')}' 的自定义牌堆 (共 {data.get('total_cards')} 张)。\n请使用此ID进行后续操作: `{data.get('deck_id')}`"

def format_draw_from_deck_results(data):
    cards_str = ', '.join(map(str, data.get('drawn_cards', [])))
    return f"从牌堆 `{data['deck_id']}` 中抽到了: {cards_str}。\n剩余牌数: {data['remaining_cards']}。"

def format_reset_deck_results(data):
    return f"牌堆 `{data['deck_id']}` 已重置。剩余牌数: {data['remaining_cards']}。"

def format_destroy_deck_results(data):
    return f"牌堆 `{data['deck_id']}` 已销毁。"

def format_query_deck_results(data):
    return f"牌堆 `{data['deck_id']}` 状态查询:\n- 剩余牌数: {data['remaining_cards']}\n- 已抽牌数: {data['drawn_cards_count']}\n- 总牌数: {data['total_cards']}"

def format_dice_results(data, params):
    count = params.get('count', 1)
    sides = params.get('sides', 6)
    rolls_str = ', '.join(map(str, data['rolls']))
    return f"为您掷出了 {count} 个 {sides} 面的骰子，结果为：{rolls_str}。总点数为：{data['total']}。"

def format_tarot_results(data):
    cards_strs = []
    for card in data['cards']:
        status = "正位" if card['upright'] else "逆位"
        cards_strs.append(f"「{card['name']}」({status})")
    return "为您抽到的塔罗牌是：\n" + "\n".join(cards_strs)

def format_rune_results(data):
    runes_str = ", ".join(data['runes'])
    return f"为您抽取的卢恩符文是：{runes_str}。"

def cleanup_old_decks():
    """清理超过24小时未使用的旧牌堆"""
    now = time.time()
    # 24 hours in seconds
    expiration_time = 24 * 60 * 60
    
    # 创建一个要删除的牌堆ID列表，以避免在迭代时修改字典
    decks_to_delete = [
        deck_id for deck_id, deck_data in ACTIVE_DECKS.items()
        if now - deck_data.get('last_accessed', 0) > expiration_time
    ]
    
    for deck_id in decks_to_delete:
        if deck_id in ACTIVE_DECKS:
            del ACTIVE_DECKS[deck_id]

def main():
    command = None
    try:
        # 加载活动的牌堆
        if os.path.exists(ACTIVE_DECKS_FILE):
            with open(ACTIVE_DECKS_FILE, 'r', encoding='utf-8') as f:
                # 防止文件为空时出错
                content = f.read()
                if content:
                    ACTIVE_DECKS.update(json.loads(content))
        
        # 清理旧牌堆
        cleanup_old_decks()

        input_json = sys.stdin.read()
        args = keys_to_snake_case(json.loads(input_json))
        command = args.get("command")
        if not command:
            raise ValueError("缺少必需的 'command' 字段。")

        command_map = {
            "getCards": get_cards,
            "rollDice": rollDice,
            "drawTarot": drawTarot,
            "castRunes": castRunes,
            # 有状态命令
            "createDeck": create_deck,
            "createCustomDeck": create_custom_deck,
            "drawFromDeck": draw_from_deck,
            "resetDeck": reset_deck,
            "destroyDeck": destroy_deck,
            "queryDeck": query_deck
        }
        
        if command in command_map and callable(command_map[command]):
            result_data = command_map[command](args)
            
            formatter_map = {
                "getCards": format_get_cards_results,
                "rollDice": lambda d: format_dice_results(d, args),
                "drawTarot": format_tarot_results,
                "castRunes": format_rune_results,
                # 有状态命令格式化
                "createDeck": format_create_deck_results,
                "createCustomDeck": format_create_custom_deck_results,
                "drawFromDeck": format_draw_from_deck_results,
                "resetDeck": format_reset_deck_results,
                "destroyDeck": format_destroy_deck_results,
                "queryDeck": format_query_deck_results
            }
            
            formatter = formatter_map.get(command)
            message = formatter(result_data) if formatter else f"已成功执行命令 '{command}'。"
        else:
            raise ValueError(f"无效的命令：'{command}' 不被支持或无法调用。")

        final_message = f"<<<RandomnessStart>>>\n\n```\n{message}\n```\n\n<<<RandomnessEnd>>>"
        response = {"status": "success", "result": result_data, "message_for_ai": final_message}
        
    except Exception as e:
        error_command_str = f" '{command}'" if command else ""
        error_message = f"执行命令{error_command_str}时发生错误: {str(e)}"
        final_message = f"<<<RandomnessStart>>>\n\n```\n{error_message}\n```\n\n<<<RandomnessEnd>>>"
        response = {"status": "error", "error": str(e), "message_for_ai": final_message}
        
    finally:
        # 始终尝试保存状态
        try:
            with open(ACTIVE_DECKS_FILE, 'w', encoding='utf-8') as f:
                json.dump(ACTIVE_DECKS, f, ensure_ascii=False, indent=4)
        except Exception as save_e:
            # 如果保存失败，也应记录错误，但不覆盖原始响应
            # 实际应用中可能需要更复杂的日志记录
            pass

    sys.stdout.write(json.dumps(keys_to_camel_case(response), ensure_ascii=False))

if __name__ == "__main__":
    main()