import { expect, test } from 'bun:test'
import { tMain } from '../electron/i18n'

test('main-process messages use English without reading Electron or saved language preferences', async () => {
  expect(await tMain('settings.sectionTheme')).toBe('Theme')
  expect(await tMain('connector.version', { version: '2.7.3' })).toBe(
    'Connector version 2.7.3',
  )
})
