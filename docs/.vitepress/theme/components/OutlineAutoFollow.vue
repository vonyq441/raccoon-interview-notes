<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted } from 'vue'
import { onContentUpdated } from 'vitepress'

let outlineObserver: MutationObserver | undefined
let setupTimer: number | undefined

function keepActiveHeadingVisible() {
  const scroller = document.querySelector<HTMLElement>('.VPDoc .aside-container')
  const activeLink = scroller?.querySelector<HTMLElement>('.outline-link.active')

  if (!scroller || !activeLink) return

  const scrollerRect = scroller.getBoundingClientRect()
  const linkRect = activeLink.getBoundingClientRect()
  const safeTop = scrollerRect.top + 48
  const safeBottom = scrollerRect.bottom - 48

  if (linkRect.top >= safeTop && linkRect.bottom <= safeBottom) return

  const nextTop =
    scroller.scrollTop +
    linkRect.top -
    scrollerRect.top -
    scroller.clientHeight / 2 +
    linkRect.height / 2

  scroller.scrollTo({
    top: Math.max(0, nextTop),
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth'
  })
}

function observeOutline() {
  outlineObserver?.disconnect()

  const outline = document.querySelector<HTMLElement>('.VPDocAsideOutline')
  if (!outline) return

  outlineObserver = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.attributeName === 'class')) {
      keepActiveHeadingVisible()
    }
  })

  outlineObserver.observe(outline, {
    attributes: true,
    attributeFilter: ['class'],
    subtree: true
  })

  keepActiveHeadingVisible()
}

function scheduleObservation() {
  if (setupTimer !== undefined) window.clearTimeout(setupTimer)
  setupTimer = window.setTimeout(() => void nextTick(observeOutline), 0)
}

onMounted(scheduleObservation)
onContentUpdated(scheduleObservation)

onBeforeUnmount(() => {
  outlineObserver?.disconnect()
  if (setupTimer !== undefined) window.clearTimeout(setupTimer)
})
</script>

<template></template>

