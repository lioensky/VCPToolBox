# SciCalculator 插件 (科学计算器)

这是一个同步插件，提供强大的科学计算能力。它通过标准输入/输出（stdio）与一个 Python 脚本 ([`calculator.py`](Plugin/SciCalculator/calculator.py)) 进行交互，以安全地执行各种数学和科学计算任务。

## 功能

该计算器利用 Python 的 `ast` 模块来安全地解析和评估表达式，支持广泛的运算和函数：

*   **基础运算**: `+`, `-`, `*`, `/` (真除法), `//` (整除), `%` (取模), `**` (乘方), 一元负号 (`-x`)。
*   **常量**: `pi`, `e`。
*   **数学函数**:
    *   三角函数: `sin`, `cos`, `tan`, `asin`, `acos`, `atan` (以及别名 `arcsin`, `arccos`, `arctan`)
    *   双曲函数: `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`
    *   其他: `sqrt` (平方根), `root(x, n)` (n次方根), `log(x, [base])` (默认自然对数), `exp` (e^x), `abs` (绝对值), `ceil` (向上取整), `floor` (向下取整)。
*   **统计函数**:
    *   描述性统计: `mean`, `median`, `mode`, `variance`, `stdev` (需要列表作为输入, e.g., `mean([1, 2, 3])`)。
    *   概率分布: `norm_pdf(x, mean, std)`, `norm_cdf(x, mean, std)` (正态分布)。
    *   假设检验: `t_test([data], mu)` (单样本 t 检验, 返回 p 值)。
*   **微积分**:
    *   **定积分**: `integral('expression_string', lower_bound, upper_bound)`。使用 `sympy` 进行符号积分，如果失败或结果包含无穷大/复数，则尝试使用 `scipy.integrate.quad` 进行数值积分。上下限可以是数字或字符串 `'-inf'`, `'inf'`。
    *   **不定积分**: `integral('expression_string')`。返回结果的 LaTeX 格式字符串，例如 `$$ -\\cos{\\left(x \\right)} + C $$`。
    *   **注意**: 微积分函数的第一个参数（表达式字符串）**必须**用单引号或双引号包裹。
*   **误差传递**: `error_propagation('expression_string', {'var1':(value, error), 'var2':(value, error), ...})`。计算基于给定变量及其误差的表达式结果的总误差。
*   **置信区间**: `confidence_interval([data_list], confidence_level)`。计算给定数据样本均值的置信区间（使用 t 分布）。

## 工作方式

1.  插件管理器（例如 Plugin.js）通过 `stdio` 启动 `python calculator.py` 进程。
2.  管理器将需要计算的数学表达式作为单行文本发送到脚本的标准输入。
3.  [`calculator.py`](Plugin/SciCalculator/calculator.py) 读取表达式，使用 `ast` 安全解析，并调用相应的数学库 (`math`, `statistics`, `sympy`, `scipy`, `numpy`) 进行计算。
4.  脚本将计算结果或错误信息封装成 JSON 对象写入标准输出。
    *   成功: `{"status": "success", "result": "###计算结果：<计算结果或LaTeX字符串>###，请将结果转告用户"}`
    *   失败: `{"status": "error", "error": "<错误信息>"}`
5.  插件管理器读取 JSON 输出并处理结果。

## 依赖

*   **Python**: 版本 >= 3.7
*   **Python 库**:
    *   `sympy`
    *   `scipy`
    *   `numpy`
    (这些库在 [`requirements.txt`](Plugin/SciCalculator/requirements.txt) 中列出，可以使用 `pip install -r requirements.txt` 安装。)

## 使用说明 (供 AI 参考)

AI 助手需要按照 [`plugin-manifest.json`](Plugin/SciCalculator/plugin-manifest.json) 中 `invocationCommands` 定义的特定格式来请求此工具。这确保了表达式被正确传递给插件。

**关键点**:

*   整个请求需要包含在 `<<<[TOOL_REQUEST]>>>` 和 `<<<[END_TOOL_REQUEST]>>>` 标记之间。
*   `tool_name` 必须是 `SciCalculator`。
*   `expression` 字段包含要计算的完整表达式。
*   所有参数值（包括工具名和表达式本身）都必须用 `「始」` 和 `「末」` 包裹。
*   当表达式包含字符串参数时（如 `integral` 或 `error_propagation` 的第一个参数），这些字符串必须在表达式内部使用单引号或双引号包裹。

**示例请求格式**:

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」SciCalculator「末」,
expression:「始」integral('sin(x)*exp(-x)', 0, 'inf')「末」
<<<[END_TOOL_REQUEST]>>>
```

## 错误处理

脚本包含错误处理机制，可以捕获：

*   语法错误 (无效的表达式)。
*   计算错误 (例如，除以零，无效的函数参数，积分不收敛)。
*   值错误 (例如，使用了不支持的变量或函数)。

错误信息会包含在输出 JSON 的 `error` 字段中。