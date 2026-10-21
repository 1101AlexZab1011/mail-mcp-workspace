<template>
  <div class="pptist-editor">
    <EditorHeader class="layout-header" />
    <div class="layout-content">
      <Thumbnails class="layout-content-left" />
      <div class="layout-content-center">
        <CanvasTool class="center-top" />
        <Canvas class="center-body" />
        <Remark
          class="center-bottom" 
          v-model:height="remarkHeight" 
          :style="{ height: `${remarkHeight}px` }"
        />
      </div>
      <Toolbar class="layout-content-right" />
    </div>
  </div>

  <SelectPanel v-if="showSelectPanel" />
  <SearchPanel v-if="showSearchPanel" />
  <NotesPanel v-if="showNotesPanel" />
  <MarkupPanel v-if="showMarkupPanel" />
  <SymbolPanel v-if="showSymbolPanel" />
  <ChartDataEditorDialog />
  <LatexEditorDialog />
  <MotionEditor />
  <ScriptEditor />

  <Modal
    :visible="!!dialogForExport" 
    :width="680"
    @closed="closeExportDialog()"
  >
    <ExportDialog />
  </Modal>
</template>

<script lang="ts" setup>
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useMainStore } from '@/store'
import useGlobalHotkey from '@/hooks/useGlobalHotkey'
import usePasteEvent from '@/hooks/usePasteEvent'

import EditorHeader from './EditorHeader/index.vue'
import Canvas from './Canvas/index.vue'
import CanvasTool from './CanvasTool/index.vue'
import Thumbnails from './Thumbnails/index.vue'
import Toolbar from './Toolbar/index.vue'
import Remark from './Remark/index.vue'
import ChartDataEditorDialog from './ChartDataEditorDialog.vue'
import LatexEditorDialog from './LatexEditorDialog.vue'
import MotionEditor from './Motion/MotionEditor.vue'
import ScriptEditor from './Script/ScriptEditor.vue'
import ExportDialog from './ExportDialog/index.vue'
import SelectPanel from './SelectPanel.vue'
import SearchPanel from './SearchPanel.vue'
import NotesPanel from './NotesPanel.vue'
import SymbolPanel from './SymbolPanel.vue'
import MarkupPanel from './MarkupPanel.vue'
import Modal from '@/components/Modal.vue'

const mainStore = useMainStore()
const {
  dialogForExport,
  showSelectPanel,
  showSearchPanel,
  showNotesPanel,
  showSymbolPanel,
  showMarkupPanel,
} = storeToRefs(mainStore)

const closeExportDialog = () => mainStore.setDialogForExport('')

const remarkHeight = ref(40)

useGlobalHotkey()
usePasteEvent()
</script>

<style lang="scss" scoped>
// A column of flex boxes: the header and the canvas toolbar may wrap onto more rows when the editor is
// narrow (e.g. beside a wide dock), and the canvas takes whatever height is left.
.pptist-editor {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.layout-header {
  min-height: 40px;
  flex: none;
}
.layout-content {
  flex: 1;
  min-height: 0;
  display: flex;
}
.layout-content-left {
  width: 160px;
  height: 100%;
  flex-shrink: 0;
}
.layout-content-center {
  width: calc(100% - 160px - 260px);
  display: flex;
  flex-direction: column;
  min-height: 0;

  .center-top {
    min-height: 40px;
    flex: none;
  }
  .center-body {
    flex: 1;
    min-height: 0;
  }
  .center-bottom {
    flex: none;
  }
}
.layout-content-right {
  width: 260px;
  height: 100%;
}
</style>
