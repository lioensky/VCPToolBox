import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const API_BASE_URL = "/admin_api/vcptavern";
const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export type RuleType = "relative" | "depth" | "embed";
export type RulePosition = "before" | "after";
export type RuleTarget = "system" | "last_user";
export type RuleRole = "system" | "user" | "assistant";

export interface RuleContent {
  role: RuleRole;
  content: string;
}

export interface RuleUiState {
  textareaWidth?: string;
  textareaHeight?: string;
}

export interface TavernRule {
  id: string;
  name: string;
  enabled: boolean;
  type: RuleType;
  position?: RulePosition;
  target?: RuleTarget;
  depth?: number;
  content: RuleContent;
  ui?: RuleUiState;
}

export interface TavernPreset {
  description?: string;
  rules?: TavernRule[];
}

export const vcptavernApi = {
  async getPresets(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<string[]> {
    const response = await requestWithUi<unknown>(
      {
        url: `${API_BASE_URL}/presets`,
      },
      uiOptions
    );
    return Array.isArray(response)
      ? response.filter((item): item is string => typeof item === "string")
      : [];
  },

  async getPreset(
    name: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<TavernPreset> {
    return requestWithUi(
      {
        url: `${API_BASE_URL}/presets/${encodeURIComponent(name)}`,
      },
      uiOptions
    );
  },

  async savePreset(
    name: string,
    payload: TavernPreset,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: `${API_BASE_URL}/presets/${encodeURIComponent(name)}`,
        method: "POST",
        body: payload,
      },
      uiOptions
    );
  },

  async deletePreset(
    name: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: `${API_BASE_URL}/presets/${encodeURIComponent(name)}`,
        method: "DELETE",
      },
      uiOptions
    );
  },
};

