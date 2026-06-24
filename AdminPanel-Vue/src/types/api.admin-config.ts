/**
 * Admin configuration API types.
 */

export interface ToolApprovalPrivacyProtectionConfig {
  enabled?: boolean;
}

export interface ToolApprovalConfig {
  enabled?: boolean;
  approveAll?: boolean;
  timeoutMinutes?: number;
  approvalList?: string[];
  fuzzyToolMatching?: boolean;
  privacyProtection?: ToolApprovalPrivacyProtectionConfig;
  timeout?: number;
  toolList?: string[];
}

export interface Preprocessor {
  name: string;
  displayName?: string;
  description?: string;
}
