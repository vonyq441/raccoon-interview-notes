import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: '浣熊智能巡检 · 面试速记',
  description: '浣熊智能巡检 Java 项目面试复习文档',
  base: process.env.DOCS_BASE || '/',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['meta', { name: 'theme-color', content: '#0f766e' }],
    ['meta', { name: 'apple-mobile-web-app-capable', content: 'yes' }],
    ['meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'default' }],
    ['meta', { name: 'format-detection', content: 'telephone=no' }]
  ],
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: '面试速记',
    nav: [
      { text: '首页', link: '/' },
      { text: '面试文档', link: '/interview' }
    ],
    sidebar: [
      {
        text: '项目面试',
        items: [
          { text: '面试速记', link: '/interview' }
        ]
      }
    ],
    outline: {
      level: [2, 4],
      label: '本页目录'
    },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索文档',
            buttonAriaLabel: '搜索文档'
          },
          modal: {
            noResultsText: '没有找到相关内容',
            resetButtonTitle: '清除查询',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭'
            }
          }
        }
      }
    },
    docFooter: {
      prev: false,
      next: false
    },
    returnToTopLabel: '返回顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    lastUpdated: {
      text: '最后更新于',
      formatOptions: {
        dateStyle: 'medium',
        timeStyle: 'short'
      }
    },
    footer: {
      message: '用于个人项目面试复习',
      copyright: '浣熊智能巡检'
    }
  }
})
