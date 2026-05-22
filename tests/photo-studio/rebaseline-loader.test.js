const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ENABLED_PHASE1_PLUGIN_NAMES = [
  'archive_project_assets',
  'create_customer_record',
  'create_delivery_tasks',
  'create_followup_reminder',
  'create_project_record',
  'create_project_tasks',
  'create_selection_notice',
  'generate_client_reply_draft',
  'sync_calendar_event',
  'update_project_status'
];

const DEFERRED_PLUGIN_NAMES = [
  'check_missing_project_fields',
  'generate_delivery_operator_report',
  'generate_delivery_queue_schedule',
  'generate_weekly_project_digest',
  'inspect_delivery_audit_trail',
  'prioritize_pending_delivery_actions',
  'process_external_delivery_queue',
  'sync_to_external_sheet_or_notion'
];

test('photo_studio rebaseline modern registry points to plugin.json contracts', async () => {
  const registryPath = path.join(__dirname, '..', '..', 'plugins', 'registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  const pluginNames = registry.plugins.map(plugin => plugin.name).sort();

  assert.deepEqual(pluginNames, [
    'archive_project_assets',
    'check_missing_project_fields',
    'create_customer_record',
    'create_delivery_tasks',
    'create_followup_reminder',
    'create_project_record',
    'create_project_tasks',
    'create_selection_notice',
    'generate_client_reply_draft',
    'generate_delivery_operator_report',
    'generate_delivery_queue_schedule',
    'generate_weekly_project_digest',
    'inspect_delivery_audit_trail',
    'prioritize_pending_delivery_actions',
    'process_external_delivery_queue',
    'sync_calendar_event',
    'sync_to_external_sheet_or_notion',
    'update_project_status'
  ]);

  assert.equal(registry.prod_stable_gate.phase, 'photo_studio_guide_contract_phase2_first_batch');
  assert.deepEqual(
    registry.plugins.filter(plugin => plugin.enabled === true).map(plugin => plugin.name).sort(),
    ENABLED_PHASE1_PLUGIN_NAMES
  );
  assert.deepEqual(
    registry.plugins.filter(plugin => plugin.enabled === false).map(plugin => plugin.name).sort(),
    DEFERRED_PLUGIN_NAMES
  );

  registry.plugins.forEach((plugin) => {
    const pluginJsonPath = path.join(path.dirname(registryPath), plugin.path, 'plugin.json');
    const normalizedPluginJsonPath = pluginJsonPath.replace(/\\/g, '/');
    const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));

    if (ENABLED_PHASE1_PLUGIN_NAMES.includes(plugin.name)) {
      assert.equal(plugin.enabled, true);
    } else {
      assert.equal(plugin.enabled, false);
      assert.match(plugin.disabled_reason, /Deferred from prod\/stable Phase 2 first batch/);
    }

    assert.equal(plugin.branch, 'staging/current');
    assert.equal(pluginJson.name, plugin.name);
    assert.equal(pluginJson.runtime.entry_point.script, 'src/index.js');
    assert.match(normalizedPluginJsonPath, /\/plugins\/custom\//);
  });
});

test('photo_studio prod/stable gate remains wired to PluginManager discovery', async () => {
  const pluginManagerSourcePath = path.join(__dirname, '..', '..', 'Plugin.js');
  const pluginManagerSource = fs.readFileSync(pluginManagerSourcePath, 'utf-8');

  assert.match(pluginManagerSource, /entry\.enabled === false\) continue/);
});
