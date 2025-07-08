import sys
import json
import random
import os

# --- 数据加载 ---
def load_data_from_env(env_var, default_path):
    """从环境变量或默认路径加载JSON数据。"""
    base_path = os.getenv('PROJECT_BASE_PATH', '.')
    relative_file_path = os.getenv(env_var, default_path)
    file_path = os.path.join(base_path, relative_file_path)
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        raise ValueError(f"数据文件未找到: {file_path}。请检查路径配置 '{env_var}'。")
    except json.JSONDecodeError:
        raise ValueError(f"数据文件格式错误: {file_path}。请确保是有效的JSON。")

# 从环境变量或默认值加载数据源
try:
    TAROT_DECK = load_data_from_env('TAROT_DECK_PATH', 'Plugin/Randomness/data/tarot_deck.json')
    RUNE_SET = load_data_from_env('RUNE_SET_PATH', 'Plugin/Randomness/data/rune_set.json')
    POKER_DECK = load_data_from_env('POKER_DECK_PATH', 'Plugin/Randomness/data/poker_deck.json')
except ValueError as e:
    # 如果在启动时数据加载失败，直接打印错误并退出，以便快速发现配置问题
    error_response = {
        "status": "error",
        "error": f"插件初始化失败: {str(e)}",
        "messageForAI": f"插件 'Randomness' 初始化失败，请检查服务器日志和插件配置文件。错误: {str(e)}"
    }
    sys.stdout.write(json.dumps(error_response, ensure_ascii=False))
    sys.exit(1)


# --- 核心逻辑函数 ---
def drawTarot(params):
    count = params.get('count', 3)
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
    
    if not isinstance(count, int) or count <= 0:
        raise ValueError(f"骰子数量 ({count}) 必须是一个正整数。")
    if not isinstance(sides, int) or sides <= 0:
        raise ValueError(f"骰子面数 ({sides}) 必须是一个正整数。")

    rolls = [random.randint(1, sides) for _ in range(count)]
    return {"type": "dice_roll", "rolls": rolls, "total": sum(rolls)}

def dealPoker(params):
    players = params.get('players', 1)
    cards_per_player = params.get('cards_per_player', 2)

    if not isinstance(players, int) or players <= 0:
        raise ValueError(f"玩家数量 ({players}) 必须是一个正整数。")
    if not isinstance(cards_per_player, int) or cards_per_player <= 0:
        raise ValueError(f"每个玩家的牌数 ({cards_per_player}) 必须是一个正整数。")

    total_cards_needed = players * cards_per_player
    if total_cards_needed > len(POKER_DECK):
        raise ValueError(f"所需总牌数 ({total_cards_needed}) 超过了扑克牌总数 ({len(POKER_DECK)})。")

    deck_copy = POKER_DECK[:]
    random.shuffle(deck_copy)

    hands = []
    for _ in range(players):
        hand = [deck_copy.pop() for _ in range(cards_per_player)]
        hands.append(hand)
    
    remaining_cards = deck_copy

    return {"type": "poker_deal", "hands": hands, "remaining_cards": remaining_cards}

def castRunes(params):
    count = params.get('count', 1)

    if not isinstance(count, int) or count <= 0:
        raise ValueError(f"卢恩符文数量 ({count}) 必须是一个正整数。")
    if count > len(RUNE_SET):
        raise ValueError(f"抽取的卢恩符文数量 ({count}) 不能超过符文总数 ({len(RUNE_SET)})。")

    set_copy = RUNE_SET[:]
    random.shuffle(set_copy)
    
    drawn_runes = [set_copy.pop() for _ in range(count)]
    return {"type": "rune_cast", "runes": drawn_runes}

# --- 结果格式化函数 ---
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

def format_poker_results(data, params):
    players = params.get('players', 1)
    result_str = f"为您向 {players} 位玩家发牌，结果如下：\n"
    for i, hand in enumerate(data['hands']):
        hand_str = ", ".join(hand)
        result_str += f"玩家 {i+1}: [{hand_str}]\n"
    
    if data.get('remaining_cards'):
        remaining_str = ", ".join(data['remaining_cards'])
        result_str += f"\n底牌: [{remaining_str}]"
        
    return result_str.strip()

def format_rune_results(data):
    runes_str = ", ".join(data['runes'])
    return f"为您抽取的卢恩符文是：{runes_str}。"


def main():
    command = None
    try:
        # 1. 从标准输入读取JSON指令
        input_json = sys.stdin.read()
        args = json.loads(input_json)

        # 2. 获取VCPToolbox传递的命令和参数
        command = args.get("command")
        params = args.get("params", {})

        if not command:
            raise ValueError("缺少必需的 'command' 字段。")

        # 3. 动态查找并调用与命令同名的函数
        if command in globals() and callable(globals()[command]):
            # 调用核心逻辑函数
            result_data = globals()[command](params)
            
            # 根据命令动态调用对应的格式化函数
            formatter_name = f"format_{command.lower().replace('poker', 'poker_results').replace('dice', 'dice_results').replace('tarot', 'tarot_results').replace('runes', 'rune_results')}"
            if 'dice' in command.lower():
                 message = format_dice_results(result_data, params)
            elif 'poker' in command.lower():
                message = format_poker_results(result_data, params)
            elif 'tarot' in command.lower():
                message = format_tarot_results(result_data)
            elif 'runes' in command.lower():
                message = format_rune_results(result_data)
            else:
                # 提供一个通用后备
                message = f"已成功执行命令 '{command}'。"

        else:
            raise ValueError(f"无效的命令：'{command}' 不被支持或无法调用。")

        # 4. 构造并打印成功的JSON输出
        response = {
            "status": "success",
            "result": result_data,
            "messageForAI": message
        }
        
    except Exception as e:
        # 5. 构造并打印失败的JSON输出
        error_command_str = f" '{command}'" if command else ""
        response = {
            "status": "error",
            "error": str(e),
            "messageForAI": f"执行命令{error_command_str}时发生错误: {str(e)}"
        }
        
    sys.stdout.write(json.dumps(response, ensure_ascii=False))

if __name__ == "__main__":
    main()