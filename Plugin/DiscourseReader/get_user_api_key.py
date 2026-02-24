#!/usr/bin/env python3
"""
Discourse User API Key Generator
=================================
Obtains a permanent read-only API key from any Discourse forum
via the standard RSA handshake protocol.

Usage:
  python get_user_api_key.py <forum_url>

Example:
  python get_user_api_key.py https://linux.do
  python get_user_api_key.py https://meta.discourse.org

Requirements:
  pip install pycryptodomex
"""

import json, sys, os
from base64 import b64decode
from secrets import token_urlsafe
from urllib.parse import urlencode

try:
    from Cryptodome.PublicKey import RSA
    from Cryptodome.Cipher import PKCS1_v1_5
    from Cryptodome.Random import get_random_bytes
except ImportError:
    print("[ERROR] pycryptodomex not installed. Run: pip install pycryptodomex")
    sys.exit(1)

def main():
    if len(sys.argv) < 2:
        print("Usage: python get_user_api_key.py <forum_url>")
        print("Example: python get_user_api_key.py https://linux.do")
        sys.exit(1)

    host = sys.argv[1].rstrip("/")
    print(f"=== Discourse User API Key Generator ===")
    print(f"Forum: {host}\n")

    # Step 1: Generate RSA keypair
    print("[1/3] Generating RSA 2048-bit keypair...")
    key = RSA.generate(2048)

    # Step 2: Build authorization URL
    query = urlencode({
        "application_name": "DiscourseReader",
        "client_id": token_urlsafe(),
        "scopes": "read",
        "public_key": key.publickey().export_key().decode(),
        "nonce": "1",
    })
    auth_url = f"{host}/user-api-key/new?{query}"

    print("[2/3] Authorization URL generated.\n")
    print("=" * 60)
    print("Open this URL in your browser (make sure you are logged in):")
    print()
    print(auth_url)
    print()
    print("=" * 60)
    print()
    print("After clicking 'Authorize', the page will show an encrypted key.")
    print("Copy the ENTIRE ciphertext and paste it below.")
    print()

    # Step 3: Decrypt
    ciphertext = input("Paste ciphertext here: ").strip()
    if not ciphertext:
        print("[ERROR] No ciphertext provided.")
        sys.exit(1)

    # Clean up whitespace/newlines that may be in the pasted text
    ciphertext = ciphertext.replace(" ", "").replace("\n", "").replace("\r", "")

    print("\n[3/3] Decrypting...")
    try:
        sentinel = get_random_bytes(16)
        cipher = PKCS1_v1_5.new(key)
        plaintext = cipher.decrypt(b64decode(ciphertext), sentinel)
        data = json.loads(plaintext.decode())
        api_key = data["key"]
    except Exception as e:
        print(f"[ERROR] Decryption failed: {e}")
        print("Make sure you copied the complete ciphertext.")
        sys.exit(1)

    # Extract forum name for config
    from urllib.parse import urlparse
    hostname = urlparse(host).hostname or "example"
    forum_name = hostname.replace(".", "").replace("-", "")

    print()
    print("=" * 60)
    print(f"  SUCCESS! Your User API Key: {api_key}")
    print("=" * 60)
    print()
    print(f"Add this line to DiscourseReader/config.env:")
    print(f"  forum_{forum_name}_api_key={api_key}")
    print()
    print(f"This key is permanent and works for: {host}")
    print("To revoke: visit your forum profile -> Preferences -> API")

if __name__ == "__main__":
    main()