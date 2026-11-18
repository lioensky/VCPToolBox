import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const API_BASE_URL = "/admin_api/placeholder-explorer";
const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export interface PlaceholderExplorerLocation {
  type?: string;
  file: string;
  line?: number;
  endLine?: number;
  value?: string;
  resolvesTo?: string | null;
  editable?: boolean;
  source?: string;
  raw?: string;
  models?: string[];
  pluginName?: string;
  pluginType?: string;
  commandCount?: number;
}

export interface PlaceholderExplorerNestingEdge {
  from: string;
  to: string;
  contains: string[];
}

export interface PlaceholderExplorerReferenceChain {
  path: string[];
  cycle: boolean;
}

export interface PlaceholderExplorerEntry {
  placeholder: string;
  type: string;
  definitions: PlaceholderExplorerLocation[];
  references: PlaceholderExplorerLocation[];
  nesting: PlaceholderExplorerNestingEdge[];
  referenceChains: PlaceholderExplorerReferenceChain[];
  editable: boolean;
  lastScan: string;
}

export interface PlaceholderExplorerStats {
  placeholders: number;
  definitions: number;
  references: number;
  deadLinks: number;
  orphans: number;
  scanErrors: number;
}

export interface PlaceholderExplorerDeadLink {
  placeholder: string;
  references: PlaceholderExplorerLocation[];
}

export interface PlaceholderExplorerOrphan {
  placeholder: string;
  type: string;
  definitions: PlaceholderExplorerLocation[];
}

export interface PlaceholderExplorerScanError {
  file: string;
  line?: number;
  message: string;
}

export interface PlaceholderExplorerIndex {
  schemaVersion: number;
  generatedAt: string;
  projectRoot: string;
  stats: PlaceholderExplorerStats;
  entries: PlaceholderExplorerEntry[];
  checks: {
    deadLinks: PlaceholderExplorerDeadLink[];
    orphans: PlaceholderExplorerOrphan[];
  };
  errors: PlaceholderExplorerScanError[];
}

export interface PlaceholderExplorerPluginStatus {
  name: string;
  displayName: string;
  pluginType: string;
  version: string | null;
  enabled: boolean;
  available: boolean;
  commands: string[];
}

export interface PlaceholderExplorerSnapshot {
  index: PlaceholderExplorerIndex;
  plugins: PlaceholderExplorerPluginStatus[];
}

export interface PlaceholderExplorerEditableContent {
  placeholder: string;
  scope: "definition" | "file";
  source: string;
  file: string;
  content: string;
  restartRequired: boolean;
}

export interface PlaceholderExplorerPreviewRequest {
  placeholder: string;
  role?: "system" | "user" | "assistant";
  model?: string;
  text?: string;
  context?: string;
}

export interface PlaceholderExplorerPreview {
  placeholder: string;
  role: string;
  model: string;
  input: string;
  output: string;
  expanded: boolean;
  securityNote: string;
  limitation: string;
}

export interface PlaceholderExplorerEditResult {
  snapshot: PlaceholderExplorerSnapshot;
  edit: {
    file: string;
    backup: string;
    bytesBefore: number;
    bytesAfter: number;
    placeholder: string;
    source: string;
    restartRequired: boolean;
  };
  message: string;
}

interface DataResponse<T> {
  data: T;
}

export const placeholderExplorerApi = {
  async getIndex(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<PlaceholderExplorerSnapshot> {
    const response = await requestWithUi<DataResponse<PlaceholderExplorerSnapshot>>(
      { url: `${API_BASE_URL}/index`, timeoutMs: 120000 },
      uiOptions
    );
    return response.data;
  },

  async scan(uiOptions: RequestUiOptions = {}): Promise<PlaceholderExplorerSnapshot> {
    const response = await requestWithUi<DataResponse<PlaceholderExplorerSnapshot>>(
      { url: `${API_BASE_URL}/scan`, method: "POST", body: {}, timeoutMs: 120000 },
      uiOptions
    );
    return response.data;
  },

  async getEditableContent(
    placeholder: string,
    scope: "definition" | "file",
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<PlaceholderExplorerEditableContent> {
    const response = await requestWithUi<DataResponse<PlaceholderExplorerEditableContent>>(
      {
        url: `${API_BASE_URL}/editable-content`,
        query: { placeholder, scope },
        timeoutMs: 30000,
      },
      uiOptions
    );
    return response.data;
  },

  async preview(
    payload: PlaceholderExplorerPreviewRequest,
    uiOptions: RequestUiOptions = {}
  ): Promise<PlaceholderExplorerPreview> {
    const response = await requestWithUi<DataResponse<{ preview: PlaceholderExplorerPreview }>>(
      {
        url: `${API_BASE_URL}/preview`,
        method: "POST",
        body: payload,
        timeoutMs: 120000,
      },
      uiOptions
    );
    return response.data.preview;
  },

  async edit(
    payload: {
      placeholder: string;
      newValue: string;
      scope: "definition" | "file";
    },
    uiOptions: RequestUiOptions = {}
  ): Promise<PlaceholderExplorerEditResult> {
    const response = await requestWithUi<DataResponse<PlaceholderExplorerEditResult>>(
      {
        url: `${API_BASE_URL}/edit`,
        method: "POST",
        body: payload,
        timeoutMs: 120000,
      },
      uiOptions
    );
    return response.data;
  },
};
