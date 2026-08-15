#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
HealthQuery - VCP Health Data Plugin (Fitbit Edition)
Integration with Google Fitbit Web API
"""

import sys
import json
import os
import time
from datetime import datetime

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(PLUGIN_DIR, 'config.env')


def load_plugin_env():
    """Load the local plugin config before imports read environment values."""
    if not os.path.exists(CONFIG_PATH):
        return

    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as config_file:
            for raw_line in config_file:
                line = raw_line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                os.environ[key.strip()] = value.strip()
    except OSError:
        pass


load_plugin_env()

# --- Logging System ---
LOG_DIR = os.path.join(PLUGIN_DIR, 'logs')
DEBUG_MODE = os.environ.get('DEBUG_MODE', os.environ.get('debug_mode', 'false')).lower() == 'true'

def init_logging():
    if not os.path.exists(LOG_DIR):
        try:
            os.makedirs(LOG_DIR, exist_ok=True)
        except Exception as e:
            print(f"Failed to create log directory: {e}", file=sys.stderr)

def log(level, message, details=None):
    if level == 'DEBUG' and not DEBUG_MODE:
        return
    init_logging()

    timestamp = datetime.now().isoformat()
    log_entry = f"[{timestamp}] [{level}] {message}"
    if details:
        log_entry += f"\nDetails: {str(details)}"

    try:
        today = datetime.now().strftime('%Y-%m-%d')
        with open(os.path.join(LOG_DIR, f'health-query-{today}.log'), 'a', encoding='utf-8') as f:
            f.write(log_entry + "\n")
    except Exception:
        pass

    if level == 'ERROR' or (level == 'INFO' and DEBUG_MODE):
        print(f"[HealthQuery {level}] {message}", file=sys.stderr)

# Import Handlers
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from handlers.fitbit_handlers import (
    check_auth_status,
    trigger_auth,
    exchange_code,
    query_daily_summary,
    query_heart_rate_trend,
    query_sleep_analysis
)

# Command Mapping
HANDLERS = {
    'auth_status': check_auth_status,
    'trigger_auth': trigger_auth,
    'exchange_code': exchange_code,
    'query_daily_summary': query_daily_summary,
    'query_heart_rate_trend': query_heart_rate_trend,
    'query_sleep_analysis': query_sleep_analysis,
    # Map legacy names if reasonable, or let them fail gracefully
    'query_health_stats': query_daily_summary, # Fallback to daily
}

def get_config():
    config = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                for line in f:
                    if '=' in line and not line.startswith('#'):
                        k, v = line.strip().split('=', 1)
                        config[k.strip()] = v.strip()
        except: pass
    return config

def read_input():
    try:
        # Check if sys.stdin.isatty() is False, meaning data is piped
        if not sys.stdin.isatty():
             input_data = sys.stdin.read()
             if input_data.strip():
                 return json.loads(input_data)
        # If no input, return None (maybe run without args)
        return None
    except Exception as e:
        return {'error': f'JSON Parse Error: {e}'}

def main():
    log('INFO', 'HealthQuery (Fitbit) Started')
    config = get_config()

    request = read_input()

    # Default to auth check if no command
    if not request or 'command' not in request:
        # If run from command line without input, maybe just check auth
        if len(sys.argv) > 1:
            # simple arg parsing
            cmd = sys.argv[1]
            request = {'command': cmd}
        else:
            # Default behavior
            request = {'command': 'auth_status'}

    command = request.get('command')
    log('DEBUG', f"Processing command: {command}")

    if command in HANDLERS:
        try:
            # Prepare params (exclude command)
            params = {k: v for k, v in request.items() if k != 'command'}
            result = HANDLERS[command](config, **params)
        except Exception as e:
            result = {'success': False, 'error': f"Handler Error: {str(e)}"}
    else:
        result = {'success': False, 'error': f"Unknown command: {command}"}

    # Format output for VCP
    output = {
        'status': 'success' if result.get('success') else 'error',
        'result': result.get('data') if result.get('success') else result.get('error')
    }

    print(json.dumps(output, ensure_ascii=False))

if __name__ == '__main__':
    main()
