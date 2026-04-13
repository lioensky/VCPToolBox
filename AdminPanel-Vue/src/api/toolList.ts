import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";
import type { Tool } from "@/features/tool-list/types";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

interface ToolsResponse {
  tools?: Tool[];
}

interface ConfigsResponse {
  configs?: string[];
}

interface ConfigResponse {
  tools?: string[];
}

export const toolListApi = {
  async getTools(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<Tool[]> {
    const response = await requestWithUi<ToolsResponse>(
      {
        url: "/admin_api/tool-list-editor/tools",
      },
      uiOptions
    );
    return response.tools || [];
  },

  async getConfigs(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<string[]> {
    const response = await requestWithUi<ConfigsResponse>(
      {
        url: "/admin_api/tool-list-editor/configs",
      },
      uiOptions
    );
    return response.configs || [];
  },

  async getConfig(
    name: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<string[]> {
    const response = await requestWithUi<ConfigResponse>(
      {
        url: `/admin_api/tool-list-editor/config/${encodeURIComponent(name)}`,
      },
      uiOptions
    );
    return response.tools || [];
  },

  async saveConfig(
    name: string,
    tools: string[],
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: `/admin_api/tool-list-editor/config/${encodeURIComponent(name)}`,
        method: "POST",
        body: { tools },
      },
      uiOptions
    );
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
  },
};

