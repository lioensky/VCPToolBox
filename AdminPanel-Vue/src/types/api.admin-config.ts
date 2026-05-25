/**
 * Admin configuration API types.
 */

export interface ToolApprovalConfig {
  enabled?: boolean;
  approveAll?: boolean;
  debugMode?: boolean;
  timeoutMinutes?: number;
  approvalList?: string[];
  fuzzyToolMatching?: boolean;
  timeout?: number;
  toolList?: string[];
}

export interface Preprocessor {
  name: string;
  displayName?: string;
  description?: string;
}
