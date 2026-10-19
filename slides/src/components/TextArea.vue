<template>
  <textarea
    class="textarea" 
    :class="{
      'disabled': disabled,
      'resizable': resizable,
    }"
    ref="textareaRef"
    :disabled="disabled"
    :value="value" 
    :rows="rows"
    :placeholder="placeholder"
    :style="{
      padding: padding ? `${padding}px` : '10px',
    }"
    @input="$event => handleInput($event)"
    @focus="$event => emit('focus', $event)"
    @blur="$event => emit('blur', $event)"
    @keydown.enter="$event => emit('enter', $event)"
  ></textarea>
</template>

<script lang="ts" setup>
import { useTemplateRef } from 'vue'

withDefaults(defineProps<{
  value: string
  rows?: number
  padding?: number
  disabled?: boolean
  resizable?: boolean
  placeholder?: string
}>(), {
  rows: 4,
  disabled: false,
  resizable: false,
  placeholder: '',
})

const emit = defineEmits<{
  (event: 'update:value', payload: string): void
  (event: 'focus', payload: FocusEvent): void
  (event: 'blur', payload: FocusEvent): void
  (event: 'enter', payload: KeyboardEvent): void
}>()

const handleInput = (e: Event) => {
  emit('update:value', (e.target as HTMLInputElement).value)
}

const textareaRef = useTemplateRef<HTMLTextAreaElement>('textareaRef')
const focus = () => {
  if (textareaRef.value) textareaRef.value.focus()
}

defineExpose({
  focus,
})
</script>

<style lang="scss" scoped>
.textarea {
  outline: 0;
  width: 100%;
  background-color: var(--pp-surface);
  border: 1px solid var(--pp-border);
  border-radius: $borderRadius;
  padding: 10px;
  transition: border-color .25s;
  box-sizing: border-box;
  line-height: 1.675;
  resize: none;
  font-family: -apple-system,BlinkMacSystemFont, 'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans',sans-serif,'Apple Color Emoji','Segoe UI Emoji','Segoe UI Symbol','Noto Color Emoji';

  &:focus {
    border-color: $themeColor;
    background-color: var(--pp-surface);
  }

  &.resizable {
    resize: vertical;
  }

  &.disabled {
    background-color: var(--pp-surface-2);
    border-color: var(--pp-border);
    color: var(--pp-text-4);
  }

  &::placeholder {
    color: var(--pp-text-4);
  }
}
</style>