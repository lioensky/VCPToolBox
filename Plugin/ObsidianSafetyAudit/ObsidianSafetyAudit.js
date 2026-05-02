const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function getConfig() {
  return {
    auditLogPath: process.env.OBSIDIAN_AUDIT_LOG_PATH
      ? path.resolve(process.env.OBSIDIAN_AUDIT_LOG_PATH)
      : path.join(__dirname, 'audit', 'obsidian-audit.jsonl'),
    denyActions: splitList(process.env.OBSIDIAN_DENY_ACTIONS || 'DeleteVault,DeleteFolder'),
    approvalActions: splitList(process.env.OBSIDIAN_REQUIRE_APPROVAL_ACTIONS || 'WriteNoteAtomic,AppendNote,ReplaceInNote,DeleteNote'),
    highRiskPathPatterns: splitList(process.env.OBSIDIAN_HIGH_RISK_PATH_PATTERNS || '.obsidian,Templates')
  };
}

function normalizeAction(action) {
  return String(action || '').trim();
}

function includesIgnoreCase(items, value) {
  const lowerValue = String(value || '').toLowerCase();
  return items.some(item => item.toLowerCase() === lowerValue);
}

function pathHasPattern(notePath, patterns) {
  const normalized = String(notePath || '').replace(/\\/g, '/').toLowerCase();
  return patterns.some(pattern => normalized.includes(pattern.replace(/\\/g, '/').toLowerCase()));
}

function assess(args, config) {
  const action = normalizeAction(args.action || args.targetAction);
  if (!action) throw new Error('action is required.');

  const notePath = args.notePath || args.target || '';
  const reasons = [];
  let decision = 'allowed';
  let riskLevel = 'low';

  if (includesIgnoreCase(config.denyActions, action)) {
    decision = 'denied';
    riskLevel = 'critical';
    reasons.push(`Action "${action}" is listed in OBSIDIAN_DENY_ACTIONS.`);
  } else if (includesIgnoreCase(config.approvalActions, action)) {
    decision = 'approval_required';
    riskLevel = 'high';
    reasons.push(`Action "${action}" requires human approval.`);
  }

  if (notePath && pathHasPattern(notePath, config.highRiskPathPatterns)) {
    if (decision === 'allowed') decision = 'approval_required';
    if (riskLevel === 'low') riskLevel = 'medium';
    reasons.push(`Target path "${notePath}" matches a high-risk path pattern.`);
  }

  if (reasons.length === 0) {
    reasons.push('No deny or approval policy matched.');
  }

  return {
    decision,
    riskLevel,
    reasons,
    action,
    notePath,
    actor: args.actor || null,
    reason: args.reason || null
  };
}

async function appendAuditRecord(config, record) {
  await fsp.mkdir(path.dirname(config.auditLogPath), { recursive: true });
  await fsp.appendFile(config.auditLogPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function resultText(record) {
  return [
    `Obsidian safety decision: ${record.decision}`,
    '',
    `- Audit ID: ${record.auditId}`,
    `- Action: ${record.action}`,
    `- Risk: ${record.riskLevel || 'n/a'}`,
    record.notePath ? `- Target: ${record.notePath}` : null,
    '',
    'Reasons:',
    ...((record.reasons || []).map(reason => `- ${reason}`))
  ].filter(Boolean).join('\n');
}

async function assessAction(args, config) {
  const assessment = assess(args, config);
  const record = {
    auditId: args.auditId || `obsidian-audit-${crypto.randomUUID()}`,
    timestamp: nowIso(),
    command: 'AssessAction',
    ...assessment,
    details: args.details || {}
  };
  await appendAuditRecord(config, record);
  return {
    content: [{ type: 'text', text: resultText(record) }],
    details: { ...record, auditLogPath: config.auditLogPath }
  };
}

async function recordAuditEvent(args, config) {
  const action = normalizeAction(args.action);
  if (!action) throw new Error('action is required.');

  const record = {
    auditId: args.auditId || `obsidian-audit-${crypto.randomUUID()}`,
    timestamp: nowIso(),
    command: 'RecordAuditEvent',
    action,
    decision: args.decision || args.status || 'completed',
    riskLevel: args.riskLevel || null,
    notePath: args.notePath || args.target || null,
    actor: args.actor || null,
    reason: args.reason || null,
    details: args.details || {}
  };
  await appendAuditRecord(config, record);
  return {
    content: [{ type: 'text', text: resultText({ ...record, reasons: [record.reason || 'Audit event recorded.'] }) }],
    details: { ...record, auditLogPath: config.auditLogPath }
  };
}

async function processRequest(args = {}) {
  const config = getConfig();
  const command = args.command || 'AssessAction';
  switch (command) {
    case 'AssessAction':
      return assessAction(args, config);
    case 'RecordAuditEvent':
      return recordAuditEvent(args, config);
    default:
      throw new Error(`Unknown ObsidianSafetyAudit command: ${command}`);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', async data => {
  const lines = data.toString().replace(/^\uFEFF+/, '').trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const request = JSON.parse(line.replace(/^\uFEFF+/, ''));
      const result = await processRequest(request);
      console.log(JSON.stringify({ status: 'success', result }));
    } catch (error) {
      console.log(JSON.stringify({ status: 'error', error: error.message }));
    }
  }
});
