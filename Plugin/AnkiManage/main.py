import json
import os
import sys
import time
import urllib.error
import urllib.request


sys.stdout.reconfigure(encoding='utf-8')

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))


def load_plugin_env():
    config_path = os.path.join(PLUGIN_DIR, 'config.env')
    if not os.path.exists(config_path):
        return

    try:
        with open(config_path, 'r', encoding='utf-8') as config_file:
            for raw_line in config_file:
                line = raw_line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip())
    except OSError:
        pass


def positive_int(value, fallback):
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return fallback


def parse_boolean(value, default=False):
    if value is None:
        return default
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


def parse_card_ids(value):
    card_ids = [int(item.strip()) for item in str(value or '').split(',') if item.strip()]
    if not card_ids:
        raise ValueError('card_ids must contain at least one card ID')
    return card_ids


def parse_fields(value):
    fields = json.loads(value or '{}')
    if not isinstance(fields, dict):
        raise ValueError('fields must be a JSON object')
    return fields


def parse_tags(value):
    if isinstance(value, list):
        return [str(tag).strip() for tag in value if str(tag).strip()]
    return [tag for tag in str(value or '').split() if tag]


load_plugin_env()
ANKI_CONNECT_URL = os.environ.get('ANKI_CONNECT_URL', 'http://127.0.0.1:8765').rstrip('/')
ANKI_CONNECT_TIMEOUT_SECONDS = positive_int(os.environ.get('ANKI_CONNECT_TIMEOUT_SECONDS'), 10)
ANKI_CONNECT_RETRIES = positive_int(os.environ.get('ANKI_CONNECT_RETRIES'), 3)


def request_anki(action, params=None, retries=ANKI_CONNECT_RETRIES):
    payload = {
        'action': action,
        'version': 6,
        'params': params or {},
    }
    data = json.dumps(payload).encode('utf-8')

    last_error = None
    for _ in range(retries):
        try:
            request = urllib.request.Request(ANKI_CONNECT_URL, data=data, method='POST')
            with urllib.request.urlopen(request, timeout=ANKI_CONNECT_TIMEOUT_SECONDS) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.URLError as error:
            last_error = f'Connection failed: {error.reason}. Ensure Anki and AnkiConnect are running locally.'
            time.sleep(1)
        except Exception as error:
            last_error = str(error)
            time.sleep(1)

    return {'error': last_error}


def success(result, message):
    return {'status': 'success', 'result': result, 'messageForAI': message}


def main():
    try:
        input_data = sys.stdin.read()
        if not input_data:
            return

        request = json.loads(input_data)
        command = request.get('command')
        args = request.get('args', {})
        if not args:
            args = {key: value for key, value in request.items() if key != 'command'}

        dry_run = parse_boolean(args.get('dryRun', args.get('dry_run')), False)

        if command == 'anki_add_note':
            fields = parse_fields(args.get('fields'))
            deck_name = str(args.get('deck', 'Default')).strip() or 'Default'
            model_name = str(args.get('model', 'Basic')).strip() or 'Basic'
            note = {
                'deckName': deck_name,
                'modelName': model_name,
                'fields': fields,
                'tags': parse_tags(args.get('tags')),
                'options': {'allowDuplicate': parse_boolean(args.get('allowDuplicate'), False)},
            }

            if dry_run:
                result = success({'dryRun': True, 'wouldAdd': note}, 'Preflight complete; no Anki note was created.')
            else:
                response = request_anki('addNote', {'note': note})
                if response.get('error') and 'deck' in response['error'].lower():
                    request_anki('createDeck', {'deck': deck_name})
                    response = request_anki('addNote', {'note': note})

                if response.get('error'):
                    result = {'status': 'error', 'error': f"Failed to add note: {response['error']}"}
                else:
                    result = success(response.get('result'), f"Note added successfully. ID: {response.get('result')}")

        elif command == 'anki_update_note':
            note_id = int(args.get('note_id'))
            if note_id <= 0:
                raise ValueError('note_id must be positive')
            fields = parse_fields(args.get('fields'))
            planned = {'id': note_id, 'fields': fields}

            if dry_run:
                result = success({'dryRun': True, 'wouldUpdate': planned}, 'Preflight complete; no Anki note was changed.')
            else:
                response = request_anki('updateNoteFields', {'note': planned})
                if response.get('error'):
                    result = {'status': 'error', 'error': response['error']}
                else:
                    result = success('Updated', 'Note fields updated successfully.')

        elif command == 'anki_suspend':
            card_ids = parse_card_ids(args.get('card_ids'))
            suspend = parse_boolean(args.get('suspend'), True)
            action = 'suspend' if suspend else 'unsuspend'

            if dry_run:
                result = success(
                    {'dryRun': True, 'wouldRun': action, 'cardIds': card_ids},
                    'Preflight complete; no card state was changed.',
                )
            else:
                response = request_anki(action, {'cards': card_ids})
                if response.get('error'):
                    result = {'status': 'error', 'error': response['error']}
                else:
                    result = success(response.get('result'), f"Cards {'suspended' if suspend else 'unsuspended'} successfully.")

        elif command == 'anki_reschedule':
            card_ids = parse_card_ids(args.get('card_ids'))
            days = int(args.get('days', 0))

            if dry_run:
                result = success(
                    {'dryRun': True, 'wouldReschedule': card_ids, 'days': days},
                    'Preflight complete; no review schedule was changed.',
                )
            else:
                response = request_anki('setDue', {'cards': card_ids, 'days': days})
                if response.get('error'):
                    response = request_anki('rescheduleCards', {'cards': card_ids, 'minDays': days, 'maxDays': days})
                if response.get('error'):
                    response = request_anki('setDueDate', {'cards': card_ids, 'days': days})

                if response.get('error'):
                    result = {'status': 'error', 'error': response['error']}
                else:
                    result = success(True, f'Cards rescheduled for {days} day(s) from today.')

        else:
            result = {'status': 'error', 'error': f'Unknown command: {command}'}

        print(json.dumps(result, ensure_ascii=False))
    except json.JSONDecodeError as error:
        print(json.dumps({'status': 'error', 'error': f'Invalid JSON input: {error}'}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status': 'error', 'error': f'Plugin execution error: {error}'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
