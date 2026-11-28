"""Segmented danmaku collection and sampling tests."""
import importlib.util
import json
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


def pb_varint(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def pb_field(number, value):
    if isinstance(value, str):
        value = value.encode('utf-8')
    if isinstance(value, bytes):
        return pb_varint(number * 8 + 2) + pb_varint(len(value)) + value
    return pb_varint(number * 8) + pb_varint(value)


def dm_segment(*items):
    return b''.join(pb_field(1, pb_field(1, dmid) + pb_field(2, progress)
                             + pb_field(7, text)) for dmid, progress, text in items)


def binary_response(content):
    return Mock(content=content)


class DanmakuCollectionTests(unittest.TestCase):
    """Protect whole-pool sampling, time-local merging and visible partial failures."""

    def test_tool_samples_merged_groups_from_every_segment_then_sorts_by_time(self):
        segments = {
            1: dm_segment((1, 0, '开头'), (2, 2000, '开头！'), (3, 318900, '结尾 & 反转')),
            11: dm_segment((4, 3918200, '一小时后')),
            12: dm_segment((5, 4000000, '最后一条')),
        }
        seen_segments = []

        def get(url, **kwargs):
            if url.endswith('/x/web-interface/view'):
                return response({'code': 0, 'data': {
                    'aid': 12, 'cid': 34, 'title': 'Fixture', 'owner': {'name': 'Author'}, 'duration': 4001}})
            if url.endswith('/x/player/videoshot'):
                return response({'code': 0, 'data': {}})
            if url == bili.DANMAKU_VIEW_URL:
                return binary_response(pb_field(4, pb_field(1, 360000) + pb_field(2, 100)))
            if url == bili.PAGELIST_API_URL:
                self.assertEqual(kwargs['params'], {'bvid': BVID})
                return binary_response(json.dumps({'code': 0, 'data': [
                    {'cid': 34, 'duration': 4001}, {'cid': 56, 'duration': 9000},
                ]}).encode())
            if url == bili.DANMAKU_SEGMENT_URL:
                self.assertEqual(kwargs['params']['oid'], '34')
                index = kwargs['params']['segment_index']
                seen_segments.append(index)
                return binary_response(segments.get(index, b''))
            raise AssertionError(f'Unexpected network request: {url}')

        def choose(population, count):
            self.assertEqual(count, 3)
            self.assertEqual(len(population), 4)
            self.assertEqual([g['count'] for g in population], [2, 1, 1, 1])
            # The final group's eligibility proves the limit is applied after collection/merging.
            return [population[-1], population[0], population[2]]

        with patch.object(bili.requests, 'get', side_effect=get), patch.object(
                bili.random, 'sample', side_effect=choose) as sample:
            result = bili.handle_single_request({
                'url': BVID, 'danmaku_num': 3, 'need_subs': False, 'need_pbp': False})
        output = '\n'.join(part['text'] for part in result['content'] if part['type'] == 'text')
        self.assertEqual(sorted(seen_segments), list(range(1, 13)))
        sample.assert_called_once()
        self.assertEqual([line for line in output.splitlines() if line.startswith('[')], [
            '[00:00~00:02] 开头 （合并 2 条）', '[01:05:18] 一小时后', '[01:06:40] 最后一条'])

    def test_merge_keeps_separate_events_numbers_negation_and_unknown_times(self):
        def entry(position, text, dmid=''):
            return {'time': position, 'text': text, 'id': dmid}
        entries = [entry(1, 'ＡＢＣ！', '1'), entry(2, 'abc', '2'), entry(2, 'abc', '2'),
                   entry(32, 'abc', '3'), entry(5, '今天这个视频真的非常好看'),
                   entry(6, '今天这个视频真的非常好看啊'),
                   entry(7, '今天这个视频真的非常不好看'),
                   entry(8, '今天这个视频真的打分100分'),
                   entry(9, '今天这个视频真的打分101分'),
                   entry(None, 'abc'), entry(None, 'abc')]
        groups = bili._merge_danmaku(entries)
        self.assertEqual([(g['start'], g['end'], g['count']) for g in groups], [
            (1, 2, 2), (5, 6, 2), (7, 7, 1), (8, 8, 1), (9, 9, 1),
            (32, 32, 1), (None, None, 1), (None, None, 1)])

    def test_xml_fallback_retains_invalid_times_and_sorts_known_times(self):
        xml = """<i>
            <d p="0,1" />
            <d>缺失时间</d><d p="">空时间</d><d p="bad,1">损坏时间</d>
            <d p="-0.5,1">负数时间</d><d p="nan,1">非数值</d>
            <d p="inf,1">无穷大</d><d p="60,1">正常弹幕</d>
        </i>"""
        with patch.object(bili.requests, 'get', side_effect=[
                requests.Timeout(), binary_response(xml.encode('utf-8'))]), patch.object(
                bili.random, 'sample') as sample:
            result = bili.fetch_danmaku('34', 100, {})
        self.assertEqual(result, [
            '[01:00] 正常弹幕', '[时间未知] 缺失时间', '[时间未知] 空时间', '[时间未知] 损坏时间',
            '[时间未知] 负数时间', '[时间未知] 非数值', '[时间未知] 无穷大'])
        sample.assert_not_called()
        self.assertFalse(result.coverage_complete)
        self.assertTrue(result.warnings)

    def test_partial_segment_failure_supplements_xml_without_double_counting(self):
        xml = '<i><d p="1,1,25,0,0,0,user,1">开头</d><d p="500,1,25,0,0,0,user,3">后半段</d></i>'

        def get(url, **kwargs):
            if url == bili.DANMAKU_VIEW_URL:
                return binary_response(pb_field(4, pb_field(2, 2)))
            if url == bili.DANMAKU_SEGMENT_URL:
                if kwargs['params']['segment_index'] == 2:
                    raise requests.Timeout()
                return binary_response(dm_segment((1, 1000, '开头')))
            if url == bili.DANMAKU_XML_URL:
                return binary_response(xml.encode('utf-8'))
            raise AssertionError(url)

        with patch.object(bili.requests, 'get', side_effect=get):
            result = bili.fetch_danmaku('34', 10, {})
        self.assertEqual(result, ['[00:01] 开头', '[08:20] 后半段'])
        self.assertEqual((result.completed_segments, result.total_segments), (1, 2))
        self.assertFalse(result.coverage_complete)
        self.assertTrue(result.warnings)

    def test_malformed_protobuf_uses_fallback_and_unknown_fields_are_skipped(self):
        # Fields added upstream may have varint, fixed64, length-delimited or fixed32 wire types.
        unknown = pb_field(90, 3) + pb_varint(91 * 8 + 1) + b'12345678'
        unknown += pb_field(92, b'new') + pb_varint(93 * 8 + 5) + b'1234'
        self.assertEqual(bili._parse_danmaku_segment(unknown + dm_segment((9, 1234, '兼容'))), [
            {'time': 1.234, 'text': '兼容', 'id': '9'}])
        for malformed in (b'\x80', b'\x22\xff', b'\x22\x05x', b'\xff' * 11, b'\x00'):
            with self.subTest(data=malformed), patch.object(bili.requests, 'get', side_effect=[
                    binary_response(malformed), binary_response(b'<i><d p="1">fallback</d></i>')]):
                result = bili.fetch_danmaku('34', 10, {})
                self.assertEqual(result, ['[00:01] fallback'])
                self.assertFalse(result.coverage_complete)
                self.assertTrue(result.warnings)

    def test_all_fetch_failures_still_surface_collection_status_in_tool_output(self):
        def get(url, **kwargs):
            if url.endswith('/x/web-interface/view'):
                return response({'code': 0, 'data': {'aid': 12, 'cid': 34}})
            if url.endswith('/x/player/videoshot'):
                return response({'code': 0, 'data': {}})
            raise requests.Timeout()

        collected = []
        original = bili.fetch_danmaku

        def collect(*args, **kwargs):
            result = original(*args, **kwargs)
            collected.append(result)
            return result

        with patch.object(bili.requests, 'get', side_effect=get), patch.object(
                bili, 'fetch_danmaku', side_effect=collect):
            result = bili.handle_single_request({
                'url': BVID, 'danmaku_num': 10, 'need_subs': False, 'need_pbp': False})
        text = '\n'.join(part['text'] for part in result['content'] if part['type'] == 'text')
        self.assertEqual(len(collected), 1)
        self.assertFalse(collected[0].coverage_complete)
        self.assertEqual(len(collected[0].warnings), 2)
        self.assertTrue(text.endswith(collected[0].summary))
