import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

interface TvsFilesResponse {
  files?: string[];
}

interface TvsFileContentResponse {
  content?: string;
}

export const tvsApi = {
  async getTvsFiles(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<string[]> {
    const response = await requestWithUi<TvsFilesResponse>(
      {
        url: "/admin_api/tvsvars",
      },
      uiOptions
    );
    return response.files || [];
  },

  async getTvsFileContent(
    fileName: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<string> {
    const response = await requestWithUi<TvsFileContentResponse>(
      {
        url: `/admin_api/tvsvars/${encodeURIComponent(fileName)}`,
      },
      uiOptions
    );
    return response.content || "";
  },

  async saveTvsFile(
    fileName: string,
    content: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: `/admin_api/tvsvars/${encodeURIComponent(fileName)}`,
        method: "POST",
        body: { content },
      },
      uiOptions
    );
  },
};

