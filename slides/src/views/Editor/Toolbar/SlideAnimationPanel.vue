<template>
  <div class="slide-animation-panel">
    <div class="section-title">Custom</div>
    <div class="custom-pool">
      <div
        class="custom-item"
        :class="{ 'active': currentTurningMode === item.value }"
        v-for="item in customTransitions"
        :key="item.value"
        @click="updateTurningMode(item.value)"
      >
        <MotionPreview :from="previousSlide" :to="currentSlide" :spec="item.spec" :width="112" hoverPlay />
        <div class="custom-text">
          <span>{{ item.label }}</span>
          <i-icon-park-outline:edit v-if="item.name" class="edit" v-tooltip="'Edit'" @click.stop="openMotionEditor('transition', item.name)" />
        </div>
      </div>
      <div class="custom-item new" @click="openMotionEditor('transition')">
        <div class="new-box"><i-icon-park-outline:plus /></div>
        <div class="custom-text"><span>New…</span></div>
      </div>
    </div>
    <div class="section-title">Built in</div>
    <div class="animation-pool">
      <div 
        class="animation-item" 
        :class="{ 'active': currentTurningMode === item.value }" 
        v-for="item in animations" 
        :key="item.label"
        @click="updateTurningMode(item.value)"
      >
        <div :class="['animation-block', item.value]">P</div>
        <div class="animation-text">{{item.label}}</div>
      </div>
    </div>
    <Button style="width: 100%;" @click="applyAllSlide()"><i-icon-park-outline:check /> Apply to all</Button>
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useSlidesStore } from '@/store'
import type { TurningMode } from '@/types/slides'
import { SLIDE_ANIMATIONS } from '@/configs/animation'
import useHistorySnapshot from '@/hooks/useHistorySnapshot'
import message from '@/utils/message'
import Button from '@/components/Button.vue'
import MotionPreview from '../Motion/MotionPreview.vue'
import { openMotionEditor } from '../Motion/state'
import { MAGIC_MOVE } from '@/utils/motion'
import type { MotionSpec } from '@/utils/motionStage'

const slidesStore = useSlidesStore()
const { slides, currentSlide, slideIndex, motion } = storeToRefs(slidesStore)

// Magic Move first, then the deck's own transitions (deck.motion.transitions), each with a hover preview.
const previousSlide = computed(() => (slideIndex.value > 0 ? slides.value[slideIndex.value - 1] : null))
const customTransitions = computed(() => [
  { value: MAGIC_MOVE as TurningMode, label: 'Magic Move', name: '', spec: (previousSlide.value ? { kind: 'magic' } : null) as MotionSpec | null },
  ...Object.entries(motion.value.transitions).map(([name, def]) => ({
    value: `custom:${name}` as TurningMode,
    label: def.label || name,
    name,
    spec: { kind: 'transition', def } as MotionSpec,
  })),
])

const currentTurningMode = computed(() => currentSlide.value.turningMode || 'slideY')

const animations = SLIDE_ANIMATIONS

const { addHistorySnapshot } = useHistorySnapshot()

// 修改播放时的切换页面方式
const updateTurningMode = (mode: TurningMode) => {
  if (mode === currentTurningMode.value) return
  slidesStore.updateSlide({ turningMode: mode })
  addHistorySnapshot()
}

// 将当前页的切换页面方式应用到全部页面
const applyAllSlide = () => {
  const newSlides = slides.value.map(slide => {
    return {
      ...slide,
      turningMode: currentSlide.value.turningMode,
    }
  })
  slidesStore.setSlides(newSlides)
  message.success('Applied to all slides')
  addHistorySnapshot()
}
</script>

<style lang="scss" scoped>
.section-title {
  font-size: 12px;
  color: var(--pp-text-3);
  margin-bottom: 8px;
}
.custom-pool {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.custom-item {
  width: calc(50% - 4px);
  border: 1px solid var(--pp-border);
  border-radius: $borderRadius;
  padding: 4px;
  cursor: pointer;

  &.active {
    border-color: $themeColor;
    background-color: color-mix(in srgb, var(--pp-accent) 5%, transparent);
  }
  &:hover .edit {
    opacity: 1;
  }
}
.custom-text {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  padding: 4px 2px 0;

  .edit {
    opacity: 0;
    color: var(--pp-text-3);
    &:hover { color: $themeColor; }
  }
}
.new-box {
  height: 63px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  color: var(--pp-text-3);
  border: 1px dashed var(--pp-border-strong);
  border-radius: $borderRadius;
}
.animation-pool {
  display: flex;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.animation-item {
  width: 50%;
  height: 100px;
  border: solid 1px #d6d6d6;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  padding: 20px 0 15px 0;
  position: relative;
  cursor: pointer;

  &.active {
    border-color: $themeColor;
    background-color: color-mix(in srgb, var(--pp-accent) 5%, transparent);
    z-index: 1;
  }

  &:nth-child(2n) {
    margin-left: -1px;
  }
  &:nth-child(n+3) {
    margin-top: -1px;
  }
}
.animation-block {
  width: 64px;
  height: 36px;
  background: #666;
  position: relative;
  overflow: hidden;
  color: #fff;
  display: flex;
  justify-content: center;
  align-items: center;

  @mixin elAnimation($animationType) {
    content: 'PPTist';
    width: 100%;
    height: 100%;
    position: absolute;
    left: 0;
    top: 0;
    background-color: $themeColor;
    color: var(--pp-on-accent);
    display: flex;
    justify-content: center;
    align-items: center;
    animation: $animationType $transitionDelaySlow linear;
  }

  &.fade:hover {
    &::after {
      @include elAnimation(fade);
    }
  }
  &.slideX:hover {
    &::after {
      @include elAnimation(slideX);
    }
  }
  &.slideY:hover {
    &::after {
      @include elAnimation(slideY);
    }
  }
  &.slideX3D:hover {
    &::after {
      @include elAnimation(slideX3D);
    }
  }
  &.slideY3D:hover {
    &::after {
      @include elAnimation(slideY3D);
    }
  }
  &.rotate:hover {
    &::after {
      transform-origin: 0 0;
      @include elAnimation(rotate);
    }
  }
  &.scaleY:hover {
    &::after {
      @include elAnimation(scaleY);
    }
  }
  &.scaleX:hover {
    &::after {
      @include elAnimation(scaleX);
    }
  }
  &.scale:hover {
    &::after {
      @include elAnimation(scale);
    }
  }
  &.scaleReverse:hover {
    &::after {
      @include elAnimation(scaleReverse);
    }
  }
}
.animation-text {
  font-size: 12px;
  color: var(--pp-text);
  text-align: center;
}

@keyframes fade {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}
@keyframes slideX {
  0% {
    transform: translateX(100%);
  }
  100% {
    transform: translateX(0);
  }
}
@keyframes slideY {
  0% {
    transform: translateY(100%);
  }
  100% {
    transform: translateY(0);
  }
}
@keyframes slideX3D {
  0% {
    transform: translateX(100%) scale(.5);
  }
  100% {
    transform: translateX(0);
  }
}
@keyframes slideY3D {
  0% {
    transform: translateY(100%) scale(.5);
  }
  100% {
    transform: translateY(0);
  }
}
@keyframes rotate {
  0% {
    transform: rotate(-90deg);
  }
  100% {
    transform: rotate(0);
  }
}
@keyframes scaleY {
  0% {
    transform: scaleY(.1);
  }
  100% {
    transform: scaleY(1);
  }
}
@keyframes scaleX {
  0% {
    transform: scaleX(.1);
  }
  100% {
    transform: scaleY(1);
  }
}
@keyframes scale {
  0% {
    transform: scale(.25);
  }
  100% {
    transform: scale(1);
  }
}
@keyframes scaleReverse {
  0% {
    transform: scale(2);
  }
  100% {
    transform: scale(1);
  }
}
</style>