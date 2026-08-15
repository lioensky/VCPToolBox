# -*- coding: utf-8 -*-
from fitbit_manager import FitbitManager
import json
import os
import sys
from datetime import datetime, timedelta

# Global manager instance
manager = FitbitManager()
LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'logs')


def _log_quality_filter(field, value, reason, context=None):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        today = datetime.now().strftime('%Y-%m-%d')
        timestamp = datetime.now().isoformat()
        context_text = f" context={json.dumps(context, ensure_ascii=False)}" if context else ""
        message = (
            f"[{timestamp}] [INFO] HealthQuery filtered abnormal data: "
            f"field={field} value={repr(value)} reason={reason}{context_text}\n"
        )
        with open(os.path.join(LOG_DIR, f'health-query-{today}.log'), 'a', encoding='utf-8') as f:
            f.write(message)
    except Exception:
        pass


def _is_enabled(config, key, default=True):
    value = config.get(key)
    if value is None:
        return default
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


def _maybe_set(container, key, value, enabled):
    if enabled:
        container[key] = value


def _to_float(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _invalid_text_value(value):
    if not isinstance(value, str):
        return False
    return value.strip().lower() in ('', '0', '0.0', 'n/a', 'na', 'none', 'null')


def _maybe_set_measurement(container, key, value, enabled, min_value=None, max_value=None, context=None):
    if not enabled:
        return
    if _invalid_text_value(value):
        _log_quality_filter(key, value, 'empty_or_na', context)
        return
    numeric_value = _to_float(value)
    if numeric_value is not None:
        if numeric_value == 0:
            _log_quality_filter(key, value, 'zero_value', context)
            return
        if min_value is not None and numeric_value < min_value:
            _log_quality_filter(key, value, f'below_min_{min_value}', context)
            return
        if max_value is not None and numeric_value > max_value:
            _log_quality_filter(key, value, f'above_max_{max_value}', context)
            return
    container[key] = value


def _has_meaningful_duration(value):
    if value is None:
        return False
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in ('', '0', '0.0', 'n/a', 'na', 'none', 'null'):
            return False
    if isinstance(value, (int, float)) and value == 0:
        return False
    return True


def _get_float_config(config, key, default):
    value = config.get(key)
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _filter_active_minutes(summary, config):
    active_minutes = {}
    context = {'command': 'query_daily_summary', 'section': 'active_minutes'}
    _maybe_set_measurement(
        active_minutes,
        'very',
        summary.get('veryActiveMinutes', 0),
        _is_enabled(config, 'RETURN_DAILY_ACTIVE_MINUTES_VERY', True),
        min_value=1,
        context=context,
    )
    _maybe_set_measurement(
        active_minutes,
        'fairly',
        summary.get('fairlyActiveMinutes', 0),
        _is_enabled(config, 'RETURN_DAILY_ACTIVE_MINUTES_FAIRLY', True),
        min_value=1,
        context=context,
    )
    _maybe_set_measurement(
        active_minutes,
        'lightly',
        summary.get('lightlyActiveMinutes', 0),
        _is_enabled(config, 'RETURN_DAILY_ACTIVE_MINUTES_LIGHTLY', True),
        min_value=1,
        context=context,
    )
    _maybe_set_measurement(
        active_minutes,
        'sedentary',
        summary.get('sedentaryMinutes', 0),
        _is_enabled(config, 'RETURN_DAILY_ACTIVE_MINUTES_SEDENTARY', False),
        min_value=1,
        context=context,
    )
    return active_minutes


def _filter_sleep_levels_summary(levels_summary, config, context):
    filtered = {}
    min_minutes = _get_float_config(
        config,
        'MIN_VALID_SLEEP_STAGE_LEVEL_MINUTES',
        _get_float_config(config, 'MIN_VALID_SLEEP_STAGE_MINUTES', 20),
    )
    for level_name, level_data in levels_summary.items():
        if not isinstance(level_data, dict):
            continue
        minutes = level_data.get('minutes')
        if _to_float(minutes) in (None, 0):
            _log_quality_filter(f'levels_summary.{level_name}.minutes', minutes, 'zero_or_missing_minutes', context)
            continue
        if _to_float(minutes) < min_minutes:
            _log_quality_filter(f'levels_summary.{level_name}.minutes', minutes, 'below_min_stage_level_minutes', context)
            continue
        filtered[level_name] = level_data
    return filtered


def _filter_sleep_stage(log, config):
    processed = {}
    context = {'sleepLogId': log.get('logId'), 'dateOfSleep': log.get('dateOfSleep')}
    min_duration = _get_float_config(config, 'MIN_VALID_SLEEP_STAGE_MINUTES', 20)
    duration_minutes = log.get('duration') / 60000 if log.get('duration') is not None else None
    numeric_duration = _to_float(duration_minutes)
    if not _has_meaningful_duration(duration_minutes):
        _log_quality_filter('duration_minutes', duration_minutes, 'empty_or_zero_duration', context)
        return {}
    if numeric_duration is not None and numeric_duration < min_duration:
        _log_quality_filter('duration_minutes', duration_minutes, f'below_min_{min_duration}', context)
        return {}
    _maybe_set(
        processed,
        'startTime',
        log.get('startTime'),
        _is_enabled(config, 'RETURN_SLEEP_STAGE_START_TIME', True),
    )
    _maybe_set(
        processed,
        'endTime',
        log.get('endTime'),
        _is_enabled(config, 'RETURN_SLEEP_STAGE_END_TIME', True),
    )
    _maybe_set_measurement(
        processed,
        'duration_minutes',
        duration_minutes,
        _is_enabled(config, 'RETURN_SLEEP_STAGE_DURATION_MINUTES', True)
        and _has_meaningful_duration(duration_minutes),
        min_value=min_duration,
        context=context,
    )
    _maybe_set_measurement(
        processed,
        'efficiency',
        log.get('efficiency'),
        _is_enabled(config, 'RETURN_SLEEP_STAGE_EFFICIENCY', True),
        min_value=1,
        context=context,
    )
    _maybe_set(
        processed,
        'isMainSleep',
        log.get('isMainSleep'),
        _is_enabled(config, 'RETURN_SLEEP_STAGE_IS_MAIN_SLEEP', True),
    )
    if _is_enabled(config, 'RETURN_SLEEP_STAGE_LEVELS_SUMMARY', True):
        levels_summary = _filter_sleep_levels_summary(log.get('levels', {}).get('summary', {}), config, context)
        if levels_summary:
            processed['levels_summary'] = levels_summary
    return processed

def _handle_api_error(e):
    return {'success': False, 'error': str(e)}

def check_auth_status(config, **kwargs):
    """Check if the plugin has valid tokens."""
    try:
        is_auth = manager.is_authenticated()
        # Try a lightweight call to verify token validity if it exists
        if is_auth:
            try:
                manager.get_profile()
                return {'success': True, 'data': {'authenticated': True, 'status': 'Token Valid'}}
            except Exception as e:
                return {'success': True, 'data': {'authenticated': False, 'status': f'Token Invalid or Expired: {e}'}}
        else:
             return {'success': True, 'data': {'authenticated': False, 'status': 'No Token Found'}}
    except Exception as e:
        return _handle_api_error(e)

def trigger_auth(config, **kwargs):
    """Trigger the auth flow (opens browser)."""
    try:
        manager.authorize()
        return {'success': True, 'data': {'message': 'Authorization successful. Tokens saved.'}}
    except Exception as e:
        return _handle_api_error(e)

def exchange_code(config, code=None, **kwargs):
    """Manually exchange auth code."""
    if not code:
        return {'success': False, 'error': 'No code provided.'}
    try:
        if manager.exchange_code_manually(code):
            return {'success': True, 'data': {'message': 'Token exchange successful. You can now query data.'}}
        else:
            return {'success': False, 'error': 'Token exchange failed. Code might be expired or invalid.'}
    except Exception as e:
        return _handle_api_error(e)

def query_daily_summary(config, date=None, **kwargs):
    """
    Query daily activity summary.
    params: date (YYYY-MM-DD), default 'today'
    """
    if not date or date == 'today':
        target_date = datetime.now().strftime('%Y-%m-%d')
    else:
        target_date = date
    try:
        data = manager.get_daily_activity_summary(target_date)
        # Extract key metrics to match expected output format generally
        summary = data.get('summary', {})
        goals = data.get('goals', {})

        result = {
            'date': target_date,
            'steps': summary.get('steps', 0),
            'calories_out': summary.get('caloriesOut', 0),
            'resting_heart_rate': summary.get('restingHeartRate', 'N/A'),
            'distance': next((x['distance'] for x in summary.get('distances', []) if x['activity'] == 'total'), 0),
            'floors': summary.get('floors', 0),
            'active_minutes': _filter_active_minutes(summary, config),
            'goals_met': {
                'steps': summary.get('steps', 0) >= goals.get('steps', 10000),
                'calories': summary.get('caloriesOut', 0) >= goals.get('caloriesOut', 2000),
            },
            'raw_summary': summary
        }
        filtered = {}
        _maybe_set(filtered, 'date', result['date'], _is_enabled(config, 'RETURN_DAILY_DATE', True))
        context = {'date': target_date, 'command': 'query_daily_summary'}
        _maybe_set_measurement(
            filtered,
            'steps',
            result['steps'],
            _is_enabled(config, 'RETURN_DAILY_STEPS', True),
            min_value=_get_float_config(config, 'MIN_VALID_DAILY_STEPS', 1),
            context=context,
        )
        _maybe_set_measurement(
            filtered,
            'calories_out',
            result['calories_out'],
            _is_enabled(config, 'RETURN_DAILY_CALORIES_OUT', True),
            min_value=_get_float_config(config, 'MIN_VALID_CALORIES_OUT', 1),
            context=context,
        )
        _maybe_set_measurement(
            filtered,
            'resting_heart_rate',
            result['resting_heart_rate'],
            _is_enabled(config, 'RETURN_DAILY_RESTING_HEART_RATE', True),
            min_value=_get_float_config(config, 'MIN_VALID_RESTING_HEART_RATE', 30),
            max_value=_get_float_config(config, 'MAX_VALID_RESTING_HEART_RATE', 220),
            context=context,
        )
        _maybe_set_measurement(
            filtered,
            'distance',
            result['distance'],
            _is_enabled(config, 'RETURN_DAILY_DISTANCE', True),
            min_value=_get_float_config(config, 'MIN_VALID_DISTANCE', 0.01),
            context=context,
        )
        _maybe_set_measurement(
            filtered,
            'floors',
            result['floors'],
            _is_enabled(config, 'RETURN_DAILY_FLOORS', True),
            min_value=_get_float_config(config, 'MIN_VALID_FLOORS', 1),
            context=context,
        )
        if _is_enabled(config, 'RETURN_DAILY_ACTIVE_MINUTES', False) and result['active_minutes']:
            filtered['active_minutes'] = result['active_minutes']
        if _is_enabled(config, 'RETURN_DAILY_GOALS_MET', True) and ('steps' in filtered or 'calories_out' in filtered):
            filtered['goals_met'] = {
                key: value
                for key, value in result['goals_met'].items()
                if (key == 'steps' and 'steps' in filtered) or (key == 'calories' and 'calories_out' in filtered)
            }
        _maybe_set(filtered, 'raw_summary', result['raw_summary'], _is_enabled(config, 'RETURN_DAILY_RAW_SUMMARY', False))
        return {'success': True, 'data': filtered}
    except Exception as e:
        return _handle_api_error(e)

def query_heart_rate_trend(config, days=1, date=None, **kwargs):
    """
    Query heart rate data.
    params: date (YYYY-MM-DD), days (int)
    """
    if not date or date == 'today':
        target_date = datetime.now().strftime('%Y-%m-%d')
    else:
        target_date = date
    # Fitbit API allows querying by date range or specific date.
    # For now, let's implement single day detailed view or range summary.
    # If 'days' > 1, maybe we fetch multiple days?
    # Let's stick to the requested "Intraday Heart Rate" from the prompt guide for a single day if days=1.

    try:
        # Get Intraday data for detailed view
        data = manager.get_heart_rate_intraday(target_date, detail_level='1min')

        activities_heart = data.get('activities-heart', [])
        intraday = data.get('activities-heart-intraday', {}).get('dataset', [])

        # Calculate some stats from intraday if available
        min_hr = 1000
        max_hr = 0
        sum_hr = 0
        count = 0

        for point in intraday:
            val = point['value']
            if val < min_hr: min_hr = val
            if val > max_hr: max_hr = val
            sum_hr += val
            count += 1

        avg_hr = int(sum_hr / count) if count > 0 else 0
        if min_hr == 1000: min_hr = 0

        summary = {
            'date': target_date,
            'resting_heart_rate': activities_heart[0].get('value', {}).get('restingHeartRate', 'N/A') if activities_heart else 'N/A',
            'zones': activities_heart[0].get('value', {}).get('heartRateZones', []) if activities_heart else [],
            'stats': {
                'min': min_hr,
                'max': max_hr,
                'avg': avg_hr,
                'sample_count': count
            },
            # Return a subset of intraday to avoid token explosion, or full if requested?
            # VCP usually handles text. Too much data might be bad.
            # Let's just return stats and zones for now, maybe sampled intraday.
            'intraday_samples_hourly': [x for i, x in enumerate(intraday) if i % 60 == 0] # Every hour
        }
        filtered = {}
        _maybe_set(filtered, 'date', summary['date'], _is_enabled(config, 'RETURN_HEART_DATE', True))
        context = {'date': target_date, 'command': 'query_heart_rate_trend'}
        _maybe_set_measurement(
            filtered,
            'resting_heart_rate',
            summary['resting_heart_rate'],
            _is_enabled(config, 'RETURN_HEART_RESTING_HEART_RATE', True),
            min_value=_get_float_config(config, 'MIN_VALID_RESTING_HEART_RATE', 30),
            max_value=_get_float_config(config, 'MAX_VALID_RESTING_HEART_RATE', 220),
            context=context,
        )
        if _is_enabled(config, 'RETURN_HEART_ZONES', True):
            if summary['zones']:
                filtered['zones'] = summary['zones']
            else:
                _log_quality_filter('zones', [], 'empty_heart_rate_zones', context)
        if _is_enabled(config, 'RETURN_HEART_STATS', True) and summary['stats'].get('sample_count', 0) > 0:
            valid_stats = {}
            _maybe_set_measurement(valid_stats, 'min', summary['stats']['min'], True, min_value=30, max_value=220, context=context)
            _maybe_set_measurement(valid_stats, 'max', summary['stats']['max'], True, min_value=30, max_value=220, context=context)
            _maybe_set_measurement(valid_stats, 'avg', summary['stats']['avg'], True, min_value=30, max_value=220, context=context)
            valid_stats['sample_count'] = summary['stats']['sample_count']
            filtered['stats'] = valid_stats
        elif _is_enabled(config, 'RETURN_HEART_STATS', True):
            _log_quality_filter('stats', summary['stats'], 'no_heart_rate_samples', context)
        if _is_enabled(config, 'RETURN_HEART_INTRADAY_SAMPLES_HOURLY', True):
            if summary['intraday_samples_hourly']:
                filtered['intraday_samples_hourly'] = summary['intraday_samples_hourly']
            else:
                _log_quality_filter('intraday_samples_hourly', [], 'no_heart_rate_samples', context)
        return {'success': True, 'data': filtered}
    except Exception as e:
        return _handle_api_error(e)

def query_sleep_analysis(config, date=None, **kwargs):
    """
    Query sleep data.
    """
    if not date or date == 'today':
        target_date = datetime.now().strftime('%Y-%m-%d')
    else:
        target_date = date
    try:
        data = manager.get_sleep_log(target_date)
        sleep_logs = data.get('sleep', [])

        processed_logs = []
        for log in sleep_logs:
            processed = _filter_sleep_stage(log, config)
            if processed:
                processed_logs.append(processed)

        summary = data.get('summary', {})

        result = {
            'date': target_date,
            'total_minutes_asleep': summary.get('totalMinutesAsleep'),
            'total_time_in_bed': summary.get('totalTimeInBed'),
            'stages_breakdown': processed_logs
        }
        filtered = {}
        _maybe_set(filtered, 'date', result['date'], _is_enabled(config, 'RETURN_SLEEP_DATE', True))
        context = {'date': target_date, 'command': 'query_sleep_analysis'}
        _maybe_set_measurement(
            filtered,
            'total_minutes_asleep',
            result['total_minutes_asleep'],
            _is_enabled(config, 'RETURN_SLEEP_TOTAL_MINUTES_ASLEEP', True)
            and _has_meaningful_duration(result['total_minutes_asleep']),
            min_value=_get_float_config(config, 'MIN_VALID_SLEEP_TOTAL_MINUTES', 60),
            context=context,
        )
        _maybe_set_measurement(
            filtered,
            'total_time_in_bed',
            result['total_time_in_bed'],
            _is_enabled(config, 'RETURN_SLEEP_TOTAL_TIME_IN_BED', True)
            and _has_meaningful_duration(result['total_time_in_bed']),
            min_value=_get_float_config(config, 'MIN_VALID_SLEEP_TOTAL_MINUTES', 60),
            context=context,
        )
        if _is_enabled(config, 'RETURN_SLEEP_STAGES_BREAKDOWN', True) and result['stages_breakdown']:
            filtered['stages_breakdown'] = result['stages_breakdown']
        return {'success': True, 'data': filtered}
    except Exception as e:
        return _handle_api_error(e)

# Alias for compatibility if needed, but we will update HealthQuery.py
