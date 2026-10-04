import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'file-explorer'
const file = (name: string) => ({ name, kind: 'file' as const, size: 6, mtimeMs: 1, isLink: false })
const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
const LISTS: Record<string, ReturnType<typeof file | typeof dir>[]> = {
  '/r': [file('b.txt'), dir('src'), file('.env'), file('a.txt'), dir('locked')],
  '/r/src': [file('c.ts')],
}
const FILES: Record<string, string> = { '/r/a.txt': 'alpha\nbeta\n', '/r/b.txt': 'bravo\n', '/r/src/c.ts': 'export const c = 1\n', '/r/.env': 'K=1\n' }
const PANE = { plugin: PLUGIN, component: 'Pane' as const, requestId: PLUGIN, viewport: { columns: 160, rows: 48, isFullscreen: true } }
const paneProps = (placement: 'dock' | 'inline') => ({ title: 'Files', isFocused: true, bodyColumns: 46, placement, scroll: { offset: 0, bodyRows: 40 }, view: {} })
const RUN = { command: 'files', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }

/** The world beneath the mod: a directory `/r` with no Git repository. `gate` holds the read of one path and records what the mod did. */
type Gate = { path?: string; wait?: Promise<void>; root?: () => string; writes?: Record<string, string>; opens?: unknown[]; store?: Record<string, unknown>; ran?: string[][] }
function world(on: On, gate: Gate = {}) {
  const clock = mock.clock(on)
  const store = gate.store ?? {}
  const gone = new Set<string>()
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  mock.env(on, { HOME: '/home/me' })
  on('session.root', () => ({ value: gate.root?.() ?? '/r' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_$, e) => (gate.opens?.push(e), { value: { isPlaced: true as const } }))
  on('ui.focus', () => ({}))
  on('fs.list', (_$, e) => {
    const list = LISTS[e.path]
    return list ? { value: list } : { deny: `EACCES: permission denied, scandir '${e.path}'` }
  })
  on('fs.stat', (_$, e) => {
    const body = gate.writes?.[e.path] ?? FILES[e.path]
    if (body !== undefined) return { value: { kind: 'file' as const, size: body.length, mtimeMs: 1, isLink: false } }
    return e.path in LISTS || e.path === '/r/locked' ? { value: { kind: 'dir' as const, size: 0, mtimeMs: 1, isLink: false, realPath: e.path } } : { deny: 'ENOENT' }
  })
  on('fs.exists', (_$, e) => ({ value: !gone.has(e.path) && (e.path === '/home/me/.Trash' || e.path in FILES || e.path in LISTS || (gate.writes !== undefined && e.path in gate.writes)) }))
  on('fs.read', async (_$, e) => {
    if (e.path === gate.path) await gate.wait
    return { value: gate.writes?.[e.path] ?? FILES[e.path] ?? '' }
  })
  on('fs.write', (_$, e) => {
    if (gate.writes) gate.writes[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'git') return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    gate.ran?.push([...e.argv])
    if (e.argv[0] === 'mv' && e.argv[2]) gone.add(e.argv[2])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return clock
}

const TREE = { in: 'tree' }
const EDITOR = { in: 'editor' }

test('the explorer is there when the session starts: nobody has to open it', async ($, on) => {
  const opens: unknown[] = []
  const clock = world(on, { opens })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  expect(opens.length).toBeGreaterThan(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: paneProps('dock') })
  expect(await ui.find({ ...TREE, type: 'Text', text: 'a.txt' })).toBeDefined()
})

test('Files mode: Back, Forward and Up, the search field, then the tabs; every entry; filters behind More', async ($, on) => {
  world(on)
  await $.command.run(RUN)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: paneProps('dock') })
    const controls = (await ui.findAll({})).filter(x => x.type === 'Input' || x.type === 'Button').map(x => String(x.props.key))
    expect(controls.slice(0, 9)).toEqual(['back', 'fwd', 'up', 'search', 'go', 'clear', 'tab:files', 'tab:code', 'tab:diff'])
    expect(String((await ui.find({ key: 'search' }))?.props.placeholder)).toBe('Find files')
    for (const name of ['locked', 'src', '.env', 'a.txt', 'b.txt']) expect(await ui.find({ ...TREE, type: 'Text', text: name })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/r/ })).toBeDefined()

    await ui.post({ press: 'row:src' }, TREE) // a click on a folder opens it
    expect(await ui.find({ ...TREE, type: 'Text', text: 'c.ts' })).toBeDefined()
    await ui.post({ press: 'row:locked' }, TREE)
    expect(await ui.find({ ...TREE, type: 'Text', text: /permission denied/ })).toBeDefined()
    expect(await ui.find({ ...TREE, type: 'Text', text: 'a.txt' })).toBeDefined()

    await ui.press({ key: 'more' })
    await ui.press({ key: 'hdot' })
    expect(await ui.find({ ...TREE, type: 'Text', text: '.env' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Hidden: dotfiles/ })).toBeDefined()
    await ui.press({ key: 'hdot' })
    expect(await ui.find({ ...TREE, type: 'Text', text: '.env' })).toBeDefined()

    await ui.post({ fold: 'row:src', open: false }, TREE) // the Left key on an open folder
    expect(await ui.find({ ...TREE, type: 'Text', text: 'c.ts' })).toBeUndefined()
    await ui.press({ key: 'collapse' })
    await ui.press({ key: 'more' })
    await ui.unmount()
  }
})

test('a click on a file opens it in Code mode; quick clicks end on the last file; Back returns to the tree', async ($, on) => {
  let release = () => {}
  world(on, { path: '/r/a.txt', wait: new Promise<void>(done => (release = done)) })
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal', props: paneProps('dock') })
  const slow = pane.post({ press: 'row:a.txt' }, TREE)
  await pane.post({ press: 'row:b.txt' }, TREE)
  release()
  await slow
  await pane.resize({ columns: 60, rows: 20, in: 'editor' })
  const code = async () => String((await pane.find({ ...EDITOR, type: 'Code' }))?.props.source)
  expect(await code()).toBe('bravo')
  expect(await pane.find({ type: 'Text', text: 'b.txt' })).toBeDefined()

  // the search field finds in the file: count, no-match and bad-regex states
  await pane.input({ key: 'search', text: 'bravo' })
  expect(await pane.find({ ...EDITOR, type: 'Text', text: /1 of 1 match/ })).toBeDefined()
  await pane.input({ key: 'search', text: 'zzz' })
  expect(await pane.find({ ...EDITOR, type: 'Text', text: /no matches/ })).toBeDefined()
  await pane.input({ key: 'search', text: '/br.vo/' }) // between slashes: a regular expression
  expect(await pane.find({ ...EDITOR, type: 'Text', text: /1 of 1 match/ })).toBeDefined()
  await pane.input({ key: 'search', text: '/(/' })
  expect(await pane.find({ ...EDITOR, type: 'Text', text: /not a valid regular expression/ })).toBeDefined()

  // Diff without Git says why; Back and Forward walk the places visited
  await pane.press({ key: 'tab:diff' })
  expect(await pane.find({ type: 'Text', text: /No Git repository contains this folder/ })).toBeDefined()
  await pane.press({ key: 'back' })
  expect(await code()).toBe('bravo')
  await pane.press({ key: 'back' })
  await pane.press({ key: 'back' }) // past the slow click on a.txt, to the tree
  expect(await pane.find({ ...TREE, type: 'Text', text: 'a.txt' })).toBeDefined()
  await pane.press({ key: 'fwd' })
  expect(await pane.find({ key: 'tree' })).toBeUndefined()
})

test('the open file is an editor: typing, pasted text, save by key and by button; unsaved text blocks leaving', async ($, on) => {
  const writes: Record<string, string> = {}
  world(on, { writes })
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal', props: paneProps('dock') })
  await pane.post({ press: 'row:b.txt' }, TREE)
  await pane.resize({ columns: 46, rows: 20, in: 'editor' })
  await pane.key({ key: 'X', ...EDITOR })
  await pane.key({ key: 'return', ...EDITOR })
  expect(await pane.find({ ...EDITOR, type: 'Text', text: /not saved/ })).toBeDefined()
  expect((await pane.find({ key: 'save' }))?.props.variant).toBe('primary') // the Save icon lights up
  await pane.press({ key: 'tab:files' }) // refused: the text is not saved
  expect(await pane.find({ type: 'Text', text: /b\.txt is not saved/ })).toBeDefined()
  expect(await pane.find({ key: 'tree' })).toBeUndefined()

  await pane.key({ key: 's', ctrl: true, ...EDITOR })
  expect(writes['/r/b.txt']).toBe('X\nbravo\n')
  expect(await pane.find({ type: 'Text', text: /Saved b\.txt/ })).toBeDefined()

  await pane.key({ key: 'end', ...EDITOR })
  await pane.key({ key: '!\nnext', ...EDITOR }) // text that comes in one piece, with a line end in it
  await pane.press({ key: 'save' }) // the Save button asks the editor for its text
  expect(writes['/r/b.txt']).toBe('X\nbravo!\nnext\n')

  const code = async () => String((await pane.find({ ...EDITOR, type: 'Code' }))?.props.source)
  await pane.key({ key: 'Z', ...EDITOR })
  await pane.key({ key: 'Y', ...EDITOR })
  expect(await code()).toContain('nextZY')
  await pane.press({ key: 'undo' }) // the Undo icon takes back one change
  expect(await code()).toContain('nextZ')
  expect(await code()).not.toContain('nextZY')
  await pane.press({ key: 'undo' }) // once more: the text is then the saved text
  expect((await pane.find({ key: 'save' }))?.props.variant).toBeUndefined()
  await pane.key({ key: 'Q', ...EDITOR })
  await pane.press({ key: 'discard' }) // drops every change that is not saved
  expect(await code()).not.toContain('Q')
  await pane.press({ key: 'tab:files' })
  expect(await pane.find({ ...TREE, type: 'Text', text: 'a.txt' })).toBeDefined()
})

test('the back and next icons step through the files in the tree order, into and out of folders', async ($, on) => {
  world(on)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal', props: paneProps('dock') })
  const open = async () => (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  await pane.post({ press: 'row:a.txt' }, TREE)
  await pane.press({ key: 'next' })
  expect(await open()).toMatch(/b\.txt/)
  await pane.press({ key: 'next' })
  expect(await open()).toMatch(/This is the last file/)
  await pane.press({ key: 'prev' })
  await pane.press({ key: 'prev' })
  expect(await open()).toMatch(/\.env/)
  await pane.press({ key: 'prev' }) // the folder before it is not expanded: the step goes into it, to its last file
  expect(await open()).toMatch(/src › .*c\.ts/)
  await pane.press({ key: 'prev' }) // before that there is only a folder that cannot be read
  expect(await open()).toMatch(/This is the first file/)
  await pane.press({ key: 'next' })
  expect(await open()).toMatch(/\.env/)
})

test('every step has a button for the pointer and a key: the tree arrows, the search, the name field', async ($, on) => {
  const writes: Record<string, string> = {}
  world(on, { writes })
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal', props: paneProps('dock') })
  const seen = async () => (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  for (const key of ['nav-up', 'nav-down', 'nav-left', 'nav-right', 'nav-open']) expect((await pane.find({ key }))?.props.hotkey).toMatch(/^[kjhlo]$/)

  await pane.press({ key: 'nav-down' }) // locked
  await pane.press({ key: 'nav-down' }) // src
  await pane.press({ key: 'nav-right' }) // opens the folder
  expect(await pane.find({ ...TREE, type: 'Text', text: /c\.ts/ })).toBeDefined()
  await pane.press({ key: 'nav-right' }) // steps in, to c.ts
  await pane.press({ key: 'nav-left' }) // back to its folder
  await pane.press({ key: 'nav-left' }) // closes it
  expect(await pane.find({ ...TREE, type: 'Text', text: /c\.ts/ })).toBeUndefined()

  await pane.post({ menu: 'row:a.txt' }, TREE) // the right button: the row is selected and its actions show
  expect(await pane.find({ key: 'rename' })).toBeDefined()
  await pane.press({ key: 'newfile' })
  await pane.input({ key: 'ask', text: 'by-mouse.txt', kind: 'change' }) // typed, not entered
  await pane.press({ key: 'ask-ok' }) // the ✓ button confirms it
  expect(writes['/r/by-mouse.txt']).toBe('')
  await pane.press({ key: 'tab:files' })
  await pane.press({ key: 'newfile' })
  await pane.press({ key: 'ask-no' }) // the ✕ button cancels
  expect(await pane.find({ key: 'ask' })).toBeUndefined()

  await pane.post({ press: 'row:b.txt' }, TREE)
  await pane.resize({ columns: 60, rows: 20, in: 'editor' })
  await pane.input({ key: 'search', text: 'bravo', kind: 'change' })
  await pane.press({ key: 'go' }) // the ⏎ button submits what is typed
  expect(await pane.find({ ...EDITOR, type: 'Text', text: /1 of 1 match/ })).toBeDefined()
  await pane.press({ key: 'match-next' })
  await pane.press({ key: 'clear' }) // the ⌫ button clears the search
  expect(await pane.find({ ...EDITOR, type: 'Text', text: /match/ })).toBeUndefined()
  // with the editor on screen no control has a key: what is typed before the text has the keyboard does nothing
  for (const key of ['prev', 'next', 'undo', 'save', 'match-prev', 'match-next', 'tab:files']) expect((await pane.find({ key }))?.props.hotkey).toBeUndefined()
  expect(await seen()).toMatch(/b\.txt/)
})

test('file manager actions: a new file, a rename, and a delete that goes to the Trash at the second press', async ($, on) => {
  const writes: Record<string, string> = {}
  const ran: string[][] = []
  world(on, { writes, ran })
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal', props: paneProps('dock') })
  const seen = async () => (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' | ') // what the pane says, for a failure to show
  await pane.post({ press: 'row:src' }, TREE) // the cursor is on the folder: a new file goes in it
  await pane.press({ key: 'newfile' })
  await pane.input({ key: 'ask', text: 'n.ts' })
  expect(writes['/r/src/n.ts']).toBe('')
  await pane.press({ key: 'back' })

  await pane.post({ to: 4 }, TREE) // the arrow keys: locked, src, c.ts, .env, a.txt
  await pane.press({ key: 'more' })
  await pane.press({ key: 'rename' })
  await pane.input({ key: 'ask', text: '../escape.txt' }) // a name must stay in its folder
  expect(await seen()).toMatch(/is not a name inside this folder/)
  expect(ran).toEqual([])
  await pane.press({ key: 'rename' })
  await pane.input({ key: 'ask', text: 'b.txt' })
  expect(await seen()).toMatch(/b\.txt exists already/)
  await pane.press({ key: 'rename' })
  await pane.input({ key: 'ask', text: 'z.txt' })
  expect(ran).toEqual([['mv', '-n', '/r/a.txt', '/r/z.txt']])

  await pane.post({ to: 5 }, TREE) // b.txt
  await pane.press({ key: 'delete' })
  expect(await seen()).toMatch(/Select Delete again to move b\.txt to the Trash/)
  expect(ran).toHaveLength(1) // the first press moves nothing
  await pane.press({ key: 'delete' })
  expect(ran[1]).toEqual(['mv', '-n', '/r/b.txt', '/home/me/.Trash/b.txt'])
  expect(await seen()).toMatch(/Moved b\.txt to the Trash/)
})

test('the root is the session directory, or a folder the person chooses and the mod remembers', async ($, on) => {
  let root = '/r'
  const store: Record<string, unknown> = {}
  world(on, { root: () => root, store })
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal', props: paneProps('dock') })

  await $.command.run({ ...RUN, args: '/r/src' }) // a folder as the argument becomes the root
  await pane.redraw()
  expect(await pane.find({ type: 'Text', text: /\/r\/src/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /chosen/ })).toBeDefined()
  expect(await pane.find({ ...TREE, type: 'Text', text: 'c.ts' })).toBeDefined()
  expect(await pane.find({ ...TREE, type: 'Text', text: 'a.txt' })).toBeUndefined()
  expect(store.pins).toEqual({ '/r': '/r/src' })

  await pane.press({ key: 'back' }) // Back returns to the folder shown before
  expect(await pane.find({ ...TREE, type: 'Text', text: 'a.txt' })).toBeDefined()
  await pane.press({ key: 'fwd' })
  expect(await pane.find({ ...TREE, type: 'Text', text: 'c.ts' })).toBeDefined()

  root = '/r/locked' // the session moves; the chosen folder stays
  await $.command.run(RUN)
  await pane.redraw()
  expect(await pane.find({ ...TREE, type: 'Text', text: 'c.ts' })).toBeDefined()

  await pane.press({ key: 'more' })
  await pane.press({ key: 'home' }) // back to the session's directory
  expect(await pane.find({ type: 'Text', text: /\/r\/locked/ })).toBeDefined()
  expect(await pane.find({ ...TREE, type: 'Text', text: 'c.ts' })).toBeUndefined()
})
