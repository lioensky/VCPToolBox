const PLACEHOLDER_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  static_plugin: "Static Plugin",
  async_placeholder: "Async Placeholder",
  agent: "Agent",
  env_tar_var: "Target Variable",
  env_sar: "Sar Prompt",
  fixed: "Fixed Value",
  tool_description: "Tool Description",
  vcp_all_tools: "All Tools",
  image_key: "Image Key",
  diary: "Diary",
  diary_character: "Diary Character",
});

function humanizeTypeKey(type: string): string {
  return type
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

export function getPlaceholderTypeLabel(type: string): string {
  if (!type) {
    return "Unknown";
  }

  return PLACEHOLDER_TYPE_LABELS[type] ?? humanizeTypeKey(type);
}
