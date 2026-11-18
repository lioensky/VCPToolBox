export interface Tool {
  uniqueId: string;
  pluginName: string;
  name: string;
  description?: string;
  displayName?: string;
  example?: string;
  category?: string;
  schema?: unknown;
  searchText?: string;
}
