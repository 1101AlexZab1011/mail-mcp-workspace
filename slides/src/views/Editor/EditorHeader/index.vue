<template>
  <div class="editor-header">
    <div class="left">
      <Popover trigger="click" placement="bottom-start" v-model:value="mainMenuVisible">
        <template #content>
          <div class="import-section">
            <div class="import-label">Import</div>
            <div class="import-grid">
              <FileInput class="import-block" accept="application/vnd.openxmlformats-officedocument.presentationml.presentation" @change="files => {
                importPPTXFile(files)
                mainMenuVisible = false
              }">
                <span class="icon"><i-custom:file-ppt /></span>
                <span class="label">PPTX</span>
              </FileInput>
              <FileInput class="import-block" accept=".json" @change="files => {
                importJSON(files)
                mainMenuVisible = false
              }">
                <span class="icon"><i-custom:file-jpg /></span>
                <span class="label">JSON</span>
              </FileInput>
              <FileInput class="import-block" accept=".pptist" @change="files => {
                importSpecificFile(files)
                mainMenuVisible = false
              }">
                <span class="icon"><i-custom:file-pptist /></span>
                <span class="label">PPTIST</span>
              </FileInput>
            </div>
          </div>
          <Divider :margin="10" />
          <PopoverMenuItem class="popover-menu-item" @click="setDialogForExport('pptx')"><i-icon-park-outline:download class="icon" /> Export</PopoverMenuItem>
          <Divider :margin="10" />
          <PopoverMenuItem class="popover-menu-item" @click="resetSlides(); mainMenuVisible = false"><i-icon-park-outline:refresh class="icon" /> Reset slides</PopoverMenuItem>
          <PopoverMenuItem class="popover-menu-item" @click="openMarkupPanel(); mainMenuVisible = false"><i-icon-park-outline:mark class="icon" /> Mark slide types</PopoverMenuItem>
          <PopoverMenuItem class="popover-menu-item" @click="mainMenuVisible = false; hotkeyDrawerVisible = true"><i-icon-park-outline:command class="icon" /> Keyboard shortcuts</PopoverMenuItem>
        </template>
        <div class="menu-item"><i-icon-park-outline:hamburger-button class="icon" /></div>
      </Popover>

      <div class="title">
        <Input 
          class="title-input" 
          ref="titleInputRef"
          v-model:value="titleValue" 
          @blur="handleUpdateTitle()" 
          v-if="editingTitle" 
        ></Input>
        <div 
          class="title-text"
          @click="startEditTitle()"
          :title="title"
          v-else
        >{{ title }}</div>
      </div>
      <!-- A hosting page renders its own status (file, save state) here; Vue leaves it alone. -->
      <div class="host-slot" id="pptist-host-left"></div>
    </div>

    <div class="right">
      <div class="host-slot" id="pptist-host-right"></div>
      <div class="group-menu-item slideshow">
        <div class="slideshow-btn" v-tooltip="'Present from this slide (F5)'" @click="enterScreening()">
          <i-icon-park-outline:play-one class="icon" /> Slideshow
        </div>
        <Popover trigger="click" center>
          <template #content>
            <PopoverMenuItem class="popover-menu-item" @click="enterScreeningFromStart()"><i-icon-park-outline:slide-two class="icon" /> From the beginning</PopoverMenuItem>
            <PopoverMenuItem class="popover-menu-item" @click="enterScreening()"><i-icon-park-outline:ppt class="icon" /> From this slide</PopoverMenuItem>
          </template>
          <div class="arrow-btn"><i-icon-park-outline:down class="arrow" /></div>
        </Popover>
      </div>
      <div class="menu-item" v-tooltip="'Export'" @click="setDialogForExport('pptx')">
        <i-icon-park-outline:download class="icon" />
      </div>
      <a class="github-link" v-tooltip="'Based on PPTist, © 2020-present pipipi-pikachu (AGPL-3.0)'" href="https://github.com/pipipi-pikachu/PPTist" target="_blank">
        <div class="menu-item"><i-icon-park-outline:github class="icon" /></div>
      </a>
    </div>

    <Drawer
      :width="320"
      v-model:visible="hotkeyDrawerVisible"
      placement="right"
    >
      <HotkeyDoc />
      <template v-slot:title>Keyboard shortcuts</template>
    </Drawer>

    <FullscreenSpin :loading="exporting" tip="Importing…" />
  </div>
</template>

<script lang="ts" setup>
import { nextTick, ref, useTemplateRef } from 'vue'
import { storeToRefs } from 'pinia'
import { useMainStore, useSlidesStore } from '@/store'
import useScreening from '@/hooks/useScreening'
import useImport from '@/hooks/useImport'
import useSlideHandler from '@/hooks/useSlideHandler'
import type { DialogForExportTypes } from '@/types/export'

import HotkeyDoc from './HotkeyDoc.vue'
import FileInput from '@/components/FileInput.vue'
import FullscreenSpin from '@/components/FullscreenSpin.vue'
import Drawer from '@/components/Drawer.vue'
import Input from '@/components/Input.vue'
import Popover from '@/components/Popover.vue'
import PopoverMenuItem from '@/components/PopoverMenuItem.vue'
import Divider from '@/components/Divider.vue'

const mainStore = useMainStore()
const slidesStore = useSlidesStore()
const { title } = storeToRefs(slidesStore)
const { enterScreening, enterScreeningFromStart } = useScreening()
const { importSpecificFile, importPPTXFile, importJSON, exporting } = useImport()
const { resetSlides } = useSlideHandler()

const mainMenuVisible = ref(false)
const hotkeyDrawerVisible = ref(false)
const editingTitle = ref(false)
const titleValue = ref('')
const titleInputRef = useTemplateRef<InstanceType<typeof Input>>('titleInputRef')

const startEditTitle = () => {
  titleValue.value = title.value
  editingTitle.value = true
  nextTick(() => titleInputRef.value?.focus())
}

const handleUpdateTitle = () => {
  slidesStore.setTitle(titleValue.value)
  editingTitle.value = false
}

const setDialogForExport = (type: DialogForExportTypes) => {
  mainStore.setDialogForExport(type)
  mainMenuVisible.value = false
}

const openMarkupPanel = () => {
  mainStore.setMarkupPanelState(true)
}

</script>

<style lang="scss" scoped>
.editor-header {
  background-color: var(--pp-surface);
  user-select: none;
  border-bottom: 1px solid $borderColor;
  display: flex;
  flex-wrap: wrap; // more rows when the editor is narrow
  align-items: center;
  justify-content: space-between;
  min-height: 40px;
  padding: 0 5px;
}
.group-menu-item.slideshow {
  margin: 0 6px;
  border-radius: 16px;
  background-color: $themeColor;
  color: var(--pp-on-accent);

  .slideshow-btn {
    height: 30px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;

    .icon { font-size: 16px; }
  }
  .arrow-btn {
    color: var(--pp-on-accent);
    border-left: 1px solid color-mix(in srgb, var(--pp-on-accent) 35%, transparent);
    padding: 0 10px 0 6px;
  }
  &:hover { background-color: $themeHoverColor; }
}
.host-slot {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.left, .right {
  display: flex;
  justify-content: center;
  align-items: center;
}
.menu-item {
  height: 30px;
  display: flex;
  justify-content: center;
  align-items: center;
  font-size: 14px;
  padding: 0 10px;
  border-radius: $borderRadius;
  cursor: pointer;

  .icon {
    font-size: 18px;
    color: var(--pp-text-2);
  }
  .text {
    width: 18px;
    text-align: center;
    font-size: 17px;
  }
  .ai {
    background: linear-gradient(270deg, #d897fd, #33bcfc);
    background-clip: text;
    color: transparent;
    font-weight: 700;
  }

  &:hover {
    background-color: var(--pp-surface-3);
  }
}
.popover-menu-item {
  display: flex;
  padding: 8px 10px;

  .icon {
    font-size: 18px;
    margin-right: 10px;
  }
}
.statement {
  font-size: 12px;
  color: var(--pp-text-3);
  padding: 8px 10px;
  font-style: italic;
}
.main-menu {
  width: 300px;
}
.ai-menu {
  background: linear-gradient(270deg, #f8edff, #d4f1ff);
  color: $themeColor;
  border-radius: $borderRadius;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  cursor: pointer;

  .icon {
    font-size: 22px;
    margin-right: 16px;
  }
  .aippt-content {
    display: flex;
    flex-direction: column;
  }
  .aippt {
    font-weight: 700;
    font-size: 16px;

    span {
      background: linear-gradient(270deg, #d897fd, #33bcfc);
      background-clip: text;
      color: transparent;
    }
  }
  .aippt-subtitle {
    font-size: 12px;
    color: #777;
    margin-top: 5px;
  }
}

.import-section {
  padding: 5px 0;

  .import-label {
    font-size: 12px;
    color: var(--pp-text-3);
    margin-bottom: 6px;
  }
  .import-grid {
    display: flex;
    gap: 8px;
    justify-content: space-between;
  }
  .import-block {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 12px 8px;
    border-radius: $borderRadius;
    border: 1px solid $borderColor;
    transition: background-color .2s;
    cursor: pointer;
  
    &:hover {
      background-color: var(--pp-surface-3);
    }
    .icon {
      font-size: 24px;
      margin-bottom: 2px;
    }
    .label {
      font-size: 12px;
      text-align: center;
    }
    .sub-label {
      font-size: 10px;
      color: var(--pp-text-3);
    }
  }
}

.group-menu-item {
  height: 30px;
  display: flex;
  margin: 0 8px;
  padding: 0 2px;
  border-radius: $borderRadius;

  &:hover {
    background-color: var(--pp-surface-3);
  }

  .menu-item {
    padding: 0 3px;
  }
  .arrow-btn {
    display: flex;
    justify-content: center;
    align-items: center;
    cursor: pointer;
  }
}
.title {
  height: 30px;
  margin-left: 2px;
  font-size: 13px;

  .title-input {
    width: 200px;
    height: 100%;
    padding-left: 0;
    padding-right: 0;

    ::v-deep(input) {
      height: 28px;
      line-height: 28px;
    }
  }
  .title-text {
    min-width: 20px;
    max-width: 400px;
    line-height: 30px;
    padding: 0 6px;
    border-radius: $borderRadius;
    cursor: pointer;

    @include ellipsis-oneline();

    &:hover {
      background-color: var(--pp-surface-3);
    }
  }
}
.github-link {
  display: inline-block;
  height: 30px;
}
</style>