/**
 * Admin configuration API types.
 */

export interface ToolApprovalConfig {
  enabled?: boolean;
  approveAll?: boolean;
  timeoutMinutes?: number;
  approvalList?: string[];
  timeout?: number;
  toolList?: string[];
}

export interface Preprocessor {
  name: string;
  displayName?: string;
  description?: string;
}
