import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const API_BASE_URL = "/admin_api/sarprompts";
const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export interface SarPrompt {
  promptKey: string;
  models: string[];
  content: string;
}

export const sarPromptApi = {
  async getPrompts(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<SarPrompt[]> {
    return requestWithUi(
      {
        url: API_BASE_URL,
      },
      uiOptions
    );
  },

  async savePrompts(
    payload: SarPrompt[],
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: API_BASE_URL,
        method: "POST",
        body: payload,
      },
      uiOptions
    );
  },
};
