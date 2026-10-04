// The editor: a surface module. It runs on the drawing thread, holds the text while the person types, and
// posts to the hooks module when the text first changes and when it is saved. It has no `$`.
//
// Long lines wrap at the width the editor has. Each drawn row is one line of a `Code` element, so the
// engine's highlighter colors it; the cursor's row and rows with a find match are plain text instead,
// so the cursor and the matches can show.
import type { ClientModule, RenderElement } from 'claude-code'

type Find = { q: string; cs: boolean; re: boolean; n: number; by: number }
type Props = { id: string; text: string; path: string; line: number; rows: number; cols: number; save: number; undo: number; wheel: number; wheelBy: number; goto: number; gotoLine: number; find: Find }
type Snap = { lines: string[]; row: number; col: number }
type State = { id: string; lines: string[]; row: number; col: number; top: number; dirty: boolean; save: number; undo: number; wheel: number; goto: number; find: number; eol: string; tail: boolean; past: Snap[] }

const TAB = 4
const NAMED = /^(escape|insert|f\d{1,2}|clear|menu|pause|capslock|numlock|scrolllock|printscreen)$/
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff
/** A line as drawn: a tab is spaces, any other control character a mark. */
const shown = (s: string) => s.replace(/\t/g, ' '.repeat(TAB)).replace(/[\u0000-\u001f\u007f-\u009f]/g, '�')
/** The string index of the character drawn at cell `x` of a line. */
function indexAt(s: string, x: number): number {
  let cell = 0
  for (let i = 0; i < s.length; i++) {
    const w = s[i] === '\t' ? TAB : 1
    if (cell + w > x) return i
    cell += w
  }
  return s.length
}
function matcher(f: Find): RegExp | null {
  if (!f.q) return null
  try {
    return new RegExp(f.re ? f.q : f.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), f.cs ? 'g' : 'gi')
  } catch {
    return null
  }
}
/** Every match of a line, as cell ranges of the line as drawn. */
function spans(rx: RegExp | null, text: string): [number, number][] {
  const out: [number, number][] = []
  if (!rx) return out
  rx.lastIndex = 0
  for (let m = rx.exec(text); m; m = rx.exec(text)) {
    if (m[0].length === 0) {
      if (++rx.lastIndex > text.length) break
      continue
    }
    out.push([m.index, m.index + m[0].length])
  }
  return out
}

const Editor: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text, Code } = surface.elements
  let st: State
  if (surface.state?.id === props.id) st = surface.state
  else {
    const eol = props.text.includes('\r\n') ? '\r\n' : '\n'
    const lines = props.text.split(/\r?\n/)
    const tail = lines.length > 1 && lines[lines.length - 1] === ''
    if (tail) lines.pop()
    const row = clamp(props.line, 0, lines.length - 1)
    st = { id: props.id, lines, row, col: 0, top: row, dirty: false, save: props.save, undo: props.undo, wheel: props.wheel, goto: props.goto, find: props.find.n, eol, tail: tail || props.text === '', past: [] }
    // kept at once: without a state, each drawing would start from the props again and miss what they ask for
    surface.setState(st)
  }
  const H = Math.max(2, (surface.rows || props.rows) - 1)
  const W = Math.max(12, surface.columns || props.cols)
  const numW = String(st.lines.length).length
  const textW = Math.max(4, W - numW - 1)
  const rx = matcher(props.find)
  /** Screen rows a line takes at this width; the cursor's line keeps a cell for a cursor at its end. */
  const tall = (s: State, i: number) => Math.max(1, Math.ceil((shown(s.lines[i] ?? '').length + (i === s.row ? 1 : 0)) / textW))
  /** The first line to draw so that the cursor's row is on screen. */
  const topFor = (s: State, row: number, top: number) => {
    if (row < top) return row
    let t = top
    let used = 0
    for (let i = t; i <= row; i++) used += tall({ ...s, row }, i)
    while (used > H && t < row) used -= tall({ ...s, row }, t++)
    return t
  }
  const body = (s: State) => s.lines.join(s.eol) + (s.tail ? s.eol : '')
  const save = (s: State) => {
    surface.post({ save: s.id, text: body(s) })
    surface.setState({ ...s, dirty: false, save: props.save })
  }
  // Two keys can come in one frame, before this function runs again: each starts from what the last one left.
  let latest = st
  const move = (s: State, row: number, col: number, lines = s.lines, dirty = s.dirty) => {
    const r = clamp(row, 0, lines.length - 1)
    const c = clamp(col, 0, (lines[r] ?? '').length)
    if (dirty && !s.dirty) surface.post({ dirty: s.id })
    latest = { ...s, lines, row: r, col: c, top: topFor({ ...s, lines }, r, s.top), dirty }
    surface.setState(latest)
  }
  // every change keeps what was there before it, so Undo can put it back; the oldest steps drop off
  const edit = (s: State, lines: string[], row: number, col: number) => move({ ...s, past: [...s.past.slice(-299), { lines: s.lines, row: s.row, col: s.col }] }, row, col, lines, true)
  const undo = (s: State) => {
    const was = s.past[s.past.length - 1]
    if (!was) return surface.setState({ ...s, undo: props.undo })
    const next = { ...s, undo: props.undo, past: s.past.slice(0, -1), lines: was.lines, row: was.row, col: was.col }
    const dirty = body(next) !== props.text // back at the text on disk: nothing is left to save
    if (!dirty && s.dirty) surface.post({ clean: s.id })
    latest = { ...next, dirty, top: topFor(next, was.row, s.top) }
    surface.setState(latest)
  }

  // A changed number in the props is the hooks module asking: its Save button, the wheel, a line to go to,
  // or the next or previous find match. One state change answers it; the state then holds the number.
  if (st.save !== props.save) save(st)
  else if (st.undo !== props.undo) undo(st)
  else if (st.wheel !== props.wheel) {
    st = { ...st, wheel: props.wheel, top: clamp(st.top + props.wheelBy, 0, Math.max(0, st.lines.length - 1)) }
    surface.setState(st)
  } else if (st.goto !== props.goto) {
    const row = clamp(props.gotoLine, 0, st.lines.length - 1)
    st = { ...st, goto: props.goto, row, col: 0, top: Math.max(0, row - 2) }
    surface.setState(st)
  } else if (st.find !== props.find.n) {
    // from the cursor on, forward or back, and around the end of the file
    const n = st.lines.length
    const from = shown((st.lines[st.row] ?? '').slice(0, st.col)).length
    let hit: [number, number] | null = null
    for (let k = 0; k <= n && !hit; k++) {
      const i = (((st.row + (props.find.by < 0 ? -k : k)) % n) + n) % n
      const found = spans(rx, shown(st.lines[i] ?? ''))
      // `by` 0 is a new find text: a match at the cursor stays the match while the person types on
      const usable = k === 0 ? found.filter(([s]) => (props.find.by < 0 ? s < from : props.find.by > 0 ? s > from : s >= from)) : found
      const pick = props.find.by < 0 ? usable[usable.length - 1] : usable[0]
      if (pick) hit = [i, indexAt(st.lines[i] ?? '', pick[0])]
    }
    st = { ...st, find: props.find.n, ...(hit ? { row: hit[0], col: hit[1], top: Math.max(0, hit[0] - 2) } : {}) }
    surface.setState(st)
  }

  latest = st
  surface.onKey(k => {
    const s = latest
    const cur = s.lines[s.row] ?? ''
    const set = (at: number, ...next: string[]) => [...s.lines.slice(0, at), ...next, ...s.lines.slice(at + 1)]
    if (k.ctrl && k.key === 's') return save(s) // ctrl+z never comes here: the host suspends Claude Code on it
    if (k.ctrl || k.meta) return
    switch (k.key) {
      case 'up':
        return move(s, s.row - 1, s.col)
      case 'down':
        return move(s, s.row + 1, s.col)
      case 'left':
        if (s.col === 0) return s.row > 0 ? move(s, s.row - 1, (s.lines[s.row - 1] ?? '').length) : undefined
        return move(s, s.row, s.col - (isLow(cur.charCodeAt(s.col - 1)) ? 2 : 1))
      case 'right':
        if (s.col >= cur.length) return s.row < s.lines.length - 1 ? move(s, s.row + 1, 0) : undefined
        return move(s, s.row, s.col + (isLow(cur.charCodeAt(s.col + 1)) ? 2 : 1))
      case 'home':
        return move(s, s.row, 0)
      case 'end':
        return move(s, s.row, cur.length)
      case 'pageup':
        return move(s, s.row - H, s.col)
      case 'pagedown':
        return move(s, s.row + H, s.col)
      case 'return':
      case 'enter': {
        const indent = /^[ \t]*/.exec(cur)?.[0] ?? ''
        return edit(s, set(s.row, cur.slice(0, s.col), indent + cur.slice(s.col)), s.row + 1, indent.length)
      }
      case 'backspace': {
        if (s.col === 0) {
          if (s.row === 0) return
          const prev = s.lines[s.row - 1] ?? ''
          return edit(s, [...s.lines.slice(0, s.row - 1), prev + cur, ...s.lines.slice(s.row + 1)], s.row - 1, prev.length)
        }
        const n = isLow(cur.charCodeAt(s.col - 1)) ? 2 : 1
        return edit(s, set(s.row, cur.slice(0, s.col - n) + cur.slice(s.col)), s.row, s.col - n)
      }
      case 'delete': {
        if (s.col >= cur.length) {
          if (s.row >= s.lines.length - 1) return
          return edit(s, [...s.lines.slice(0, s.row), cur + (s.lines[s.row + 1] ?? ''), ...s.lines.slice(s.row + 2)], s.row, s.col)
        }
        const n = isLow(cur.charCodeAt(s.col + 1)) ? 2 : 1
        return edit(s, set(s.row, cur.slice(0, s.col) + cur.slice(s.col + n)), s.row, s.col)
      }
    }
    if (NAMED.test(k.key)) return // the name of a key this editor has no use for
    // A file indented with tabs gets a tab, any other two spaces. Text that comes in one piece (fast typing,
    // a paste) is one event with all of it, and can hold line ends.
    const typed = (k.key === 'tab' ? (/^\t/m.test(s.lines.join('\n')) ? '\t' : '  ') : k.key === 'space' ? ' ' : k.key).split(/\r\n|\r|\n/)
    const last = typed[typed.length - 1] ?? ''
    const added = typed.length === 1 ? [cur.slice(0, s.col) + last + cur.slice(s.col)] : [cur.slice(0, s.col) + typed[0], ...typed.slice(1, -1), last + cur.slice(s.col)]
    edit(s, set(s.row, ...added), s.row + typed.length - 1, typed.length === 1 ? s.col + last.length : last.length)
  })

  // the rows on screen: each line from the top, cut into pieces of the width
  type Piece = { i: number; off: number; text: string; isFirst: boolean }
  const pieces: Piece[] = []
  for (let i = st.top; i < st.lines.length && pieces.length < H; i++) {
    const text = shown(st.lines[i] ?? '')
    for (let k = 0; k < tall(st, i) && pieces.length < H; k++) pieces.push({ i, off: k * textW, text: text.slice(k * textW, (k + 1) * textW), isFirst: k === 0 })
  }
  surface.onPointer(p => {
    const at = pieces[p.y]
    if (p.type !== 'down' || !at) return
    move(latest, at.i, indexAt(st.lines[at.i] ?? '', at.off + Math.max(0, p.x - numW - 1)))
  })

  const cell = shown((st.lines[st.row] ?? '').slice(0, st.col)).length
  const left = numW + 1
  // Every row is one line of a `Code` element, so the engine's highlighter colors all of them, the cursor's
  // row too. The cursor and the find matches are small boxes placed over the code at their cells.
  const over: RenderElement[] = []
  let total = 0
  let nth = 0
  if (rx)
    for (let i = 0; i < st.lines.length; i++) {
      const found = spans(rx, shown(st.lines[i] ?? ''))
      total += found.length
      nth += i < st.row ? found.length : i === st.row ? found.filter(([s]) => s <= cell).length : 0
    }
  pieces.forEach((p, y) => {
    for (const [s, e] of spans(rx, shown(st.lines[p.i] ?? ''))) {
      const from = Math.max(s, p.off)
      const to = Math.min(e, p.off + textW)
      if (to > from)
        over.push(
          <Box position="absolute" top={y} left={left + from - p.off}>
            <Text inverse color="warning">
              {p.text.slice(from - p.off, to - p.off)}
            </Text>
          </Box>,
        )
    }
  })
  const at = pieces.findIndex(p => p.i === st.row && cell >= p.off && cell < p.off + textW)
  const cursorPiece = pieces[at]
  if (cursorPiece)
    over.push(
      <Box position="absolute" top={at} left={left + cell - cursorPiece.off}>
        <Text inverse>{cursorPiece.text[cell - cursorPiece.off] ?? ' '}</Text>
      </Box>,
    )
  const out = (
    <Box>
      <Box flexDirection="column" flexShrink={0} width={left}>
        {pieces.map(p => (
          <Text {...(p.i === st.row ? { color: 'suggestion', bold: true } : { dimColor: true })}>{(p.isFirst ? String(p.i + 1).padStart(numW) : ' '.repeat(numW)) + ' '}</Text>
        ))}
      </Box>
      {/* an empty line is given a space: the engine's highlighter drops a line with nothing in it */}
      <Code source={pieces.map(p => p.text || ' ').join('\n') || ' '} path={props.path} wrap="truncate-end" />
      {over}
    </Box>
  )
  return (
    <Box flexDirection="column" width={W} height={H + 1}>
      <Box flexDirection="column" height={H} overflow="hidden">
        {out}
      </Box>
      <Box height={1} overflow="hidden">
        <Text wrap="truncate-end">
          <Text color="suggestion">
            Ln {st.row + 1}, Col {st.col + 1}
          </Text>
          {props.find.q ? <Text color="warning">{rx ? ` · ${total ? `${Math.max(1, nth)} of ${total}` : 'no'} match${total === 1 ? '' : 'es'}` : ' · the find pattern is not a valid regular expression'}</Text> : null}
          {st.dirty ? <Text color="warning"> · ● not saved · ctrl+s saves</Text> : <Text dimColor> · saved</Text>}
          <Text dimColor> · click the text, then type · Esc: prompt</Text>
        </Text>
      </Box>
    </Box>
  )
}

export default Editor
