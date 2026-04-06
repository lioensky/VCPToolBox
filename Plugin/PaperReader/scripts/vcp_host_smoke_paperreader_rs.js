/*
 * Windows smoke for the Rust PaperReader stdio plugin.
 *
 * Verifies two execution paths:
 * 1) VCP host path via PluginManager.executePlugin()
 * 2) Direct stdio spawn of paperreader-cli.exe with the same env/workspace
 *
 * Usage:
 *   node scripts/vcp_host_smoke_paperreader_rs.js "D:\path\to\paper.pdf"
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const pluginRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.join(pluginRoot, 'workspace-rs');
const pdfPath = process.argv[2];
const forceDeterministic = process.env.PAPERREADER_SMOKE_REAL === '1' ? '0' : '1';

function makeEnvelope(command, payload, execution = { mode: 'sync', timeout_ms: 1800000, priority: 'normal', feature_flags: [] }) {
  return {
    protocol_version: '1.0',
    command,
    request_id: `smoke-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    client: {
      name: 'vcp-smoke',
      version: '0.2.0',
      capabilities: ['accepted-response', 'workspace-artifacts', 'streaming-ready']
    },
    workspace: {
      root: workspaceRoot
    },
    execution,
    payload
  };
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const env = {};
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const idx = line.indexOf('=');
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function splitCommand(commandLine) {
  return commandLine.match(/"[^"]+"|\S+/g).map((part) => part.replace(/^"(.*)"$/, '$1'));
}

async function execViaHost(pluginManager, input) {
  const output = await pluginManager.executePlugin('PaperReader', JSON.stringify(input));
  if (!output || output.status !== 'success') {
    const err = (output && (output.error || output.pluginStderr)) || 'unknown error';
    throw new Error(`Host invoke failed: ${err}`);
  }
  return output.result;
}

async function execViaDirect(entryCommand, input, extraEnv) {
  const [command, ...args] = splitCommand(entryCommand);
  const child = spawn(command, args, {
    cwd: pluginRoot,
    env: { ...process.env, ...extraEnv },
    windowsHide: true
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  child.stdin.write(`${JSON.stringify(input)}\n`);
  child.stdin.end();

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });

  const trimmed = stdout.trim();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Direct invoke produced non-JSON stdout. exit=${exitCode}, stderr=${stderr.slice(0, 200)}, stdout=${trimmed.slice(0, 200)}`);
  }
  if (!parsed || parsed.status !== 'success') {
    const err = (parsed && parsed.error) || stderr.trim() || `exit=${exitCode}`;
    throw new Error(`Direct invoke failed: ${err}`);
  }
  return parsed.result;
}

function requirePluginManager() {
  return require(path.join(repoRoot, 'Plugin.js'));
}

function registerPaperReaderForSmoke(pluginManager) {
  const manifestPath = path.join(pluginRoot, 'plugin-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.basePath = pluginRoot;
  manifest.pluginSpecificEnvConfig = loadDotEnv(path.join(pluginRoot, 'config.env'));
  pluginManager.plugins.set('PaperReader', manifest);
  return manifest;
}

function extractCommandIdentifiers(manifest) {
  return new Set(
    ((manifest && manifest.capabilities && manifest.capabilities.invocationCommands) || [])
      .map((command) => command && command.commandIdentifier)
      .filter(Boolean)
      .map((command) => String(command))
  );
}

function assertCommandSurface(label, expectedSet, actualSet) {
  const expected = [...expectedSet].sort();
  const actual = [...actualSet].sort();
  const missing = expected.filter((command) => !actualSet.has(command));
  const extra = actual.filter((command) => !expectedSet.has(command));
  if (missing.length || extra.length) {
    throw new Error(
      `${label} command surface mismatch. missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`
    );
  }
}

async function waitForRunCompletion(pluginManager, runId, timeoutMs) {
  const started = Date.now();
  let polls = 0;
  let lastState = null;
  while (Date.now() - started < timeoutMs) {
    polls += 1;
    const state = await execViaHost(pluginManager, makeEnvelope('get_run_state', { run_id: runId }));
    lastState = state;
    const status = state?.data?.run_state?.status;
    if (status === 'completed') {
      return { polls, state };
    }
    if (status === 'failed' || status === 'aborted') {
      throw new Error(`Research run ${runId} entered terminal status ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for async run ${runId}. Last state: ${JSON.stringify(lastState?.data?.run_state || {})}`);
}

async function main() {
  if (!pdfPath) {
    throw new Error('Usage: node scripts/vcp_host_smoke_paperreader_rs.js "<absolute-pdf-path>"');
  }

  // Default smoke should be deterministic and offline-friendly.
  // Set `PAPERREADER_SMOKE_REAL=1` to allow real MinerU/LLM calls (requires valid keys).
  process.env.PAPERREADER_FORCE_DETERMINISTIC = forceDeterministic;
  const enableRecursiveCritic = forceDeterministic === '1';
  if (enableRecursiveCritic) {
    // Gate the "critic agent" branch in deterministic smoke (offline and stable).
    // Avoid enabling this in real smoke, as it increases cost/latency.
    process.env.PaperReaderRecursiveCritic = 'true';
  }

  const pluginManager = requirePluginManager();
  const manifest = registerPaperReaderForSmoke(pluginManager);
  if (enableRecursiveCritic) {
    // PluginManager captures per-plugin env overrides from the manifest object.
    // Mutate the in-memory manifest to guarantee the flag reaches the spawned process.
    manifest.pluginSpecificEnvConfig = {
      ...(manifest.pluginSpecificEnvConfig || {}),
      PaperReaderRecursiveCritic: 'true'
    };
  }
  const manifestCommandIds = extractCommandIdentifiers(manifest);
  const entryCommand = manifest.entryPoint && manifest.entryPoint.command;
  if (!entryCommand) {
    throw new Error('PaperReader entryPoint.command missing.');
  }
  const smokeSuffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const pdfDocumentId = `smoke-pdf-${smokeSuffix}`;
  const canonicalDocumentId = `smoke-canonical-${smokeSuffix}`;
  const collectionId = `smoke-collection-${smokeSuffix}`;

  const directEnv = {
    ...loadDotEnv(path.join(pluginRoot, 'config.env')),
    PAPERREADER_WORKSPACE_ROOT: workspaceRoot,
    PAPERREADER_FORCE_DETERMINISTIC: forceDeterministic
  };

  const bootstrap = await execViaHost(pluginManager, makeEnvelope('bootstrap_workspace', {}));
  const runtime = await execViaHost(pluginManager, makeEnvelope('describe_runtime', {}));
  const health = await execViaHost(pluginManager, makeEnvelope('get_health_snapshot', {}));
  const supportedCommands = new Set(runtime?.data?.supported_commands || []);
  assertCommandSurface('host describe_runtime', manifestCommandIds, supportedCommands);

  const ingest = await execViaHost(pluginManager, makeEnvelope('IngestPDF', {
    filePath: pdfPath,
    paperId: pdfDocumentId
  }));
  const documentId = ingest?.data?.document_id;
  if (!documentId) {
    throw new Error(`IngestPDF did not return document_id. keys=${Object.keys(ingest?.data || {}).join(',')}`);
  }

  const canonicalIngest = await execViaHost(pluginManager, makeEnvelope('ingest_source', {
    source_text: 'Canonical smoke source.\n\nThis short document exists to exercise ingest_source, refresh_ingestion, read_document, resume_read, retrieve_evidence, audit_document, and trace_claim_in_document.',
    source_type: 'raw_text',
    document_name: 'canonical-smoke-source',
    document_id: canonicalDocumentId
  }));
  if (canonicalIngest?.data?.document_id !== canonicalDocumentId) {
    throw new Error(`ingest_source did not return the requested document_id. payload=${JSON.stringify(canonicalIngest?.data || {})}`);
  }

  const refresh = await execViaHost(pluginManager, makeEnvelope('refresh_ingestion', {
    document_id: canonicalDocumentId
  }));
  if (refresh?.data?.refreshed !== true) {
    throw new Error(`refresh_ingestion did not confirm refresh. payload=${JSON.stringify(refresh?.data || {})}`);
  }

  const read = await execViaHost(pluginManager, makeEnvelope('Read', {
    paperId: documentId,
    goal: '总结核心贡献、方法和实验设计'
  }));

  const canonicalRead = await execViaHost(pluginManager, makeEnvelope('read_document', {
    document_id: canonicalDocumentId,
    goal: 'Summarize the canonical smoke document',
    mode: 'auto'
  }));
  if (!canonicalRead?.data?.reading_state_ref) {
    throw new Error(`read_document did not return reading_state_ref. payload=${JSON.stringify(canonicalRead?.data || {})}`);
  }

  const resumeRead = await execViaHost(pluginManager, makeEnvelope('resume_read', {
    document_id: canonicalDocumentId,
    goal: 'Continue the canonical smoke document'
  }));
  if (!resumeRead?.data?.reading_state_ref) {
    throw new Error(`resume_read did not return reading_state_ref. payload=${JSON.stringify(resumeRead?.data || {})}`);
  }

  const recursiveDocumentId = `smoke-recursive-${smokeSuffix}`;
  const recursiveParagraph = 'This paragraph exists to exercise recursive single-document reading. It should be long enough and split into many blocks so the SegmentSet yields multiple segments.';
  const recursiveText = Array.from({ length: 60 }, (_, idx) => `Section ${idx + 1}. ${recursiveParagraph} ${recursiveParagraph}`).join('\n\n');
  const recursiveIngest = await execViaHost(pluginManager, makeEnvelope('ingest_source', {
    source_text: recursiveText,
    source_type: 'raw_text',
    document_name: 'recursive-smoke-source',
    document_id: recursiveDocumentId
  }));
  if (recursiveIngest?.data?.document_id !== recursiveDocumentId) {
    throw new Error(`recursive ingest_source did not return the requested document_id. payload=${JSON.stringify(recursiveIngest?.data || {})}`);
  }

  const recursiveRead = await execViaHost(pluginManager, makeEnvelope('read_document', {
    document_id: recursiveDocumentId,
    goal: 'Build a global map for recursive smoke',
    mode: 'recursive'
  }));
  if (!recursiveRead?.data?.global_map_ref) {
    throw new Error(`recursive read_document did not return global_map_ref. payload=${JSON.stringify(recursiveRead?.data || {})}`);
  }
  if (!Array.isArray(recursiveRead?.data?.recursive_artifact_refs) || recursiveRead.data.recursive_artifact_refs.length === 0) {
    throw new Error(`recursive read_document did not produce intermediate recursive_artifact_refs. payload=${JSON.stringify(recursiveRead?.data || {})}`);
  }
  if (enableRecursiveCritic) {
    const refs = (recursiveRead?.data?.recursive_artifact_refs || []).map((ref) => String(ref));
    if (!refs.some((ref) => ref.endsWith('global_map.critic.md'))) {
      throw new Error(`recursive critic smoke did not produce global_map.critic.md. refs=${refs.join(',')}`);
    }
    if (!refs.some((ref) => ref.includes('group_') && ref.endsWith('.critic.md'))) {
      throw new Error(`recursive critic smoke did not produce group_*.critic.md. refs=${refs.join(',')}`);
    }
  }

  const query = await execViaHost(pluginManager, makeEnvelope('Query', {
    paperId: documentId,
    question: '这篇文档的核心贡献是什么？'
  }));

  const retrieve = await execViaHost(pluginManager, makeEnvelope('retrieve_evidence', {
    document_id: canonicalDocumentId,
    query_text: 'canonical smoke evidence'
  }));
  if (!retrieve?.data?.retrieval_hits_ref) {
    throw new Error(`retrieve_evidence did not return retrieval_hits_ref. payload=${JSON.stringify(retrieve?.data || {})}`);
  }

  const evidencePack = await execViaHost(pluginManager, makeEnvelope('build_evidence_pack', {
    document_id: canonicalDocumentId,
    query_text: 'canonical smoke evidence'
  }));
  if (!evidencePack?.data?.evidence_pack_ref) {
    throw new Error(`build_evidence_pack did not return evidence_pack_ref. payload=${JSON.stringify(evidencePack?.data || {})}`);
  }

  const trace = await execViaHost(pluginManager, makeEnvelope('trace_claim_in_document', {
    document_id: canonicalDocumentId,
    claim_text: 'Canonical smoke document includes evidence-backed statements.'
  }));

  const audit = await execViaHost(pluginManager, makeEnvelope('audit_document', {
    document_id: canonicalDocumentId
  }));
  if (!audit?.data?.audit_report_ref) {
    throw new Error(`audit_document did not return audit_report_ref. payload=${JSON.stringify(audit?.data || {})}`);
  }

  const collection = await execViaHost(pluginManager, makeEnvelope('ingest_collection', {
    collection_id: collectionId,
    name: 'Smoke Collection',
    goal: 'Compare three small smoke documents',
    sources: [
      {
        source_type: 'raw_text',
        source_text: 'Collection Doc A\n\nAlpha evidence and shared methods.',
        document_name: 'collection-a'
      },
      {
        source_type: 'raw_text',
        source_text: 'Collection Doc B\n\nBeta evidence and conflicting claims.',
        document_name: 'collection-b'
      },
      {
        source_type: 'raw_text',
        source_text: 'Collection Doc C\n\nGamma evidence and complementary results.',
        document_name: 'collection-c'
      }
    ]
  }));

  const collectionIds = (collection?.data?.document_ids || []).map((value) => String(value));
  if (collectionIds.length !== 3) {
    throw new Error(`ingest_collection did not produce three document_ids. payload=${JSON.stringify(collection?.data || {})}`);
  }

  const survey = await execViaHost(pluginManager, makeEnvelope('survey_collection', {
    collection_id: collectionId,
    document_ids: collectionIds,
    goal: 'Survey the smoke collection'
  }));
  if (!survey?.data?.collection_map_ref) {
    throw new Error(`survey_collection did not return collection_map_ref. payload=${JSON.stringify(survey?.data || {})}`);
  }

  const comparison = await execViaHost(pluginManager, makeEnvelope('compare_documents', {
    collection_id: collectionId,
    document_ids: collectionIds
  }));
  if (comparison?.data?.comparison_table?.pair_count !== 3) {
    throw new Error(`compare_documents did not produce all pairwise comparisons. payload=${JSON.stringify(comparison?.data || {})}`);
  }

  const conflictAudit = await execViaHost(pluginManager, makeEnvelope('audit_collection_conflicts', {
    collection_id: collectionId,
    document_ids: collectionIds,
    goal: 'Audit smoke collection conflicts'
  }));
  if (!conflictAudit?.data?.conflict_report_ref) {
    throw new Error(`audit_collection_conflicts did not return conflict_report_ref. payload=${JSON.stringify(conflictAudit?.data || {})}`);
  }

  const collectionCompare = await execViaHost(pluginManager, makeEnvelope('synthesize_collection', {
    collection_id: collectionId,
    document_ids: collectionIds,
    mode: 'compare',
    constraints: ['cover all documents']
  }));
  if (collectionCompare?.data?.comparison_table?.document_count !== 3) {
    throw new Error(`synthesize_collection(compare) did not keep all documents. payload=${JSON.stringify(collectionCompare?.data || {})}`);
  }
  if (collectionCompare?.data?.comparison_table?.pair_count !== 3) {
    throw new Error(`synthesize_collection(compare) did not create all pairwise comparisons. payload=${JSON.stringify(collectionCompare?.data || {})}`);
  }
  const collectionSynthesis = await execViaHost(pluginManager, makeEnvelope('synthesize_collection', {
    collection_id: collectionId,
    document_ids: collectionIds,
    mode: 'synthesis',
    constraints: ['surface overlap and conflicts']
  }));

  const plan = await execViaHost(pluginManager, makeEnvelope('plan_research', {
    collection_id: collectionId,
    document_ids: collectionIds,
    goal: 'Run a collection-scoped async research graph'
  }));
  const plannedNodes = plan?.data?.nodes || [];
  for (const nodeId of ['compare', 'conflict_audit']) {
    if (!plannedNodes.includes(nodeId)) {
      throw new Error(`plan_research did not include required node ${nodeId}. payload=${JSON.stringify(plan?.data || {})}`);
    }
  }
  const runId = plan?.data?.run_id;
  if (!runId) {
    throw new Error('plan_research did not return run_id');
  }
  const graphRef = (plan?.data?.artifact_refs || []).find((ref) => String(ref).replace(/\\/g, '/').endsWith('/graph.json'));
  if (!graphRef) {
    throw new Error(`plan_research did not return graph.json artifact ref. payload=${JSON.stringify(plan?.data || {})}`);
  }
  const graphArtifact = await execViaHost(pluginManager, makeEnvelope('get_artifact', { artifact_path: graphRef }));
  const graphNodes = Object.keys(graphArtifact?.data?.data?.nodes || {});
  for (const nodeId of ['compare', 'conflict_audit']) {
    if (!graphNodes.includes(nodeId)) {
      throw new Error(`graph.json did not materialize required node ${nodeId}. payload=${JSON.stringify(graphArtifact?.data || {})}`);
    }
  }

  const accepted = await execViaHost(
    pluginManager,
    makeEnvelope(
      'run_research_graph',
      { run_id: runId },
      { mode: 'async', timeout_ms: 1800000, priority: 'normal', feature_flags: [] }
    )
  );
  if (accepted?.data?.status !== 'accepted') {
    throw new Error(`run_research_graph did not return accepted. payload=${JSON.stringify(accepted?.data || {})}`);
  }

  const completed = await waitForRunCompletion(pluginManager, runId, 60000);
  const events = await execViaHost(pluginManager, makeEnvelope('stream_run_events', { run_id: runId, cursor: 0, limit: 100 }));
  const runState = await execViaHost(pluginManager, makeEnvelope('get_run_state', { run_id: runId }));
  const workspaceState = await execViaHost(pluginManager, makeEnvelope('get_workspace_state', { run_id: runId }));
  const artifacts = await execViaHost(pluginManager, makeEnvelope('list_artifacts', { run_id: runId }));
  const artifactPaths = (artifacts?.data?.artifacts || []).map((item) => String(item?.path || '').replace(/\\/g, '/'));
  for (const suffix of ['/nodes/compare/result.json', '/nodes/conflict_audit/result.json']) {
    if (!artifactPaths.some((artifactPath) => artifactPath.endsWith(suffix))) {
      throw new Error(`run artifacts did not include ${suffix}. payload=${JSON.stringify(artifacts?.data || {})}`);
    }
  }

  const runStateRef = workspaceState?.data?.run_state_ref;
  if (!runStateRef) {
    throw new Error('get_workspace_state did not return run_state_ref');
  }
  const artifact = await execViaHost(pluginManager, makeEnvelope('get_artifact', { artifact_path: runStateRef }));

  const cancelPlan = await execViaHost(pluginManager, makeEnvelope('plan_research', {
    document_id: documentId,
    goal: 'Lifecycle cancel smoke'
  }));
  const cancelRunId = cancelPlan?.data?.run_id;
  if (!cancelRunId) {
    throw new Error(`cancel smoke plan_research did not return run_id. payload=${JSON.stringify(cancelPlan?.data || {})}`);
  }
  const cancelAccepted = await execViaHost(
    pluginManager,
    makeEnvelope(
      'run_research_graph',
      { run_id: cancelRunId },
      { mode: 'async', timeout_ms: 1800000, priority: 'normal', feature_flags: [] }
    )
  );
  if (cancelAccepted?.data?.status !== 'accepted') {
    throw new Error(`cancel smoke run_research_graph did not return accepted. payload=${JSON.stringify(cancelAccepted?.data || {})}`);
  }
  const cancelled = await execViaHost(pluginManager, makeEnvelope('cancel_run', {
    run_id: cancelRunId,
    reason: 'smoke cancel validation'
  }));
  if (!['aborted', 'partial'].includes(cancelled?.data?.status)) {
    throw new Error(`cancel_run returned unexpected status. payload=${JSON.stringify(cancelled?.data || {})}`);
  }
  const cancelState = await execViaHost(pluginManager, makeEnvelope('get_workspace_state', { run_id: cancelRunId }));

  const reset = await execViaHost(pluginManager, makeEnvelope('reset_run', { run_id: runId }));
  if (reset?.data?.status !== 'reset') {
    throw new Error(`reset_run returned unexpected status. payload=${JSON.stringify(reset?.data || {})}`);
  }
  const resetState = await execViaHost(pluginManager, makeEnvelope('get_workspace_state', { run_id: runId }));
  if (resetState?.data?.run_state?.status !== 'pending') {
    throw new Error(`reset_run did not return run to pending state. payload=${JSON.stringify(resetState?.data || {})}`);
  }

  const resumedRun = await execViaHost(pluginManager, makeEnvelope('resume_research_graph', { run_id: runId }));
  if (resumedRun?.data?.status !== 'completed') {
    throw new Error(`resume_research_graph did not return completed. payload=${JSON.stringify(resumedRun?.data || {})}`);
  }
  const resumedState = await execViaHost(pluginManager, makeEnvelope('get_run_state', { run_id: runId }));
  if (resumedState?.data?.run_state?.status !== 'completed') {
    throw new Error(`resume_research_graph did not restore run to completed state. payload=${JSON.stringify(resumedState?.data || {})}`);
  }

  const directRuntime = await execViaDirect(entryCommand, makeEnvelope('describe_runtime', {}), directEnv);
  const directSupportedCommands = new Set(directRuntime?.data?.supported_commands || []);
  assertCommandSurface('direct describe_runtime', manifestCommandIds, directSupportedCommands);
  const directRefresh = await execViaDirect(entryCommand, makeEnvelope('refresh_ingestion', {
    document_id: canonicalDocumentId
  }), directEnv);
  const directResumeRead = await execViaDirect(entryCommand, makeEnvelope('resume_read', {
    document_id: canonicalDocumentId
  }), directEnv);
  const directAudit = await execViaDirect(entryCommand, makeEnvelope('audit_document', {
    document_id: canonicalDocumentId
  }), directEnv);
  const directSurvey = await execViaDirect(entryCommand, makeEnvelope('survey_collection', {
    collection_id: collectionId,
    document_ids: collectionIds
  }), directEnv);
  const directCompare = await execViaDirect(entryCommand, makeEnvelope('compare_documents', {
    collection_id: collectionId,
    document_ids: collectionIds
  }), directEnv);
  const directConflictAudit = await execViaDirect(entryCommand, makeEnvelope('audit_collection_conflicts', {
    collection_id: collectionId,
    document_ids: collectionIds
  }), directEnv);
  const directReadDeep = await execViaDirect(entryCommand, makeEnvelope('ReadDeep', {
    paperId: documentId,
    goal: 'Direct stdio deep-focus compatibility check'
  }), directEnv);
  const directRunState = await execViaDirect(entryCommand, makeEnvelope('get_run_state', { run_id: runId }), directEnv);
  const directWorkspaceState = await execViaDirect(entryCommand, makeEnvelope('get_workspace_state', { run_id: runId }), directEnv);

  const summary = {
    ok: true,
    pdf: pdfPath,
    workspace_root: workspaceRoot,
    plugin_entry: entryCommand,
    host: {
      bootstrap_status: bootstrap?.status,
      runtime_status: runtime?.status,
      health_status: health?.status,
      ingest_status: ingest?.status,
      canonical_ingest_status: canonicalIngest?.status,
      refresh_ingestion_status: refresh?.status,
      read_status: read?.status,
      read_document_status: canonicalRead?.status,
      resume_read_status: resumeRead?.status,
      query_status: query?.status,
      retrieve_evidence_status: retrieve?.status,
      trace_status: trace?.status,
      audit_document_status: audit?.status,
      evidence_pack_status: evidencePack?.status,
      survey_collection_status: survey?.status,
      compare_documents_status: comparison?.status,
      audit_collection_conflicts_status: conflictAudit?.status,
      collection_compare_status: collectionCompare?.status,
      collection_synthesis_status: collectionSynthesis?.status,
      async_run_status: accepted?.data?.status,
      async_run_polls: completed.polls,
      final_run_status: completed.state?.data?.run_state?.status,
      get_run_state_status: runState?.status,
      cancel_run_status: cancelled?.data?.status,
      cancel_run_final_state: cancelState?.data?.run_state?.status || null,
      reset_run_status: reset?.data?.status,
      reset_run_final_state: resetState?.data?.run_state?.status || null,
      resumed_run_status: resumedRun?.data?.status,
      resumed_run_final_state: resumedState?.data?.run_state?.status || null,
      event_count: events?.data?.events?.length || 0,
      artifact_count: artifacts?.data?.artifacts?.length || 0,
      round_trip_artifact_kind: artifact?.data?.kind || artifact?.kind
    },
    direct: {
      runtime_status: directRuntime?.status,
      refresh_ingestion_status: directRefresh?.status,
      resume_read_status: directResumeRead?.status,
      audit_document_status: directAudit?.status,
      survey_collection_status: directSurvey?.status,
      compare_documents_status: directCompare?.status,
      audit_collection_conflicts_status: directConflictAudit?.status,
      read_deep_status: directReadDeep?.status,
      get_run_state_status: directRunState?.status,
      workspace_state_status: directWorkspaceState?.status,
      manifest_surface_matches_runtime: [...manifestCommandIds].every((command) => directSupportedCommands.has(command))
    },
    ids: {
      document_id: documentId,
      canonical_document_id: canonicalDocumentId,
      collection_id: collectionId,
      run_id: runId,
      cancel_run_id: cancelRunId
    },
    refs: {
      run_state_ref: runStateRef,
      direct_workspace_state_ref: directWorkspaceState?.data?.run_state_ref || null,
      comparison_table_ref: collectionCompare?.data?.comparison_table_ref || null
    }
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[smoke] FAILED: ${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
