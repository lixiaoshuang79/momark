import log from 'electron-log'

import { trustedHandle } from './guard'

interface FontListShape {
  getFonts?: () => Promise<string[]>
  default?: { getFonts?: () => Promise<string[]> }
}

export const registerFontsHandlers = (): void => {
  trustedHandle('mt::fonts::list', async () => {
    try {
      const fontList = (await import('font-list')) as FontListShape
      const getFonts = fontList.getFonts || fontList.default?.getFonts
      if (typeof getFonts !== 'function') return []
      return await getFonts()
    } catch (err) {
      log.error('font-list failed:', err)
      return []
    }
  })
}
