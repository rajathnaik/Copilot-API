import { describe, expect, test } from 'bun:test'
import { translate } from '../src/locales'

describe('English application strings', () => {
  test('resolves nested keys and interpolates string and numeric values', () => {
    expect(translate('settings.sectionTheme')).toBe('Theme')
    expect(translate('connector.version', { version: '2.7.3' })).toBe(
      'Connector version 2.7.3',
    )
    expect(translate('connector.modelCount', { count: 12 })).toContain('12')
  })

  test('does not require a browser or operating-system locale', () => {
    expect(translate('connector.showKey')).toBe('Show key')
    expect(translate('settings.restartAppPrompt')).toContain('Restart the app')
  })
})
