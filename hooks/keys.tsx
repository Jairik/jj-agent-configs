import type { ClientModule } from 'claude-code'

// Catches keys while the pane has the focus (click it first): Ctrl+D leaves voice mode, Space pauses.
const Keys: ClientModule = (_props, surface) => {
  const { Text } = surface.elements
  surface.onKey(event => {
    if (event.ctrl && event.key.toLowerCase() === 'd') surface.post({ type: 'stop' })
    if (event.key === ' ' && !event.ctrl && !event.meta) surface.post({ type: 'pause' })
  })

  return <Text dimColor>Space pauses · Ctrl+D types instead</Text>
}

export default Keys
