import { loadTranslations, getSupportedLanguages, isLanguageSupported } from 'common/i18n'

import { trustedHandle } from './guard'

export const registerI18nHandlers = (): void => {
  trustedHandle('mt::i18n::load', (_e, language: string) => loadTranslations(language))
  trustedHandle('mt::i18n::supported', () => getSupportedLanguages())
  trustedHandle('mt::i18n::is-supported', (_e, language: string) => isLanguageSupported(language))
}
