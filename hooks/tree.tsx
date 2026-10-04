// The tree: a surface module. It draws the rows in color, follows the pointer, and takes the arrow keys
// after a click. It holds no data of its own: every action is a post to the hooks module, which answers
// with new rows. It has no `$`.
import type { ClientModule } from 'claude-code'

/** One row: its key, depth, kind, label, Git badge, open state, error, icon mark and icon color. */
export type TreeRow = { k: string; d: number; t: string; l: string; b?: string; o?: boolean; e?: string; m: string; c: string }
type Props = { rows: TreeRow[]; start: number; total: number; cursor: string; selected: string; cols: number; lines: number; empty: string }
type State = { hover: number }

// name and badge colors by Git state, as an editor's explorer shows them
const TINT: Record<string, string> = { M: '#e2c08d', A: '#73c991', '?': '#73c991', D: '#f14c4c', U: '#f14c4c', R: '#7aa2f7', '•': '#e2c08d' }

const Tree: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const hover = surface.state?.hover ?? -1
  const H = surface.rows || props.lines
  const W = surface.columns || props.cols
  const at = props.rows.findIndex(r => r.k === props.cursor)
  const row = (i: number) => props.rows[i]
  // an absolute row number, so a move that passes the rows drawn here still names its target
  const to = (abs: number) => surface.post({ to: Math.max(0, Math.min(props.total - 1, abs)) })

  surface.onPointer(p => {
    if (p.type === 'leave') return hover === -1 ? undefined : surface.setState({ hover: -1 })
    if (p.type === 'move' && p.y !== hover) return surface.setState({ hover: p.y })
    const r = row(p.y)
    if (p.type !== 'down' || !r || r.t === 'note') return
    // the right button selects the row and shows the actions for it, as a context menu does
    surface.post(p.button === 'right' ? { menu: r.k } : { press: r.k })
  })
  surface.onKey(k => {
    const r = row(at)
    const abs = props.start + Math.max(0, at)
    if (k.ctrl || k.meta) return
    if (k.key === 'up') return to(at < 0 ? props.start : abs - 1)
    if (k.key === 'down') return to(at < 0 ? props.start : abs + 1)
    if (k.key === 'pageup') return to(abs - H)
    if (k.key === 'pagedown') return to(abs + H)
    if (k.key === 'home') return to(0)
    if (k.key === 'end') return to(props.total - 1)
    if (!r) return
    if (k.key === 'return' || k.key === 'enter' || k.key === 'space' || k.key === ' ') return surface.post({ press: r.k })
    // as in an editor's explorer: Right opens a folder, then steps in; Left closes it, then goes to the parent
    if (k.key === 'right') return r.t === 'dir' && !r.o ? surface.post({ fold: r.k, open: true }) : to(abs + 1)
    if (k.key === 'left') return r.t === 'dir' && r.o ? surface.post({ fold: r.k, open: false }) : surface.post({ parent: r.k })
  })

  if (!props.rows.length)
    return (
      <Box height={H}>
        <Text dimColor>{props.empty}</Text>
      </Box>
    )
  return (
    <Box flexDirection="column" width={W} height={H}>
      {props.rows.slice(0, H).map((r, i) => {
        const guides = '│ '.repeat(r.d) // a line per level, so the eye follows the nesting
        if (r.t === 'note')
          return (
            <Box height={1} overflow="hidden">
              <Text dimColor italic wrap="truncate-end">
                {guides}    {r.l}
              </Text>
            </Box>
          )
        const isDir = r.t === 'dir' || r.t === 'head'
        // a folder: its arrow, then a block in the color of its main language; a file: its type's mark
        const arrow = isDir ? (r.o || r.t === 'head' ? '▾ ' : '▸ ') : r.t === 'hit' ? '' : '  '
        const icon = r.t === 'hit' ? '' : r.t === 'dir' ? '■  ' : `${r.m.padEnd(2)} `
        const badge = r.b ? ` ${r.b} ` : ''
        const isOn = r.k === props.cursor || r.k === props.selected
        if (isOn || i === hover) {
          // the row under the cursor, the open file, and the pointer's row are one bar across the pane
          const text = `${guides}${arrow}${icon}${r.l}${r.e ? `  ⚠ ${r.e}` : ''}`
          const room = Math.max(1, W - badge.length)
          return (
            <Box height={1} overflow="hidden">
              <Text inverse bold={isOn} color={isOn ? 'suggestion' : 'gray'} wrap="truncate-end">
                {(text.length > room ? `${text.slice(0, room - 1)}…` : text.padEnd(room)) + badge}
              </Text>
            </Box>
          )
        }
        const tint = r.b ? TINT[r.b] : undefined
        return (
          <Box height={1} overflow="hidden" justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text dimColor>
                {guides}
                {arrow}
              </Text>
              <Text color={r.c} bold>
                {icon}
              </Text>
              <Text bold={isDir} {...(tint ? { color: tint } : r.b === '!' ? { dimColor: true } : {})}>
                {r.l}
              </Text>
              {r.e ? <Text color="error"> ⚠ {r.e}</Text> : null}
            </Text>
            {r.b ? (
              <Box flexShrink={0}>
                <Text bold {...(r.b === '!' ? { dimColor: true } : { color: tint ?? 'warning' })}>
                  {badge}
                </Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

export default Tree
