"""Bilibili content-selection contracts; run with unittest discovery."""
from contextlib import ExitStack
import importlib.util
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import Mock, patch

from PIL import Image

PLUGIN = Path(__file__).resolve().parents[1] / 'Plugin' / 'BilibiliFetch' / 'BilibiliFetch.py'
spec = importlib.util.spec_from_file_location('bilibili_fetch_content_selection', PLUGIN)
bili = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bili)
BVID = 'BV1pGnn67EC2'


def response(payload):
    result = Mock()
    result.json.return_value = payload
    return result


class ContentSelectionTests(unittest.TestCase):
    """Protect selected content and image payloads across the public request entry."""

    def check_selection(self, request, expected, direct=False):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            image_path = Path(directory) / 'hd_snapshot_fixture.jpg'
            Image.new('RGB', (4, 4), 'red').save(image_path)
            image_bytes = image_path.read_bytes()
            stack.enter_context(patch.dict(bili.os.environ, {'PROJECT_BASE_PATH': directory}))
            stack.enter_context(patch.object(bili, 'build_bilibili_cookie', return_value=''))
            stack.enter_context(patch.object(bili, 'fetch_videoshot', return_value={
                'image': ['https://fixture.invalid/sprite.jpg'], 'index': [0, 30, 120],
                'img_x_size': 2, 'img_y_size': 2, 'img_x_len': 2, 'img_y_len': 2}))
            def get(url, **kwargs):
                if url == bili.VIEW_API_URL:
                    return response({'code': 0, 'data': {
                        'aid': 12, 'cid': 34, 'title': 'Fixture', 'owner': {'name': 'Author'}}})
                if url == 'https://fixture.invalid/sprite.jpg':
                    return Mock(content=image_bytes)
                raise AssertionError(f'Unexpected network request: {url}')

            stack.enter_context(patch.object(bili.requests, 'get', side_effect=get))
            stack.enter_context(patch.object(bili, 'fetch_hd_snapshot', return_value=str(image_path)))
            stack.enter_context(patch.object(bili, 'get_accessible_url', return_value='https://fixture.invalid/snapshot.jpg'))
            sources = {
                'subs': ('process_bilibili_url', 'subtitle-payload'),
                'pbp': ('fetch_pbp', 'energy-payload'),
                'danmaku': ('fetch_danmaku', ['danmaku-payload']),
                'comments': ('fetch_comments', ['comment-payload'])
            }
            mocks = {key: stack.enter_context(patch.object(bili, name, return_value=value))
                     for key, (name, value) in sources.items()}
            if direct:
                result = bili.process_bilibili_enhanced(BVID, **request)
            else:
                result = bili.handle_single_request({'url': BVID, **request})
            text = '\n'.join(part['text'] for part in result['content'] if part['type'] == 'text')
            # Assert requested data and actual fetches together, independent of display wording.
            for key, (_, value) in sources.items():
                token = value[0] if isinstance(value, list) else value
                self.assertEqual(mocks[key].call_count, int(expected[key]), key)
                self.assertEqual(token in text, bool(expected[key]), key)
            images = [part for part in result['content'] if part['type'] == 'image_url']
            self.assertEqual(len(images), expected.get('images', 0))
            for image in images:
                self.assertTrue(image['image_url']['url'].startswith('data:image/jpeg;base64,'))
            if expected['comments']:
                self.assertEqual(mocks['comments'].call_args.args[1], int(request['comment_num']))
            if expected['danmaku']:
                self.assertEqual(mocks['danmaku'].call_args.args[1], int(request['danmaku_num']))

    def test_direct_tool_requests_fetch_only_selected_content(self):
        lean = dict(subs=False, pbp=False, danmaku=False, comments=False)
        cases = [
            ({}, {**lean, 'subs': True, 'pbp': True}),
            ({'snapshots': '30', 'hd_snapshot': 'true'}, {**lean, 'images': 1}),
            ({'snapshots': [30]}, {**lean, 'images': 1}),
            ({'snapshots': ' , '}, {**lean, 'subs': True, 'pbp': True}),
            ({'snapshots': '30', 'need_subs': ' true ', 'need_pbp': True},
             {**lean, 'subs': True, 'pbp': True, 'images': 1}),
            ({'snapshots': '30', 'comment_num': '5', 'danmaku_num': '10'},
             {**lean, 'comments': True, 'danmaku': True, 'images': 1}),
            ({'need_subs': ' false ', 'need_pbp': '0'}, lean),
            ({'need_subs': False, 'need_pbp': False, 'comment_num': 1}, {**lean, 'comments': True})
        ]
        for request, expected in cases:
            with self.subTest(request=request):
                self.check_selection(request, expected)

    def test_python_api_uses_same_snapshot_defaults_and_explicit_overrides(self):
        lean = dict(subs=False, pbp=False, danmaku=False, comments=False, images=1)
        for flags in ({}, {'need_subs': True, 'need_pbp': True}):
            with self.subTest(flags=flags):
                self.check_selection({'snapshot_at_times': [30], **flags},
                                     {**lean, 'subs': bool(flags), 'pbp': bool(flags)}, direct=True)

    def test_search_and_up_video_requests_keep_their_parameters(self):
        for request, function, args in [
            ({'action': 'search', 'keyword': 'Python', 'search_type': 'bili_user', 'page': '2'},
             'search_bilibili', ('Python', 'bili_user', 2)),
            ({'action': 'get_up_videos', 'mid': '123', 'pn': '2', 'ps': '10'},
             'get_up_videos', ('123', 2, 10))
        ]:
            with self.subTest(action=request['action']), patch.object(bili, function, return_value={'fixture': True}) as fetch:
                self.assertEqual(bili.handle_single_request(request), {'fixture': True})
                fetch.assert_called_once_with(*args)

    def test_stdio_batch_preserves_each_tasks_explicit_content_selection(self):
        def get(url, **kwargs):
            if url == bili.VIEW_API_URL:
                return response({'code': 0, 'data': {'aid': 12, 'cid': 34, 'title': 'Fixture', 'owner': {'name': 'Author'}}})
            if url.endswith('/x/player/videoshot'):
                return response({'code': 0, 'data': {}})
            if url.endswith('/x/v2/reply'):
                return response({'code': 0, 'data': {'replies': [
                    {'member': {'uname': 'Author'}, 'content': {'message': 'batch-comment-payload'}, 'like': 1}]}})
            raise AssertionError(f'Unexpected network request: {url}')

        request = {'url1': BVID, 'snapshots1': '30',
                   'url2': BVID, 'snapshots2': '60', 'comment_num2': '1'}
        output_bytes = io.BytesIO()
        output = io.TextIOWrapper(output_bytes, encoding='utf-8')
        with patch('sys.stdin', io.StringIO(json.dumps(request))), patch('sys.stdout', output):
            with patch.object(bili.requests, 'get', side_effect=get) as fetch:
                runpy.run_path(str(PLUGIN), run_name='__main__')
        result = json.loads(output_bytes.getvalue())
        self.assertEqual(result['status'], 'success')
        parts = result['result']['content']
        self.assertEqual([part['type'] for part in parts], ['text'] * 4)
        self.assertEqual(['batch-comment-payload' in part['text'] for part in (parts[1], parts[3])], [False, True])
        self.assertEqual(sum(call.args[0].endswith('/x/v2/reply') for call in fetch.call_args_list), 1)


if __name__ == '__main__':
    unittest.main()
