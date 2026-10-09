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
  whitelist?: string[];
  fuzzyToolMatching?: boolean;
  allowChainedCommandWhitelist?: boolean;
  privacyProtection?: ToolApprovalPrivacyProtectionConfig;
  timeout?: number;
  toolList?: string[];
}

export interface Preprocessor {
  name: string;
  kind?: "preprocessor" | "stage";
  displayName?: string;
  description?: string;
}
