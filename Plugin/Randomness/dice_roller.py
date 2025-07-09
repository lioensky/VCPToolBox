import re
import random

# --- 主入口函数 ---

def roll_dice(params):
    """
    掷一个或多个骰子，支持复杂的TRPG风格的骰子表达式，包括数学运算。
    """
    expression_param = params.get('dice_string') or params.get('dice', '')
    original_expression = expression_param.strip()
    
    # 优先处理重复掷骰 (Repeat)
    # 允许多层括号，例如 3r((1d6+1)*2)
    repeat_match = re.match(r"(\d+)\s*r\s*\((.+)\)", original_expression, re.IGNORECASE)
    if repeat_match:
        repeat_count = int(repeat_match.group(1))
        sub_expression = repeat_match.group(2)
        if repeat_count > 20: raise ValueError("重复次数不能超过20次。")

        all_results = []
        for _ in range(repeat_count):
            result = _evaluate_mathematical_expression(sub_expression)
            all_results.append(result)
        
        return {
            "expression": original_expression,
            "is_repeat": True,
            "repeat_count": repeat_count,
            "results": all_results
        }

    # 处理单个复杂表达式
    return _evaluate_mathematical_expression(original_expression)


# --- 数学表达式处理模块 ---

def _evaluate_mathematical_expression(expression_str):
    """
    解析并计算可能包含括号和数学运算的完整掷骰表达式。
    """
    sub_rolls_data = []
    calculation_steps = []

    def roll_and_replace(match):
        dice_expr = match.group(0)
        roll_result = _parse_and_roll(dice_expr)
        sub_rolls_data.append(roll_result)
        
        sub_steps = " -> ".join(roll_result.get('calculation_steps', []))
        calculation_steps.append(f"计算 '{dice_expr}': {sub_steps}")
        
        return str(roll_result['total'])

    # 匹配所有独立的原子掷骰表达式
    dice_pattern = re.compile(r"\b\d*d(\d+|\{.*?\}|[fF])(?:[a-zA-Z0-9<>=\-]+)?\b", re.IGNORECASE)
    
    # 如果表达式本身就是一个完整的原子掷骰，直接用旧流程处理，以保留所有细节
    if dice_pattern.fullmatch(expression_str.lower()):
        return _parse_and_roll(expression_str)

    # 替换表达式中的掷骰部分为它们的数值结果
    math_expr = dice_pattern.sub(roll_and_replace, expression_str)

    try:
        # 移除非法字符，增强安全性
        safe_expr = re.sub(r"[^0-9\.\s\(\)\+\-\*\/]", "", math_expr)
        if safe_expr != math_expr:
             raise ValueError(f"包含无效字符")
        
        total = eval(safe_expr, {"__builtins__": {}}, {})
        calculation_steps.append(f"最终计算: {math_expr} = {total}")

    except Exception as e:
        raise ValueError(f"数学表达式 '{math_expr}' 求值失败: {e}")

    return {
        "expression": expression_str,
        "total": float(total),
        "is_complex_math": True,
        "sub_rolls": sub_rolls_data,
        "calculation_steps": calculation_steps,
    }


# --- 原子掷骰处理模块 ---

def _parse_and_roll(expression_str):
    """
    内部函数，处理单个原子掷骰表达式的解析和计算 (例如 '4d6kh3+5')。
    """
    expression = expression_str.lower().strip()
    
    # 优先处理特殊骰子类型
    fate_match = re.match(r"(\d+)df$", expression, re.IGNORECASE)
    if fate_match:
        count = int(fate_match.group(1))
        if count > 100: raise ValueError("骰子数量不能超过100。")
        rolls_values = [random.choice([-1, -1, 0, 0, 1, 1]) for _ in range(count)]
        rolls_symbols = ['+' if v == 1 else '-' if v == -1 else ' ' for v in rolls_values]
        total = sum(rolls_values)
        return {"expression": expression_str, "total": total, "rolls": {"initial": rolls_symbols}, "calculation_steps": [f"掷 Fate 骰: {rolls_symbols} -> 合计 {total}"]}

    custom_sides_match = re.match(r"(\d+)d\{(.+)\}", expression, re.IGNORECASE)
    if custom_sides_match:
        count = int(custom_sides_match.group(1))
        custom_sides = [s.strip() for s in custom_sides_match.group(2).split(',')]
        if count > 100: raise ValueError("骰子数量不能超过100。")
        rolls = [random.choice(custom_sides) for _ in range(count)]
        return {"expression": expression_str, "total": ", ".join(rolls), "rolls": {"initial": rolls}, "calculation_steps": [f"掷自定义骰: {rolls}"]}
    
    # 标准数字骰子解析
    pattern = re.compile(r"(\d*)d(\d+)(adv|dis)?(k[hl]\d+)?(s)?([<>]=?\d+)?(bp\d*|pb\d*)?([+-]\d+)?", re.IGNORECASE)
    match = pattern.match(expression)
    if not match: raise ValueError(f"无效的骰子表达式: '{expression_str}'")
    
    groups = match.groups()
    count_str, sides_str, adv_mod, keep_mod, sort_flag, check_or_pool_mod, coc_mod, arith_mod = groups
    
    count = int(count_str) if count_str else 1
    sides = int(sides_str)
    
    calculation_steps, original_count = [], count
    if adv_mod:
        if count != 1 or sides != 20: raise ValueError("优势/劣势 (adv/dis) 仅适用于 1d20。")
        count, keep_mod = 2, "kh1" if adv_mod == "adv" else "kl1"
        calculation_steps.append(f"掷骰 ({adv_mod}) -> 2d20")

    is_pool = bool(check_or_pool_mod and not arith_mod and not keep_mod and check_or_pool_mod.startswith(('>', '<')))
    if count <= 0 or sides <= 0 or count > 100: raise ValueError("骰子数量和面数必须是正整数，且数量不能超过100。")

    rolls = [random.randint(1, sides) for _ in range(count)]
    detailed_rolls, result_rolls = {"initial": rolls[:]}, rolls[:]
    if not adv_mod: calculation_steps.append(f"掷骰 ({count}d{sides}): {rolls}")

    if sort_flag:
        result_rolls.sort()
        calculation_steps.append(f"排序: {result_rolls}")
        detailed_rolls["after_sort"] = result_rolls[:]

    if keep_mod:
        keep_type, keep_count = keep_mod[1], int(keep_mod[2:])
        if keep_count >= count: raise ValueError("保留的骰子数量必须小于总数量。")
        sorted_rolls = sorted(result_rolls)
        if keep_type == 'h':
            result_rolls = sorted_rolls[-keep_count:]
            calculation_steps.append(f"取最高 {keep_count} 个: {result_rolls}")
        else: # 'l'
            result_rolls = sorted_rolls[:keep_count]
            calculation_steps.append(f"取最低 {keep_count} 个: {result_rolls}")
        detailed_rolls["after_keep"] = result_rolls[:]

    if coc_mod:
        if sides != 100 or original_count != 1: raise ValueError("奖励/惩罚骰 (bp/pb) 仅适用于 1d100。")
        is_bonus, num_extra_dice = coc_mod.lower().startswith('bp'), int(coc_mod[2:] or 1)
        original_roll = rolls[0]
        units_digit = (original_roll - 1) % 10
        all_tens = [(original_roll - 1) // 10] + [random.randint(0, 9) for _ in range(num_extra_dice)]
        chosen_tens = min(all_tens) if is_bonus else max(all_tens)
        result_rolls = [chosen_tens * 10 + units_digit + 1]
        calculation_steps.append(f"{'奖励' if is_bonus else '惩罚'}骰 (十位): {all_tens} -> 取{'最小' if is_bonus else '最大'} {chosen_tens}")
        detailed_rolls["coc_dice"] = {"all_tens": all_tens, "chosen_tens": chosen_tens}

    total = sum(result_rolls)
    if arith_mod:
        # 处理多个加减项, e.g., +5-2
        modifiers = re.findall(r"([+-]\d+)", arith_mod)
        for mod in modifiers:
            total += int(mod)
            calculation_steps.append(f"修正: {mod}")

    final_result = {"expression": expression_str, "total": total, "rolls": detailed_rolls, "calculation_steps": calculation_steps, "sides": sides}
    
    if original_count == 1 and sides == 20 and not keep_mod and not is_pool:
        initial_roll = detailed_rolls["initial"][0]
        if initial_roll == 20: final_result["crit_status"] = "critical_success"
        elif initial_roll == 1: final_result["crit_status"] = "critical_failure"

    if check_or_pool_mod:
        op, target = re.match(r"([<>]=?)(\d+)", check_or_pool_mod).groups()
        target = int(target)
        if is_pool:
            successes = sum(1 for r in rolls if eval(f"{r}{op}{target}"))
            final_result.update({"dice_pool": {"successes": successes}, "total": successes})
            calculation_steps.append(f"骰池检定 (每个骰子 {op} {target}): {successes} 个成功")
        else:
            success = eval(f"{total}{op}{target}")
            final_result["success_check"] = {"is_success": success}
            calculation_steps.append(f"检定: {total} {op} {target} -> {'成功' if success else '失败'}")
    
    return final_result


# --- 格式化模块 ---

def format_dice_results(data, params):
    """
    统一格式化函数，兼容所有掷骰结果。
    """
    output_format = params.get('format', 'text')
    
    if data.get('is_repeat'):
        expression = data.get('expression')
        lines = [f"执行重复掷骰: **{expression}**"]
        for i, result in enumerate(data.get('results', [])):
            sub_format = format_dice_results(result, params)
            lines.append(f"第 {i+1} 次: {sub_format}")
        return "\n".join(lines)
    
    if data.get('is_complex_math'):
        result_line = f"掷骰: **{data['expression']}** = **{data['total']:.2f}**" if isinstance(data['total'], float) else f"掷骰: **{data['expression']}** = **{data['total']}**"
        details = "计算过程: " + " -> ".join(data.get('calculation_steps', []))
        return f"{result_line}\n`{details}`"
    
    return _format_single_roll(data, output_format)


def _format_single_roll(data, output_format):
    """格式化单个原子掷骰的结果。"""
    # 优先处理ASCII art
    if output_format == 'ascii' and data.get('sides') == 6 and data.get('rolls', {}).get('initial'):
        return _format_ascii_roll(data)
        
    expression = data.get('expression')
    total = data.get('total')
    
    # 对Fate骰和自定义骰面进行特殊格式化
    if isinstance(total, str):
         result_line = f"掷骰: **{expression}** = **{total}**"
    else:
        result_line = f"掷骰: **{expression}** = **{total}**"

    if data.get('success_check'):
        result_line += f" -> **{'成功' if data['success_check']['is_success'] else '失败'}**"
    elif data.get('dice_pool'):
        result_line = f"掷骰: **{expression}** = **{data['dice_pool']['successes']}** 个成功"
    
    if data.get('crit_status') == "critical_success": result_line += " **(暴击!)**"
    elif data.get('crit_status') == "critical_failure": result_line += " **(大失败!)**"
        
    details = "计算过程: " + " -> ".join(data.get('calculation_steps', []))
    return f"{result_line}\n`{details}`"


def _generate_ascii_d6(value):
    """生成单个D6骰子的ASCII艺术画"""
    templates = {
        1: ["       ", "   ●   ", "       "], 2: [" ●     ", "       ", "     ● "],
        3: [" ●     ", "   ●   ", "     ● "], 4: [" ●   ● ", "       ", " ●   ● "],
        5: [" ●   ● ", "   ●   ", " ●   ● "], 6: [" ●   ● ", " ●   ● ", " ●   ● "],
    }
    art = templates.get(value, ["       ", str(value).center(7), "       "])
    return ["┌───────┐", f"│{art[0]}│", f"│{art[1]}│", f"│{art[2]}│", "└───────┘"]


def _join_ascii_art(arts):
    """水平拼接多个ASCII艺术画"""
    if not arts: return ""
    lines = []
    for i in range(len(arts[0])):
        lines.append("  ".join(art[i] for art in arts))
    return "\n".join(lines)


def _format_ascii_roll(data):
    """格式化为ASCII艺术画输出"""
    initial_rolls = data.get('rolls', {}).get('initial', [])
    if not isinstance(initial_rolls, list) or not all(isinstance(r, int) for r in initial_rolls):
        return _format_single_roll(data, 'text')

    arts = [_generate_ascii_d6(roll) for roll in initial_rolls]
    art_str = _join_ascii_art(arts)
    
    result_line_with_details = _format_single_roll(data, 'text')
    
    return f"{result_line_with_details}\n{art_str}"