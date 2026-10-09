import {
  translate,
  type LocaleKey,
  type LocaleVars,
} from '@copilot-api/shared/locales'
export function tMain(key: LocaleKey, vars?: LocaleVars): Promise<string> {
  return Promise.resolve(translate(key, vars))
}
