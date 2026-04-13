import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export interface ToolboxValue {
  file?: string;
  description?: string;
}

interface ToolboxFileResponse {
  content?: string;
}

export const toolboxApi = {
  async getToolboxMap(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<Record<string, ToolboxValue>> {
    return requestWithUi(
      {
        url: "/admin_api/toolbox/map",
      },
      uiOptions
    );
  },

  async saveToolboxMap(
    payload: Record<string, { file: string; description: string }>,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: "/admin_api/toolbox/map",
        method: "POST",
        body: payload,
      },
      uiOptions
    );
  },

  async createToolboxFile(
    fileName: string,
    folderPath?: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: "/admin_api/toolbox/new-file",
        method: "POST",
        body: { fileName, folderPath },
      },
      uiOptions
    );
  },

  async getToolboxFile(
    fileName: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<string> {
    const response = await requestWithUi<ToolboxFileResponse>(
      {
        url: `/admin_api/toolbox/file/${encodeURIComponent(fileName)}`,
      },
      uiOptions
    );
    return response.content || "";
  },

  async saveToolboxFile(
    fileName: string,
    content: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: `/admin_api/toolbox/file/${encodeURIComponent(fileName)}`,
        method: "POST",
        body: { content },
      },
      uiOptions
    );
  },
};

