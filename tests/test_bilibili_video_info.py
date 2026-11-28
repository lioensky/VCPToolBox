"""Bilibili video ID and metadata fallback tests."""
import importlib.util
import io
import json
import runpy
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

import requests

PLUGIN = Path(__file__).resolve().parents[1] / 'Plugin' / 'BilibiliFetch' / 'BilibiliFetch.py'
spec = importlib.util.spec_from_file_location('bilibili_fetch', PLUGIN)
bili = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bili)
BVID = 'BV1pGnn67EC2'


def response(payload=None, status=200, json_error=False):
    result = Mock(status_code=status, headers={'Content-Type': 'text/html' if json_error else 'application/json'})
    if json_error:
        result.json.side_effect = ValueError('invalid JSON')
    else:
        result.json.return_value = payload
    return result


class VideoInfoTests(unittest.TestCase):
    def test_url_variants_resolve_to_same_video(self):
        expected = (f'https://www.bilibili.com/video/{BVID}/', 1)
        for value in (BVID, expected[0], expected[0].rstrip('/')):
            with self.subTest(value=value):
                self.assertEqual(bili.resolve_video_input(value), expected)

    def test_av_inputs_keep_the_requested_page(self):
        resolved = response({'code': 0, 'data': {'bvid': BVID}})
        with patch.object(bili.requests, 'get', return_value=resolved) as get:
            for value, page in [('av12', 1), ('https://www.bilibili.com/video/av12?p=2', 2)]:
                suffix = '?p=2' if page == 2 else ''
                self.assertEqual(bili.resolve_video_input(value), (f'https://www.bilibili.com/video/{BVID}/{suffix}', page))
                self.assertEqual(get.call_args.kwargs['params'], {'aid': '12'})

    def test_view_success_returns_metadata_without_fallback(self):
        payload = {'code': 0, 'data': {'aid': 12, 'cid': 34, 'title': 'Example', 'owner': {'name': 'Author'}}}
        with patch.object(bili.requests, 'get', return_value=response(payload)) as get:
            info = bili.fetch_video_info(BVID, 1, {})
        self.assertEqual(info, {'aid': '12', 'cid': '34', 'title': 'Example', 'author': 'Author'})
        self.assertEqual(get.call_count, 1)

    def test_view_failures_still_try_pagelist(self):
        failures = [requests.Timeout(), requests.ConnectionError(), response(status=412),
                    response(json_error=True), response({'code': -400, 'message': 'bad request'}),
                    response([]), response({'code': 0, 'data': None})]
        for failure in failures:
            with self.subTest(failure=failure):
                fallback = response({'code': 0, 'data': [{'cid': 34}]})
                with patch.object(bili.requests, 'get', side_effect=[failure, fallback]) as get:
                    info = bili.fetch_video_info(BVID, 1, {})
                self.assertEqual(info['cid'], '34')
                self.assertEqual([call.args[0] for call in get.call_args_list], [bili.VIEW_API_URL, bili.PAGELIST_API_URL])

    def test_both_failures_retain_endpoint_and_reason(self):
        cases = [
            (response(status=412), response({'code': -404, 'message': 'video missing'}), ['HTTP 412', 'code=-404', 'video missing']),
            (requests.Timeout(), response(json_error=True), ['超时', 'HTTP 200', '无效JSON', 'text/html']),
            (requests.exceptions.ProxyError(), requests.exceptions.SSLError(), ['代理连接失败', 'TLS连接失败']),
        ]
        for first, second, reasons in cases:
            with self.subTest(reasons=reasons):
                with patch.object(bili.requests, 'get', side_effect=[first, second]):
                    with self.assertRaises(bili.VideoInfoError) as caught:
                        bili.fetch_video_info(BVID, 2, {})
                for fragment in [BVID, 'P2', 'view:', 'pagelist:'] + reasons:
                    self.assertIn(fragment, str(caught.exception))

    def test_missing_cid_uses_fallback_and_rejects_invalid_ids(self):
        for value in (None, '', 0, 'None'):
            with self.subTest(cid=value):
                view = response({'code': 0, 'data': {'aid': 12, 'cid': value, 'title': 'Example'}})
                fallback = response({'code': 0, 'data': [{'cid': 34}]})
                with patch.object(bili.requests, 'get', side_effect=[view, fallback]):
                    info = bili.fetch_video_info(BVID, 1, {})
                self.assertEqual((info['aid'], info['cid'], info['title']), ('12', '34', 'Example'))
        with patch.object(bili.requests, 'get', side_effect=[response({'code': 0, 'data': {}}), response({'code': 0, 'data': []})]):
            with self.assertRaises(bili.VideoInfoError):
                bili.fetch_video_info(BVID, 1, {})

    def test_stdio_error_reports_both_causes(self):
        output_bytes = io.BytesIO()
        output = io.TextIOWrapper(output_bytes, encoding='utf-8')
        request = io.StringIO(json.dumps({'url': BVID, 'need_subs': False, 'need_pbp': False}))
        with patch('sys.stdin', request), patch('sys.stdout', output):
            with patch.object(bili.requests, 'get', side_effect=[requests.Timeout(), response(status=412)]):
                runpy.run_path(str(PLUGIN), run_name='__main__')
        result = json.loads(output_bytes.getvalue())
        self.assertEqual(result['status'], 'error')
        for fragment in [BVID, 'view:', '超时', 'pagelist:', 'HTTP 412']:
            self.assertIn(fragment, result['error'])

    def test_second_page_uses_requested_cid_or_fallback(self):
        for pages in ([{'cid': 34}, {'cid': 56}], None):
            with self.subTest(pages=pages):
                view = response({'code': 0, 'data': {'aid': 12, 'cid': 34, 'pages': pages}})
                fallback = response({'code': 0, 'data': [{'cid': 34}, {'cid': 56}]})
                with patch.object(bili.requests, 'get', side_effect=[view, fallback]):
                    info = bili.fetch_video_info(BVID, 2, {})
                self.assertEqual(info['cid'], '56')
