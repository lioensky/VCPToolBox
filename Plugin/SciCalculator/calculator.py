import ast
import operator
import math
import statistics
import sys # 新增：用于 stdin, stdout, stderr
from typing import Union, Dict, Tuple
# from mcp.server.fastmcp import FastMCP # 移除MCP
from sympy import sympify, Symbol, integrate, diff, sin, cos, pi as sympy_pi, atan, asin, acos, sqrt, latex, sinh, cosh, tanh, asinh, acosh, atanh, oo as sympy_inf
from scipy import stats
from scipy.integrate import quad
from numpy import inf as numpy_inf

# 支持的操作符 (保持不变)
allowed_operators = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod,
    ast.Pow: operator.pow, ast.USub: operator.neg,
}

# 支持的数学和统计函数 (保持不变)
math_functions = {
    'sin': math.sin, 'cos': math.cos, 'tan': math.tan, 'asin': math.asin,
    'acos': math.acos, 'atan': math.atan, 'arctan': math.atan, 'arcsin': math.asin,
    'arccos': math.acos, 'sinh': math.sinh, 'cosh': math.cosh, 'tanh': math.tanh,
    'asinh': math.asinh, 'acosh': math.acosh, 'atanh': math.atanh,
    'sqrt': lambda x: math.sqrt(x), 'root': lambda x, n: x ** (1 / n),
    'log': math.log, 'exp': math.exp, 'abs': math.fabs, 'ceil': math.ceil,
    'floor': math.floor, 'mean': statistics.mean, 'median': statistics.median,
    'mode': statistics.mode, 'variance': statistics.variance, 'stdev': statistics.stdev,
    'norm_pdf': stats.norm.pdf, 'norm_cdf': stats.norm.cdf,
    't_test': lambda data, mu: stats.ttest_1samp(data, mu).pvalue,
}

# 支持的常数 (保持不变)
constants = { 'pi': math.pi, 'e': math.e }

def evaluate(expression: str) -> str:
    """Evaluate a mathematical, statistical, or integral expression with numerical results."""
    
    def eval_expr(node) -> Union[float, int, list, dict, tuple]:
        if isinstance(node, ast.Constant):
            return node.value
        elif isinstance(node, ast.Name):
            if node.id in constants: return constants[node.id]
            if node.id == 'inf': return float('inf')
            # Sympy symbols like 'x' will be handled by sympify if part of an integral expression string
            raise ValueError(f"Unsupported variable or constant: {node.id}")
        elif isinstance(node, ast.BinOp):
            left = eval_expr(node.left)
            right = eval_expr(node.right)

            # If left or right is a string, it indicates an error or an unprocessable symbolic result
            # from a sub-expression (e.g., an indefinite integral's LaTeX string, or an error message from compute_integral).
            # We cannot perform further arithmetic operations with such strings.
            if isinstance(left, str):
                raise ValueError(f"Left operand for '{type(node.op).__name__}' operation resolved to a non-numeric string: '{left}'")
            if isinstance(right, str):
                raise ValueError(f"Right operand for '{type(node.op).__name__}' operation resolved to a non-numeric string: '{right}'")

            # Ensure both operands are numeric at this point.
            # This check is somewhat redundant if the string checks above are comprehensive,
            # but provides an additional safeguard.
            if not (isinstance(left, (int, float)) and isinstance(right, (int, float))):
                raise ValueError(f"Operands for '{type(node.op).__name__}' must be numeric, but got {type(left).__name__} and {type(right).__name__}")

            if type(node.op) in allowed_operators:
                return allowed_operators[type(node.op)](left, right)
            raise ValueError(f"Unsupported binary operation: {type(node.op).__name__}")
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            return -eval_expr(node.operand)
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            func_name = node.func.id
            args = [eval_expr(arg) for arg in node.args]
            
            # Special handling for functions that take string expressions (like integral)
            if func_name == 'integral':
                if not (1 <= len(args) <= 3 or len(args) == 5) : # Check for valid arg counts
                     raise ValueError("integral() syntax: integral('expr_str'), integral('expr_str', lower, upper) or integral('expr_str', var1_lower, var1_upper, var2_lower, var2_upper)")
                
                expr_str_arg = args[0]
                if not isinstance(expr_str_arg, str):
                    raise ValueError("First argument to integral() must be a string expression (e.g., 'sin(x)').")

                if len(args) == 1: return compute_integral(expr_str_arg, None, None)
                if len(args) == 3: return compute_integral(expr_str_arg, args[1], args[2])
                # For 2D integral, we assume args are (expr_str, x_lower, x_upper, y_lower, y_upper)
                # and compute_integral needs to be adapted or a new function created if 2D is kept.
                # For now, simplifying to 1D definite/indefinite.
                # if len(args) == 5: return compute_integral(expr_str_arg, (args[1], args[2]), (args[3], args[4])) 
                raise ValueError("Integral with 5 arguments (2D) not fully supported in this simplified version yet.")


            elif func_name == 'error_propagation':
                if len(args) != 2 or not isinstance(args[0], str) or not isinstance(args[1], dict):
                    raise ValueError("error_propagation() requires expr_str, {var: (value, error)}")
                return compute_error_propagation(args[0], args[1])
            elif func_name == 'confidence_interval':
                if len(args) < 2:
                    raise ValueError("confidence_interval() requires data_list and confidence_level")
                return compute_confidence_interval(args[0], args[1], args[2] if len(args) > 2 else None)
            elif func_name in math_functions:
                if func_name == 'log' and len(args) == 2: return math_functions[func_name](args[0], args[1])
                if func_name == 'root' and len(args) == 2: return math_functions[func_name](args[0], args[1])
                if func_name in ['mean', 'median', 'mode', 'variance', 'stdev', 't_test']:
                    if not isinstance(args[0], list): raise ValueError(f"{func_name} requires a list input")
                    return math_functions[func_name](*args)
                if func_name in ['norm_pdf', 'norm_cdf']:
                    if len(args) != 3: raise ValueError(f"{func_name} requires x, mean, std")
                    return math_functions[func_name](args[0], loc=args[1], scale=args[2])
                if len(args) == 1: return math_functions[func_name](args[0])
                raise ValueError(f"Invalid arguments for {func_name}")
            raise ValueError(f"Unsupported function: {func_name}")
        elif isinstance(node, ast.List): return [eval_expr(elt) for elt in node.elts]
        elif isinstance(node, ast.Dict): return {eval_expr(k): eval_expr(v) for k, v in zip(node.keys, node.values)}
        elif isinstance(node, ast.Tuple): return tuple(eval_expr(elt) for elt in node.elts)
        raise ValueError(f"Unsupported AST node: {type(node).__name__}")

    def compute_integral(expr_str: str, lower: Union[float, None], upper: Union[float, None]) -> Union[float, str]: # Allow returning float or error string
        try:
            x = Symbol('x')
            # Ensure common math functions are available to sympify
            local_dict = {
                'sin': sin, 'cos': cos, 'tan': atan, 'asin': asin, 'acos': acos, 'atan': atan,
                'arctan': atan, 'arcsin': asin, 'arccos': acos, 'sqrt': sqrt, 'exp': math.exp, # sympy's exp is different
                'log': math.log, # sympy's log is different for base
                'pi': sympy_pi, 'e': math.e,
                'sinh': sinh, 'cosh': cosh, 'tanh': tanh,
                'asinh': asinh, 'acosh': acosh, 'atanh': atanh
            }
            expr = sympify(expr_str, locals=local_dict)
            
            if lower is None and upper is None:  # Indefinite integral
                result = integrate(expr, x)
                # For indefinite integral, we can't return a simple float.
                # This case needs careful handling if it's part of a larger expression.
                # For now, if it's an indefinite integral, we'll return its LaTeX string representation.
                # The calling eval_expr will need to handle this if it's not the top-level operation.
                return f"$$ {latex(result)} + C $$"
            else:  # Definite integral
                # Convert string 'inf', '-inf' to sympy infinity
                if isinstance(lower, str):
                    if lower.lower() == 'inf': lower = sympy_inf
                    elif lower.lower() == '-inf': lower = -sympy_inf
                if isinstance(upper, str):
                    if upper.lower() == 'inf': upper = sympy_inf
                    elif upper.lower() == '-inf': upper = -sympy_inf

                result = integrate(expr, (x, lower, upper))
                if result.has(sympy_inf, -sympy_inf) or not result.is_real: # Check for non-convergence or complex
                    # Attempt numerical integration as fallback if symbolic result is complex or infinity
                    def f_for_quad(x_val):
                        # Substitute and evaluate, ensuring it's float for quad
                        try: return float(expr.subs(x, x_val).evalf())
                        except: return float('nan') # Return NaN on evaluation error for robust quad

                    quad_lower = -numpy_inf if lower == -sympy_inf else (numpy_inf if lower == sympy_inf else float(lower))
                    quad_upper = -numpy_inf if upper == -sympy_inf else (numpy_inf if upper == sympy_inf else float(upper))
                    
                    try:
                        numeric_result, num_error = quad(f_for_quad, quad_lower, quad_upper, limit=100, epsabs=1.49e-05, epsrel=1.49e-05)
                        if abs(num_error) > 0.1 * abs(numeric_result) and abs(num_error) > 1e-3 : # If error is significant
                             # Return a string error, or raise an exception
                             return f"Numerical integral result {numeric_result:.6g} with large error {num_error:.2g}. Symbolic: {latex(result)}"
                        return float(numeric_result) # Return float for successful numerical integration
                    except Exception as quad_e:
                        # Return a string error, or raise an exception
                        return f"Symbolic: {latex(result)}. Numerical integration failed: {str(quad_e)}"
                else: # Symbolic result is real and finite
                    numeric_result = result.evalf()
                    return float(numeric_result) # Return float
        except Exception as e:
            return f"Error in integral: {str(e)}" # Return error string

    def compute_error_propagation(expr_str: str, vars_errors: Dict[str, Tuple[float, float]]) -> str:
        try:
            expr = sympify(expr_str)
            total_error_sq = 0
            subs_dict = {Symbol(k): v[0] for k, v in vars_errors.items()}
            for var_name, (value, error) in vars_errors.items():
                s_var = Symbol(var_name)
                partial_derivative = diff(expr, s_var)
                partial_derivative_val = partial_derivative.subs(subs_dict)
                total_error_sq += (partial_derivative_val * error)**2
            final_error = sqrt(total_error_sq).evalf()
            return f"{float(final_error):.6f}".rstrip('0').rstrip('.')
        except Exception as e:
            return f"Error in error_propagation: {str(e)}"

    def compute_confidence_interval(data: list, confidence_level: float, population_mean: float = None) -> str:
        try:
            n = len(data)
            if n < 2: return "Error: Data sample too small for confidence interval."
            sample_mean = statistics.mean(data)
            sample_std = statistics.stdev(data) if n > 1 else 0
            
            # If population_mean is provided, it's more like a z-interval or t-interval around a known mean,
            # but the typical CI is for an unknown population mean based on sample.
            # Assuming standard CI for the sample mean:
            alpha = 1 - confidence_level
            # Use t-distribution for sample standard deviation
            t_critical = stats.t.ppf(1 - alpha / 2, df=n - 1)
            margin_of_error = t_critical * (sample_std / math.sqrt(n))
            
            lower_bound = sample_mean - margin_of_error
            upper_bound = sample_mean + margin_of_error
            return f"[{float(lower_bound):.6f}, {float(upper_bound):.6f}]"
        except Exception as e:
            return f"Error in confidence_interval: {str(e)}"

    try:
        # Ensure expression is a string, as it comes from stdin
        expression_str = str(expression).strip()
        if not expression_str:
            raise ValueError("Expression cannot be empty.")
            
        # For integral, error_propagation, confidence_interval, the expression itself might contain quotes
        # The main parsing is for basic math. These functions handle their string sub-expressions internally.
        # We need to identify if it's a direct call to one of these complex functions first.
        # This is a simplification; a more robust parser would be better.
        
        # Attempt to parse simple function calls or direct evaluations
        # This simple check might not be robust enough for all cases.
        # e.g. "integral('sin(x)', 0, pi)" should be handled by eval_expr calling compute_integral.
        
        parsed_expr = ast.parse(expression_str, mode='eval')
        result = eval_expr(parsed_expr.body) # This might be a float or a string (e.g. from indefinite integral)
        
        # If the result from eval_expr is already a string (e.g. LaTeX from indefinite integral or an error message), return it as is.
        if isinstance(result, str):
            return result
        
        if isinstance(result, float):
            # Format float to a reasonable number of decimal places, remove trailing zeros
            return f"{result:.10g}".rstrip('0').rstrip('.') if '.' in f"{result:.10g}" else f"{result:.0f}"
        # For other numerical types like int
        return str(result)
    except SyntaxError as se:
        return f"Syntax Error: Invalid mathematical expression. Details: {str(se)}"
    except ValueError as ve: # Catch specific ValueErrors from our logic
        return f"Input Error: {str(ve)}"
    except Exception as e:
        # Generic error for anything else
        return f"Calculation Error: {str(e)}"

import json # 新增：用于输出 JSON

def main():
    expression_input = sys.stdin.readline().strip()
    output = {}
    if not expression_input:
        output = {"status": "error", "error": "SciCalculator Plugin Error: No expression provided."}
        print(json.dumps(output), file=sys.stdout) # 输出 JSON 到 stdout
        sys.exit(1) # 仍然用 exit code 1 表示错误
        return

    result_str = evaluate(expression_input) # evaluate 返回的是字符串

    # evaluate 函数内部已经将错误信息格式化为 "Error: ..." 或 "Syntax Error: ..." 等
    if result_str.startswith("Error:") or \
       result_str.startswith("Syntax Error:") or \
       result_str.startswith("Input Error:") or \
       result_str.startswith("Calculation Error:"):
        output = {"status": "error", "error": result_str}
        print(json.dumps(output), file=sys.stdout)
        sys.exit(1)
    else:
        # SciCalculator 的 manifest 中定义的 responseFormatToAI 是 "###计算结果：{result}###"
        # 我们在这里直接应用这个格式，或者让 Plugin.js 来处理
        # 根据新的架构，插件自身应该完成最终面向AI的文本构建
        # 注意：原始的 "，请将结果转告用户" 后缀是在 server.js 中添加的，现在也移到这里
        formatted_result_for_ai = f"###计算结果：{result_str}###，请将结果转告用户"
        output = {"status": "success", "result": formatted_result_for_ai}
        print(json.dumps(output), file=sys.stdout)
        sys.exit(0)

if __name__ == "__main__":
    # Test cases (optional, can be removed for production plugin)
    # print(f"Test '1+1': {evaluate('1+1')}")
    # print(f"Test 'sin(pi/2)': {evaluate('sin(pi/2)')}")
    # print(f"Test 'integral(\"x^2\", 0, 1)': {evaluate('integral(\"x^2\", 0, 1)')}") # Note: string literal for expr
    # print(f"Test 'integral(\"sin(x)\")': {evaluate('integral(\"sin(x)\")')}")
    # print(f"Test 'log(100, 10)': {evaluate('log(100,10)')}")
    # print(f"Test 'mean([1,2,3,4,5])': {evaluate('mean([1,2,3,4,5])')}")
    # print(f"Test '1/0': {evaluate('1/0')}") # Error test
    # print(f"Test 'sqrt(-1)': {evaluate('sqrt(-1)')}") # Error test
    # print(f"Test 'integral(\"1/x\", -1, 1)': {evaluate('integral(\"1/x\", -1, 1)')}") # Error test (divergent)
    main()