import type { DashboardCardSize } from "@/dashboard/core/types";

export interface PluginBuiltinCardRenderer {
  kind: "builtin";
  componentKey: string;
}

export interface PluginWebComponentCardRenderer {
  kind: "web-component";
  entry: string;
  tagName: string;
  publicPath: string;
}

export type PluginDashboardCardRenderer =
  | PluginBuiltinCardRenderer
  | PluginWebComponentCardRenderer;

export interface PluginDashboardCardContribution {
  typeId: string;
  localTypeId: string;
  pluginName: string;
  source: "plugin";
  title: string;
  description: string;
  singleton: boolean;
  defaultEnabled: boolean;
  legacyId: string | null;
  defaultSize: DashboardCardSize;
  minSize: DashboardCardSize;
  maxSize: DashboardCardSize;
  renderer: PluginDashboardCardRenderer;
}

export interface PluginInvocationCommand {
  commandIdentifier?: string;
  command?: string;
  description?: string;
}

export interface PluginManifest {
  name: string;
  pluginType?: string;
  displayName?: string;
  description?: string;
  version?: string;
  configSchema?: Record<string, string>;
  configSchemaDescriptions?: Record<string, string>;
  defaults?: Record<string, string>;
  icon?: string;
  author?: string;
  capabilities?: {
    invocationCommands?: PluginInvocationCommand[];
  };
  adminPanel?: {
    dashboard?: {
      cards?: Array<Record<string, unknown>>;
    };
  };
}

export interface PluginInfo {
  name: string;
  manifest: PluginManifest;
  isDistributed?: boolean;
  serverId?: string;
  configEnvContent?: string;
  enabled: boolean;
  configENVContent?: string;
  configPath?: string;
  dashboardCards?: PluginDashboardCardContribution[];
}

export interface PluginListResponse {
  plugins: PluginInfo[];
  total: number;
}

export interface ConfigEntry {
  key: string;
  value: string;
  description?: string;
  isSecret?: boolean;
}

export interface ConfigListResponse {
  entries: ConfigEntry[];
}

export interface SaveConfigRequest {
  entries: ConfigEntry[];
}
