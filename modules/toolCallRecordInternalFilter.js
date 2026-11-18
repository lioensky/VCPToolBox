// modules/toolCallRecordInternalFilter.js

const INTERNAL_TOOL_CALL_RULES = Object.freeze([
  {
    toolName: 'OpenHerPersona',
    matches: ({ args }) => normalizeString(args?.command) === 'status',
    reason: 'OpenHerPersona status polling is a system-level internal health/status query.'
  }
]);

function normalizeString(value) {
  return String(value ?? '').trim().toLowerCase();
}

function isInternalToolCall({ toolName, args } = {}) {
  const normalizedToolName = String(toolName || '').trim();
  if (!normalizedToolName) {
    return false;
  }

  return INTERNAL_TOOL_CALL_RULES.some(rule => (
    rule.toolName === normalizedToolName &&
    typeof rule.matches === 'function' &&
    rule.matches({ toolName: normalizedToolName, args: args || {} })
  ));
}

function getInternalToolCallReason({ toolName, args } = {}) {
  const normalizedToolName = String(toolName || '').trim();
  const matchedRule = INTERNAL_TOOL_CALL_RULES.find(rule => (
    rule.toolName === normalizedToolName &&
    typeof rule.matches === 'function' &&
    rule.matches({ toolName: normalizedToolName, args: args || {} })
  ));

  return matchedRule?.reason || null;
}

module.exports = {
  isInternalToolCall,
  getInternalToolCallReason
};