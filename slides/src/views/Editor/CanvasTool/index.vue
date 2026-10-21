<template>
  <div class="canvas-tool">
    <div class="left-handler">
      <span class="handler-item" :class="{ 'disable': !canUndo }" v-tooltip="'Undo (Ctrl + Z)'" @click="undo()">
        <i-icon-park-outline:back />
      </span>
      <span class="handler-item" :class="{ 'disable': !canRedo }" v-tooltip="'Redo (Ctrl + Y)'" @click="redo()">
        <i-icon-park-outline:next />
      </span>
      <div class="more">
        <Divider type="vertical" style="height: 20px;" />
        <Popover class="more-icon" trigger="click" v-model:value="moreVisible" :offset="10">
          <template #content>
            <PopoverMenuItem class="popover-menu-item" center @click="toggleNotesPanel(); moreVisible = false"><i-icon-park-outline:comment class="icon" />Comments</PopoverMenuItem>
            <PopoverMenuItem class="popover-menu-item" center @click="toggleSelectPanel(); moreVisible = false"><i-icon-park-outline:move-one class="icon" />Selection pane</PopoverMenuItem>
            <PopoverMenuItem class="popover-menu-item" center @click="toggleSraechPanel(); moreVisible = false"><i-icon-park-outline:search class="icon" />Find and replace</PopoverMenuItem>
          </template>
          <span class="handler-item">
            <i-icon-park-outline:more />
          </span>
        </Popover>
        <span class="handler-item" :class="{ 'active': showNotesPanel }" v-tooltip="'Comments'" @click="toggleNotesPanel()">
          <i-icon-park-outline:comment />
        </span>
        <span class="handler-item" :class="{ 'active': showSelectPanel }" v-tooltip="'Selection pane'" @click="toggleSelectPanel()">
          <i-icon-park-outline:move-one />
        </span>
        <span class="handler-item" :class="{ 'active': showSearchPanel }" v-tooltip="'Find and replace (Ctrl + F)'" @click="toggleSraechPanel()">
          <i-icon-park-outline:search />
        </span>
      </div>
    </div>

    <div class="add-element-handler">
      <div class="insert-handler-item group-btn" :class="{ 'active': creatingElement?.type === 'text' }" v-tooltip="'Insert text'">
        <div class="group-btn-main" @click="drawText()"><i-icon-park-outline:font-size class="icon" /> <span class="text">Text box</span></div>
        
        <Popover trigger="click" v-model:value="textTypeSelectVisible" style="height: 100%;" :offset="10">
          <template #content>
            <PopoverMenuItem center @click="() => { drawText(); textTypeSelectVisible = false }"><i-icon-park-outline:text-rotation-none class="icon" /> Horizontal text box</PopoverMenuItem>
            <PopoverMenuItem center @click="() => { drawText(true); textTypeSelectVisible = false }"><i-icon-park-outline:text-rotation-down class="icon" /> Vertical text box</PopoverMenuItem>
          </template>
          <span class="arrow"><i-icon-park-outline:down /></span>
        </Popover>
      </div>
      <div class="insert-handler-item group-btn" :class="{ 'active': creatingCustomShape || creatingElement?.type === 'shape' }" v-tooltip="'Insert shape'" :offset="10">
        <Popover trigger="click" style="height: 100%;" v-model:value="shapePoolVisible" :offset="10">
          <template #content>
            <ShapePool @select="shape => drawShape(shape)" />
          </template>
          <div class="group-btn-main"><i-icon-park-outline:graphic-design class="icon" /> <span class="text">Shape</span></div>
        </Popover>
        
        <Popover trigger="click" v-model:value="shapeMenuVisible" style="height: 100%;" :offset="10">
          <template #content>
            <PopoverMenuItem center @click="shapeMenuVisible = false; shapePoolVisible = true"><i-icon-park-outline:graphic-design class="icon" />Preset shapes</PopoverMenuItem>
            <PopoverMenuItem center @click="() => { svgPathEditorVisible = true; shapeMenuVisible = false }"><i-icon-park-outline:connection class="icon" />Draw a path</PopoverMenuItem>
            <PopoverMenuItem center @click="() => { drawCustomShape(); shapeMenuVisible = false }"><i-icon-park-outline:writing-fluently class="icon" />Freehand</PopoverMenuItem>
          </template>
          <span class="arrow"><i-icon-park-outline:down /></span>
        </Popover>
      </div>
      <div class="insert-handler-item group-btn" v-tooltip="'Insert image'">
        <FileInput style="height: 100%;" @change="files => insertImageElement(files)">
          <div class="group-btn-main"><i-icon-park-outline:picture class="icon" /> <span class="text">Image</span></div>
        </FileInput>
        
        <Popover trigger="click" v-model:value="imageMenuVisible" style="height: 100%;" :offset="10">
          <template #content>
            <FileInput @change="files => { insertImageElement(files); imageMenuVisible = false }">
              <PopoverMenuItem center><i-icon-park-outline:upload class="icon" /> Upload image</PopoverMenuItem>
            </FileInput>
          </template>
          <span class="arrow"><i-icon-park-outline:down /></span>
        </Popover>
      </div>
      <Popover trigger="click" v-model:value="linePoolVisible" :offset="10">
        <template #content>
          <LinePool @select="line => drawLine(line)" />
        </template>
        <div class="insert-handler-item" :class="{ 'active': creatingElement?.type === 'line' }" v-tooltip="'Insert line'">
          <i-icon-park-outline:connection class="icon" /> <span class="text">Line</span>
        </div>
      </Popover>
      <Popover trigger="click" v-model:value="chartPoolVisible" :offset="10">
        <template #content>
          <ChartPool @select="chart => { createChartElement(chart); chartPoolVisible = false }" />
        </template>
        <div class="insert-handler-item" v-tooltip="'Insert chart'">
          <i-icon-park-outline:chart-proportion class="icon" /> <span class="text">Chart</span>
        </div>
      </Popover>
      <Popover trigger="click" v-model:value="tableGeneratorVisible" :offset="10">
        <template #content>
          <TableGenerator
            @close="tableGeneratorVisible = false"
            @insert="({ row, col }) => { createTableElement(row, col); tableGeneratorVisible = false }"
          />
        </template>
        <div class="insert-handler-item" v-tooltip="'Insert table'">
          <i-icon-park-outline:insert-table class="icon" /> <span class="text">Table</span>
        </div>
      </Popover>
      <div class="insert-handler-item" v-tooltip="'Insert formula'" @click="latexEditorVisible = true">
        <i-icon-park-outline:formula class="icon" /> <span class="text">Formula</span>
      </div>
      <div class="insert-handler-item" v-tooltip="'Insert script (code that draws and animates)'" @click="insertScript()">
        <i-icon-park-outline:code class="icon" /> <span class="text">Script</span>
      </div>
      <Popover trigger="click" v-model:value="mediaInputVisible" :offset="10">
        <template #content>
          <MediaInput 
            @close="mediaInputVisible = false"
            @insertVideo="({ src, ext }) => { createVideoElement(src, ext); mediaInputVisible = false }"
            @insertAudio="({ src, ext }) => { createAudioElement(src, ext); mediaInputVisible = false }"
          />
        </template>
        <div class="insert-handler-item" v-tooltip="'Insert audio or video'">
          <i-icon-park-outline:video-two class="icon" /> <span class="text">Media</span>
        </div>
      </Popover>
      <div class="insert-handler-item" :class="{ 'active': showSymbolPanel }" v-tooltip="'Insert symbol'" @click="toggleSymbolPanel()">
        <i-icon-park-outline:symbol class="icon" /> <span class="text">Symbol</span>
      </div>
    </div>

    <div class="right-handler">
      <span class="handler-item viewport-size" v-tooltip="'Zoom out (Ctrl + -)'" @click="scaleCanvas('-')">
        <i-icon-park-outline:minus />
      </span>
      <Popover trigger="click" v-model:value="canvasScaleVisible">
        <template #content>
          <PopoverMenuItem
            center
            v-for="item in canvasScalePresetList" 
            :key="item" 
            @click="applyCanvasPresetScale(item)"
          >{{item}}%</PopoverMenuItem>
          <PopoverMenuItem center @click="resetCanvas(); canvasScaleVisible = false">Fit to screen</PopoverMenuItem>
        </template>
        <span class="text">{{ canvasScalePercentage }}</span>
      </Popover>
      <span class="handler-item viewport-size" v-tooltip="'Zoom in (Ctrl + =)'" @click="scaleCanvas('+')">
        <i-icon-park-outline:plus />
      </span>
      <span class="handler-item viewport-size-adaptation" v-tooltip="'Fit to screen (Ctrl + 0)'" @click="resetCanvas()">
        <i-icon-park-outline:full-screen />
      </span>
    </div>

    <Modal
      v-model:visible="latexEditorVisible" 
      :width="880"
    >
      <LaTeXEditor 
        @close="latexEditorVisible = false"
        @update="data => { createLatexElement(data); latexEditorVisible = false }"
      />
    </Modal>

    <Modal
      v-model:visible="svgPathEditorVisible"
      :width="800"
    >
      <SVGPathEditor
        @close="svgPathEditorVisible = false"
        @insert="path => insertSvgPath(path)"
      />
    </Modal>
  </div>
</template>

<script lang="ts" setup>
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useMainStore, useSlidesStore, useSnapshotStore } from '@/store'
import { getImageDataURL } from '@/utils/image'
import type { ShapePoolItem } from '@/configs/shapes'
import type { LinePoolItem } from '@/configs/lines'
import type { PPTShapeElement } from '@/types/slides'
import useScaleCanvas from '@/hooks/useScaleCanvas'
import useHistorySnapshot from '@/hooks/useHistorySnapshot'
import { hooks } from '@/bridge/hooks'
import message from '@/utils/message'
import { openScriptEditor } from '@/views/Editor/Script/state'
import { nanoid as newScriptId } from 'nanoid'
import type { PPTScriptElement } from '@/types/slides'
import useCreateElement from '@/hooks/useCreateElement'

import ShapePool from './ShapePool.vue'
import LinePool from './LinePool.vue'
import ChartPool from './ChartPool.vue'
import TableGenerator from './TableGenerator.vue'
import MediaInput from './MediaInput.vue'
import SVGPathEditor from './SVGPathEditor.vue'
import LaTeXEditor from '@/components/LaTeXEditor/index.vue'
import FileInput from '@/components/FileInput.vue'
import Modal from '@/components/Modal.vue'
import Divider from '@/components/Divider.vue'
import Popover from '@/components/Popover.vue'
import PopoverMenuItem from '@/components/PopoverMenuItem.vue'

const mainStore = useMainStore()
const slidesStore = useSlidesStore()
const { creatingElement, creatingCustomShape, showSelectPanel, showSearchPanel, showNotesPanel, showSymbolPanel } = storeToRefs(mainStore)
const { canUndo, canRedo } = storeToRefs(useSnapshotStore())
const { theme, viewportRatio, viewportSize } = storeToRefs(slidesStore)

const { redo, undo, addHistorySnapshot } = useHistorySnapshot()

const {
  scaleCanvas,
  setCanvasScalePercentage,
  resetCanvas,
  canvasScalePercentage,
} = useScaleCanvas()

const canvasScalePresetList = [200, 150, 125, 100, 75, 50]
const canvasScaleVisible = ref(false)

const applyCanvasPresetScale = (value: number) => {
  setCanvasScalePercentage(value)
  canvasScaleVisible.value = false
}

const {
  createImageElement,
  createChartElement,
  createTableElement,
  createLatexElement,
  createVideoElement,
  createAudioElement,
  createShapeElement,
} = useCreateElement()

// A script element: a new script file (starter code, written by the host page) in a box mid-slide.
const insertScript = async () => {
  if (!hooks.createScript) return message.error('Scripts need the Slides space of Mail Workspace')
  const src = await hooks.createScript()
  const width = 480
  const height = 320
  const element: PPTScriptElement = {
    type: 'script', id: newScriptId(10), src, steps: 0, libs: [], rotate: 0, width, height,
    left: (viewportSize.value - width) / 2,
    top: (viewportSize.value * viewportRatio.value - height) / 2,
  }
  slidesStore.addElement(element)
  mainStore.setActiveElementIdList([element.id])
  addHistorySnapshot()
  openScriptEditor(element.id)
}

const insertImageElement = (files: FileList) => {
  const imageFile = files[0]
  if (!imageFile) return
  getImageDataURL(imageFile).then(dataURL => createImageElement(dataURL))
}

const shapePoolVisible = ref(false)
const linePoolVisible = ref(false)
const chartPoolVisible = ref(false)
const tableGeneratorVisible = ref(false)
const mediaInputVisible = ref(false)
const latexEditorVisible = ref(false)
const svgPathEditorVisible = ref(false)
const textTypeSelectVisible = ref(false)
const shapeMenuVisible = ref(false)
const imageMenuVisible = ref(false)
const moreVisible = ref(false)

// 绘制文字范围
const drawText = (vertical = false) => {
  mainStore.setCreatingElement({
    type: 'text',
    vertical,
  })
}

// 绘制形状范围
const drawShape = (shape: ShapePoolItem) => {
  mainStore.setCreatingElement({
    type: 'shape',
    data: shape,
  })
  shapePoolVisible.value = false
}
// 绘制自定义任意多边形
const drawCustomShape = () => {
  mainStore.setCreatingCustomShapeState(true)
  shapePoolVisible.value = false
}
// 根据路径插入形状
const insertSvgPath = (path: string) => {
  const width = 400
  const height = 400
  const isClosedPath = /z\s*$/i.test(path)
  const position = {
    width,
    height,
    left: (viewportSize.value - width) / 2,
    top: (viewportSize.value * viewportRatio.value - height) / 2,
  }
  const supplement: Partial<PPTShapeElement> = isClosedPath
    ? { fill: theme.value.themeColors[0] }
    : {
      fill: 'rgba(0, 0, 0, 0)',
      outline: {
        width: 2,
        color: theme.value.themeColors[0],
        style: 'solid',
      },
    }

  createShapeElement(position, {
    path,
    viewBox: [width, height],
  }, supplement)
  svgPathEditorVisible.value = false
}

// 绘制线条路径
const drawLine = (line: LinePoolItem) => {
  mainStore.setCreatingElement({
    type: 'line',
    data: line,
  })
  linePoolVisible.value = false
}

// 打开选择面板
const toggleSelectPanel = () => {
  mainStore.setSelectPanelState(!showSelectPanel.value)
}

// 打开搜索替换面板
const toggleSraechPanel = () => {
  mainStore.setSearchPanelState(!showSearchPanel.value)
}

// 打开批注面板
const toggleNotesPanel = () => {
  mainStore.setNotesPanelState(!showNotesPanel.value)
}

// 打开符号面板
const toggleSymbolPanel = () => {
  mainStore.setSymbolPanelState(!showSymbolPanel.value)
}

// 打开图库面板
</script>

<style lang="scss" scoped>
// Undo/redo on the left, the insert buttons in the middle, zoom on the right; when the editor is narrow
// the row wraps (no part is hidden), and labels give way first. Sizes follow the editor, not the window.
.canvas-tool {
  position: relative;
  border-bottom: 1px solid $borderColor;
  background-color: var(--pp-surface);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 8px;
  min-height: 40px;
  box-sizing: border-box;
  padding: 4px 10px;
  font-size: 13px;
  user-select: none;
  container-type: inline-size;
}
.left-handler, .more {
  display: flex;
  align-items: center;
}
.more-icon {
  display: none;
}
.popover-menu-item {
  display: flex;
  padding: 8px 10px;

  &.center {
    justify-content: center;
  }

  .icon {
    font-size: 18px;
    margin-right: 8px;
  }
}
.add-element-handler {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  row-gap: 2px;

  & > div {
    flex-shrink: 0;
  }

  .insert-handler-item {
    height: 30px;
    font-size: 14px;
    margin: 0 2px;
    padding: 0 10px;
    display: flex;
    justify-content: center;
    align-items: center;
    border-radius: $borderRadius;
    overflow: hidden;
    cursor: pointer;

    &:not(.group-btn):hover {
      background-color: var(--pp-surface-3);
    }

    &.active {
      background-color: var(--pp-surface-3);
    }

    .icon {
      margin-right: 4px;
    }

    &.group-btn {
      margin-right: 6px;
      padding: 0;

      &:hover {
        background-color: #f3f3f3;
      }

      .group-btn-main {
        height: 100%;
        display: flex;
        justify-content: center;
        align-items: center;
        padding: 0 5px;

        &:hover {
          background-color: #e9e9e9;
        }
      }

      .arrow {
        height: 100%;
        display: flex;
        justify-content: center;
        align-items: center;
        font-size: 12px;
        padding: 0 1px;
  
        &:hover {
          background-color: #e9e9e9;
        }
      }
    }
  }
}
.handler-item {
  height: 30px;
  font-size: 14px;
  margin: 0 2px;
  display: flex;
  justify-content: center;
  align-items: center;
  border-radius: $borderRadius;
  overflow: hidden;
  cursor: pointer;

  &.disable {
    opacity: .5;
  }
}
.left-handler, .right-handler {
  .handler-item {
    padding: 0 8px;

    &.active,
    &:not(.disable):hover {
      background-color: var(--pp-surface-3);
    }
  }
}
.right-handler {
  display: flex;
  align-items: center;

  .text {
    display: inline-block;
    width: 40px;
    text-align: center;
    cursor: pointer;
  }

  .viewport-size {
    font-size: 13px;
  }
}

@container (width <= 1250px) {
  .add-element-handler {
    .insert-handler-item {
      .icon {
        margin-right: 0;
      }
      .text {
        display: none;
      }
    }
  }
}
@container (width <= 950px) {
  .add-element-handler {
    .insert-handler-item {
      padding: 0 6px;
    }
  }
}
@container (width <= 820px) {
  .right-handler .text {
    display: none;
  }
  .more > .handler-item {
    display: none;
  }
  .more-icon {
    display: block;
  }
}

</style>