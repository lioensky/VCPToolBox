#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import json
import os
import re
import html
import logging
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse, parse_qs

import requests

try:
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api._errors import (
        TranscriptsDisabled,
        NoTranscriptFound,
        VideoUnavailable,
        CouldNotRetrieveTranscript,
    )
except Exception:
    YouTubeTranscriptApi = None
    TranscriptsDisabled = Exception
    NoTranscriptFound = Exception
    VideoUnavailable = Exception
    CouldNotRetrieveTranscript = Exception


# --- Logging Setup ---
# stdout 仅输出插件 JSON 结果；日志全部写 stderr，避免干扰 VCP stdio 通信。
class UTF8StreamHandler(logging.StreamHandler):
    def emit(self, record):
        try:
            msg = self.format(record)
            stream = self.stream
            if hasattr(stream, "buffer"):
                stream.buffer.write((msg + self.terminator).encode("utf-8"))
                stream.buffer.flush()
            else:
                stream.write(msg + self.terminator)
                self.flush()
        except Exception:
            self.handleError(record)


handler = UTF8StreamHandler(sys.stderr)
handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
logging.getLogger().addHandler(handler)
logging.getLogger().setLevel(logging.INFO)


YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"
YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v={video_id}"


def get_api_key() -> str:
    """读取插件配置中的 YouTube Data API v3 Key。"""
    return (
        os.environ.get("YoutubeAPI")
        or os.environ.get("YOUTUBE_API_KEY")
        or os.environ.get("YoutubeApi")
        or ""
    ).strip()


def get_proxy_config() -> Optional[Dict[str, str]]:
    """根据 YoutubeProxyPort 构造 requests 代理。留空则不启用。"""
    port = (os.environ.get("YoutubeProxyPort") or "").strip()
    if not port:
        return None

    if port.startswith("http://") or port.startswith("https://") or port.startswith("socks"):
        proxy_url = port
    else:
        proxy_url = f"http://127.0.0.1:{port}"

    return {"http": proxy_url, "https": proxy_url}


def youtube_api_get(endpoint: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """调用 YouTube Data API v3。"""
    api_key = get_api_key()
    if not api_key:
        raise ValueError("缺少 YoutubeAPI 配置，请在 Plugin/YoutubeFetch/config.env 中填写 YouTube Data API v3 Key。")

    clean_params = {k: v for k, v in params.items() if v is not None and v != ""}
    clean_params["key"] = api_key

    url = f"{YOUTUBE_API_BASE}/{endpoint}"
    logging.info(f"Calling YouTube API endpoint: {endpoint}")
    response = requests.get(url, params=clean_params, proxies=get_proxy_config(), timeout=20)
    try:
        data = response.json()
    except Exception:
        response.raise_for_status()
        raise

    if response.status_code >= 400 or "error" in data:
        error = data.get("error", {})
        message = error.get("message") or response.text[:500]
        raise RuntimeError(f"YouTube API 请求失败: {message}")

    return data


def parse_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "y", "on")
    return default


def clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except Exception:
        parsed = default
    return max(minimum, min(maximum, parsed))


def parse_video_id(video_input: str) -> Optional[str]:
    """从 YouTube URL / youtu.be 短链 / Shorts URL / embed URL / 直接 ID 中提取 videoId。"""
    if not video_input:
        return None

    raw = video_input.strip()

    if re.fullmatch(r"[0-9A-Za-z_-]{11}", raw):
        return raw

    # 兼容 AI 输出中带尖括号或 Markdown 的场景。
    raw = raw.strip("<>()[]")

    try:
        parsed = urlparse(raw)
        host = parsed.netloc.lower().replace("www.", "").replace("m.", "")

        if host in ("youtube.com", "music.youtube.com"):
            query_id = parse_qs(parsed.query).get("v", [None])[0]
            if query_id and re.fullmatch(r"[0-9A-Za-z_-]{11}", query_id):
                return query_id

            path_parts = [p for p in parsed.path.split("/") if p]
            for marker in ("shorts", "embed", "live", "v"):
                if marker in path_parts:
                    idx = path_parts.index(marker)
                    if idx + 1 < len(path_parts):
                        candidate = path_parts[idx + 1]
                        if re.fullmatch(r"[0-9A-Za-z_-]{11}", candidate):
                            return candidate

        if host == "youtu.be":
            candidate = parsed.path.strip("/").split("/")[0]
            if re.fullmatch(r"[0-9A-Za-z_-]{11}", candidate):
                return candidate
    except Exception:
        pass

    match = re.search(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([0-9A-Za-z_-]{11})", raw)
    if match:
        return match.group(1)

    return None


def parse_channel_id(channel_input: str) -> Optional[str]:
    """从频道 ID 或频道 URL 中提取 channelId。@handle/custom URL 需要通过搜索解析，不在此处强行转换。"""
    if not channel_input:
        return None

    raw = channel_input.strip()
    if raw.startswith("UC") and len(raw) >= 20:
        return raw

    try:
        parsed = urlparse(raw)
        parts = [p for p in parsed.path.split("/") if p]
        if "channel" in parts:
            idx = parts.index("channel")
            if idx + 1 < len(parts):
                return parts[idx + 1]
    except Exception:
        pass

    return raw


def parse_iso8601_duration(duration: str) -> str:
    """将 YouTube ISO 8601 时长转换为 HH:MM:SS / MM:SS。"""
    if not duration:
        return "未知"
    match = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", duration)
    if not match:
        return duration

    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    seconds = int(match.group(3) or 0)

    if hours:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def format_count(value: Any) -> str:
    if value is None:
        return "未知"
    try:
        n = int(value)
    except Exception:
        return str(value)

    if n >= 100000000:
        return f"{n / 100000000:.2f}亿"
    if n >= 10000:
        return f"{n / 10000:.2f}万"
    return str(n)


def safe_text(value: Any, limit: Optional[int] = None) -> str:
    text = html.unescape(str(value or "")).replace("\r", "\n").strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    if limit and len(text) > limit:
        return text[:limit].rstrip() + "..."
    return text


def format_timestamp(seconds_value: float) -> str:
    seconds = int(float(seconds_value or 0))
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    seconds = seconds % 60
    if hours:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def get_video_details(video_input: str) -> Dict[str, Any]:
    video_id = parse_video_id(video_input)
    if not video_id:
        raise ValueError(f"无法从输入提取 YouTube videoId: {video_input}")

    data = youtube_api_get(
        "videos",
        {
            "part": "snippet,contentDetails,statistics,status",
            "id": video_id,
            "maxResults": 1,
        },
    )
    items = data.get("items", [])
    if not items:
        raise ValueError(f"未找到视频: {video_input}")

    video = items[0]
    snippet = video.get("snippet", {})
    content = video.get("contentDetails", {})
    stats = video.get("statistics", {})

    return {
        "id": video.get("id"),
        "title": snippet.get("title"),
        "description": snippet.get("description"),
        "publishedAt": snippet.get("publishedAt"),
        "channelId": snippet.get("channelId"),
        "channelTitle": snippet.get("channelTitle"),
        "tags": snippet.get("tags", []),
        "categoryId": snippet.get("categoryId"),
        "duration": content.get("duration"),
        "durationText": parse_iso8601_duration(content.get("duration")),
        "definition": content.get("definition"),
        "caption": content.get("caption"),
        "licensedContent": content.get("licensedContent"),
        "viewCount": stats.get("viewCount"),
        "likeCount": stats.get("likeCount"),
        "commentCount": stats.get("commentCount"),
        "thumbnails": snippet.get("thumbnails", {}),
        "url": YOUTUBE_WATCH_URL.format(video_id=video.get("id")),
    }


def normalize_transcript_segment(segment: Any) -> Dict[str, Any]:
    if isinstance(segment, dict):
        text = segment.get("text", "")
        start = segment.get("start", 0)
        duration = segment.get("duration", 0)
    else:
        text = getattr(segment, "text", "")
        start = getattr(segment, "start", 0)
        duration = getattr(segment, "duration", 0)

    try:
        start_float = float(start)
    except Exception:
        start_float = 0.0

    try:
        duration_float = float(duration)
    except Exception:
        duration_float = 0.0

    return {
        "text": safe_text(text),
        "start": start_float,
        "duration": duration_float,
        "timestamp": format_timestamp(start_float),
    }


def _call_transcript_api(method_name: str, *args, **kwargs):
    """兼容 youtube-transcript-api 旧版静态 API 与新版实例 API。"""
    proxies = kwargs.pop("proxies", None)

    # 旧版 API：YouTubeTranscriptApi.get_transcript / list_transcripts
    if hasattr(YouTubeTranscriptApi, method_name):
        method = getattr(YouTubeTranscriptApi, method_name)
        try:
            return method(*args, proxies=proxies, **kwargs)
        except TypeError:
            return method(*args, **kwargs)

    # 新版 API：YouTubeTranscriptApi().fetch / .list
    api = YouTubeTranscriptApi()
    if method_name == "get_transcript" and hasattr(api, "fetch"):
        return api.fetch(*args, **kwargs)
    if method_name == "list_transcripts" and hasattr(api, "list"):
        return api.list(*args, **kwargs)

    raise AttributeError(f"YouTubeTranscriptApi does not support method: {method_name}")


def fetch_transcript(video_input: str, lang: Optional[str] = None, translate_to: Optional[str] = None) -> List[Dict[str, Any]]:
    """加强版 YouTube 字幕获取：直取优先，失败后逐语言查找手动/自动轨道。"""
    if YouTubeTranscriptApi is None:
        raise RuntimeError("缺少 youtube-transcript-api 依赖")

    video_id = parse_video_id(video_input)
    if not video_id:
        raise ValueError(f"无法提取 video_id: {video_input}")

    # 更全面的语言优先级
    preferred = []
    if lang:
        preferred.extend([x.strip() for x in str(lang).split(",") if x.strip()])
    preferred.extend(["zh-Hans", "zh-CN", "zh", "cmn", "zh-Hant", "zh-TW", "en", "en-US"])
    preferred = list(dict.fromkeys(preferred))  # 去重

    proxies = get_proxy_config()

    logging.info(f"尝试获取字幕 {video_id}，优先语言: {preferred}")

    # 方案1: 直接获取（最快）
    try:
        fetched = _call_transcript_api("get_transcript", video_id, languages=preferred, proxies=proxies)
        logging.info(f"直接 get_transcript 成功，获得 {len(fetched)} 条")
        return [normalize_transcript_segment(seg) for seg in fetched]
    except Exception as e:
        logging.info(f"直接获取失败: {type(e).__name__} - {e}")

    # 方案2: 详细列出所有轨道并智能选择（最稳）
    try:
        transcript_list = _call_transcript_api("list_transcripts", video_id, proxies=proxies)
        available = list(transcript_list)

        logging.info(f"找到 {len(available)} 条字幕轨")
        for item in available:
            logging.info(
                "字幕轨: language=%s, code=%s, generated=%s, translatable=%s",
                getattr(item, "language", "unknown"),
                getattr(item, "language_code", "unknown"),
                getattr(item, "is_generated", False),
                getattr(item, "is_translatable", False),
            )

        # 优先尝试手动字幕 → 自动生成字幕 → 任意
        transcript_obj = None
        for lang_code in preferred:
            try:
                transcript_obj = transcript_list.find_manually_created_transcript([lang_code])
                logging.info(f"找到手动字幕: {lang_code}")
                break
            except Exception:
                pass

        if not transcript_obj:
            for lang_code in preferred:
                try:
                    transcript_obj = transcript_list.find_generated_transcript([lang_code])
                    logging.info(f"找到自动生成字幕: {lang_code}")
                    break
                except Exception:
                    pass

        if not transcript_obj and available:
            transcript_obj = available[0]   # 兜底取第一条
            logging.info(f"兜底使用第一条字幕: {getattr(transcript_obj, 'language_code', 'unknown')}")

        if transcript_obj:
            # 翻译（如果需要）。显式 translate_to 优先；否则不强制翻译，避免破坏可用原文轨道。
            if translate_to and getattr(transcript_obj, "is_translatable", False):
                try:
                    transcript_obj = transcript_obj.translate(translate_to)
                    logging.info(f"字幕已翻译为: {translate_to}")
                except Exception as e:
                    logging.info(f"字幕翻译失败，使用原字幕: {type(e).__name__} - {e}")

            fetched = transcript_obj.fetch()
            logging.info(f"字幕轨 fetch 成功，获得 {len(fetched)} 条")
            return [normalize_transcript_segment(seg) for seg in fetched]

    except Exception as e:
        logging.warning(f"list_transcripts 也失败: {type(e).__name__} - {e}")

    logging.warning(f"最终未能获取到 {video_id} 的字幕")
    return []


def fetch_comments(video_input: str, comment_num: int = 0, order: str = "relevance") -> List[str]:
    if comment_num <= 0:
        return []

    video_id = parse_video_id(video_input)
    if not video_id:
        raise ValueError(f"无法从输入提取 YouTube videoId: {video_input}")

    data = youtube_api_get(
        "commentThreads",
        {
            "part": "snippet",
            "videoId": video_id,
            "maxResults": max(1, min(100, comment_num)),
            "order": order if order in ("relevance", "time") else "relevance",
            "textFormat": "plainText",
        },
    )

    comments = []
    for item in data.get("items", []):
        snippet = item.get("snippet", {}).get("topLevelComment", {}).get("snippet", {})
        author = safe_text(snippet.get("authorDisplayName") or "Unknown")
        likes = snippet.get("likeCount", 0)
        text = safe_text(snippet.get("textDisplay") or snippet.get("textOriginal"), 500)
        if text:
            comments.append(f"{author}(👍{likes}): {text}")
        if len(comments) >= comment_num:
            break

    return comments


def process_youtube_video(
    video_input: str,
    lang: Optional[str] = None,
    comment_num: int = 0,
    need_subs: bool = True,
    need_comments: bool = False,
    comment_order: str = "relevance",
) -> str:
    """获取 YouTube 视频信息、字幕与评论，返回与 BilibiliFetch 类似的纯文本结果。"""
    details = get_video_details(video_input)

    text_parts = []
    metadata = [
        f"视频标题：{safe_text(details.get('title'))}",
        f"频道：{safe_text(details.get('channelTitle'))}",
        f"发布时间：{details.get('publishedAt') or '未知'}",
        f"时长：{details.get('durationText') or '未知'}",
        f"清晰度：{details.get('definition') or '未知'}",
        f"观看数：{format_count(details.get('viewCount'))}",
        f"点赞数：{format_count(details.get('likeCount'))}",
        f"评论数：{format_count(details.get('commentCount'))}",
        f"链接：{details.get('url')}",
    ]

    description = safe_text(details.get("description"), 600)
    if description:
        metadata.append(f"简介：{description}")

    text_parts.append("【视频信息】\n" + "\n".join(metadata))

    if need_subs:
        transcript = fetch_transcript(details["id"], lang)
        if transcript:
            lines = [f"[{seg['timestamp']}] {seg['text']}" for seg in transcript if seg.get("text")]
            transcript_text = "\n".join(lines).strip()
            if transcript_text:
                transcript_text += "\n\n——以上内容来自 YouTube 字幕/自动字幕，可能存在识别错误或翻译偏差，请自行甄别"
                text_parts.append("\n【字幕内容】\n" + transcript_text)
            else:
                text_parts.append("\n（未获取到字幕内容）")
        else:
            text_parts.append("\n（未获取到字幕内容：该视频可能未公开字幕，或字幕接口受限）")

    if need_comments or comment_num > 0:
        try:
            comments = fetch_comments(details["id"], comment_num, comment_order)
        except Exception as e:
            logging.warning(f"Failed to fetch comments: {e}")
            comments = []
        if comments:
            text_parts.append("\n\n【热门评论】\n" + "\n".join(comments))
        elif comment_num > 0:
            text_parts.append("\n\n（未获取到评论：评论可能关闭、数量不足或 API 权限受限）")

    return "\n".join(text_parts).strip()


def search_youtube(
    keyword: str,
    max_results: int = 10,
    order: str = "relevance",
    page_token: Optional[str] = None,
    region_code: Optional[str] = None,
    channel_id: Optional[str] = None,
    video_duration: Optional[str] = None,
    published_after: Optional[str] = None,
    published_before: Optional[str] = None,
    video_caption: Optional[str] = None,
) -> str:
    if not keyword:
        raise ValueError("Missing required argument: keyword for search")

    data = youtube_api_get(
        "search",
        {
            "part": "snippet",
            "q": keyword,
            "type": "video",
            "maxResults": max(1, min(50, max_results)),
            "order": order,
            "pageToken": page_token,
            "regionCode": region_code,
            "channelId": channel_id,
            "videoDuration": video_duration,
            "publishedAfter": published_after,
            "publishedBefore": published_before,
            "videoCaption": video_caption,
        },
    )

    items = data.get("items", [])
    if not items:
        return "未找到相关 YouTube 视频。"

    lines = [f"--- 关键词 '{keyword}' 的 YouTube 视频搜索结果 ---"]
    for item in items:
        snippet = item.get("snippet", {})
        video_id = item.get("id", {}).get("videoId")
        if not video_id:
            continue
        lines.append(
            "【{title}】\n- 频道: {channel} | VideoID: {video_id}\n- 发布日期: {published}\n- 链接: {url}\n- 简介: {description}".format(
                title=safe_text(snippet.get("title")),
                channel=safe_text(snippet.get("channelTitle")),
                video_id=video_id,
                published=snippet.get("publishedAt", "未知"),
                url=YOUTUBE_WATCH_URL.format(video_id=video_id),
                description=safe_text(snippet.get("description"), 160),
            )
        )

    if data.get("nextPageToken"):
        lines.append(f"\n下一页 page_token: {data.get('nextPageToken')}")

    return "\n\n".join(lines)


def get_channel_details(channel_input: str) -> Dict[str, Any]:
    channel_id = parse_channel_id(channel_input)
    if not channel_id:
        raise ValueError("Missing required argument: channel_id")

    data = youtube_api_get(
        "channels",
        {
            "part": "snippet,statistics,contentDetails",
            "id": channel_id,
            "maxResults": 1,
        },
    )

    items = data.get("items", [])
    if not items:
        raise ValueError(f"未找到频道: {channel_input}")

    channel = items[0]
    snippet = channel.get("snippet", {})
    stats = channel.get("statistics", {})
    related = channel.get("contentDetails", {}).get("relatedPlaylists", {})

    return {
        "id": channel.get("id"),
        "title": snippet.get("title"),
        "description": snippet.get("description"),
        "publishedAt": snippet.get("publishedAt"),
        "customUrl": snippet.get("customUrl"),
        "subscriberCount": stats.get("subscriberCount"),
        "videoCount": stats.get("videoCount"),
        "viewCount": stats.get("viewCount"),
        "uploadsPlaylistId": related.get("uploads"),
        "thumbnails": snippet.get("thumbnails", {}),
        "url": f"https://www.youtube.com/channel/{channel.get('id')}",
    }


def format_channel_details(channel: Dict[str, Any]) -> str:
    lines = [
        "【频道信息】",
        f"频道名：{safe_text(channel.get('title'))}",
        f"ChannelID：{channel.get('id')}",
        f"订阅数：{format_count(channel.get('subscriberCount'))}",
        f"视频数：{format_count(channel.get('videoCount'))}",
        f"总播放：{format_count(channel.get('viewCount'))}",
        f"创建时间：{channel.get('publishedAt') or '未知'}",
        f"链接：{channel.get('url')}",
    ]
    desc = safe_text(channel.get("description"), 800)
    if desc:
        lines.append(f"简介：{desc}")
    return "\n".join(lines)


def get_channel_videos(channel_input: str, max_results: int = 10, page_token: Optional[str] = None) -> str:
    channel = get_channel_details(channel_input)
    playlist_id = channel.get("uploadsPlaylistId")
    if not playlist_id:
        raise ValueError(f"无法找到频道上传列表: {channel_input}")

    data = youtube_api_get(
        "playlistItems",
        {
            "part": "snippet,contentDetails",
            "playlistId": playlist_id,
            "maxResults": max(1, min(50, max_results)),
            "pageToken": page_token,
        },
    )

    items = data.get("items", [])
    if not items:
        return f"频道 {channel.get('title')} 暂无可见投稿视频。"

    lines = [f"--- 频道【{safe_text(channel.get('title'))}】的投稿视频 ---"]
    for item in items:
        snippet = item.get("snippet", {})
        video_id = item.get("contentDetails", {}).get("videoId") or snippet.get("resourceId", {}).get("videoId")
        if not video_id:
            continue
        lines.append(
            "【{title}】\n- VideoID: {video_id}\n- 发布日期: {published}\n- 链接: {url}\n- 简介: {description}".format(
                title=safe_text(snippet.get("title")),
                video_id=video_id,
                published=snippet.get("publishedAt", "未知"),
                url=YOUTUBE_WATCH_URL.format(video_id=video_id),
                description=safe_text(snippet.get("description"), 160),
            )
        )

    if data.get("nextPageToken"):
        lines.append(f"\n下一页 page_token: {data.get('nextPageToken')}")

    return "\n\n".join(lines)


def get_trending_videos(region_code: str = "US", max_results: int = 10) -> str:
    data = youtube_api_get(
        "videos",
        {
            "part": "snippet,contentDetails,statistics",
            "chart": "mostPopular",
            "regionCode": (region_code or "US").upper(),
            "maxResults": max(1, min(50, max_results)),
        },
    )

    items = data.get("items", [])
    if not items:
        return f"未找到地区 {region_code} 的热门视频。"

    lines = [f"--- YouTube 热门视频 ({(region_code or 'US').upper()}) ---"]
    for video in items:
        snippet = video.get("snippet", {})
        stats = video.get("statistics", {})
        content = video.get("contentDetails", {})
        video_id = video.get("id")
        lines.append(
            "【{title}】\n- 频道: {channel} | VideoID: {video_id} | 时长: {duration}\n- 观看数: {views} | 点赞数: {likes} | 发布日期: {published}\n- 链接: {url}\n- 简介: {description}".format(
                title=safe_text(snippet.get("title")),
                channel=safe_text(snippet.get("channelTitle")),
                video_id=video_id,
                duration=parse_iso8601_duration(content.get("duration")),
                views=format_count(stats.get("viewCount")),
                likes=format_count(stats.get("likeCount")),
                published=snippet.get("publishedAt", "未知"),
                url=YOUTUBE_WATCH_URL.format(video_id=video_id),
                description=safe_text(snippet.get("description"), 160),
            )
        )

    return "\n\n".join(lines)


def parse_video_ids(raw_value: Any) -> List[str]:
    if isinstance(raw_value, list):
        candidates = raw_value
    elif isinstance(raw_value, str):
        candidates = [item.strip() for item in raw_value.split(",") if item.strip()]
    elif raw_value:
        candidates = [str(raw_value)]
    else:
        candidates = []

    video_ids = []
    for candidate in candidates:
        video_id = parse_video_id(candidate)
        if video_id:
            video_ids.append(video_id)

    return list(dict.fromkeys(video_ids))


def get_enhanced_transcript(
    video_ids: List[str],
    lang: Optional[str] = None,
    start_time: Optional[float] = None,
    end_time: Optional[float] = None,
    query: Optional[str] = None,
    format_type: str = "timestamped",
    include_metadata: bool = True,
) -> str:
    if not video_ids:
        raise ValueError("Missing required argument: video_ids")

    video_ids = video_ids[:5]
    outputs = []

    for video_id in video_ids:
        if include_metadata:
            try:
                details = get_video_details(video_id)
            except Exception as e:
                logging.info(f"Metadata fetch failed for {video_id}, transcript will continue without API metadata: {e}")
                details = {"id": video_id, "title": video_id, "channelTitle": ""}
        else:
            details = {"id": video_id, "title": video_id, "channelTitle": ""}
        transcript = fetch_transcript(video_id, lang)

        filtered = []
        query_norm = query.lower() if query else None
        for seg in transcript:
            seg_start = float(seg.get("start", 0))
            seg_end = seg_start + float(seg.get("duration", 0))
            if start_time is not None and seg_end < start_time:
                continue
            if end_time is not None and seg_start > end_time:
                continue
            if query_norm and query_norm not in seg.get("text", "").lower():
                continue
            filtered.append(seg)

        header = [
            f"--- Transcript: {safe_text(details.get('title'))} ({video_id}) ---",
            f"频道: {safe_text(details.get('channelTitle'))}",
            f"链接: {YOUTUBE_WATCH_URL.format(video_id=video_id)}",
            f"片段数: {len(filtered)} / {len(transcript)}",
        ]

        if format_type == "raw":
            body = json.dumps(filtered, ensure_ascii=False, indent=2)
        elif format_type == "merged":
            body = " ".join(seg.get("text", "") for seg in filtered).strip()
        else:
            body = "\n".join(f"[{seg['timestamp']}] {seg['text']}" for seg in filtered)

        outputs.append("\n".join(header) + "\n\n" + (body or "（未获取到匹配字幕内容）"))

    return "\n\n".join(outputs)


def handle_single_request(data: Dict[str, Any]):
    """处理单个 VCP 工具请求。"""
    action = data.get("action", "fetch_video")

    if action == "search":
        return search_youtube(
            keyword=data.get("keyword") or data.get("query"),
            max_results=clamp_int(data.get("max_results", data.get("maxResults", 10)), 10, 1, 50),
            order=data.get("order", "relevance"),
            page_token=data.get("page_token") or data.get("pageToken"),
            region_code=data.get("region_code") or data.get("regionCode"),
            channel_id=data.get("channel_id") or data.get("channelId"),
            video_duration=data.get("video_duration") or data.get("videoDuration"),
            published_after=data.get("published_after") or data.get("publishedAfter"),
            published_before=data.get("published_before") or data.get("publishedBefore"),
            video_caption=data.get("video_caption") or data.get("videoCaption"),
        )

    if action == "get_channel":
        channel_id = data.get("channel_id") or data.get("channelId") or data.get("channel")
        channel = get_channel_details(channel_id)
        return format_channel_details(channel)

    if action == "get_channel_videos":
        channel_id = data.get("channel_id") or data.get("channelId") or data.get("channel")
        return get_channel_videos(
            channel_id,
            max_results=clamp_int(data.get("max_results", data.get("maxResults", 10)), 10, 1, 50),
            page_token=data.get("page_token") or data.get("pageToken"),
        )

    if action == "trending":
        return get_trending_videos(
            region_code=data.get("region_code") or data.get("regionCode") or "US",
            max_results=clamp_int(data.get("max_results", data.get("maxResults", 10)), 10, 1, 50),
        )

    if action == "transcript":
        raw_ids = data.get("video_ids") or data.get("videoIds") or data.get("url") or data.get("video_id") or data.get("videoId")
        video_ids = parse_video_ids(raw_ids)
        start_time = data.get("start_time") or data.get("startTime")
        end_time = data.get("end_time") or data.get("endTime")
        return get_enhanced_transcript(
            video_ids=video_ids,
            lang=data.get("lang") or data.get("language"),
            start_time=float(start_time) if start_time not in (None, "") else None,
            end_time=float(end_time) if end_time not in (None, "") else None,
            query=data.get("query"),
            format_type=data.get("format", "timestamped"),
            include_metadata=parse_bool(data.get("include_metadata", data.get("includeMetadata", True)), True),
        )

    # Default: fetch_video
    url = data.get("url") or data.get("video_id") or data.get("videoId")
    if not url:
        raise ValueError("Missing required argument: url")

    comment_num = clamp_int(data.get("comment_num", data.get("commentNum", 0)), 0, 0, 100)
    need_subs = parse_bool(data.get("need_subs", data.get("needSubs", True)), True)
    need_comments = parse_bool(data.get("need_comments", data.get("needComments", comment_num > 0)), comment_num > 0)

    return process_youtube_video(
        video_input=url,
        lang=data.get("lang") or data.get("language"),
        comment_num=comment_num,
        need_subs=need_subs,
        need_comments=need_comments,
        comment_order=data.get("comment_order", data.get("commentOrder", "relevance")),
    )


def build_serial_sub_data(input_data: Dict[str, Any], idx: str) -> Dict[str, Any]:
    sub_data = {}
    for key, value in input_data.items():
        if idx and key.endswith(idx):
            sub_data[key[: -len(idx)]] = value
        elif not idx:
            sub_data[key] = value
    return sub_data


if __name__ == "__main__":
    input_data_raw = sys.stdin.read()
    output = {}

    try:
        if not input_data_raw.strip():
            raise ValueError("No input data received from stdin.")

        input_data = json.loads(input_data_raw)

        # 兼容 BilibiliFetch 的批量调用模式：url1/action1/keyword1...
        numbered_keys = [k for k in input_data.keys() if re.search(r"\d+$", k)]
        is_serial = any(k.startswith("command") or k.startswith("url") or k.startswith("video_id") for k in numbered_keys)

        if is_serial:
            logging.info("Detected serial/batch request.")
            indices = sorted(set(re.findall(r"\d+$", k)[0] for k in numbered_keys), key=lambda x: int(x))
            results = []

            for idx in indices:
                sub_data = build_serial_sub_data(input_data, idx)
                try:
                    result = handle_single_request(sub_data)
                    rendered = result if isinstance(result, str) else json.dumps(result, indent=2, ensure_ascii=False)
                    results.append(f"--- 任务 {idx} 结果 ---\n{rendered}")
                except Exception as e:
                    results.append(f"--- 任务 {idx} 失败 ---\n错误: {e}")

            output = {"status": "success", "result": "\n\n".join(results)}
        else:
            result_data = handle_single_request(input_data)
            output = {"status": "success", "result": result_data}

    except (json.JSONDecodeError, ValueError) as e:
        output = {"status": "error", "error": f"Input Error: {e}"}
    except Exception as e:
        logging.exception("An unexpected error occurred during plugin execution.")
        output = {"status": "error", "error": f"An unexpected error occurred: {e}"}

    sys.stdout.buffer.write(json.dumps(output, indent=2, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()