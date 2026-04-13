<template>
  <section class="config-section active-section">
    <div v-if="files.length === 0" class="tvs-empty-guide">
      <span class="material-symbols-outlined">edit_note</span>
      <h3>暂无变量文件</h3>
      <p>TVS 文件用于存储系统自定义变量，每行一个 KEY=VALUE 对。</p>
    </div>

    <template v-else>
    <div class="tvs-editor-controls">
      <label for="tvs-file-select">选择变量文件:</label>
      <select id="tvs-file-select" v-model="selectedFile" @change="loadFileContent">
        <option value="">请选择一个文件…</option>
        <option v-for="file in files" :key="file" :value="file">{{ file }}</option>
      </select>
      <button @click="saveFile" :disabled="!selectedFile" class="btn-success">保存变量文件</button>
      <span v-if="statusMessage" :class="['status-message', statusType]">{{ statusMessage }}</span>
    </div>

    <div v-if="!selectedFile" class="tvs-file-hint">
      <span class="material-symbols-outlined">arrow_upward</span>
      <p>从上方下拉菜单选择一个变量文件开始编辑。</p>
    </div>

    <textarea
      v-else
      id="tvs-file-content-editor"
      v-model="fileContent"
      spellcheck="false"
      placeholder="选择一个变量文件以编辑其内容…"
      rows="25"
    ></textarea>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { tvsApi } from '@/api'
import { showMessage } from '@/utils'

const files = ref<string[]>([])
const selectedFile = ref('')
const fileContent = ref('')
const originalContent = ref('')
const isDirty = ref(false)
const statusMessage = ref('')
const statusType = ref<'info' | 'success' | 'error'>('info')

// 跟踪内容变化
watch(fileContent, (newContent) => {
  isDirty.value = newContent !== originalContent.value
})

// 页面离开前检查
function handleBeforeUnload(e: BeforeUnloadEvent) {
  if (isDirty.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}

async function loadFiles() {
  try {
    files.value = await tvsApi.getTvsFiles({
      showLoader: false,
      loadingKey: 'tvs-files.list.load'
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    showMessage(`加载文件列表失败：${errorMessage}`, 'error')
  }
}

async function loadFileContent() {
  if (isDirty.value && !confirm('有未保存的更改，确定要切换文件吗？')) {
    return
  }

  if (!selectedFile.value) {
    fileContent.value = ''
    originalContent.value = ''
    isDirty.value = false
    return
  }

  try {
    fileContent.value = await tvsApi.getTvsFileContent(selectedFile.value, {
      showLoader: false,
      loadingKey: 'tvs-files.content.load'
    })
    originalContent.value = fileContent.value
    isDirty.value = false
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    showMessage(`加载文件失败：${errorMessage}`, 'error')
  }
}

async function saveFile() {
  if (!selectedFile.value) return

  try {
    await tvsApi.saveTvsFile(selectedFile.value, fileContent.value, {
      loadingKey: 'tvs-files.content.save'
    })
    originalContent.value = fileContent.value
    isDirty.value = false
    statusMessage.value = '文件已保存！'
    statusType.value = 'success'
    showMessage('文件已保存！', 'success')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    statusMessage.value = `保存失败：${errorMessage}`
    statusType.value = 'error'
  }
}

onMounted(() => {
  loadFiles()
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
})
</script>

<style scoped>
.tvs-empty-guide {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-9) var(--space-4);
  color: var(--secondary-text);
  text-align: center;
}

.tvs-empty-guide .material-symbols-outlined {
  font-size: var(--font-size-icon-empty-lg);
  opacity: 0.3;
  color: var(--highlight-text);
}

.tvs-empty-guide h3 {
  color: var(--primary-text);
  font-size: var(--font-size-emphasis);
}

.tvs-empty-guide p {
  max-width: 45ch;
  font-size: var(--font-size-body);
  line-height: 1.6;
}

.tvs-file-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-8) var(--space-4);
  color: var(--secondary-text);
  text-align: center;
}

.tvs-file-hint .material-symbols-outlined {
  font-size: var(--font-size-icon-empty);
  opacity: 0.4;
}

.tvs-file-hint p {
  max-width: 40ch;
  font-size: var(--font-size-body);
}

.tvs-editor-controls {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: var(--space-4);
}

.tvs-editor-controls select {
  flex: 1;
  max-width: 400px;
  padding: 8px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--primary-text);
}

textarea#tvs-file-content-editor {
  width: 100%;
  max-width: 90ch;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: var(--font-size-body);
  line-height: 1.6;
}

@media (max-width: 640px) {
  .tvs-editor-controls {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-3);
  }

  .tvs-editor-controls select {
    max-width: none;
    width: 100%;
  }

  .tvs-editor-controls .btn-success,
  .tvs-editor-controls .status-message {
    width: 100%;
  }

  textarea#tvs-file-content-editor {
    max-width: none;
  }
}
</style>
