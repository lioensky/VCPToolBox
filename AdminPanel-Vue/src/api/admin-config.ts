import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";
import type {
  Preprocessor,
  ToolApprovalConfig,
} from "@/types/api.admin-config";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };
export type { Preprocessor, ToolApprovalConfig } from "@/types/api.admin-config";

interface MainConfigResponse {
  content?: string;
  exampleContent?: string;
  source?: "config.env" | "config.env.example" | "none";
  hasCustomConfig?: boolean;
  configExists?: boolean;
  exampleExists?: boolean;
  configMatchesExample?: boolean;
}

export interface MainConfigData {
  content: string;
  exampleContent: string;
  source: "config.env" | "config.env.example" | "none";
  hasCustomConfig: boolean;
  configExists: boolean;
  exampleExists: boolean;
  configMatchesExample: boolean;
}

interface PreprocessorOrderResponse {
  order?: Preprocessor[];
  newOrder?: Preprocessor[];
}

export const adminConfigApi = {
  async getMainConfig(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<MainConfigData> {
    const response = await requestWithUi<MainConfigResponse>(
      {
        url: "/admin_api/config/main",
      },
      uiOptions
    );

    const source =
      response.source === "config.env" ||
      response.source === "config.env.example" ||
      response.source === "none"
        ? response.source
        : "config.env";

    return {
      content: response.content || "",
      exampleContent: response.exampleContent || "",
      source,
      hasCustomConfig:
        response.hasCustomConfig === true ||
        (response.hasCustomConfig !== false && source === "config.env"),
      configExists: response.configExists !== false,
      exampleExists:
        response.exampleExists === true || source === "config.env.example",
      configMatchesExample: response.configMatchesExample === true,
    };
  },

  async saveMainConfig(
    content: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: "/admin_api/config/main",
        method: "POST",
        body: { content },
      },
      uiOptions
    );
  },

  async getToolApprovalConfig(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ToolApprovalConfig> {
    return requestWithUi(
      {
        url: "/admin_api/tool-approval-config",
      },
      uiOptions
    );
  },

  async saveToolApprovalConfig(
    config: ToolApprovalConfig,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: "/admin_api/tool-approval-config",
        method: "POST",
        body: { config },
      },
      uiOptions
    );
  },

  async getPreprocessorOrder(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<Preprocessor[]> {
    const response = await requestWithUi<PreprocessorOrderResponse>(
      {
        url: "/admin_api/preprocessors/order",
      },
      uiOptions
    );
    const order = response.order || response.newOrder;
    return Array.isArray(order) ? order : [];
  },

  async savePreprocessorOrder(
    order: string[],
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: "/admin_api/preprocessors/order",
        method: "POST",
        body: { order },
      },
      uiOptions
    );
  },
};

