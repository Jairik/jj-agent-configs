import { expect, test } from 'claude-code/testing'

test('the pane draws Clawd\'s header with no placeholder text while it waits', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
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

  await $.command.run({ command: 'voice-mode', args: 'on' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'voice-grill',
      surface,
      component: 'Pane',
      requestId: 'voice-grill',
      props: { title: 'Voice grilling', isFocused: false } as never,
      viewport: { columns: 60, rows: 40 },
    })
    expect(await pane.find({ type: 'Text', text: /Waiting for Claude/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /on its way|writing the next/ })).toBeUndefined()
    expect(await pane.find(surface === 'desktop' ? { type: 'Svg' } : { type: 'Text', text: /▐▛███▜▌/ })).toBeDefined()
    await pane.unmount()
  }
  release()
})
