<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import EyeCareToggle from './components/EyeCareToggle.vue'
import OutlineAutoFollow from './components/OutlineAutoFollow.vue'
import SidebarCollapseToggle from './components/SidebarCollapseToggle.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #nav-bar-content-after>
      <EyeCareToggle />
    </template>
    <template #layout-bottom>
      <SidebarCollapseToggle />
      <OutlineAutoFollow />
    </template>
  </Layout>
</template>
