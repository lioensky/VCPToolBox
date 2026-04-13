import { HttpError } from "@/platform/http/errors";
import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";
import type { ForumPost } from "@/features/vcp-forum/types";

interface ForumPostsResponse {
  posts?: unknown;
}

interface ForumPostDetailResponse {
  content?: unknown;
}

interface ForumActionResponse {
  message?: unknown;
}

interface ForumEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
  message?: string;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unwrapEnvelope<T>(payload: unknown): T {
  if (!isRecord(payload)) {
    return {} as T;
  }

  const envelope = payload as ForumEnvelope<T>;
  if (envelope.success === false) {
    throw new HttpError(
      envelope.error || envelope.message || "Forum request failed"
    );
  }

  if (envelope.data !== undefined) {
    return envelope.data;
  }

  return payload as T;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizePost(raw: unknown): ForumPost | null {
  if (!isRecord(raw)) {
    return null;
  }

  const uid = asString(raw.uid);
  const title = asString(raw.title);
  const author = asString(raw.author);
  const board = asString(raw.board);
  const timestamp = asString(raw.timestamp);

  if (!uid || !title || !author || !board || !timestamp) {
    return null;
  }

  return {
    uid,
    title,
    author,
    board,
    timestamp,
    lastReplyBy:
      typeof raw.lastReplyBy === "string" || raw.lastReplyBy === null
        ? raw.lastReplyBy
        : null,
    lastReplyAt:
      typeof raw.lastReplyAt === "string" || raw.lastReplyAt === null
        ? raw.lastReplyAt
        : null,
  };
}

function normalizeReplyPayload(payload: { maid: string; content: string }): {
  maid: string;
  content: string;
} {
  const maid = payload.maid.trim();
  const content = payload.content.trim();

  if (!maid) {
    throw new Error("回复昵称不能为空");
  }

  if (!content) {
    throw new Error("回复内容不能为空");
  }

  return {
    maid,
    content,
  };
}

function normalizeFloorNumber(floor: number): number {
  if (!Number.isInteger(floor) || floor <= 0) {
    throw new Error("楼层号必须为大于 0 的整数");
  }

  return floor;
}

async function requestForum<T>(
  request: {
    url: string;
    method?: "GET" | "POST" | "DELETE" | "PATCH";
    body?: unknown;
  },
  uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
): Promise<T> {
  const payload = await requestWithUi<unknown>(
    {
      ...request,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    uiOptions
  );

  return unwrapEnvelope<T>(payload);
}

export const forumApi = {
  async getPosts(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ForumPost[]> {
    const response = await requestForum<ForumPostsResponse>(
      {
        url: "/admin_api/forum/posts",
        method: "GET",
      },
      uiOptions
    );

    const posts = Array.isArray(response.posts) ? response.posts : [];
    return posts.map((item) => normalizePost(item)).filter((item): item is ForumPost => item !== null);
  },

  async getPostContent(
    uid: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<string> {
    const response = await requestForum<ForumPostDetailResponse>(
      {
        url: `/admin_api/forum/post/${encodeURIComponent(uid)}`,
        method: "GET",
      },
      uiOptions
    );

    return asString(response.content);
  },

  async submitReply(
    uid: string,
    payload: { maid: string; content: string },
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    const normalizedPayload = normalizeReplyPayload(payload);

    await requestForum(
      {
        url: `/admin_api/forum/reply/${encodeURIComponent(uid)}`,
        method: "POST",
        body: normalizedPayload,
      },
      uiOptions
    );
  },

  async deletePost(
    uid: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<string> {
    const response = await requestForum<ForumActionResponse>(
      {
        url: `/admin_api/forum/post/${encodeURIComponent(uid)}`,
        method: "DELETE",
        body: {},
      },
      uiOptions
    );

    return asString(response.message);
  },

  async deleteReply(
    uid: string,
    floor: number,
    uiOptions: RequestUiOptions = {}
  ): Promise<string> {
    const response = await requestForum<ForumActionResponse>(
      {
        url: `/admin_api/forum/post/${encodeURIComponent(uid)}`,
        method: "DELETE",
        body: {
          floor: normalizeFloorNumber(floor),
        },
      },
      uiOptions
    );

    return asString(response.message);
  },
};
