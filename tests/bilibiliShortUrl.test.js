const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

test('BilibiliFetch resolve_short_url converts b23.tv short links into canonical video URLs', () => {
    const pyScript = `
import os, sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(${JSON.stringify(REPO_ROOT)}, "Plugin", "BilibiliFetch"))
import BilibiliFetch as bf

class DummyResp:
    def __init__(self, final_url):
        self.url = final_url
        self.closed = False
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, tb):
        self.closed = True
        return False

calls = []
def make_fake_get(final_url):
    def _fake_get(url, **kwargs):
        calls.append((url, kwargs))
        return DummyResp(final_url)
    return _fake_get

# 1. Plain b23.tv short URL redirecting to a localized/tracking URL -> canonical video URL
with patch.object(bf.requests, "get", side_effect=make_fake_get("https://www.bilibili.com/zh-Hans/video/BV14xy6zXE2F/?p=1&buvid=abc&share_source=GENERIC")):
    got = bf.resolve_short_url("https://b23.tv/ZbeYGRr")
    assert got == "https://www.bilibili.com/video/BV14xy6zXE2F", got
    assert bf.extract_bvid_and_page(got) == ("BV14xy6zXE2F", 1)

# 2. Share text containing title + b23.tv short URL
calls.clear()
with patch.object(bf.requests, "get", side_effect=make_fake_get("https://www.bilibili.com/video/BV14xy6zXE2F?share_medium=android")):
    got = bf.resolve_short_url("视频标题示例 https://b23.tv/ZbeYGRr")
    assert got == "https://www.bilibili.com/video/BV14xy6zXE2F", got
    assert calls[0][0] == "https://b23.tv/ZbeYGRr", calls

# 3. Scheme-less b23.tv short URL with multi-part ?p=3
calls.clear()
with patch.object(bf.requests, "get", side_effect=make_fake_get("https://m.bilibili.com/video/BV1CC4y1a7ee?p=3&buvid=xyz")):
    got = bf.resolve_short_url("b23.tv/abc123")
    assert got == "https://www.bilibili.com/video/BV1CC4y1a7ee?p=3", got
    assert calls[0][0] == "https://b23.tv/abc123", calls
    assert bf.extract_bvid_and_page(got) == ("BV1CC4y1a7ee", 3)

# 4. Non-short URLs are returned untouched without making any HTTP request
calls.clear()
with patch.object(bf.requests, "get", side_effect=AssertionError("should not request")):
    assert bf.resolve_short_url("https://www.bilibili.com/video/BV14xy6zXE2F") == "https://www.bilibili.com/video/BV14xy6zXE2F"
    assert bf.resolve_short_url("BV14xy6zXE2F") == "BV14xy6zXE2F"

# 5. Non-video b23.tv redirect falls back to resolved URL
with patch.object(bf.requests, "get", side_effect=make_fake_get("https://live.bilibili.com/12345")):
    assert bf.resolve_short_url("https://b23.tv/live123") == "https://live.bilibili.com/12345"

print("BILIBILI_SHORT_URL_TESTS_OK")
`;
    const out = execFileSync('python3', ['-c', pyScript], { encoding: 'utf8' });
    assert.match(out, /BILIBILI_SHORT_URL_TESTS_OK/);
});
