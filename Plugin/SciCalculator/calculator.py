import ast
import operator
import math
import statistics
import sys # 用于 stdin, stdout, stderr
from typing import Union, Dict, Tuple, Any, List

import sympy # 导入 sympy 模块本身
# SymPy imports
from sympy import (
    sympify, Symbol, integrate, diff, sin, cos, tan, pi as sympy_pi,
    atan, asin, acos, sqrt, exp as sympy_exp, log as sympy_log, E as sympy_E, Abs,
    sinh, cosh, tanh, asinh, acosh, atanh, oo as sympy_inf,
    Integral as SympyIntegral, I as sympy_I, zoo as sympy_zoo, nan as sympy_nan_symbol, # I, zoo, nan for checking
    latex, Add, Mul, Pow, Integer, Float, Rational, Function, Number # Added Number
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

# 支持的数学和统计函数 (用于直接数值计算)
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

# 支持的常数 (用于直接数值计算)
constants = { 'pi': math.pi, 'e': math.e }

# 基础的 SymPy 符号和函数，用于符号计算
base_sympy_locals = {
    'sin': sympy.sin, 'cos': sympy.cos, 'tan': sympy.tan,
    'asin': sympy.asin, 'acos': sympy.acos, 'atan': sympy.atan, 'atan2': sympy.atan2,
    'arctan': sympy.atan, 'arcsin': sympy.asin, 'arccos': sympy.acos,
    'sqrt': sympy.sqrt, 'exp': sympy_exp, 'E': sympy_E, 'log': sympy_log, 
    'abs': Abs, 'Abs': Abs, 
    'pi': sympy_pi, 'I': sympy_I, 'oo': sympy_inf, 'zoo': sympy_zoo, 'nan': sympy_nan_symbol,
    'sinh': sympy.sinh, 'cosh': sympy.cosh, 'tanh': sympy.tanh,
    'asinh': sympy.asinh, 'acosh': sympy.acosh, 'atanh': sympy.atanh,
    'gamma': sympy.gamma, 'factorial': sympy.factorial,
    'Min': sympy.Min, 'Max': sympy.Max,
    'DiracDelta': sympy.DiracDelta, 'Heaviside': sympy.Heaviside,
    'Symbol': Symbol, 'Integer': Integer, 'Float': Float, 'Rational': Rational, 'Function': Function,
    'Add': Add, 'Mul': Mul, 'Pow': Pow, 'Number': Number
}

def preprocess_expression_string(expr_str: str) -> str:
    expr_str = expr_str.replace('^', '**')
    return expr_str

def compute_integral(original_expr_str: str, var_name_str: str,
                     lower_limit_in: Any, upper_limit_in: Any) -> Any:
    try:
        var_symbol = Symbol(var_name_str)
        sympy_integration_locals = base_sympy_locals.copy()
        sympy_integration_locals[var_name_str] = var_symbol
        expr = sympify(original_expr_str, locals=sympy_integration_locals)

        def standardize_limit(lim_val: Any, locals_for_eval: Dict[str, Any]) -> Any:
            # (No changes to standardize_limit from previous version)
            if isinstance(lim_val, str):
                s_lim_val = lim_val.strip().lower()
                if s_lim_val == 'inf': return sympy_inf
                if s_lim_val == '-inf': return -sympy_inf
                try:
                    return sympify(lim_val, locals=locals_for_eval) 
                except Exception as e_sympify_lim:
                    raise ValueError(f"Invalid string limit value '{lim_val}': {e_sympify_lim}")
            elif lim_val is float('inf'): return sympy_inf 
            elif lim_val is float('-inf'): return -sympy_inf
            elif isinstance(lim_val, (int, float, Integer, Float, Rational)): return sympify(lim_val)
            elif lim_val is None: return None 
            else: 
                try:
                    return sympify(lim_val, locals=locals_for_eval)
                except Exception as e_sympify_lim_other:
                    raise ValueError(f"Invalid limit type '{type(lim_val).__name__}' for value '{lim_val}': {e_sympify_lim_other}")
        
        if lower_limit_in is None and upper_limit_in is None:
            result_sympy = integrate(expr, var_symbol)
            return f"$$ {latex(result_sympy)} + C $$"
        else:
            sympy_lower = standardize_limit(lower_limit_in, sympy_integration_locals)
            sympy_upper = standardize_limit(upper_limit_in, sympy_integration_locals)
            result_sympy = integrate(expr, (var_symbol, sympy_lower, sympy_upper))
            evaluated_sympy_result = result_sympy.evalf(chop=True)
            is_unevaluated_integral = isinstance(result_sympy, SympyIntegral)
            is_eval_problematic = evaluated_sympy_result.has(sympy_inf, -sympy_inf, sympy_zoo, sympy_nan_symbol) or \
                                  (evaluated_sympy_result.is_real is False and evaluated_sympy_result.is_complex is False)

            if is_unevaluated_integral or is_eval_problematic:
                numerical_attempt_message_prefix = ""
                if is_unevaluated_integral:
                    numerical_attempt_message_prefix = f"Symbolic integration unevaluated ($${latex(result_sympy)}$$). "
                else:
                    numerical_attempt_message_prefix = f"Symbolic result ($${latex(result_sympy)}$$) evaluated to ($${latex(evaluated_sympy_result)}$$). "

                # MODIFIED f_for_quad STARTS HERE
                def f_for_quad(x_val_np: float) -> float:
                    try:
                        substituted_expr = expr.subs({var_symbol: x_val_np})
                        val_sympy = substituted_expr.evalf(subs_options={'chop': True}, n=15)

                        if val_sympy is sympy.S.NaN: return numpy_nan
                        if val_sympy is sympy.S.Infinity: return numpy_inf
                        if val_sympy is sympy.S.NegativeInfinity: return -numpy_inf
                        if val_sympy is sympy.S.ComplexInfinity: return numpy_nan # zoo for quad

                        if isinstance(val_sympy, sympy.Number):
                            if val_sympy.is_infinite:
                                if hasattr(val_sympy, 'is_extended_positive') and val_sympy.is_extended_positive: return numpy_inf
                                if hasattr(val_sympy, 'is_extended_negative') and val_sympy.is_extended_negative: return -numpy_inf
                                return numpy_nan 

                            if not val_sympy.is_extended_real: # Checks if it's complex
                                if hasattr(val_sympy, 'as_real_imag'):
                                    _real, _imag = val_sympy.as_real_imag()
                                    # Check imag part with tolerance
                                    if abs(float(_imag.evalf(chop=True))) < 1e-9:
                                        val_to_check = float(_real.evalf(chop=True))
                                        # Check real part for NaN/Inf
                                        if math.isnan(val_to_check): return numpy_nan
                                        if math.isinf(val_to_check): return numpy_inf if val_to_check > 0 else -numpy_inf
                                        return val_to_check
                                    else: # Genuinely complex
                                        return numpy_nan
                                else: # Should have as_real_imag if complex Number
                                    return numpy_nan
                            
                            # Is extended_real and finite (infinites handled above)
                            # Convert to Python float; this handles sympy.Float('nan') correctly.
                            py_float_val = float(val_sympy)
                            if math.isnan(py_float_val): return numpy_nan
                            # Should not be infinite here if sympy's is_infinite was False, but for safety:
                            if math.isinf(py_float_val): return numpy_inf if py_float_val > 0 else -numpy_inf
                            return py_float_val

                        # Not a recognized symbolic constant and not a SymPy Number after evalf.
                        # This implies it's still symbolic or an unhandled type.
                        return numpy_nan

                    except Exception: 
                        return numpy_nan 
                # MODIFIED f_for_quad ENDS HERE
                
                q_lower_sympy_evalf = sympy_lower.evalf()
                q_upper_sympy_evalf = sympy_upper.evalf()

                # (Limit checking logic for q_lower, q_upper remains mostly same,
                #  but ensure float conversion handles potential NaN/Inf from evalf robustly)
                if q_lower_sympy_evalf.has(sympy_nan_symbol, sympy_zoo) or \
                   q_upper_sympy_evalf.has(sympy_nan_symbol, sympy_zoo) or \
                   (hasattr(q_lower_sympy_evalf, 'is_finite') and q_lower_sympy_evalf.is_finite is False and not q_lower_sympy_evalf.is_infinite) or \
                   (hasattr(q_upper_sympy_evalf, 'is_finite') and q_upper_sympy_evalf.is_finite is False and not q_upper_sympy_evalf.is_infinite) : # e.g. if limit expression evaluates to NaN or other non-finite non-infinite
                    return f"{numerical_attempt_message_prefix}Numerical integration failed: Could not evaluate limits to finite numbers for numerical integration (Lower: {latex(sympy_lower)}, Upper: {latex(sympy_upper)})."

                q_lower = float(q_lower_sympy_evalf) if q_lower_sympy_evalf.is_finite else (numpy_inf if (q_lower_sympy_evalf == sympy_inf or (hasattr(q_lower_sympy_evalf,'is_extended_positive') and q_lower_sympy_evalf.is_extended_positive)) else (-numpy_inf if (q_lower_sympy_evalf == -sympy_inf or (hasattr(q_lower_sympy_evalf,'is_extended_negative') and q_lower_sympy_evalf.is_extended_negative)) else numpy_nan))
                q_upper = float(q_upper_sympy_evalf) if q_upper_sympy_evalf.is_finite else (numpy_inf if (q_upper_sympy_evalf == sympy_inf or (hasattr(q_upper_sympy_evalf,'is_extended_positive') and q_upper_sympy_evalf.is_extended_positive)) else (-numpy_inf if (q_upper_sympy_evalf == -sympy_inf or (hasattr(q_upper_sympy_evalf,'is_extended_negative') and q_upper_sympy_evalf.is_extended_negative)) else numpy_nan))

                if q_lower is numpy_nan or q_upper is numpy_nan:
                     return f"{numerical_attempt_message_prefix}Numerical integration failed: Limits evaluated to NaN (Lower: {latex(sympy_lower)}, Upper: {latex(sympy_upper)})."


                if q_lower >= q_upper and not (math.isinf(q_lower) and math.isinf(q_upper) and q_lower == q_upper) :
                     return f"{numerical_attempt_message_prefix}Numerical integration error: lower limit {q_lower} must be less than upper limit {q_upper}."

                try:
                    numeric_val, num_error = quad(f_for_quad, q_lower, q_upper, limit=150, epsabs=1.49e-07, epsrel=1.49e-07)
                    if math.isnan(numeric_val):
                        return f"{numerical_attempt_message_prefix}Numerical integration resulted in NaN."
                    if abs(num_error) > 0.01 * abs(numeric_val) and abs(num_error) > 1e-4:
                        # Return the number, but also include a warning string.
                        # The calling function will need to handle this tuple.
                        # For now, let's just return the formatted string to avoid breaking things.
                        return f"{numerical_attempt_message_prefix}Numerical result: {numeric_val:.7g} (Warning: Potentially large error: {num_error:.2g})"
                    return float(numeric_val)
                except Exception as quad_e:
                    return f"{numerical_attempt_message_prefix}Numerical integration failed: {type(quad_e).__name__} - {str(quad_e)}"
            else:
                if evaluated_sympy_result.is_extended_real and evaluated_sympy_result.is_finite:
                    return float(evaluated_sympy_result)
                elif evaluated_sympy_result.is_extended_real: # Non-finite real
                    return f"Symbolic result: $${latex(result_sympy)}$$ evaluated to non-finite $${latex(evaluated_sympy_result)}$$"
                elif evaluated_sympy_result.is_complex and evaluated_sympy_result.is_finite:
                    return f"$${latex(evaluated_sympy_result)}$$" # Return complex as string
                elif evaluated_sympy_result.is_complex: # Non-finite complex
                    return f"Symbolic result: $${latex(result_sympy)}$$ evaluated to non-finite complex $${latex(evaluated_sympy_result)}$$"
                else:
                    return f"Symbolic result: $${latex(result_sympy)}$$ (evaluated to $${latex(evaluated_sympy_result)}$$, but type is unexpected)"

    except ValueError as ve:
        return f"Error in integral setup for '{original_expr_str}' with var '{var_name_str}': {str(ve)}"
    except TypeError as te: 
        return f"Error processing integral for '{original_expr_str}' (likely type issue or malformed expression for SymPy): {type(te).__name__} - {str(te)}"
    except Exception as e: 
        import traceback
        tb_str = traceback.format_exc()
        return f"Error in integral computation for '{original_expr_str}': {type(e).__name__} - {str(e)}\nTraceback:\n{tb_str}"


def evaluate(expression: str) -> str:
    # (evaluate function largely unchanged from previous, ensure it calls the modified compute_integral)
    # ... (rest of the evaluate, main, etc. functions are the same as your last provided version) ...
    def eval_expr(node: ast.AST) -> Any: # Changed return type to Any
        if isinstance(node, ast.Constant):
            return node.value
        elif isinstance(node, ast.Name):
            if node.id in constants: return constants[node.id]
            nid = node.id.lower()
            if nid == 'inf' or nid == 'infinity': return float('inf')
            if nid == '-inf' or nid == '-infinity': return float('-inf')
            if nid == 'nan': return float('nan')
            raise ValueError(f"Unsupported variable or constant: {node.id}")
        elif isinstance(node, ast.BinOp):
            left = eval_expr(node.left)
            right = eval_expr(node.right)
            if isinstance(left, str) or isinstance(right, str): 
                raise ValueError(f"Cannot perform arithmetic operation '{type(node.op).__name__}' with non-numeric string operands: '{left}', '{right}'")
            if not all(isinstance(x, (int, float, complex)) for x in [left, right]):
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
                num_args = len(node.args)
                if not (1 <= num_args <= 4):
                    raise ValueError("integral() syntax: integral('expr_str' [, 'var_str'] [, lower, upper]) or integral('expr_str', 'var_str', lower, upper)")

                expr_str_arg_node = node.args[0]
                if not (isinstance(expr_str_arg_node, ast.Constant) and isinstance(expr_str_arg_node.value, str)):
                    raise ValueError("First argument to integral() must be a string expression (e.g., 'sin(x)').")
                
                expr_str_val = preprocess_expression_string(expr_str_arg_node.value)
                var_name_val = 'x' 
                lower_limit_val = None
                upper_limit_val = None

                if num_args == 1: 
                    pass
                elif num_args == 2: 
                    arg1_val = eval_expr(node.args[1]) 
                    if not isinstance(arg1_val, str): 
                        raise ValueError("If 2 args for integral (indefinite), 2nd arg (variable name) must be a string.")
                    var_name_val = arg1_val
                elif num_args == 3: 
                    lower_limit_val = eval_expr(node.args[1])
                    upper_limit_val = eval_expr(node.args[2])
                elif num_args == 4: 
                    arg1_val = eval_expr(node.args[1]) 
                    if not isinstance(arg1_val, str):
                        raise ValueError("If 4 args for integral, 2nd arg (variable name) must be a string.")
                    var_name_val = arg1_val
                    lower_limit_val = eval_expr(node.args[2])
                    upper_limit_val = eval_expr(node.args[3])
                
                return compute_integral(expr_str_val, var_name_val, lower_limit_val, upper_limit_val)

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
                if func_name in ['mean', 'median', 'mode', 'variance', 'stdev']:
                    if not isinstance(args[0], list): raise ValueError(f"{func_name} requires a list input for its first argument.")
                    return math_functions[func_name](*args) 
                if func_name == 't_test': 
                     if not (isinstance(args[0], list) and isinstance(args[1], (int,float))):
                         raise ValueError("t_test requires a list and a number (mu).")
                     return math_functions[func_name](args[0], args[1])
                if func_name in ['norm_pdf', 'norm_cdf']:
                    if len(args) != 3: raise ValueError(f"{func_name} requires x, mean, std_dev")
                    return math_functions[func_name](args[0], loc=args[1], scale=args[2])
                if len(args) == 1: return math_functions[func_name](args[0])
                raise ValueError(f"Incorrect number of arguments or argument type for {func_name}")
            raise ValueError(f"Unsupported function: {func_name}")
        elif isinstance(node, ast.List): return [eval_expr(elt) for elt in node.elts]
        elif isinstance(node, ast.Dict): 
            keys = []
            for k_node in node.keys:
                k_val = eval_expr(k_node)
                if not isinstance(k_val, (str, int, float)): 
                    raise ValueError(f"Dictionary keys must be strings, integers, or floats, got {type(k_val).__name__}")
                keys.append(k_val)
            values = [eval_expr(v) for v in node.values]
            return dict(zip(keys, values))
        elif isinstance(node, ast.Tuple): return tuple(eval_expr(elt) for elt in node.elts)
        raise ValueError(f"Unsupported AST node: {type(node).__name__}")

    def compute_error_propagation(expr_str: str, vars_errors: Dict[str, Tuple[float, float]]) -> str:
        try:
            symbols_map = {var_name: Symbol(var_name) for var_name in vars_errors.keys()}
            # Ensure that base_sympy_locals are available and that symbols from vars_errors take precedence
            current_locals = base_sympy_locals.copy()
            current_locals.update(symbols_map)
            sympy_expr = sympify(preprocess_expression_string(expr_str), locals=current_locals) # Preprocess here too
            
            subs_values = {symbols_map[k]: v[0] for k, v in vars_errors.items()}
            calculated_value = sympy_expr.subs(subs_values).evalf()

            total_error_sq = sympy.S.Zero
            for var_name, (val, err) in vars_errors.items():
                s_var = symbols_map[var_name]
                partial_derivative = diff(sympy_expr, s_var)
                partial_derivative_val = partial_derivative.subs(subs_values).evalf()
                if not partial_derivative_val.is_number: # Check if derivative is numeric
                     raise ValueError(f"Partial derivative w.r.t '{var_name}' is not numeric: {latex(partial_derivative_val)}")
                total_error_sq += (partial_derivative_val * err)**2
            
            final_error = sympy.sqrt(total_error_sq).evalf()
            if not calculated_value.is_number or not final_error.is_number:
                raise ValueError("Calculated value or final error is not numeric.")

            return f"Value = {float(calculated_value):.7g}, Error = {float(final_error):.4g}"
        except Exception as e:
            return f"Error in error_propagation for '{expr_str}': {type(e).__name__} - {str(e)}"

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
            
            # Using Scipy's t.interval for more robust CI calculation
            ci_lower, ci_upper = stats.t.interval(confidence_level, df=n-1, loc=sample_mean, scale=sample_std/math.sqrt(n))
            
            return f"[{float(ci_lower):.6g}, {float(ci_upper):.6g}] ({(confidence_level*100):.0f}% CI for mean)"
        except Exception as e:
            return f"Error in confidence_interval: {str(e)}"

    try:
        expression_str_input = str(expression).strip()
        if not expression_str_input:
            raise ValueError("Expression cannot be empty.")
        
        brackets = {'(': ')', '[': ']', '{': '}'}
        stack = []
        for char in expression_str_input:
            if char in brackets.keys():
                stack.append(char)
            elif char in brackets.values():
                if not stack or brackets[stack.pop()] != char:
                    raise SyntaxError(f"Mismatched parentheses or brackets in '{expression_str_input}'")
        if stack:
            raise SyntaxError(f"Unclosed parentheses or brackets in '{expression_str_input}'")

        parsed_expr = ast.parse(expression_str_input, mode='eval')
        result = eval_expr(parsed_expr.body)
        
        if isinstance(result, str): 
            return result
        if isinstance(result, (float, sympy.Float, sympy.Rational, sympy.Number)): # sympy.Number includes Integer
            try:
                num_result = float(result) # Attempt to convert to Python float
                if math.isinf(num_result) or math.isnan(num_result):
                    return str(num_result) 
                formatted_float = f"{num_result:.10g}"
                if '.' in formatted_float: 
                    formatted_float = formatted_float.rstrip('0').rstrip('.')
                return formatted_float
            except Exception: # If conversion to float fails for some SymPy Number type
                return str(result) # Fallback to string representation of the SymPy number

        if isinstance(result, (int, sympy.Integer)): # Redundant due to sympy.Number above, but harmless
            return str(result)
        if isinstance(result, complex): 
             return f"{result.real:.10g}{'+' if result.imag >= 0 else ''}{result.imag:.10g}j".replace("+-","-")
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
        import traceback
        tb_str = traceback.format_exc()
        return f"Calculation Error: An unexpected error occurred. ({type(e).__name__}: {str(e)})\nTraceback:\n{tb_str}"

import json

def main():
    # (main function unchanged from previous version)
    expression_input = sys.stdin.readline().strip()

    try:
        # Attempt to parse the input as JSON, in case the expression is wrapped in a JSON object.
        data = json.loads(expression_input)
        if isinstance(data, dict) and 'expression' in data:
            expression_input = data['expression']
    except (json.JSONDecodeError, TypeError):
        # If it's not valid JSON or not a dict, assume it's a raw expression string.
        pass

    output = {}
    if not expression_input:
        output = {"status": "error", "error": "SciCalculator Plugin Error: No expression provided."}
    else:
        result_str = evaluate(expression_input)
        error_prefixes = ("Error:", "Syntax Error:", "Input Error:", "Calculation Error:") 
        
        is_error_result = False
        if isinstance(result_str, str):
            for prefix in error_prefixes:
                if result_str.startswith(prefix) : 
                    is_error_result = True
                    break
            # Warnings are not necessarily hard errors for status
            if result_str.startswith("Warning:") and "Potentially large error" in result_str:
                pass # This is a success with a caveat

        if is_error_result:
            output = {"status": "error", "error": result_str}
        else:
            ai_friendly_result = result_str
            formatted_result_for_ai = f"###计算结果：{ai_friendly_result}###，请将结果转告用户"
            output = {"status": "success", "result": formatted_result_for_ai}

    print(json.dumps(output), file=sys.stdout)
    sys.exit(0 if output.get("status") == "success" else 1)


if __name__ == "__main__":
    # To test your specific case:
    # test_integral_expr = 'integral(\'x * tan(x) / (x**2 + cos(x))\', 1, 2)'
    # print(f"Test '{test_integral_expr}': {evaluate(test_integral_expr)}")
    # Expected for divergent integral: A message indicating NaN or failure from numerical integration.
    # e.g., "Symbolic integration unevaluated ($$\int\limits_{1}^{2} \frac{x \tan{\left(x \right)}}{x^{2} + \cos{\left(x \right)}}\, dx$$). Numerical integration resulted in NaN."
    # or "Numerical integration failed: ..." if quad raises an issue.

    main()
