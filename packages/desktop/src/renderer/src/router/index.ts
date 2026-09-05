import type { RouteRecordRaw } from 'vue-router'
// .vue extensions are explicit so TS resolves them through the *.vue module
// shim in src/types/renderer.d.ts. Vite handles extension-less imports at
// runtime, but vue-tsc needs the suffix.
import App from '@/pages/app.vue'
import Preference from '@/pages/preference.vue'
import Welcome from '@/pages/welcome.vue'
import About from '@/pages/about.vue'
import General from '@/prefComponents/general/index.vue'
import Editor from '@/prefComponents/editor/index.vue'
import Markdown from '@/prefComponents/markdown/index.vue'
import SpellChecker from '@/prefComponents/spellchecker/index.vue'
import Theme from '@/prefComponents/theme/index.vue'
import Image from '@/prefComponents/image/index.vue'
import Keybindings from '@/prefComponents/keybindings/index.vue'

const parseSettingsPage = (type: string | null | undefined): string => {
  let pageUrl = '/preference'
  if (type && /\/spelling$/.test(type)) {
    pageUrl += '/spelling'
  }
  return pageUrl
}

const entryRedirect = (type: string | null | undefined): string => {
  if (type === 'welcome') return '/welcome'
  if (type === 'about') return '/about'
  return type === 'editor' ? '/editor' : parseSettingsPage(type)
}

const routes = (type: string | null | undefined): RouteRecordRaw[] => [
  {
    path: '/',
    redirect: entryRedirect(type)
  },
  {
    path: '/editor',
    component: App
  },
  {
    path: '/welcome',
    component: Welcome
  },
  {
    path: '/about',
    component: About
  },
  {
    path: '/preference',
    component: Preference,
    children: [
      {
        path: '',
        component: General
      },
      {
        path: 'general',
        component: General,
        name: 'general'
      },
      {
        path: 'editor',
        component: Editor,
        name: 'editor'
      },
      {
        path: 'markdown',
        component: Markdown,
        name: 'markdown'
      },
      {
        path: 'spelling',
        component: SpellChecker,
        name: 'spelling'
      },
      {
        path: 'theme',
        component: Theme,
        name: 'theme'
      },
      {
        path: 'image',
        component: Image,
        name: 'image'
      },
      {
        path: 'keybindings',
        component: Keybindings,
        name: 'keybindings'
      }
    ]
  }
]

export default routes
