<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useData } from 'vitepress'

const STORAGE_KEY = 'raccoon-docs-sidebar-collapsed'
const collapsed = ref(false)
const { frontmatter } = useData()

const visible = computed(() => frontmatter.value.layout !== 'home')

function applyState(value: boolean) {
  document.documentElement.classList.toggle('sidebar-collapsed', value)
}

function toggleSidebar() {
  collapsed.value = !collapsed.value
  applyState(collapsed.value)

  try {
    localStorage.setItem(STORAGE_KEY, collapsed.value ? '1' : '0')
  } catch {
    // 无痕模式或禁用存储时仍保留本次页面的折叠状态。
  }
}

onMounted(() => {
  try {
    collapsed.value = localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    collapsed.value = document.documentElement.classList.contains('sidebar-collapsed')
  }

  applyState(collapsed.value)
})
</script>

<template>
  <button
    v-if="visible"
    class="sidebar-collapse-toggle"
    :class="{ collapsed }"
    type="button"
    aria-controls="VPSidebarNav"
    :aria-expanded="!collapsed"
    :aria-label="collapsed ? '展开左侧导航' : '隐藏左侧导航'"
    :title="collapsed ? '展开左侧导航' : '隐藏左侧导航'"
    @click="toggleSidebar"
  >
    <span aria-hidden="true">{{ collapsed ? '>>> 展开' : '<<< 隐藏' }}</span>
  </button>
</template>

