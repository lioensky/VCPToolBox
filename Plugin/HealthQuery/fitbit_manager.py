# -*- coding: utf-8 -*-
import os
import json
import time
import requests
import base64
import webbrowser
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import datetime
import sys

def load_env_config():
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.env')
    if os.path.exists(config_path):
        with open(config_path, 'r', encoding='utf-8') as f:
            for line in f:
                if '=' in line and not line.startswith('#'):
                    k, v = line.strip().split('=', 1)
                    os.environ[k.strip()] = v.strip()

load_env_config()

# Now read from os.environ
CLIENT_ID = os.environ.get('CLIENT_ID')
CLIENT_SECRET = os.environ.get('CLIENT_SECRET')
REDIRECT_URI = os.environ.get('REDIRECT_URI', 'http://localhost:8129/')
TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.environ.get('TOKEN_FILE', 'tokens.json'))


def _request_timeout_seconds():
    try:
        return float(os.environ.get('FITBIT_REQUEST_TIMEOUT_SECONDS', '20'))
    except (TypeError, ValueError):
        return 20.0


REQUEST_TIMEOUT_SECONDS = _request_timeout_seconds()

# Scopes
SCOPES = [
    'activity', 'heartrate', 'location', 'nutrition',
    'profile', 'settings', 'sleep', 'social', 'weight', 'oxygen_saturation',
    'respiratory_rate', 'temperature'
]

class OAuthCallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_path.query)

        if 'code' in query_params:
            self.server.auth_code = query_params['code'][0]
            self.send_response(200)
            self.send_header('Content-type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(b"<html><head><title>Auth Success</title></head><body><h1 style='color:green'>Authorization Successful!</h1><p>You can close this window and return to VCP.</p><script>window.close()</script></body></html>")
        else:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Authorization Failed: No code found.")

class FitbitManager:
    def __init__(self):
        self.client_id = CLIENT_ID
        self.client_secret = CLIENT_SECRET
        self.redirect_uri = REDIRECT_URI
        self.token_file = TOKEN_FILE
        self.tokens = self._load_tokens()

    def _load_tokens(self):
        if os.path.exists(self.token_file):
            try:
                with open(self.token_file, 'r') as f:
                    return json.load(f)
            except Exception as e:
                print(f"[FitbitManager] Error loading tokens: {e}", file=sys.stderr)
        return None

    def _save_tokens(self, tokens):
        self.tokens = tokens
        with open(self.token_file, 'w') as f:
            json.dump(tokens, f, indent=2)

    def is_authenticated(self):
        return self.tokens is not None

    def authorize(self):
        """Initiates the OAuth2 authorization flow."""
        # 1. Generate Auth URL
        base_url = "https://www.fitbit.com/oauth2/authorize"
        params = {
            'client_id': self.client_id,
            'response_type': 'code',
            'scope': ' '.join(SCOPES),
            'redirect_uri': self.redirect_uri,
            'expires_in': '31536000' # 1 year consent
        }
        auth_url = f"{base_url}?{urllib.parse.urlencode(params)}"

        print(f"\n[FitbitManager] Auth URL (Copy this if browser fails):", file=sys.stderr)
        print(f"{auth_url}\n", file=sys.stderr)
        print(f"[FitbitManager] Opening browser for authentication...", file=sys.stderr)
        # webbrowser.open(auth_url)

        # 2. Start local server to catch code
        port = int(urllib.parse.urlparse(self.redirect_uri).port)
        server = HTTPServer(('localhost', port), OAuthCallbackHandler)
        server.auth_code = None

        print(f"[FitbitManager] Waiting for callback on port {port}...", file=sys.stderr)
        server.handle_request() # Blocking call, handles one request

        if server.auth_code:
            print(f"[FitbitManager] Auth code received. Exchanging for tokens...", file=sys.stderr)
            return self._exchange_code_for_token(server.auth_code)
        else:
            raise Exception("Authorization failed: No code received.")

    def exchange_code_manually(self, code):
        """Manually exchange a code for tokens."""
        print(f"[FitbitManager] Exchanging manual code: {code[:10]}...", file=sys.stderr)
        return self._exchange_code_for_token(code)

    def _exchange_code_for_token(self, code):
        token_url = "https://api.fitbit.com/oauth2/token"
        auth_string = f"{self.client_id}:{self.client_secret}"
        b64_auth = base64.b64encode(auth_string.encode('utf-8')).decode('utf-8')

        headers = {
            'Authorization': f"Basic {b64_auth}",
            'Content-Type': 'application/x-www-form-urlencoded'
        }

        data = {
            'clientId': self.client_id,
            'grant_type': 'authorization_code',
            'redirect_uri': self.redirect_uri,
            'code': code
        }

        response = requests.post(token_url, headers=headers, data=data, timeout=REQUEST_TIMEOUT_SECONDS)
        if response.status_code == 200:
            tokens = response.json()
            # Add timestamp to calculate expiry locally if needed, though requests usually checks 401
            tokens['obtained_at'] = time.time()
            self._save_tokens(tokens)
            return True
        else:
            print(f"[FitbitManager] Token exchange failed: {response.text}", file=sys.stderr)
            return False

    def _refresh_token(self):
        if not self.tokens or 'refresh_token' not in self.tokens:
            raise Exception("No refresh token available.")

        token_url = "https://api.fitbit.com/oauth2/token"
        auth_string = f"{self.client_id}:{self.client_secret}"
        b64_auth = base64.b64encode(auth_string.encode('utf-8')).decode('utf-8')

        headers = {
            'Authorization': f"Basic {b64_auth}",
            'Content-Type': 'application/x-www-form-urlencoded'
        }

        data = {
            'grant_type': 'refresh_token',
            'refresh_token': self.tokens['refresh_token']
        }

        print("[FitbitManager] Refreshing access token...", file=sys.stderr)
        response = requests.post(token_url, headers=headers, data=data, timeout=REQUEST_TIMEOUT_SECONDS)
        if response.status_code == 200:
            new_tokens = response.json()
            new_tokens['obtained_at'] = time.time()
            self._save_tokens(new_tokens)
            return True
        else:
            print(f"[FitbitManager] Token refresh failed: {response.text}", file=sys.stderr)
            return False

    def get(self, endpoint):
        """Makes an authenticated GET request to Fitbit API."""
        if not self.tokens:
            raise Exception("Not authenticated. Please run authorization.")

        headers = {
            'Authorization': f"Bearer {self.tokens['access_token']}",
            'Accept-Language': 'en_US' # Ensure units are consistent or localized if needed
        }

        base_url = "https://api.fitbit.com"
        url = f"{base_url}{endpoint}"

        response = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)

        # Handle Token Expiry
        if response.status_code == 401:
            print("[FitbitManager] Access token expired. Refreshing...", file=sys.stderr)
            if self._refresh_token():
                # Retry request with new token
                headers['Authorization'] = f"Bearer {self.tokens['access_token']}"
                response = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)
            else:
                raise Exception("Token expired and refresh failed.")

        if response.status_code != 200:
            raise Exception(f"API Request Failed ({response.status_code}): {response.text}")

        return response.json()

    # --- Specific Data Methods ---

    def get_profile(self):
        return self.get("/1/user/-/profile.json")

    def get_daily_activity_summary(self, date_str):
        """
        date_str: 'YYYY-MM-DD' or 'today'
        """
        return self.get(f"/1/user/-/activities/date/{date_str}.json")

    def get_heart_rate_intraday(self, date_str, detail_level='1min'):
        """
        Get detailed heart rate.
        detail_level: 1sec or 1min
        """
        return self.get(f"/1/user/-/activities/heart/date/{date_str}/1d/{detail_level}.json")

    def get_sleep_log(self, date_str):
        """
        Get sleep log for a date.
        Note: Fitbit Sleep API uses the end date of the sleep.
        """
        return self.get(f"/1.2/user/-/sleep/date/{date_str}.json")

if __name__ == "__main__":
    # Simple test when run directly
    manager = FitbitManager()
    if not manager.is_authenticated():
        print("Starting Auth Flow...")
        manager.authorize()

    try:
        profile = manager.get_profile()
        print("User Profile:", profile['user']['displayName'])
    except Exception as e:
        print(f"Error: {e}")
