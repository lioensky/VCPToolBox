import ast
import operator
import math
import statistics
import sys # 用于 stdin, stdout, stderr
from typing import Union, Dict, Tuple

import sympy # 导入 sympy 模块本身
# SymPy imports
from sympy import (
    sympify, Symbol, integrate, diff, sin, cos, tan, pi as sympy_pi,
    atan, asin, acos, sqrt, exp as sympy_exp, log as sympy_log, E as sympy_E,
    sinh, cosh, tanh, asinh, acosh, atanh, oo as sympy_inf,
    Integral as SympyIntegral, I as sympy_I, zoo as sympy_zoo, nan as sympy_nan_symbol, # I, zoo, nan for checking
    latex # 确保 latex 被导入
)
from scipy import stats
from scipy.integrate import quad
from numpy import inf as numpy_inf, nan as numpy_nan # For numerical integration with quad

# 支持的操作符 (保持不变)
allowed_operators = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod,
    ast.Pow: operator.pow, ast.USub: operator.neg,
}

# 支持的数学和统计函数 (保持不变, 这些是用于直接数值计算的)
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

    def compute_integral(expr_str: str, lower_limit_in, upper_limit_in) -> Union[float, str]:
        try:
            var_symbol = Symbol('x')
            sympy_locals = {
                'sin': sympy.sin, 'cos': sympy.cos, 'tan': sympy.tan,
                'asin': sympy.asin, 'acos': sympy.acos, 'atan': sympy.atan,
                'arctan': sympy.atan, 'arcsin': sympy.asin, 'arccos': sympy.acos,
                'sqrt': sympy.sqrt, 'exp': sympy_exp, 'log': sympy_log,
                'pi': sympy_pi, 'e': sympy_E,
                'sinh': sympy.sinh, 'cosh': sympy.cosh, 'tanh': sympy.tanh,
                'asinh': sympy.asinh, 'acosh': sympy.acosh, 'atanh': sympy.atanh,
            }
            expr = sympify(expr_str, locals=sympy_locals)

            if lower_limit_in is None and upper_limit_in is None:  # Indefinite integral
                result = integrate(expr, var_symbol)
                return f"$$ {latex(result)} + C $$"
            else:  # Definite integral
                def standardize_limit(lim_val):
                    if isinstance(lim_val, str):
                        if lim_val.lower() == 'inf': return sympy_inf
                        if lim_val.lower() == '-inf': return -sympy_inf
                        try:
                            return sympify(lim_val, locals=sympy_locals).evalf()
                        except Exception as e_sympify_lim:
                            raise ValueError(f"Invalid string limit value '{lim_val}': {e_sympify_lim}")
                    elif lim_val == float('inf'): return sympy_inf
                    elif lim_val == float('-inf'): return -sympy_inf
                    elif isinstance(lim_val, (int, float)): return lim_val
                    else:
                        try:
                            return sympify(str(lim_val), locals=sympy_locals)
                        except Exception as e_sympify_lim_other:
                             raise ValueError(f"Invalid limit type '{type(lim_val).__name__}' for value '{lim_val}': {e_sympify_lim_other}")

                sympy_lower = standardize_limit(lower_limit_in)
                sympy_upper = standardize_limit(upper_limit_in)

                result = integrate(expr, (var_symbol, sympy_lower, sympy_upper))
                
                is_unevaluated_integral = isinstance(result, SympyIntegral)
                has_problematic_symbols = result.has(sympy_inf, -sympy_inf, sympy_I, sympy_zoo, sympy_nan_symbol)
                is_not_real_or_complex = (result.is_real is False) or \
                                         (hasattr(result, 'is_complex') and result.is_complex is True and not result.is_real)

                if is_unevaluated_integral or has_problematic_symbols or is_not_real_or_complex:
                    def f_for_quad(x_val_np):
                        try:
                            substituted = expr.subs(var_symbol, x_val_np)
                            val_sympy = substituted.evalf(chop=True)

                            if not val_sympy.is_number:
                                return numpy_nan
                            if hasattr(val_sympy, 'is_infinite') and val_sympy.is_infinite:
                                return numpy_inf if val_sympy.is_positive else -numpy_inf
                            if hasattr(val_sympy, 'is_NaN') and val_sympy.is_NaN:
                                return numpy_nan
                            if not val_sympy.is_real:
                                real_part, imag_part = val_sympy.as_real_imag()
                                if abs(imag_part.evalf()) < 1e-9:
                                    return float(real_part.evalf())
                                else:
                                    return numpy_nan
                            return float(val_sympy)
                        except Exception:
                            return numpy_nan

                    q_lower_eval = sympy_lower.evalf() if hasattr(sympy_lower, 'evalf') else sympy_lower
                    q_upper_eval = sympy_upper.evalf() if hasattr(sympy_upper, 'evalf') else sympy_upper
                    q_lower = -numpy_inf if q_lower_eval == -sympy_inf else (numpy_inf if q_lower_eval == sympy_inf else float(q_lower_eval))
                    q_upper = -numpy_inf if q_upper_eval == -sympy_inf else (numpy_inf if q_upper_eval == sympy_inf else float(q_upper_eval))
                    
                    if q_lower >= q_upper and not (q_lower == numpy_inf and q_upper == numpy_inf) and not (q_lower == -numpy_inf and q_upper == -numpy_inf) :
                         return f"Numerical integration error: lower limit {q_lower} must be less than upper limit {q_upper}. Symbolic: {latex(result)}"

                    try:
                        numeric_result_val, num_error = quad(f_for_quad, q_lower, q_upper, limit=100, epsabs=1.49e-06, epsrel=1.49e-06)
                        if math.isnan(numeric_result_val): # CORRECTED: Use math.isnan for float results from quad
                             return f"Numerical integration resulted in NaN. Symbolic: {latex(result)}"
                        if abs(num_error) > 0.01 * abs(numeric_result_val) and abs(num_error) > 1e-4 :
                            return f"Numerical integral {numeric_result_val:.6g} with potentially large error {num_error:.2g}. Symbolic: {latex(result)}"
                        return float(numeric_result_val)
                    except Exception as quad_e:
                        return f"Symbolic: {latex(result)}. Numerical integration failed: {str(quad_e)}"
                else: 
                    numeric_result_sympy = result.evalf(chop=True)
                    if (hasattr(numeric_result_sympy, 'is_infinite') and numeric_result_sympy.is_infinite) or \
                       (hasattr(numeric_result_sympy, 'is_real') and not numeric_result_sympy.is_real) or \
                       (hasattr(numeric_result_sympy, 'is_NaN') and numeric_result_sympy.is_NaN):
                        return f"Symbolic result {latex(result)} evaluated to non-finite/non-real {latex(numeric_result_sympy)}. Cannot convert to float."
                    return float(numeric_result_sympy)
        except ValueError as ve:
            return f"Error in integral setup: {str(ve)}"
        except Exception as e:
            return f"Error in integral computation: {str(e)}"


    def eval_expr(node) -> Union[float, int, list, dict, tuple, str]:
        if isinstance(node, ast.Constant):
            return node.value
        elif isinstance(node, ast.Name):
            if node.id in constants: return constants[node.id]
            if node.id.lower() == 'inf': return float('inf')
            if node.id.lower() == '-inf': return float('-inf')
            raise ValueError(f"Unsupported variable or constant: {node.id}")
        elif isinstance(node, ast.BinOp):
            left = eval_expr(node.left)
            right = eval_expr(node.right)
            if isinstance(left, str) or isinstance(right, str):
                raise ValueError(f"Cannot perform arithmetic operation '{type(node.op).__name__}' with non-numeric string operands: '{left}', '{right}'")
            if not (isinstance(left, (int, float)) and isinstance(right, (int, float))):
                raise ValueError(f"Operands for '{type(node.op).__name__}' must be numeric, got {type(left).__name__} and {type(right).__name__}")
            if type(node.op) in allowed_operators:
                return allowed_operators[type(node.op)](left, right)
            raise ValueError(f"Unsupported binary operation: {type(node.op).__name__}")
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            operand_val = eval_expr(node.operand)
            if isinstance(operand_val, str):
                 raise ValueError(f"Cannot apply unary minus to non-numeric string operand: '{operand_val}'")
            return -operand_val
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            func_name = node.func.id
            
            if func_name == 'integral':
                if not (1 <= len(node.args) <= 3):
                     raise ValueError("integral() syntax: integral('expr_str'), or integral('expr_str', lower, upper)")
                if not (isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
                    raise ValueError("First argument to integral() must be a string expression (e.g., 'sin(x)').")
                expr_str_arg = node.args[0].value
                args_processed = [expr_str_arg]
                for arg_node in node.args[1:]:
                    args_processed.append(eval_expr(arg_node))
                if len(args_processed) == 1: return compute_integral(args_processed[0], None, None)
                if len(args_processed) == 3: return compute_integral(args_processed[0], args_processed[1], args_processed[2])
                raise ValueError("Internal error: Integral argument processing failed.")

            args = [eval_expr(arg) for arg in node.args]
            
            if func_name == 'error_propagation':
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
        elif isinstance(node, ast.Dict): 
            keys = [eval_expr(k) for k in node.keys]
            values = [eval_expr(v) for v in node.values]
            return dict(zip(keys, values))
        elif isinstance(node, ast.Tuple): return tuple(eval_expr(elt) for elt in node.elts)
        raise ValueError(f"Unsupported AST node: {type(node).__name__}")

    def compute_error_propagation(expr_str: str, vars_errors: Dict[str, Tuple[float, float]]) -> str:
        try:
            symbols_map = {}
            subs_dict_val_err = {}
            for var_name, (value, error) in vars_errors.items():
                if not isinstance(var_name, str):
                    return "Error in error_propagation: Variable names must be strings."
                if not (isinstance(value, (int, float)) and isinstance(error, (int, float))):
                     return f"Error in error_propagation: Value and error for '{var_name}' must be numeric."
                symbols_map[var_name] = Symbol(var_name)
                subs_dict_val_err[symbols_map[var_name]] = (float(value), float(error))

            sympy_locals_prop = {
                'sin': sympy.sin, 'cos': sympy.cos, 'tan': sympy.tan, 'sqrt': sympy.sqrt,
                'exp': sympy_exp, 'log': sympy_log, 'pi': sympy_pi, 'e': sympy_E,
                'asin': sympy.asin, 'acos': sympy.acos, 'atan': sympy.atan,
                'sinh': sympy.sinh, 'cosh': sympy.cosh, 'tanh': sympy.tanh,
                'asinh': sympy.asinh, 'acosh': sympy.acosh, 'atanh': sympy.atanh,
            }
            sympy_locals_prop.update({k: v for k,v in symbols_map.items()})
            expr = sympify(expr_str, locals=sympy_locals_prop)
            total_error_sq = sympy.S.Zero # Using sympy.S.Zero for symbolic zero
            subs_values_only = {s: val_err[0] for s, val_err in subs_dict_val_err.items()}

            for s_var, (value, error) in subs_dict_val_err.items():
                partial_derivative = diff(expr, s_var)
                partial_derivative_val = partial_derivative.subs(subs_values_only)
                if not partial_derivative_val.is_number:
                    return f"Error in error_propagation: Partial derivative for {s_var} is not numeric: {latex(partial_derivative_val)}"
                total_error_sq += (partial_derivative_val * error)**2
            
            final_error_sympy = sympy.sqrt(total_error_sq)
            if not final_error_sympy.is_number:
                 return f"Error in error_propagation: Final error calculation resulted in non-numeric expression: {latex(final_error_sympy)}"
            final_error_val = final_error_sympy.evalf()
            expr_val_sympy = expr.subs(subs_values_only)
            if not expr_val_sympy.is_number:
                return f"Error in error_propagation: Expression value is not numeric: {latex(expr_val_sympy)}"
            expr_val = expr_val_sympy.evalf()
            return f"Value = {float(expr_val):.7g}, Error = {float(final_error_val):.4g}"
        except Exception as e:
            return f"Error in error_propagation: {str(e)}"

    def compute_confidence_interval(data: list, confidence_level: float, population_mean: float = None) -> str:
        try:
            if not isinstance(data, list) or not all(isinstance(x, (int, float)) for x in data):
                return "Error: Data for confidence_interval must be a list of numbers."
            if not isinstance(confidence_level, (int, float)) or not (0 < confidence_level < 1):
                return "Error: Confidence level must be a number between 0 and 1."
            n = len(data)
            if n < 2: return "Error: Data sample too small for confidence interval (need at least 2 points)."
            sample_mean = statistics.mean(data)
            sample_std = statistics.stdev(data)
            alpha = 1 - confidence_level
            t_critical = stats.t.ppf(1 - alpha / 2, df=n - 1)
            margin_of_error = t_critical * (sample_std / math.sqrt(n))
            lower_bound = sample_mean - margin_of_error
            upper_bound = sample_mean + margin_of_error
            return f"[{float(lower_bound):.6g}, {float(upper_bound):.6g}] ({(confidence_level*100):.0f}% CI)"
        except Exception as e:
            return f"Error in confidence_interval: {str(e)}"

    try:
        expression_str_input = str(expression).strip()
        if not expression_str_input:
            raise ValueError("Expression cannot be empty.")
        parsed_expr = ast.parse(expression_str_input, mode='eval')
        result = eval_expr(parsed_expr.body)
        
        if isinstance(result, str):
            return result
        if isinstance(result, float):
            if math.isinf(result) or math.isnan(result): # math.isnan for regular floats
                return str(result)
            formatted_float = f"{result:.10g}"
            if '.' in formatted_float:
                formatted_float = formatted_float.rstrip('0').rstrip('.')
            return formatted_float
        return str(result)
    except SyntaxError as se:
        return f"Syntax Error: Invalid mathematical expression. Details: {str(se)}"
    except ValueError as ve:
        return f"Input Error: {str(ve)}"
    except ZeroDivisionError:
        return "Error: Division by zero."
    except OverflowError:
        return "Error: Numerical result out of range (overflow)."
    except Exception as e:
        return f"Calculation Error: An unexpected error occurred. ({type(e).__name__}: {str(e)})"

import json

def main():
    expression_input = sys.stdin.readline().strip()
    output = {}
    if not expression_input:
        output = {"status": "error", "error": "SciCalculator Plugin Error: No expression provided."}
        print(json.dumps(output), file=sys.stdout)
        sys.exit(1)
        return

    result_str = evaluate(expression_input)
    error_prefixes = ("Error:", "Syntax Error:", "Input Error:", "Calculation Error:", "Warning:")
    if result_str.startswith(error_prefixes):
        output = {"status": "error", "error": result_str}
        print(json.dumps(output), file=sys.stdout)
        sys.exit(1)
    else:
        formatted_result_for_ai = f"###计算结果：{result_str}###，请将结果转告用户"
        output = {"status": "success", "result": formatted_result_for_ai}
        print(json.dumps(output), file=sys.stdout)
        sys.exit(0)

if __name__ == "__main__":
    # Test cases
    # print(f"Test 'integral(\"x^2\", 0, 1)': {evaluate('integral(\"x^2\", 0, 1)')}") # Expected: 0.3333333333
    # print(f"Test 'integral(\"exp(-x**2)\", \"-inf\", \"inf\")': {evaluate('integral(\"exp(-x**2)\", \"-inf\", \"inf\")')}") # Expected: 1.772453851 (sqrt(pi))
    main()
