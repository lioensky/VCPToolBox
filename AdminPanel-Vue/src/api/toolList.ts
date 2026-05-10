import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";
import type { Tool } from "@/features/tool-list/types";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };
const DEFAULT_READ_OPTIONS: { forceRefresh: boolean } = { forceRefresh: false };

let toolsCache: Tool[] | null = null;
let configsCache: string[] | null = null;

interface ToolsResponse {
  tools?: Tool[];
}

interface ConfigsResponse {
  configs?: string[];
}

export interface ToolConfigPayload {
  tools: string[];
  toolDescriptions: Record<string, string>;
  includeHeader?: boolean;
  includeExamples?: boolean;
}

interface ConfigResponse {
  tools?: string[];
  toolDescriptions?: Record<string, string>;
  includeHeader?: boolean;
  includeExamples?: boolean;
}

interface CheckFileResponse {
  exists: boolean;
}

export interface ExportRequest {
  tools: string[];
  toolDescriptions?: Record<string, string>;
  includeHeader: boolean;
  includeExamples: boolean;
}

interface ExportResponse {
  status: string;
  filePath?: string;
}

interface ReadOptions {
  forceRefresh?: boolean;
}

function cloneTools(tools: Tool[]): Tool[] {
  return tools.map((tool) => ({ ...tool }));
}

function cloneConfigs(configs: string[]): string[] {
  return [...configs];
}

function normalizeReadOptions(options?: ReadOptions): { forceRefresh: boolean } {
  return {
    ...DEFAULT_READ_OPTIONS,
    ...(options || {}),
  };
}

export const toolListApi = {
  clearCache(): void {
    toolsCache = null;
    configsCache = null;
  },

  async getTools(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS,
    options?: ReadOptions
  ): Promise<Tool[]> {
    const normalizedOptions = normalizeReadOptions(options);
    if (!normalizedOptions.forceRefresh && toolsCache) {
      return cloneTools(toolsCache);
    }

    const response = await requestWithUi<ToolsResponse>(
      {
        url: "/admin_api/tool-list-editor/tools",
      },
      uiOptions
    );

    toolsCache = response.tools || [];
    return cloneTools(toolsCache);
  },

  async getConfigs(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS,
    options?: ReadOptions
  ): Promise<string[]> {
    const normalizedOptions = normalizeReadOptions(options);
    if (!normalizedOptions.forceRefresh && configsCache) {
      return cloneConfigs(configsCache);
    }

    const response = await requestWithUi<ConfigsResponse>(
      {
        url: "/admin_api/tool-list-editor/configs",
      },
      uiOptions
    );

    configsCache = response.configs || [];
    return cloneConfigs(configsCache);
  },

  async getConfig(
    name: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ToolConfigPayload> {
    const response = await requestWithUi<ConfigResponse>(
      {
        url: `/admin_api/tool-list-editor/config/${encodeURIComponent(name)}`,
      },
      uiOptions
    );
    return {
      tools: response.tools || [],
      toolDescriptions: response.toolDescriptions || {},
      includeHeader:
        typeof response.includeHeader === "boolean"
          ? response.includeHeader
          : undefined,
      includeExamples:
        typeof response.includeExamples === "boolean"
          ? response.includeExamples
          : undefined,
    };
  },

  async saveConfig(
    name: string,
    payload: ToolConfigPayload,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: `/admin_api/tool-list-editor/config/${encodeURIComponent(name)}`,
        method: "POST",
        body: payload,
      },
      uiOptions
    );

    configsCache = null;
  },

  async deleteConfig(
    name: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: `/admin_api/tool-list-editor/config/${encodeURIComponent(name)}`,
        method: "DELETE",
      },
      uiOptions
    );

    configsCache = null;
  },

  async exportTxt(
    fileName: string,
    payload: ExportRequest,
    uiOptions: RequestUiOptions = {}
  ): Promise<ExportResponse> {
    return await requestWithUi<ExportResponse>(
      {
        url: `/admin_api/tool-list-editor/export/${encodeURIComponent(fileName)}`,
        method: "POST",
        body: payload,
      },
      uiOptions
    );
  },

  async checkFile(
    fileName: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<boolean> {
    const response = await requestWithUi<CheckFileResponse>(
      {
        url: `/admin_api/tool-list-editor/check-file/${encodeURIComponent(fileName)}`,
      },
      uiOptions
    );
    return Boolean(response.exists);
  },
};
