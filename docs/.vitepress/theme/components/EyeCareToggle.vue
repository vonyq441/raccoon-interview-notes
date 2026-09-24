<script setup lang="ts">
import { onMounted, ref } from 'vue'

const STORAGE_KEY = 'raccoon-docs-eye-care'
const enabled = ref(false)

function applyEyeCare(value: boolean) {
  document.documentElement.classList.toggle('eye-care', value)
}

function toggleEyeCare() {
  enabled.value = !enabled.value
  applyEyeCare(enabled.value)

  try {
    localStorage.setItem(STORAGE_KEY, enabled.value ? '1' : '0')
  } catch {
    // 隐私模式或存储被禁用时，本次页面仍然可以正常切换。
  }
}

onMounted(() => {
  try {
    enabled.value = localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    enabled.value = document.documentElement.classList.contains('eye-care')
  }

  applyEyeCare(enabled.value)
})
</script>

<template>
  <button
    class="eye-care-toggle"
    type="button"
    :class="{ active: enabled }"
    :aria-pressed="enabled"
    :aria-label="enabled ? '关闭护眼模式' : '开启护眼模式'"
    :title="enabled ? '关闭护眼模式' : '开启护眼模式'"
    @click="toggleEyeCare"
  >
    <svg class="eye-care-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19.8 3.7C13.3 3.9 8.7 6 6.3 9.5c-1.7 2.5-1.8 5.4-.3 7.6 2.1-3.9 5.3-6.6 9.6-8.2-3.8 2.2-6.5 5.2-8 9.1 2.1 1.2 4.8 1 7-.5 3.8-2.6 5.3-7.4 5.2-13.8Z" />
    </svg>
    <span class="eye-care-label">{{ enabled ? '护眼已开' : '护眼模式' }}</span>
  </button>
</template>
