<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import EyeCareToggle from './components/EyeCareToggle.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #nav-bar-content-after>
      <EyeCareToggle />
    </template>
  </Layout>
</template>
