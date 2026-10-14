import { expect, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4 },
  viewport: { columns: 100, rows: 30 },
} as const

test('the band shows only while voice grilling is on, and Voice off ends it', async ($, on) => {
  // The engine beneath the plugin: its own empty band, and panes that open nowhere.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('ui.open', () => ({ value: { isPlaced: false } }))
  on('ui.close', () => ({ value: undefined }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', () => ({ value: { isFilled: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  // No speech helper in a test: it stays "starting" until the test ends.
  let release = () => {}
  const ended = new Promise<void>(resolve => {
    release = resolve
  })
  on('process.spawn', async function* () {
    await ended
  })
  on('clock.now', () => ({ value: 0 }))
  on('clock.after', async () => {
    await ended
    return { value: undefined }
  })
  on('http.fetch', () => {
    throw new Error('no helper socket in tests')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const off = await $.ui.mount({ plugin: 'voice-grill', surface, ...BAND })
    expect(await off.find({ key: 'off' })).toBeUndefined()
    await off.unmount()

    await $.command.run({ command: 'voice-mode', args: 'on' })
    const on_ = await $.ui.mount({ plugin: 'voice-grill', surface, ...BAND })
    expect(await on_.find({ type: 'Text', text: /Voice grilling/ })).toBeDefined()
    await on_.press({ key: 'off' })
    expect(await on_.find({ key: 'off' })).toBeUndefined()
    await on_.unmount()
  }
  release()
})
