<template>
  <UiCard>
    <details class="policy-disclosure">
      <summary>第三方 JevCall 管理 <span class="disclosure-hint">展开 / 收起</span></summary>
      <div class="policy-content">
    <p>自动汇总本地及分布式节点注册声明。白名单只控制准入，不绕过声明校验、插件启用状态或第三方实验总开关。</p>
    <p v-if="snapshot">实验总开关：{{ snapshot.experiment.enabled ? '已开启' : '未开启' }} · {{ snapshot.entries.length }} 个声明</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="policy-controls">
      <UiButton type="button" size="sm" variant="outline" :disabled="busy" @click="load(true)">刷新注册声明</UiButton>
      <UiButton type="button" size="sm" :disabled="busy || !snapshot" @click="save">保存白名单</UiButton>
      <label><input v-model="unrestricted" type="checkbox" :disabled="busy || !snapshot" /> 不限插件（仍执行安全校验）</label>
    </div>
    <p v-if="unrestricted">当前为不限模式。关闭此项后按勾选保存；全部取消将拒绝全部第三方插件。</p>
    <label v-for="entry in snapshot?.entries || []" :key="entry.pluginName || entry.toolName || ''" class="policy-entry">
      <input v-model="selected" type="checkbox" :value="entry.pluginName"
        :disabled="busy || unrestricted || !entry.pluginName || (entry.validation.status !== 'valid' && !selected.includes(entry.pluginName))" />
      <span>{{ entry.displayName || entry.pluginName }} · {{ entry.pluginName }} · {{ entry.origin === 'cloud' ? `分布式 ${entry.serverId || ''}` : '本地' }}
        · {{ entry.categoryLabel || entry.category }} · {{ entry.pluginEnabled ? '启用' : '禁用' }}
        · {{ entry.validation.status === 'valid' ? '声明有效' : '声明无效' }}
        <small v-for="message in entry.validation.errors" :key="message">{{ message }}</small>
      </span>
    </label>
    <label v-for="name in offlineNames" :key="name" class="policy-entry">
      <input v-model="selected" type="checkbox" :value="name" :disabled="busy || unrestricted" />
      <span>{{ name }} · 当前未注册（保留旧授权，取消可移除）</span>
    </label>
      </div>
    </details>
  </UiCard>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { jevRegistryApi, type JevRegistrySnapshot } from "@/api/jevRegistry";
import { askConfirm } from "@/platform/feedback/feedbackBus";
import { showMessage } from "@/utils";
import UiCard from "@/components/ui/UiCard.vue";
import UiButton from "@/components/ui/UiButton.vue";
const snapshot = ref<JevRegistrySnapshot | null>(null);
const selected = ref<string[]>([]);
const unrestricted = ref(false);
const busy = ref(false);
const error = ref("");
let disposed = false;
const offlineNames = computed(() => (snapshot.value?.experiment.allowlist || [])
  .filter(name => !snapshot.value?.entries.some(entry => entry.pluginName === name)));
function apply(value: JevRegistrySnapshot) {
  snapshot.value = value;
  unrestricted.value = value.experiment.allowlist === null;
  selected.value = value.experiment.allowlist ? [...value.experiment.allowlist] : [];
}
async function load(refresh = false) {
  if (busy.value) return;
  if (refresh && !(await askConfirm({ message: "刷新会重新读取白名单并丢弃未保存的勾选，继续吗？" }))) return;
  busy.value = true;
  error.value = "";
  try {
    const value = refresh ? await jevRegistryApi.rebuild() : await jevRegistryApi.getSnapshot();
    if (!disposed) apply(value);
  } catch (cause) {
    if (!disposed) error.value = `读取失败：${cause instanceof Error ? cause.message : String(cause)}`;
  } finally { if (!disposed) busy.value = false; }
}
async function save() {
  if (busy.value || !snapshot.value) return;
  if (unrestricted.value && !(await askConfirm({ message: "确认允许所有通过安全校验的第三方插件？", confirmText: "允许不限" }))) return;
  busy.value = true;
  error.value = "";
  try {
    const value = await jevRegistryApi.savePolicy(unrestricted.value ? "unrestricted" : "selected", unrestricted.value ? [] : selected.value);
    if (!disposed) { apply(value); showMessage("JevCall 白名单已保存并生效。", "success"); }
  } catch (cause) {
    if (!disposed) error.value = `保存失败：${cause instanceof Error ? cause.message : String(cause)}`;
  } finally { if (!disposed) busy.value = false; }
}
onMounted(() => { void load(); });
onBeforeUnmount(() => { disposed = true; });
</script>

<style scoped>
.policy-disclosure > summary { cursor: pointer; color: var(--primary-text); font-weight: 600; }
.disclosure-hint { margin-left: var(--space-2); color: var(--secondary-text); font-size: var(--font-size-helper); font-weight: 400; }
.policy-content { padding-top: var(--space-2); }
.policy-controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.policy-entry { display: flex; align-items: flex-start; gap: var(--space-2); padding: var(--space-2) 0; border-bottom: 1px solid var(--border-color); overflow-wrap: anywhere; }
small { display: block; color: var(--danger-color); }
</style>