import re
import random

def roll_dice(params):
    """
    掷一个或多个骰子，支持复杂的TRPG风格的骰子表达式。
    支持的格式示例:
    - '2d6' (掷2个6面骰)
    - '4d6kh3' (掷4个6面骰，取最高的3个)
    - '1d20+5' (掷1个20面骰，结果加5)
    - '1d100<=75' (成功检定)
    - '1d100bp' (COC奖励骰)
    - '10d10>6' (骰池检定)
    - '3r2d6' (重复掷3次2d6)
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
    # 正则表达式，用于捕获所有部分
    # --- 解析表达式 ---
    # 首先检查自定义骰面格式
    custom_sides_match = re.match(r"(\d+)d\{(.+)\}", expression)
    if custom_sides_match:
        count = int(custom_sides_match.group(1))
        sides_str = custom_sides_match.group(2)
        custom_sides = [s.strip() for s in sides_str.split(',')]
        
        if count > 100: raise ValueError("骰子数量不能超过100。")

        rolls = [random.choice(custom_sides) for _ in range(count)]
        
        return {
            "expression": expression_str,
            "total": ", ".join(rolls), # 对于自定义骰面，总和就是结果的拼接
            "rolls": {"initial": rolls},
            "calculation_steps": [f"掷自定义骰: {rolls}"],
        }

    # 标准数字骰子格式
    pattern = re.compile(
        r"(\d+)d(\d+)"      # 1, 2: 主要骰子部分 (e.g., 4d6)
        r"(adv|dis)?"       # 3: D&D 优势/劣势
        r"(k[hl]\d+)?"      # 4: 保留最高/最低 (e.g., kh3)
        r"(s)?"             # 5: 排序标志 (e.g., s)
        r"([<>]=?\d+)?"     # 6: 成功检定或骰池 (e.g., <=75, >6)
        r"([+-]\d+)?"       # 7: 算术修正 (e.g., +5)
        r"(bp\d*|pb\d*)?"   # 8: COC 奖励/惩罚骰
    )
    match = pattern.match(expression)

    if not match:
        # 为 'd6' 或 'd20' 这样的简单格式提供兼容
        match_simple = re.match(r"d(\d+)", expression)
        if match_simple:
            expression = "1" + expression
            match = pattern.match(expression)
        else:
            raise ValueError(f"无效的骰子表达式: '{expression}'")

    groups = match.groups()
    
    count = int(groups[0])
    sides = int(groups[1])
    adv_mod = groups[2]
    keep_mod = groups[3]
    sort_flag = groups[4]
    check_or_pool_mod = groups[5]
    arith_mod = groups[6]
    coc_mod = groups[7]

    # 处理 adv/dis 语法糖
    if adv_mod:
        if count != 1 or sides != 20:
            raise ValueError("优势/劣势 (adv/dis) 仅适用于 1d20。")
        count = 2 # 掷两个d20
        keep_mod = "kh1" if adv_mod == "adv" else "kl1"
        calculation_steps = [f"掷骰 ({adv_mod}) -> 2d20"]
    else:
        calculation_steps = [f"掷骰 ({count}d{sides}): {rolls}"]

    # 判断是骰池还是成功检定
    is_pool = False
    if check_or_pool_mod and arith_mod is None and keep_mod is None:
        op_match = re.match(r"([<>]=?)(\d+)", check_or_pool_mod)
        if op_match:
            op, _ = op_match.groups()
            # 骰池通常只用 > 或 >=
            if op in ['>', '>=']:
                is_pool = True

    # --- 输入验证 ---
    if count <= 0 or sides <= 0 or count > 100: # 添加一个合理的上限
        raise ValueError("骰子数量和面数必须是正整数，且数量不能超过100。")

    # --- 掷骰 ---
    rolls = [random.randint(1, sides) for _ in range(count)]
    detailed_rolls = {"initial": rolls[:]}
    result_rolls = rolls[:]
    if not adv_mod:
        calculation_steps = [f"掷骰 ({count}d{sides}): {rolls}"]

    # --- 处理修饰符 ---

    # 排序 (Sort)
    if sort_flag:
        result_rolls.sort()
        calculation_steps.append(f"排序: {result_rolls}")
        detailed_rolls["after_sort"] = result_rolls[:]

    # 保留最高/最低 (Keep Highest/Lowest)
    if keep_mod:
        keep_type = keep_mod[1]
        keep_count = int(keep_mod[2:])
        if keep_count >= count:
            raise ValueError("保留的骰子数量必须小于总数量。")
        
        sorted_rolls = sorted(result_rolls)
        if keep_type == 'h':
            result_rolls = sorted_rolls[-keep_count:]
            calculation_steps.append(f"取最高 {keep_count} 个: {result_rolls}")
        else: # 'l'
            result_rolls = sorted_rolls[:keep_count]
            calculation_steps.append(f"取最低 {keep_count} 个: {result_rolls}")
        detailed_rolls["after_keep"] = result_rolls[:]

    # COC 奖励/惩罚骰 (Bonus/Penalty Dice)
    if coc_mod:
        if sides != 100 or count != 1:
            raise ValueError("奖励/惩罚骰 (bp/pb) 仅适用于 1d100。")
        
        is_bonus = coc_mod.startswith('bp')
        num_extra_dice = int(coc_mod[2:] or 1)
        
        original_roll = rolls[0]
        units_digit = (original_roll - 1) % 10
        original_tens = (original_roll - 1) // 10
        
        extra_tens = [random.randint(0, 9) for _ in range(num_extra_dice)]
        all_tens = [original_tens] + extra_tens
        
        if is_bonus:
            chosen_tens = min(all_tens)
            calc_str = f"奖励骰 (十位): {all_tens} -> 取最小 {chosen_tens}"
        else: # Penalty
            chosen_tens = max(all_tens)
            calc_str = f"惩罚骰 (十位): {all_tens} -> 取最大 {chosen_tens}"
            
        final_roll = chosen_tens * 10 + units_digit + 1
        result_rolls = [final_roll]
        detailed_rolls["coc_dice"] = {"original_tens": original_tens, "extra_tens": extra_tens, "chosen_tens": chosen_tens, "final_roll": final_roll}
        calculation_steps.append(calc_str)


    # --- 计算总和 ---
    total = sum(result_rolls)
    
    # 算术修正 (Arithmetic Modifier)
    modifier = 0
    if arith_mod:
        modifier = int(arith_mod)
        total += modifier
        calculation_steps.append(f"修正: {arith_mod}")

    # --- 构建最终结果 ---
    final_result = {
        "expression": expression,
        "total": total,
        "rolls": detailed_rolls,
        "calculation_steps": calculation_steps,
    }

    # 暴击/大失败判断 (Crit/Fumble Check)
    if count == 1 and sides == 20 and not keep_mod and not is_pool:
        initial_roll = detailed_rolls["initial"][0]
        if initial_roll == 20:
            final_result["crit_status"] = "critical_success"
            calculation_steps.append("暴击!")
        elif initial_roll == 1:
            final_result["crit_status"] = "critical_failure"
            calculation_steps.append("大失败!")

    # 成功检定或骰池 (Success Check or Dice Pool)
    if check_or_pool_mod:
        op_match = re.match(r"([<>]=?)(\d+)", check_or_pool_mod)
        op, target = op_match.groups()
        target = int(target)

        if is_pool:
            # --- 骰池逻辑 ---
            successes = 0
            if op == '>': successes = sum(1 for r in result_rolls if r > target)
            elif op == '>=': successes = sum(1 for r in result_rolls if r >= target)
            
            final_result["dice_pool"] = {
                "operator": op,
                "target": target,
                "successes": successes
            }
            final_result["total"] = successes # 骰池的结果是成功数
            calculation_steps.append(f"骰池检定 ({op}{target}): {successes} 个成功")
        else:
            # --- 成功检定逻辑 ---
            success = False
            if op == '<=': success = total <= target
            elif op == '>=': success = total >= target
            elif op == '<': success = total < target
            elif op == '>': success = total > target
            
            final_result["success_check"] = {
                "operator": op,
                "target": target,
                "is_success": success
            }
            calculation_steps.append(f"检定: {total} {op} {target} -> {'成功' if success else '失败'}")

    return final_result

def format_dice_results(data, params):
    # 处理重复掷骰的格式化
    if data.get('is_repeat'):
        expression = data.get('expression')
        results = data.get('results', [])
        
        lines = [f"执行重复掷骰: **{expression}**"]
        for i, result in enumerate(results):
            # 复用单次掷骰的格式化逻辑
            sub_format = format_single_roll(result)
            lines.append(f"第 {i+1} 次: {sub_format}")
        return "\n".join(lines)
    
    # 处理单次掷骰
    return format_single_roll(data)

def format_single_roll(data):
    """格式化单次掷骰的结果。"""
    expression = data.get('expression')
    total = data.get('total')
    steps = data.get('calculation_steps', [])
    
    result_line = f"掷骰: **{expression}** = **{total}**"
    
    success_check = data.get('success_check')
    dice_pool = data.get('dice_pool')
    crit_status = data.get('crit_status')

    if success_check:
        op = success_check['operator']
        target = success_check['target']
        success_str = "成功" if success_check['is_success'] else "失败"
        result_line += f" (检定: {total} {op} {target} -> **{success_str}**)"
    elif dice_pool:
        op = dice_pool['operator']
        target = dice_pool['target']
        successes = dice_pool['successes']
        result_line = f"掷骰: **{expression}** = **{successes}** 个成功"
    
    if crit_status == "critical_success":
        result_line += " **(暴击!)**"
    elif crit_status == "critical_failure":
        result_line += " **(大失败!)**"
        
    details = "计算过程: " + " -> ".join(steps)
    
    return f"{result_line}\n`{details}`"