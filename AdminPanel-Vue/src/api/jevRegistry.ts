import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export interface JevRegistryValidation {
  status: "valid" | "invalid" | string;
  errors: string[];
  warnings: string[];
}

export interface JevRegistryParameter {
  type: "enum" | "boolean" | "text" | string;
  required?: boolean;
  description?: string;
  values?: Record<string, string>;
  source?: string;
  prefixes?: string[];
  maxLength?: number;
  default?: string | boolean;
}

export interface JevRegistryCommand {
  commandIdentifier: string;
  description: string;
  aliases: string[];
  injectCommand: boolean;
  fixedArgs: Record<string, string>;
  parameters: Record<string, JevRegistryParameter>;
}

export interface JevRegistryEntry {
  pluginName: string | null;
  toolName: string | null;
  displayName?: string | null;
  version?: string | null;
  origin?: string;
  serverId?: string | null;
  pluginEnabled: boolean;
  jevEnabled?: boolean;
  category?: string | null;
  categoryLabel?: string | null;
  jevDescPrompt?: string;
  jevPrompt?: string;
  agentPrompt?: string;
  commands?: JevRegistryCommand[];
  defaultCommand?: string | null;
  callTemplate?: string | null;
  promptHash?: string | null;
  validation: JevRegistryValidation;
}

export interface JevRegistryEntryResponse {
  status: "success";
  entry: JevRegistryEntry;
}

export const jevRegistryApi = {
  /** 精确、大小写敏感查询单个插件的 JEV 注册条目；未登记时抛出 404 错误。 */
  async getEntry(
    pluginName: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<JevRegistryEntry> {
    const response = await requestWithUi<JevRegistryEntryResponse>(
      {
        url: `/admin_api/jev/registry/${encodeURIComponent(pluginName)}`,
      },
      uiOptions
    );
    return response.entry;
  },
};