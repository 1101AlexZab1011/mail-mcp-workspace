<template>
  <div class="script-style-panel">
    <div class="row">
      <Button style="flex: 1;" @click="openScriptEditor(handleElement.id)"><i-icon-park-outline:code /> Edit script…</Button>
    </div>
    <Divider />
    <div class="row info"><div class="label">File:</div><div class="value">{{ handleElement.src }}</div></div>
    <div class="row info"><div class="label">Steps:</div><div class="value">{{ handleElement.steps || 0 }} {{ handleElement.steps ? 'clicks' : '(runs on its own)' }}</div></div>
    <div class="row info" v-if="handleElement.libs?.length"><div class="label">Libraries:</div><div class="value">{{ handleElement.libs.join(', ') }}</div></div>
    <div class="row info" v-if="handleElement.data?.length"><div class="label">Data:</div><div class="value">{{ handleElement.data.join(', ') }}</div></div>
    <div class="row info"><div class="label">Poster:</div><div class="value">{{ handleElement.poster ? 'set' : 'none (set it in the editor)' }}</div></div>
    <div class="hint">Scripts run in a sealed frame: no network, no access to your files or mail.</div>
  </div>
</template>

<script lang="ts" setup>
import { type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useMainStore } from '@/store'
import type { PPTScriptElement } from '@/types/slides'
import { openScriptEditor } from '@/views/Editor/Script/state'
import Button from '@/components/Button.vue'
import Divider from '@/components/Divider.vue'

const { handleElement: handleElementRef } = storeToRefs(useMainStore())
const handleElement = handleElementRef as Ref<PPTScriptElement>
</script>

<style lang="scss" scoped>
.row {
  display: flex;
  align-items: center;
  margin-bottom: 10px;
}
.info {
  font-size: 13px;

  .label {
    width: 35%;
    color: var(--pp-text-3);
  }
  .value {
    width: 65%;
    word-break: break-all;
  }
}
.hint {
  font-size: 12px;
  color: var(--pp-text-3);
}
</style>
