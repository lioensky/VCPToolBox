import type { Folder, Note, RagTagsConfig } from "@/types/diary";
import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export interface DiaryListParams {
  folder?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface DiaryListResponse {
  notes: Note[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DiaryContentResponse {
  file: string;
  content: string;
}

export interface DiarySaveResponse {
  path: string;
  message?: string;
}

export interface DiaryDeleteResponse {
  deleted: string[];
  message?: string;
}

export interface DiaryMoveTarget {
  folder: string;
  file: string;
}

export interface AssociativeDiscoveryParams {
  sourceFilePath: string;
  k: number;
  range: string[];
  tagBoost?: number;
}

export interface DiscoveryResultRaw {
  name: string;
  path: string;
  score: number;
  matchedTags?: string[];
  chunks?: string[];
}

export interface AssociativeDiscoveryResponse {
  warning?: string;
  results?: DiscoveryResultRaw[];
}

interface NoteListApiItem {
  name?: string;
  lastModified?: string;
  preview?: string;
  excerpt?: string;
  contentPreview?: string;
  summary?: string;
}

interface DailyNotesResponse {
  notes?: NoteListApiItem[];
}

type RagTagsFolderResponse =
  | {
      tags?: string[];
      threshold?: number;
    }
  | string[];

function parseDiaryPath(filePath: string): { folder: string; file: string } {
  const normalized = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (normalized.length !== 2) {
    throw new Error("Diary path must use the format <folder>/<file>.");
  }

  return {
    folder: normalized[0],
    file: normalized[1],
  };
}

function normalizeNote(note: NoteListApiItem): Note {
  const file = note.name || "";
  return {
    file,
    title: file.replace(/\.md$/i, ""),
    modified: note.lastModified || "",
    preview: note.preview || note.excerpt || note.contentPreview || note.summary || "",
  };
}

function normalizeRagTagsConfig(config: RagTagsFolderResponse | undefined): RagTagsConfig {
  if (!config) {
    return {
      thresholdEnabled: false,
      threshold: 0.7,
      tags: [],
    };
  }

  if (Array.isArray(config)) {
    return {
      thresholdEnabled: false,
      threshold: 0.7,
      tags: config,
    };
  }

  return {
    thresholdEnabled: config.threshold !== undefined,
    threshold: config.threshold ?? 0.7,
    tags: config.tags || [],
  };
}

export const diaryApi = {
  async getDiaryList(
    params: DiaryListParams = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<DiaryListResponse> {
    let response: DailyNotesResponse = {};

    if (params.search?.trim()) {
      response = await requestWithUi<DailyNotesResponse>(
        {
          url: "/admin_api/dailynotes/search",
          query: {
            term: params.search.trim(),
            folder: params.folder,
          },
        },
        uiOptions
      );
    } else if (params.folder) {
      response = await requestWithUi<DailyNotesResponse>(
        {
          url: `/admin_api/dailynotes/folder/${encodeURIComponent(params.folder)}`,
        },
        uiOptions
      );
    }

    const notes = Array.isArray(response.notes)
      ? response.notes.map((note) => normalizeNote(note))
      : [];

    return {
      notes,
      total: notes.length,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? notes.length,
    };
  },

  async getDiaryContent(
    file: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<string> {
    const path = parseDiaryPath(file);
    const response = await requestWithUi<{ content?: string }>(
      {
        url: `/admin_api/dailynotes/note/${encodeURIComponent(path.folder)}/${encodeURIComponent(path.file)}`,
      },
      uiOptions
    );
    return response.content || "";
  },

  async saveDiary(
    file: string,
    content: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<DiarySaveResponse> {
    const path = parseDiaryPath(file);
    const response = await requestWithUi<{ message?: string }>(
      {
        url: `/admin_api/dailynotes/note/${encodeURIComponent(path.folder)}/${encodeURIComponent(path.file)}`,
        method: "POST",
        body: { content },
      },
      uiOptions
    );

    return {
      path: file,
      message: response.message,
    };
  },

  async deleteDiary(
    files: string[],
    uiOptions: RequestUiOptions = {}
  ): Promise<DiaryDeleteResponse> {
    const notesToDelete = files.map((filePath) => {
      const path = parseDiaryPath(filePath);
      return {
        folder: path.folder,
        file: path.file,
      };
    });

    const response = await requestWithUi<DiaryDeleteResponse>(
      {
        url: "/admin_api/dailynotes/delete-batch",
        method: "POST",
        body: { notesToDelete },
      },
      uiOptions
    );

    return {
      deleted: response.deleted || [],
      message: response.message,
    };
  },

  async getRagTagsConfig(
    folder: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<RagTagsConfig> {
    const response = await requestWithUi<Record<string, RagTagsFolderResponse>>(
      {
        url: "/admin_api/rag-tags",
      },
      uiOptions
    );
    return normalizeRagTagsConfig(response[folder]);
  },

  async saveRagTagsConfig(
    folder: string,
    config: RagTagsConfig,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    const payload: Record<string, { tags: string[]; threshold?: number }> = {
      [folder]: {
        tags: config.tags.filter((tag) => tag.trim()),
      },
    };

    if (config.thresholdEnabled) {
      payload[folder].threshold = config.threshold;
    }

    await requestWithUi(
      {
        url: "/admin_api/rag-tags",
        method: "POST",
        body: payload,
      },
      uiOptions
    );
  },

  async getFolders(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<Folder[]> {
    const response = await requestWithUi<{ folders?: string[] }>(
      {
        url: "/admin_api/dailynotes/folders",
      },
      uiOptions
    );
    return (response.folders || []).map((name) => ({
      name,
      path: name,
    }));
  },

  async moveDiaries(
    notes: DiaryMoveTarget[],
    targetFolder: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: "/admin_api/dailynotes/move",
        method: "POST",
        body: {
          sourceNotes: notes,
          targetFolder,
        },
      },
      uiOptions
    );
  },

  async associativeDiscovery(
    payload: AssociativeDiscoveryParams,
    uiOptions: RequestUiOptions = {}
  ): Promise<AssociativeDiscoveryResponse> {
    return requestWithUi(
      {
        url: "/admin_api/dailynotes/associative-discovery",
        method: "POST",
        body: payload,
      },
      uiOptions
    );
  },
};

