import re
import random

def roll_dice(params):
    """
    掷一个或多个骰子，支持复杂的TRPG风格的骰子表达式。
    """
    expression_param = params.get('dice_string') or params.get('dice', '')
    if not isinstance(expression_param, str):
        # 为了兼容性，处理旧的列表格式输入
        if isinstance(expression_param, list):
            dice_set = expression_param[0]
            count = dice_set.get('count', 1)
            sides = dice_set.get('sides', 6)
            expression_param = f"{count}d{sides}"
        else:
            expression_param = '1d6' # 默认回退

    original_expression = expression_param.strip()
    expression = original_expression.lower()

    # --- 解析重复掷骰 (Repeat) ---
    repeat_match = re.match(r"(\d+)r(.+)", expression)
    if repeat_match:
        repeat_count = int(repeat_match.group(1))
        sub_expression = repeat_match.group(2)
        if repeat_count > 20: # 限制重复次数
            raise ValueError("重复次数不能超过20次。")

        all_results = []
        for i in range(repeat_count):
            result = _parse_and_roll(sub_expression)
            all_results.append(result)
        
        return {
            "expression": original_expression,
            "is_repeat": True,
            "repeat_count": repeat_count,
            "results": all_results
        }

    return _parse_and_roll(original_expression)

def _parse_and_roll(expression_str):
    """内部函数，处理单个掷骰表达式的解析和计算。"""
    expression = expression_str.lower().strip()
    # --- 解析表达式 ---
    # 首先检查 Fate/Fudge 骰子格式
    fate_match = re.match(r"(\d+)df", expression)
    if fate_match:
        count = int(fate_match.group(1))
        if count > 100: raise ValueError("骰子数量不能超过100。")
        
        fate_sides = [-1, -1, 0, 0, 1, 1]
        rolls_values = [random.choice(fate_sides) for _ in range(count)]
        
        def to_symbol(val):
            if val == 1: return '+'
            if val == -1: return '-'
            return ' ' # 空白
            
        rolls_symbols = [to_symbol(v) for v in rolls_values]
        total = sum(rolls_values)
        
        return {
            "expression": expression_str,
            "total": total,
            "rolls": {"initial": rolls_symbols},
            "calculation_steps": [f"掷 Fate 骰: {rolls_symbols} -> 合计 {total}"],
        }

    # 接着检查自定义骰面格式
    custom_sides_match = re.match(r"(\d+)d\{(.+)\}", expression)
    if custom_sides_match:
        count = int(custom_sides_match.group(1))
        sides_str = custom_sides_match.group(2)
        custom_sides = [s.strip() for s in sides_str.split(',')]
        
        if count > 100: raise ValueError("骰子数量不能超过100。")

        rolls = [random.choice(custom_sides) for _ in range(count)]
        
        return {
            "expression": expression_str,
            "total": ", ".join(rolls),
            "rolls": {"initial": rolls},
            "calculation_steps": [f"掷自定义骰: {rolls}"],
        }

    # 标准数字骰子格式
    pattern = re.compile(
        r"(\d*)d(\d+)"      # 1, 2: 主要骰子部分 (e.g., 4d6, d20)
        r"(adv|dis)?"       # 3: D&D 优势/劣势
        r"(k[hl]\d+)?"      # 4: 保留最高/最低 (e.g., kh3)
        r"(s)?"             # 5: 排序标志 (e.g., s)
        r"([<>]=?\d+)?"     # 6: 成功检定或骰池 (e.g., <=75, >6)
        r"([+-]\d+)?"       # 7: 算术修正 (e.g., +5)
        r"(bp\d*|pb\d*)?"   # 8: COC 奖励/惩罚骰
    )
    match = pattern.match(expression)

    if not match:
        raise ValueError(f"无效的骰子表达式: '{expression_str}'")

    groups = match.groups()
    
    count_str, sides_str = groups[0], groups[1]
    count = int(count_str) if count_str else 1
    sides = int(sides_str)
    
    adv_mod = groups[2]
    keep_mod = groups[3]
    sort_flag = groups[4]
    check_or_pool_mod = groups[5]
    arith_mod = groups[6]
    coc_mod = groups[7]

    calculation_steps = []
    
    original_count = count
    if adv_mod:
        if count != 1 or sides != 20:
            raise ValueError("优势/劣势 (adv/dis) 仅适用于 1d20。")
        count = 2
        keep_mod = "kh1" if adv_mod == "adv" else "kl1"
        calculation_steps.append(f"掷骰 ({adv_mod}) -> 2d20")
    
    is_pool = False
    if check_or_pool_mod and arith_mod is None and keep_mod is None:
        op_match = re.match(r"([<>]=?)(\d+)", check_or_pool_mod)
        if op_match and op_match.group(1) in ['>', '>=']:
            is_pool = True

    if count <= 0 or sides <= 0 or count > 100:
        raise ValueError("骰子数量和面数必须是正整数，且数量不能超过100。")

    rolls = [random.randint(1, sides) for _ in range(count)]
    detailed_rolls = {"initial": rolls[:]}
    result_rolls = rolls[:]
    
    if not adv_mod:
        calculation_steps.append(f"掷骰 ({count}d{sides}): {rolls}")

    if sort_flag:
        result_rolls.sort()
        calculation_steps.append(f"排序: {result_rolls}")
        detailed_rolls["after_sort"] = result_rolls[:]

    if keep_mod:
        keep_type = keep_mod[1]
        keep_count = int(keep_mod[2:])
        if keep_count >= count:
            raise ValueError("保留的骰子数量必须小于总数量。")
        
        sorted_rolls = sorted(result_rolls, reverse=(keep_type == 'h'))
        result_rolls = sorted_rolls[:keep_count]
        result_rolls.sort() # 保持最终结果升序
        
        if keep_type == 'h':
            calculation_steps.append(f"取最高 {keep_count} 个: {result_rolls}")
        else:
            calculation_steps.append(f"取最低 {keep_count} 个: {result_rolls}")
        detailed_rolls["after_keep"] = result_rolls[:]

    if coc_mod:
        if sides != 100 or original_count != 1:
            raise ValueError("奖励/惩罚骰 (bp/pb) 仅适用于 1d100。")
        
        is_bonus = coc_mod.startswith('bp')
        num_extra_dice = int(coc_mod[2:] or 1)
        
        original_roll = rolls[0]
        units_digit = (original_roll - 1) % 10
        original_tens = (original_roll - 1) // 10
        
        extra_tens = [random.randint(0, 9) for _ in range(num_extra_dice)]
        all_tens = [original_tens] + extra_tens
        
        chosen_tens = min(all_tens) if is_bonus else max(all_tens)
        calc_str = f"{'奖励' if is_bonus else '惩罚'}骰 (十位): {all_tens} -> 取{'最小' if is_bonus else '最大'} {chosen_tens}"
            
        final_roll = chosen_tens * 10 + units_digit + 1
        result_rolls = [final_roll]
        detailed_rolls["coc_dice"] = {"original_tens": original_tens, "extra_tens": extra_tens, "chosen_tens": chosen_tens, "final_roll": final_roll}
        calculation_steps.append(calc_str)

    total = sum(result_rolls)
    
    if arith_mod:
        modifier = int(arith_mod)
        total += modifier
        calculation_steps.append(f"修正: {arith_mod}")

    final_result = {
        "expression": expression_str, "total": total, "rolls": detailed_rolls,
        "calculation_steps": calculation_steps, "sides": sides
    }

    if original_count == 1 and sides == 20 and not keep_mod and not is_pool:
        initial_roll = detailed_rolls["initial"][0]
        if initial_roll == 20: final_result["crit_status"] = "critical_success"
        elif initial_roll == 1: final_result["crit_status"] = "critical_failure"

    if check_or_pool_mod:
        op, target = re.match(r"([<>]=?)(\d+)", check_or_pool_mod).groups()
        target = int(target)
        if is_pool:
            successes = sum(1 for r in result_rolls if (op == '>' and r > target) or (op == '>=' and r >= target))
            final_result["dice_pool"] = {"operator": op, "target": target, "successes": successes}
            final_result["total"] = successes
            calculation_steps.append(f"骰池检定 ({op}{target}): {successes} 个成功")
        else:
            success_map = {'<=': total <= target, '>=': total >= target, '<': total < target, '>': total > target}
            success = success_map.get(op, False)
            final_result["success_check"] = {"operator": op, "target": target, "is_success": success}
            calculation_steps.append(f"检定: {total} {op} {target} -> {'成功' if success else '失败'}")

    return final_result

def format_dice_results(data, params):
    output_format = params.get('format', 'text')
    
    if data.get('is_repeat'):
        expression = data.get('expression')
        results = data.get('results', [])
        lines = [f"执行重复掷骰: **{expression}**"]
        for i, result in enumerate(results):
            sub_format = _format_single_roll(result, output_format)
            lines.append(f"第 {i+1} 次: {sub_format}")
        return "\n".join(lines)
    
    return _format_single_roll(data, output_format)

def _format_single_roll(data, output_format):
    if output_format == 'ascii' and data.get('sides') == 6:
        return _format_ascii_roll(data)
        
    expression = data.get('expression')
    total = data.get('total')
    steps = data.get('calculation_steps', [])
    
    result_line = f"掷骰: **{expression}** = **{total}**"
    
    if data.get('success_check'):
        sc = data['success_check']
        result_line += f" (检定: {total} {sc['operator']} {sc['target']} -> **{'成功' if sc['is_success'] else '失败'}**)"
    elif data.get('dice_pool'):
        dp = data['dice_pool']
        result_line = f"掷骰: **{expression}** = **{dp['successes']}** 个成功"
    
    if data.get('crit_status') == "critical_success": result_line += " **(暴击!)**"
    elif data.get('crit_status') == "critical_failure": result_line += " **(大失败!)**"
        
    details = "计算过程: " + " -> ".join(steps) if steps else ""
    return f"{result_line}\n`{details}`" if details else result_line

def _generate_ascii_d6(value):
    """生成单个D6骰子的ASCII艺术画"""
    templates = {
        1: ["       ", "   ●   ", "       "],
        2: [" ●     ", "       ", "     ● "],
        3: [" ●     ", "   ●   ", "     ● "],
        4: [" ●   ● ", "       ", " ●   ● "],
        5: [" ●   ● ", "   ●   ", " ●   ● "],
        6: [" ●   ● ", " ●   ● ", " ●   ● "],
    }
    art = templates.get(value, ["       ", f"   {value}   ", "       "])
    return [
        "┌───────┐",
        f"│{art[0]}│",
        f"│{art[1]}│",
        f"│{art[2]}│",
        "└───────┘"
    ]

def _join_ascii_art(arts):
    """水平拼接多个ASCII艺术画"""
    if not arts:
        return ""
    
    num_lines = len(arts[0])
    joined_lines = []
    for i in range(num_lines):
        joined_lines.append("  ".join(art[i] for art in arts))
    return "\n".join(joined_lines)

def _format_ascii_roll(data):
    """格式化为ASCII艺术画输出"""
    initial_rolls = data.get('rolls', {}).get('initial', [])
    if not initial_rolls:
        return _format_single_roll(data, 'text') # 回退到文本格式

    expression = data.get('expression')
    total = data.get('total')
    
    arts = [_generate_ascii_d6(roll) for roll in initial_rolls]
    art_str = _join_ascii_art(arts)

    result_line = f"掷骰: **{expression}** = **{total}**"
    if data.get('success_check'):
        sc = data['success_check']
        result_line += f" (检定: {total} {sc['operator']} {sc['target']} -> **{'成功' if sc['is_success'] else '失败'}**)"
    elif data.get('dice_pool'):
        dp = data['dice_pool']
        result_line = f"掷骰: **{expression}** = **{dp['successes']}** 个成功"
    
    return f"{result_line}\n{art_str}"