import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, ProcessSpawnChunk, ProcessSpawnResult, Register, RenderElement } from 'claude-code'

import type { Base, Nav, Pr } from '../types'
import {
  badgeOf,
  basename,
  dirname,
  emptyStatus,
  findMatches,
  fit,
  flatten,
  folderTint,
  fmtSize,
  ghError,
  isAncestor,
  join,
  pairRows,
  parseDiff,
  parseHit,
  parseNameStatus,
  parsePrs,
  parseStatus,
  remoteFor,
  rowsFromPaths,
  sortEntries,
  splitGlobs,
  splitLines,
  typeOf,
} from './lib'
import type { Change, DiffRow, Dir, Entry, Hit, Pair, Row } from './lib'

type E = EngineInterface
type UI = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Input' | 'Code'> & { Client?: Elements['terminal']['Client'] }
type Style = { color?: string; dimColor?: boolean; bold?: boolean }
type Btn = { k: string; label: string; hot?: string; on: () => void }
type Doc = {
  path: string
  state: 'loading' | 'ok' | 'empty' | 'binary' | 'deleted' | 'error'
  text: string
  lines: string[]
  size: number
  loaded: number
  sig: string
  info: string
}
type DiffDoc = {
  path: string
  state: 'loading' | 'ok' | 'same' | 'info'
  rows: DiffRow[]
  pairs: Pair[] // the rows side by side
  at: number[] // row → the pair that holds it
  numW: number // digits of the largest line number
  hunks: number[]
  binary: boolean
  cut: boolean
  info: string
}
type Kid = AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult>
type Ask = { kind: 'newfile' | 'newfolder' | 'rename' | 'open'; base: string; label: string; hint: string; value: string; typed?: string }
type Loc = { pin: string | null; mode: Nav['mode']; selected: string | null }

const PANE = 'file-explorer'
const CHUNK = 262144 // bytes read per load of a file larger than this
const MAX_LINE = 2000 // characters drawn of one line; the rest is announced in the line
const HIT_CAP = 1000
const FILE_CAP = 500
const CONTEXTS = [3, 10, 30, 100000]
const EDIT_MAX = 60000 // characters of a file the editor takes: its text crosses to the editor as one value
const BADGE: Record<string, string> = { M: 'warning', A: 'success', '?': 'success', D: 'error', U: 'error', R: 'suggestion', '•': 'warning' }
// Side-by-side diff: red for a removed line, green for an added line, with light text, on every theme.
// The theme's own `diffRemoved` and `diffAdded` are valid here too, but a daltonized theme draws them blue.
const DEL_BG = '#6b2222'
const ADD_BG = '#1f5a2e'
const DIFF_FG = '#f2f2f2'
const PR_FIELDS = 'number,title,state,headRefName,headRefOid,baseRefName,baseRefOid,updatedAt,url,author'

const INITIAL: Nav = {
  root: '',
  expanded: [],
  selected: null,
  cursor: null,
  treeTop: 0,
  view: 'files',
  hide: { dot: false, ignored: false, untracked: false },
  fileQuery: '',
  pin: null,
  mode: 'files',
  wrap: true,
  scroll: {},
  find: { q: '', cs: false, re: false, idx: 0 },
  grep: { q: '', hidden: false, ignored: false, include: '', exclude: '' },
  base: null,
  pr: null,
  want: 'head',
  ctx: 3,
  listing: false,
  picker: false,
  myPrs: false,
}
const nav = atom({ plugin: 'file-explorer', key: 'nav' } as const, INITIAL)

// What was read from disk and from git. A hot reload drops it; `hydrate` reads it again from `nav`.
let cur: Nav = INITIAL
let dirs = new Map<string, Dir>()
let reals = new Map<string, string>()
let dirSig = new Map<string, string>()
let tints = new Map<string, string>() // folder path → the color of its icon: the language most of its files are in
let peeked = new Set<string>() // folders already read for their color
let status = emptyStatus()
let statusRaw = ''
let git: { top: string; prefix: string; branch: string; hasHead: boolean; hasParent: boolean } | null = null
let rows: Row[] = []
let doc: Doc | null = null
let diff: DiffDoc | null = null
let changes: Change[] = []
let found: { hits: Hit[]; capped: boolean; error?: string; byLine: Map<number, Hit[]> } = { hits: [], capped: false, byLine: new Map() }
let grep = { q: '', running: false, groups: new Map<string, { line: number; text: string }[]>(), hits: 0, capped: false, error: '', tool: 'rg' }
let filt = { q: '', running: false, paths: [] as string[], capped: false, error: '' }
let prs = { branch: [] as Pr[], recent: [] as Pr[], error: '', loading: false, loaded: false }
let note = ''
let dtop = 0 // the first diff line on screen: a pair while `split`, else a row
let split = true // Diff draws the old file and the new file side by side
let pickTop = 0
let paneUp = false
let busy = false
let warming = false
let where: 'dock' | 'inline' = 'dock'
let screen = 0 // the terminal's columns, as the last drawing saw them
let asked = 0 // the pane width last asked of the host
let sessionRoot = ''
let moreOpen = false // the second toolbar row is drawn
let choosing = false // the baseline chooser is drawn in Diff mode
let ask: Ask | null = null // the name field is drawn, for a new file, a new folder, a rename, or a folder to open
let doomed = '' // the path a second press of Delete moves to the Trash
let jumpTo = { n: 0, line: 0 } // a line the editor is asked to go to
let findNav = { n: 0, by: 1 } // a step to the next or previous match the editor is asked to make
const hist = { back: [] as Loc[], fwd: [] as Loc[], busy: false }
let dirty = false // the editor holds text that is not saved
let stale = false // a save was refused once: the file changed on disk after it was opened
let editSeq = 0
let saveN = 0
let undoN = 0
let typedSearch = '' // what is in the search field now, for the button that submits it
let liveN = 0 // counts the changes of the search field: a newer change drops an older one that still waits
let applied = '' // the find text that is applied now, as it was typed
let afterEnter = false // the host empties the field after Enter: that change is not the person's
let fieldDrop = false // the search field is drawn once with another value, so the host drops what was typed
let wheel = { n: 0, by: 0 }
let ring: string | null = null // the row under the focus ring; `nav.cursor` is the last row pressed
let ticks = 0
const seq = { tree: 0, open: 0, diff: 0, grep: 0, filt: 0 }
const kids: { grep?: Kid; filt?: Kid } = {}
const last = { tree: 10, reader: 10 }

const abs = (root: string, rel: string) => (rel ? `${root.replace(/\/$/, '')}/${rel}` : root)
const text = (err: unknown) => (err instanceof Error ? err.message : String(err))
const first = (s: string) => s.trim().split('\n')[0] ?? ''
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const clip = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s)
const dot = (on: boolean) => (on ? '●' : '○')
/** The place of a diff row in the diff window, and the window's length. */
const dpos = (row: number) => (split ? (diff?.at[row] ?? 0) : row)
const dlen = () => (split ? diff?.pairs.length : diff?.rows.length) ?? 0
/** A file system error in a few words for a tree row; the whole message goes to the note line on a press. */
const brief = (why: string) => {
  const code = /\bE[A-Z]{3,}\b/.exec(why)?.[0]
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied'
  if (code === 'ENOENT') return 'not found'
  return code ?? why.replace(/^.*\$\.fs\.\w+\([^)]*\)[:\s]*/, '')
}
const tab = (s: string) => s.replaceAll('\t', '    ')
// a value an older load of this module wrote can lack a field: the defaults fill it
const get = async ($: E) => (cur = { ...INITIAL, ...(await read($, nav)) })
const put = async ($: E, p: Partial<Nav>) => (cur = await update($, nav, n => ({ ...INITIAL, ...n, ...p })))
const redraw = ($: E) => $.ui.invalidate('ui.render')
/**
 * Empties the search field. The host keeps what the person typed until the field is drawn with another value:
 * one drawing with a zero-width space drops it, and the next drawing, with no value, shows the hint again.
 */
const dropTyped = ($: E) => {
  liveN++
  typedSearch = ''
  fieldDrop = true
  redraw($)
  $.clock.after(80, () => {
    fieldDrop = false
    redraw($)
  })
}
const git$ = ($: E, root: string, args: string[], timeoutMs = 20000) =>
  $.process.run(['git', '-c', 'core.quotepath=off', ...args], { cwd: root, timeoutMs })
/** A handler closure: the work runs on after the press returns, and a failure is shown, not lost. */
const go = ($: E, f: () => Promise<unknown>) => () => {
  void f().catch(err => {
    note = text(err)
    redraw($)
  })
}

// ---------------------------------------------------------------- tree

const entryAt = (path: string): Entry | undefined =>
  dirs.get(dirname(path))?.entries.find(e => e.name === basename(path))

function grepRows(): Row[] {
  const out: Row[] = []
  for (const [file, hits] of grep.groups) {
    out.push({ key: `gh:${file}`, path: file, depth: 0, kind: 'head', label: `${file} (${hits.length})` })
    for (const h of hits) out.push({ key: `hit:${file}:${h.line}`, path: file, depth: 1, kind: 'hit', line: h.line, label: `${h.line}: ${h.text}` })
  }
  return out
}

/** Builds the rows of the view on screen. Called after every change of what they are made from, never while drawing. */
function build(n: Nav) {
  if (n.view === 'search') rows = grepRows()
  else if (n.fileQuery) rows = rowsFromPaths(filt.paths, status)
  else rows = flatten(dirs, new Set(n.expanded), n.hide, status)
}

async function loadDir($: E, root: string, rel: string, my: number) {
  let dir: Dir
  const links: [string, string][] = []
  try {
    const here = reals.get(rel) ?? abs(root, rel)
    const list = await $.fs.list(abs(root, rel))
    const entries = await Promise.all(
      list.map(async (f): Promise<Entry> => {
        const path = join(rel, f.name)
        if (!f.isLink) {
          if (f.kind === 'dir') links.push([path, `${here.replace(/\/$/, '')}/${f.name}`])
          return { name: f.name, kind: f.kind, isLink: false, size: f.size }
        }
        const st = await $.fs.stat(abs(root, path), { resolve: true }).catch(() => undefined)
        if (!st?.realPath) return { name: f.name, kind: 'other', isLink: true, size: 0 }
        if (st.kind === 'dir') links.push([path, st.realPath])
        // a link to an ancestor of the directory it is in would expand into itself for ever
        const top = reals.get('') ?? root
        const target = st.realPath === top ? '. (the root)' : isAncestor(top, st.realPath) ? st.realPath.slice(top.replace(/\/$/, '').length + 1) : st.realPath
        return { name: f.name, kind: st.kind, isLink: true, size: st.size, target, loop: st.kind === 'dir' && isAncestor(st.realPath, here) }
      }),
    )
    dir = { entries: sortEntries(entries) }
  } catch (err) {
    dir = { entries: [], error: first(text(err)) }
  }
  if (my !== seq.tree) return
  for (const [p, r] of links) reals.set(p, r)
  dirs.set(rel, dir)
  // a folder that was looked into keeps that color: it counts one level more than this listing has
  if (!dir.error && !peeked.has(rel)) tints.set(rel, folderTint(dir.entries.filter(e => e.kind === 'file').map(e => e.name), basename(rel)))
}

/**
 * Colors the folders that are listed but not opened: each is read once, for the names of its files only.
 * It runs after the listing is on screen, for 80 folders at most, so a large folder does not hold the tree.
 */
async function peek($: E, root: string, rel: string, my: number) {
  const kids = (dirs.get(rel)?.entries ?? []).filter(e => e.kind === 'dir' && !e.isLink && !peeked.has(join(rel, e.name))).slice(0, 80)
  const files = async (path: string) => (await $.fs.list(abs(root, path)).catch(() => [])).filter(f => !f.isLink)
  await Promise.all(
    kids.map(async e => {
      const path = join(rel, e.name)
      peeked.add(path)
      // its own files, and the files one level down: `src` is often where a project's language is
      const own = await files(path)
      const below = await Promise.all(own.filter(f => f.kind === 'dir' && !/^(node_modules|\.git|dist|build|target|vendor)$/.test(f.name)).slice(0, 6).map(f => files(join(path, f.name))))
      if (my === seq.tree) tints.set(path, folderTint([...own, ...below.flat()].filter(f => f.kind === 'file').map(f => f.name), e.name))
    }),
  )
  if (kids.length && my === seq.tree) redraw($)
}

/** Loads a directory and, under it, every directory the person left expanded. */
async function loadOpen($: E, root: string, rel: string, open: Set<string>, my: number): Promise<void> {
  await loadDir($, root, rel, my)
  void peek($, root, rel, my).catch(() => undefined)
  const kidsOf = dirs.get(rel)?.entries.filter(e => e.kind === 'dir' && !e.loop && open.has(join(rel, e.name))) ?? []
  await Promise.all(kidsOf.map(e => loadOpen($, root, join(rel, e.name), open, my)))
}

async function loadGit($: E, root: string) {
  // `git` changes only once the answer is whole: a second load under way never sees a half state
  try {
    const top = await git$($, root, ['rev-parse', '--show-toplevel', '--show-prefix'])
    if (top.exitCode !== 0) return void (git = null)
    const [dir = '', prefix = ''] = top.stdout.split('\n')
    const [br, head, prev] = await Promise.all([
      git$($, root, ['symbolic-ref', '--short', '-q', 'HEAD']),
      git$($, root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']),
      git$($, root, ['rev-parse', '--verify', '-q', 'HEAD^^{commit}']),
    ])
    git = { top: dir, prefix, branch: br.stdout.trim(), hasHead: head.exitCode === 0, hasParent: prev.exitCode === 0 }
  } catch {
    git = null // git did not start: the tree, the reader and search work without it
  }
}

async function loadStatus($: E, root: string): Promise<boolean> {
  const g = git
  let raw = ''
  if (g) {
    const r = await git$($, root, ['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=normal', '--', '.']).catch(() => null)
    if (r?.exitCode === 0) raw = r.stdout
  }
  if (raw === statusRaw) return false
  statusRaw = raw
  status = g ? parseStatus(raw, g.prefix) : emptyStatus()
  // the files that differ from the baseline change when the status does: a save, a new file, a commit
  if (g && cur.base && cur.root === root) await loadChanges($, root, cur.base)
  return true
}

/** Reads the session's root again and, when it moved or `force`, the tree under it. Selection and scroll stay. */
async function sync($: E, force: boolean): Promise<Nav> {
  sessionRoot = await $.session.root()
  let n = await get($)
  if (n.pin && (await $.fs.stat(n.pin).catch(() => null))?.kind !== 'dir') {
    note = `${n.pin} is not a directory now. The explorer is back at the session's directory.`
    n = await put($, { pin: null })
  }
  const root = n.pin ?? sessionRoot
  if (n.root !== root) {
    const old = n.root
    const keep = (rel: string) => {
      const a = abs(old, rel)
      return old && a !== root && isAncestor(root, a) ? a.slice(root.replace(/\/$/, '').length + 1) : null
    }
    const selected = n.selected === null ? null : keep(n.selected)
    n = await put($, {
      root,
      expanded: n.expanded.map(keep).filter((p): p is string => p !== null),
      selected,
      mode: selected === null ? 'files' : n.mode,
      listing: false,
      cursor: null,
      treeTop: 0,
      scroll: {},
      base: null,
      pr: null,
      fileQuery: '',
      picker: false,
    })
    seq.open++
    seq.diff++
    dropTyped($) // the text in the search field was for the folder before
    void cancel('grep')
    void cancel('filt')
    dirs = new Map()
    tints = new Map()
    peeked = new Set()
    reals = new Map()
    dirSig = new Map()
    statusRaw = '\0'
    doc = diff = null
    dirty = false
    changes = []
    grep = { ...grep, q: '', running: false, groups: new Map(), hits: 0, error: '' }
    filt = { ...filt, q: '', running: false, paths: [] }
    prs = { branch: [], recent: [], error: '', loading: false, loaded: false }
    force = true
  }
  if (!force && dirs.has('')) return n
  const my = ++seq.tree
  const st = await $.fs.stat(root, { resolve: true }).catch(() => undefined)
  reals.set('', st?.realPath ?? root)
  await loadGit($, root)
  await Promise.all([loadOpen($, root, '', new Set(n.expanded), my), loadStatus($, root)])
  build(n)
  redraw($)
  return n
}

async function refresh($: E) {
  note = ''
  const n = await sync($, true)
  if (n.base && git) await loadChanges($, n.root, n.base)
  if (n.mode !== 'files' && n.selected && !dirty) await openFile($, n.selected, { keep: true })
  build(await get($))
  redraw($)
}

async function toggle($: E, path: string) {
  const n = await get($)
  const e = entryAt(path)
  if (e?.loop) {
    note = `Not expanded: ${path} links to ${e.target}, a directory that contains it.`
    return redraw($)
  }
  const isOpen = n.expanded.includes(path)
  const next = await put($, { expanded: isOpen ? n.expanded.filter(p => p !== path) : [...n.expanded, path] })
  build(next)
  redraw($)
  if (isOpen) return
  await loadOpen($, next.root, path, new Set(next.expanded), seq.tree)
  const why = dirs.get(path)?.error
  if (why) note = `${path}: ${why}`
  build(await get($))
  redraw($)
}

/** Expands every ancestor of a file so its row is in the tree. */
async function reveal($: E, rel: string) {
  const n = await get($)
  const up: string[] = []
  for (let d = dirname(rel); d; d = dirname(d)) if (!n.expanded.includes(d)) up.unshift(d)
  if (!up.length) return
  const next = await put($, { expanded: [...n.expanded, ...up] })
  for (const d of up) await loadDir($, next.root, d, seq.tree)
  build(next)
}

const treeTop = (n: Nav) => clamp(n.treeTop, 0, Math.max(0, rows.length - last.tree))
const ringKey = () => ring ?? cur.cursor

const ringRow = () => rows.find(r => r.key === ringKey())

/** Puts the cursor on row `i` and moves the window so the row is in it. */
async function showRow($: E, i: number) {
  const at = clamp(i, 0, rows.length - 1)
  const r = rows[at]
  if (!r) return
  ring = r.key
  doomed = ''
  const top = treeTop(cur)
  const next = at < top ? at : at >= top + last.tree ? at - last.tree + 1 : top
  if (next !== cur.treeTop) await put($, { treeTop: next })
  else redraw($)
}

/** One step in the tree, from an arrow button or its key: what the arrow keys do in the tree after a click. */
async function treeStep($: E, to: 'up' | 'down' | 'left' | 'right' | 'open') {
  const i = rows.findIndex(r => r.key === ringKey())
  const r = rows[i]
  if (to === 'up' || to === 'down') return showRow($, i < 0 ? treeTop(cur) : i + (to === 'up' ? -1 : 1))
  if (!r || r.kind === 'note') return
  if (to === 'open') return pressRow($, r)
  const canFold = r.kind === 'dir' && !cur.fileQuery
  if (to === 'right') return canFold && !r.open ? toggle($, r.path) : showRow($, i + 1)
  if (canFold && r.open) return toggle($, r.path)
  const up = rows.findIndex(x => x.key === `row:${dirname(r.path)}`)
  if (up >= 0) await showRow($, up)
}

/**
 * Asks the host to give the pane the keyboard. Every click in the pane does this. Without it, a click on
 * the tree or the editor gives them the keys while the prompt still has them too, and what is typed goes to both.
 * The host does not let a mod hand the keys to the tree or the editor itself, so the first click in an unfocused
 * pane focuses the pane, and the next click on the tree or the text gives that part the keys.
 */
function grab($: E) {
  void (async () => {
    // the engine's own record: a drawing does not always run again when the pane loses the keyboard
    if ((await $.ui.panes()).some(p => p.id === PANE && p.isFocused)) return
    await $.ui.open({ id: PANE, title: 'Files', focus: true, columns: asked || wantColumns() })
  })().catch(() => undefined)
}

async function pressRow($: E, r: Row) {
  note = ''
  doomed = ''
  ring = r.key
  await put($, { cursor: r.key })
  if (r.kind === 'dir') {
    if (cur.fileQuery) {
      note = 'Clear the file filter to expand or collapse directories.'
      return redraw($)
    }
    return toggle($, r.path)
  }
  if (r.kind === 'hit' || r.kind === 'head') {
    await reveal($, r.path)
    return openFile($, r.path, { line: r.line, mode: 'code' })
  }
  return openFile($, r.path)
}

// ---------------------------------------------------------------- reader

function refind(n: Nav) {
  const lines = n.mode === 'diff' ? (diff?.rows.map(r => r.s) ?? []) : (doc?.lines ?? [])
  const f = findMatches(lines, n.find.q, n.find)
  const byLine = new Map<number, Hit[]>()
  for (const h of f.hits) {
    const list = byLine.get(h.line)
    if (list) list.push(h)
    else byLine.set(h.line, [h])
  }
  found = { ...f, byLine }
}

async function chunk($: E, path: string, k: number): Promise<string> {
  const r = await $.process.run(['dd', `if=${path}`, `bs=${CHUNK}`, `skip=${k}`, 'count=1'], { timeoutMs: 15000 })
  if (r.exitCode !== 0) throw new Error(first(r.stderr) || 'dd failed')
  return r.stdout
}

async function loadDoc($: E, root: string, rel: string): Promise<Doc> {
  const path = abs(root, rel)
  const d: Doc = { path: rel, state: 'error', text: '', lines: [], size: 0, loaded: 0, sig: 'gone', info: '' }
  const st = await $.fs.stat(path).catch(() => null)
  if (!st) return { ...d, state: 'deleted' }
  d.sig = `${st.mtimeMs}:${st.size}`
  d.size = st.size
  if (st.kind !== 'file') return { ...d, info: st.kind === 'dir' ? 'This entry is a directory.' : 'This entry is not a regular file (a device, a socket, or a broken link).' }
  if (st.size === 0) return { ...d, state: 'empty' }
  try {
    const body = st.size <= CHUNK ? await $.fs.read(path) : await chunk($, path, 0)
    if (body.slice(0, 8000).includes('\0')) return { ...d, state: 'binary' }
    return { ...d, state: 'ok', text: body, lines: splitLines(body, MAX_LINE), loaded: Math.min(st.size, CHUNK) }
  } catch (err) {
    return { ...d, info: first(text(err)) }
  }
}

/** Opens a file in the pane. A click opens Code mode; `keep` reads the open file again and changes nothing else. */
async function openFile($: E, rel: string, o: { line?: number; mode?: Nav['mode']; keep?: boolean } = {}) {
  if (!o.keep && blocked($)) return
  if (!o.keep) visit()
  const my = ++seq.open
  let n = await get($)
  const scroll = o.line ? { ...n.scroll, [rel]: Math.max(0, o.line - 1) } : n.scroll
  const keys = Object.keys(scroll)
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) if (k !== rel) delete scroll[k]
  if (!o.keep) note = ''
  n = o.keep ? await put($, { scroll }) : await put($, { selected: rel, picker: false, listing: false, mode: o.mode ?? 'code', scroll })
  if (!o.keep) {
    choosing = false
    dirty = stale = false
    if (o.line) jumpTo = { n: jumpTo.n + 1, line: o.line - 1 }
  }
  if (!o.keep || doc?.path !== rel) {
    doc = { path: rel, state: 'loading', text: '', lines: [], size: 0, loaded: 0, sig: '', info: '' }
    diff = null
    dtop = 0
    refind(n)
    build(n)
    redraw($)
  }
  const next = await loadDoc($, n.root, rel)
  if (my !== seq.open) return // a newer selection owns the reader
  doc = next
  editSeq++ // the editor takes the text that was just read
  refind(n)
  if (n.mode === 'diff') await loadDiff($, n, rel)
  void resize($)
  redraw($)
}

async function loadMore($: E) {
  const d = doc
  if (!d || d.state !== 'ok' || d.loaded >= d.size) return
  const my = seq.open
  const more = await chunk($, abs(cur.root, d.path), d.loaded / CHUNK)
  if (my !== seq.open || doc !== d) return
  d.text += more
  d.lines = splitLines(d.text, MAX_LINE)
  d.loaded = Math.min(d.size, d.loaded + CHUNK)
  refind(cur)
  redraw($)
}

async function scrollTree($: E, by: number) {
  const n = await get($)
  const top = clamp(n.treeTop + by, 0, Math.max(0, rows.length - last.tree))
  if (top !== n.treeTop) await put($, { treeTop: top })
}

async function scrollReader($: E, by: number, to?: number) {
  const n = await get($)
  if (n.picker) pickTop = Math.max(0, to ?? pickTop + by)
  else if (n.mode === 'diff') dtop = clamp(to ?? dtop + by, 0, Math.max(0, dlen() - 1))
  else if (doc && n.selected) {
    const top = clamp(to ?? (n.scroll[n.selected] ?? 0) + by, 0, Math.max(0, doc.lines.length - 1))
    return put($, { scroll: { ...n.scroll, [n.selected]: top } })
  }
  redraw($)
}

async function setFind($: E, p: Partial<Nav['find']>) {
  if (cur.mode === 'code' && !canEdit()) {
    // the editor finds in its own text, which can be newer than the file
    await put($, { find: { ...cur.find, ...p, idx: 0 } })
    if (cur.find.q) findNav = { n: findNav.n + 1, by: 0 }
    return redraw($)
  }
  const n = await get($)
  const next = { ...n, find: { ...n.find, ...p, idx: 0 } }
  refind(next)
  const top = n.mode === 'diff' ? dtop : (n.scroll[n.selected ?? ''] ?? 0)
  const pos = (line: number) => (n.mode === 'diff' ? dpos(line) : line)
  next.find.idx = Math.max(0, found.hits.findIndex(h => pos(h.line) >= top))
  await put($, { find: next.find })
  const hit = found.hits[next.find.idx]
  if (hit) await scrollReader($, 0, Math.max(0, pos(hit.line) - 2))
  redraw($)
}

async function jump($: E, by: number) {
  if (cur.mode === 'code' && !canEdit()) {
    findNav = { n: findNav.n + 1, by }
    return redraw($)
  }
  const n = await get($)
  if (!found.hits.length) return
  const idx = (n.find.idx + by + found.hits.length) % found.hits.length
  await put($, { find: { ...n.find, idx } })
  const line = found.hits[idx]?.line ?? 0
  await scrollReader($, 0, Math.max(0, (n.mode === 'diff' ? dpos(line) : line) - 2))
}

async function gotoLine($: E, value: string) {
  const line = Number(value.trim())
  const total = doc?.lines.length ?? 0
  if (!value.trim()) return
  if (!Number.isInteger(line) || line < 1 || line > total) {
    const part = doc && doc.loaded < doc.size ? ' in the loaded part' : ''
    note = `Line "${value.trim()}" is not a line of this file${part} (1 to ${total}).`
    return redraw($)
  }
  note = ''
  if (cur.mode === 'code' && !canEdit()) {
    jumpTo = { n: jumpTo.n + 1, line: line - 1 }
    return redraw($)
  }
  await scrollReader($, 0, line - 1)
}

async function setMode($: E, mode: Nav['mode']) {
  if (mode === cur.mode) return
  if (blocked($)) return
  visit()
  note = ''
  choosing = false
  dropTyped($) // the text in the search field was for the mode before
  const n = await put($, { mode, picker: false, listing: mode === 'diff' && !cur.selected })
  void resize($)
  redraw($)
  if (mode !== 'files' && n.selected && doc?.path !== n.selected) await openFile($, n.selected, { keep: true })
  if (mode === 'diff' && n.selected) await loadDiff($, n, n.selected)
  else if (mode === 'diff') await ensureBase($, n).catch(err => (note = text(err)))
  refind(cur)
  build(cur)
  void resize($)
  redraw($)
}

// ---------------------------------------------------------------- pane, root, editor

/**
 * The width the docked pane asks of the host. The tree is narrow. Code and diffs ask for the width of
 * their longest line, up to a share of the terminal; a line longer than that wraps.
 */
function wantColumns(): number {
  if (cur.mode === 'files') return 46
  let longest = 0
  if (cur.mode === 'diff') for (const r of diff?.rows ?? []) longest = Math.max(longest, split ? 2 * (r.s.length + 8) : r.s.length + 14)
  else for (const l of doc?.lines ?? []) longest = Math.max(longest, l.length + 8)
  return clamp(longest, 60, Math.max(60, Math.floor((screen || 160) * 0.6)))
}

async function resize($: E) {
  if (where !== 'dock') return
  const columns = wantColumns()
  if (columns === asked) return
  asked = columns
  await $.ui.open({ id: PANE, title: 'Files', columns }).catch(() => undefined)
}

/** True, with the reason on screen, while the editor holds text that is not saved. */
function blocked($: E): boolean {
  if (!dirty) return false
  note = `${cur.selected} is not saved. 💾 saves it. ↶ takes back one change. ✕ drops all changes.`
  redraw($)
  return true
}

/** Makes a directory the root, or with null goes back to the session's directory. The choice is kept per session directory. */
async function setRoot($: E, input: string | null) {
  if (blocked($)) return
  visit()
  note = ''
  let pin: string | null = null
  if (input !== null) {
    let p = input.trim()
    if (!p) return
    if (p === '~' || p.startsWith('~/')) p = `${(await $.env.get('HOME')) ?? ''}${p.slice(1)}`
    else if (!p.startsWith('/')) p = abs(cur.root, p)
    const st = await $.fs.stat(p, { resolve: true }).catch(() => null)
    if (st?.kind !== 'dir' || !st.realPath) {
      note = `${p} is not a directory.`
      return redraw($)
    }
    pin = st.realPath === sessionRoot ? null : st.realPath
  }
  await put($, { pin })
  const saved = await $.store.get('pins')
  const pins: Record<string, string> = typeof saved === 'object' && saved !== null ? { ...(saved as Record<string, string>) } : {}
  if (pin) pins[sessionRoot] = pin
  else delete pins[sessionRoot]
  await $.store.set('pins', pins)
  await sync($, true)
  build(cur)
  redraw($)
}

function canEdit(): string {
  const d = doc
  if (!d || (d.state !== 'ok' && d.state !== 'empty')) return 'Only a text file that is on disk can be edited.'
  if (d.loaded < d.size) return 'This file is only partly loaded. It is too large to edit here.'
  if (d.text.length > EDIT_MAX) return `This file has more than ${EDIT_MAX} characters. It is too large to edit here.`
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(d.text)) return 'This file has control characters. It cannot be edited here.'
  return ''
}

/** Puts the file back as it is on disk. */
async function revert($: E) {
  dirty = stale = false
  note = ''
  if (cur.selected) await openFile($, cur.selected, { keep: true })
  redraw($)
}

/** Writes the editor's text to the selected file. A file that changed on disk since it was opened is not overwritten at the first try. */
async function saveFile($: E, body: string) {
  const n = cur
  const d = doc
  if (!n.selected || !d || d.path !== n.selected) return
  const path = abs(n.root, n.selected)
  const st = await $.fs.stat(path).catch(() => null)
  if ((st ? `${st.mtimeMs}:${st.size}` : 'gone') !== d.sig && !stale) {
    stale = true
    note = 'This file changed on disk after you opened it. 💾 again overwrites it. ✕ drops your changes.'
    return redraw($)
  }
  await $.fs.write(path, body)
  doc = await loadDoc($, n.root, n.selected)
  dirty = stale = false
  note = `Saved ${n.selected} (${fmtSize(doc.size)}).`
  refind(cur)
  await loadStatus($, n.root)
  build(cur)
  redraw($)
}

// ---------------------------------------------------------------- previous and next file

/** The entries of a folder that a step to the next file can land on or go into, in the tree's order. */
async function walkable($: E, dir: string): Promise<Entry[]> {
  if (!dirs.has(dir)) await loadDir($, cur.root, dir, seq.tree)
  return (dirs.get(dir)?.entries ?? []).filter(e => {
    const path = join(dir, e.name)
    const badge = badgeOf(path, e.kind === 'dir', status)
    if ((cur.hide.dot && e.name.startsWith('.')) || (cur.hide.ignored && badge === '!') || (cur.hide.untracked && badge === '?')) return false
    // a step never goes into Git's own folder, a folder Git ignores, or a link that loops
    return e.kind === 'file' || (e.kind === 'dir' && !e.loop && e.name !== '.git' && badge !== '!')
  })
}

/** The first file (or with `by` -1 the last) in a folder or below it; folders come before files, as in the tree. */
async function edgeFile($: E, dir: string, by: 1 | -1, budget: { left: number }): Promise<string | null> {
  if (budget.left-- <= 0) return null
  const list = await walkable($, dir)
  for (const e of by > 0 ? list : [...list].reverse()) {
    const path = join(dir, e.name)
    if (e.kind === 'file') return path
    const inside = await edgeFile($, path, by, budget)
    if (inside) return inside
  }
  return null
}

/**
 * The file after (or before) a file in the tree's order. At the end of a folder the step goes on into the
 * next folder, however deep, and takes its first file: folders that are not expanded are read on the way.
 */
async function fileBeside($: E, path: string, by: 1 | -1): Promise<string | null> {
  const budget = { left: 400 } // folders read for one step
  for (let at = path; ; at = dirname(at)) {
    const dir = dirname(at)
    const list = await walkable($, dir)
    const i = list.findIndex(e => e.name === basename(at))
    const rest = by > 0 ? list.slice(i + 1) : list.slice(0, Math.max(0, i)).reverse()
    for (const e of i < 0 ? [] : rest) {
      const next = join(dir, e.name)
      if (e.kind === 'file') return next
      const inside = await edgeFile($, next, by, budget)
      if (inside) return inside
    }
    if (!dir) return null
  }
}

/** The back and next signs: in Code the file before or after this one, in Diff the changed file before or after. */
async function stepFile($: E, by: 1 | -1) {
  if (blocked($)) return
  const from = cur.selected
  let to: string | null = null
  if (cur.mode === 'diff') {
    const i = changes.findIndex(c => c.path === from)
    to = changes[i < 0 ? (by > 0 ? 0 : changes.length - 1) : i + by]?.path ?? null
  } else to = from === null ? await edgeFile($, '', by, { left: 400 }) : await fileBeside($, from, by)
  if (to === null) {
    note = by > 0 ? 'This is the last file.' : 'This is the first file.'
    return redraw($)
  }
  await reveal($, to)
  ring = `row:${to}`
  await put($, { cursor: ring })
  await openFile($, to, { mode: cur.mode === 'diff' ? 'diff' : 'code' })
}

// ---------------------------------------------------------------- history and file operations

const here = (): Loc => ({ pin: cur.pin, mode: cur.mode, selected: cur.selected })

/** Records where the person is, before they go elsewhere, so Back can return there. */
function visit() {
  if (hist.busy) return
  const loc = here()
  const top = hist.back[hist.back.length - 1]
  if (!top || top.pin !== loc.pin || top.mode !== loc.mode || top.selected !== loc.selected) hist.back.push(loc)
  if (hist.back.length > 50) hist.back.shift()
  hist.fwd = []
}

async function travel($: E, by: -1 | 1) {
  if (blocked($)) return
  const loc = (by < 0 ? hist.back : hist.fwd).pop()
  if (!loc && by < 0 && cur.mode !== 'files') return setMode($, 'files') // with no history, Back still leaves a file for the tree
  if (!loc) {
    note = by < 0 ? 'There is nothing to go back to.' : 'There is nothing to go forward to.'
    return redraw($)
  }
  ;(by < 0 ? hist.fwd : hist.back).push(here())
  hist.busy = true
  try {
    if (loc.pin !== cur.pin) await setRoot($, loc.pin)
    if (loc.selected && loc.mode !== 'files') await openFile($, loc.selected, { mode: loc.mode })
    else await setMode($, loc.mode)
  } finally {
    hist.busy = false
  }
}

/** Opens the name field for a new file, a new folder, a rename, or a folder to open. */
function startAsk($: E, kind: Ask['kind']) {
  const r = ringRow()
  const isEntry = r !== undefined && (r.kind === 'dir' || r.kind === 'file' || r.kind === 'other') && cur.view === 'files' && !cur.fileQuery
  doomed = ''
  note = ''
  if (kind === 'rename') {
    if (!r || !isEntry) {
      note = 'Select a file or a folder first: click it, or move to it with the arrow keys.'
      return redraw($)
    }
    ask = { kind, base: r.path, label: 'Rename to', hint: basename(r.path), value: basename(r.path) }
  } else if (kind === 'open') ask = { kind, base: '', label: 'Open folder', hint: 'a path: /abs, ~/in-home, or ../relative', value: '' }
  else {
    const dir = r && isEntry ? (r.kind === 'dir' ? r.path : dirname(r.path)) : ''
    ask = { kind, base: dir, label: kind === 'newfile' ? 'New file' : 'New folder', hint: `name, in ${dir || 'the root'}`, value: '' }
  }
  redraw($)
  void $.ui.focus({ requestId: PANE, key: 'ask' }).catch(() => undefined)
}

async function answer($: E, value: string) {
  const a = ask
  ask = null
  const name = value.trim()
  if (!a || !name) return redraw($) // an empty Enter cancels
  if (a.kind === 'open') return setRoot($, name)
  if (blocked($)) return
  if (name.startsWith('/') || name.split('/').some(part => part === '' || part === '.' || part === '..')) {
    note = `"${name}" is not a name inside this folder.`
    return redraw($)
  }
  const root = cur.root
  const rel = a.kind === 'rename' ? join(dirname(a.base), name) : join(a.base, name)
  if (await $.fs.exists(abs(root, rel))) {
    note = `${rel} exists already.`
    return redraw($)
  }
  if (a.kind === 'newfile') await $.fs.write(abs(root, rel), '')
  else {
    const argv = a.kind === 'newfolder' ? ['mkdir', '-p', abs(root, rel)] : ['mv', '-n', abs(root, a.base), abs(root, rel)]
    const r = await $.process.run(argv, { timeoutMs: 15000 })
    if (r.exitCode !== 0) {
      note = first(r.stderr) || `${argv[0]} failed.`
      return redraw($)
    }
  }
  if (a.kind === 'rename') {
    // what was open or expanded under the old name is under the new one
    const moved = (p: string) => (p === a.base || p.startsWith(`${a.base}/`) ? rel + p.slice(a.base.length) : p)
    await put($, { expanded: cur.expanded.map(moved), selected: cur.selected === null ? null : moved(cur.selected) })
  } else if (a.kind === 'newfolder') await put($, { expanded: [...cur.expanded, rel] })
  await reveal($, rel)
  await refresh($)
  ring = `row:${rel}`
  await put($, { cursor: ring })
  note = a.kind === 'rename' ? `Renamed ${a.base} to ${rel}.` : `Created ${rel}.` // after the refresh, which clears the note
  redraw($)
  if (a.kind === 'newfile') await openFile($, rel)
}

/** Moves the selected entry to the Trash, at the second press. Nothing is removed for good. */
async function trash($: E) {
  const r = ringRow()
  if (!r || (r.kind !== 'dir' && r.kind !== 'file' && r.kind !== 'other') || cur.view !== 'files' || cur.fileQuery) {
    note = 'Select a file or a folder first: click it, or move to it with the arrow keys.'
    return redraw($)
  }
  if (blocked($)) return
  if (doomed !== r.path) {
    doomed = r.path
    note = `Select Delete again to move ${r.path}${r.kind === 'dir' ? ' and everything in it' : ''} to the Trash.`
    return redraw($)
  }
  doomed = ''
  const home = await $.env.get('HOME')
  const bin = `${home}/.Trash`
  const from = abs(cur.root, r.path)
  if (!home || !(await $.fs.exists(bin))) {
    note = 'There is no Trash folder (~/.Trash) on this system. The mod does not delete without one.'
    return redraw($)
  }
  // `mv -n` never overwrites: a name that is taken in the Trash gets the time added
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
  for (const to of [`${bin}/${basename(r.path)}`, `${bin}/${basename(r.path)} ${stamp}`]) {
    await $.process.run(['mv', '-n', from, to], { timeoutMs: 30000 }).catch(() => undefined)
    if (!(await $.fs.exists(from))) break
  }
  if (await $.fs.exists(from)) {
    note = `${r.path} was not moved to the Trash.`
    return redraw($)
  }
  ring = null
  if (cur.selected !== null && isAncestor(r.path, cur.selected)) {
    doc = diff = null
    await put($, { selected: null, cursor: null, mode: 'files' })
  }
  await refresh($)
  note = `Moved ${r.path} to the Trash.` // after the refresh, which clears the note
  redraw($)
}

// ---------------------------------------------------------------- diff

async function resolveBase($: E, root: string, kind: Base['kind'], pr: Pr | null): Promise<Base> {
  const branch = git?.branch || 'detached HEAD'
  if (kind === 'head' || kind === 'prev') {
    const rev = kind === 'head' ? 'HEAD' : 'HEAD^'
    const r = await git$($, root, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])
    if (r.exitCode !== 0 || !r.stdout.trim())
      throw new Error(kind === 'head' ? 'This repository has no commit. There is no HEAD to compare against.' : 'HEAD has no parent commit.')
    return { kind, sha: r.stdout.trim(), label: `${rev} · ${branch}` }
  }
  if (!pr) throw new Error('No pull request is selected.')
  await ensure($, root, pr.headOid, pr, `refs/pull/${pr.number}/head`)
  if (kind === 'prhead') return { kind, sha: pr.headOid, label: `PR #${pr.number} head · ${pr.head}` }
  await ensure($, root, pr.baseOid, pr, `refs/heads/${pr.base}`)
  const mb = await git$($, root, ['merge-base', pr.baseOid, pr.headOid])
  if (mb.exitCode !== 0 || !mb.stdout.trim()) throw new Error(`PR #${pr.number} has no merge base (${pr.base}…${pr.head}).`)
  return { kind, sha: mb.stdout.trim(), label: `PR #${pr.number} merge base · ${pr.base}…${pr.head}` }
}

/** Makes one commit available locally. The fetch gets objects only: no ref, no FETCH_HEAD, no working file changes. */
async function ensure($: E, root: string, sha: string, pr: Pr, ref: string) {
  const has = async () => (await git$($, root, ['cat-file', '-e', `${sha}^{commit}`])).exitCode === 0
  if (await has()) return
  const remote = remoteFor((await git$($, root, ['remote', '-v'])).stdout, pr.url)
  let why = ''
  for (const what of [sha, ref]) {
    const r = await git$($, root, ['fetch', '--no-tags', '--no-write-fetch-head', remote, what], 60000)
    if (await has()) return
    why = first(r.stderr)
  }
  throw new Error(`Commit ${sha.slice(0, 8)} is not in the local repository and the fetch from ${remote} failed: ${why}`)
}

async function loadChanges($: E, root: string, base: Base) {
  const [d, u] = await Promise.all([
    git$($, root, ['diff', '--name-status', '-M', '-z', '--relative', base.sha]),
    git$($, root, ['ls-files', '-o', '--exclude-standard', '-z']),
  ])
  const list = d.exitCode === 0 ? parseNameStatus(d.stdout) : []
  if (u.exitCode === 0) for (const p of u.stdout.split('\0').filter(Boolean).slice(0, 2000)) list.push({ path: p, code: '?' })
  changes = list.sort((a, b) => (a.path < b.path ? -1 : 1))
}

/** The pinned baseline; the first use pins HEAD and reads what changed against it. */
async function ensureBase($: E, n: Nav): Promise<Base> {
  if (n.base) return n.base
  if (!git) throw new Error('No Git repository contains this root.')
  const base = await resolveBase($, n.root, 'head', null)
  await put($, { base, want: 'head' })
  await loadChanges($, n.root, base)
  return base
}

async function loadDiff($: E, n: Nav, rel: string) {
  const my = ++seq.diff
  const d: DiffDoc = { path: rel, state: 'info', rows: [], pairs: [], at: [], numW: 1, hunks: [], binary: false, cut: false, info: '' }
  const done = (next: DiffDoc) => {
    if (my !== seq.diff) return
    diff = next
    dtop = Math.min(dtop, Math.max(0, dlen() - 1))
    refind(cur)
    void resize($)
    redraw($)
  }
  if (!git) return done({ ...d, info: 'No Git repository contains this root. Diff is not available. Code view and search work.' })
  try {
    const base = await ensureBase($, n)
    const old = changes.find(c => c.path === rel)?.old
    const badge = badgeOf(rel, false, status)
    const isNew =
      (badge === '?' || badge === '!') &&
      (await git$($, n.root, ['cat-file', '-e', `${base.sha}:${git.prefix}${rel}`])).exitCode !== 0
    const r = isNew // not in the index and not in the baseline: every line is an addition
      ? await git$($, n.root, ['diff', '--no-color', '--no-ext-diff', `-U${n.ctx}`, '--no-index', '--', '/dev/null', rel])
      : await git$($, n.root, ['diff', '--no-color', '--no-ext-diff', '-M', `-U${n.ctx}`, base.sha, '--', ...(old ? [old] : []), rel])
    if (r.exitCode > 1) return done({ ...d, info: `git diff failed: ${first(r.stderr)}` })
    const p = parseDiff(r.stdout, MAX_LINE)
    const numW = String(p.rows.reduce((m, row) => Math.max(m, row.o ?? 0, row.n ?? 0), 1)).length
    done({ ...d, ...p, ...pairRows(p.rows), numW, state: p.rows.length ? 'ok' : 'same', cut: r.isStdoutTruncated })
  } catch (err) {
    done({ ...d, info: text(err) })
  }
}

async function gh($: E, root: string, args: string[]): Promise<Pr[]> {
  const r = await $.process.run(['gh', 'pr', ...args, '--json', PR_FIELDS], { cwd: root, timeoutMs: 30000 }).catch(() => {
    throw new Error('The GitHub CLI (gh) did not start. Install it to compare against pull requests. Local comparison still works.')
  })
  if (r.exitCode !== 0) throw new Error(ghError(r.stderr))
  return parsePrs(r.stdout)
}

async function discover($: E, n: Nav) {
  prs = { ...prs, loading: true, error: '' }
  redraw($)
  try {
    const branch = git?.branch ?? ''
    const [mine, recent] = await Promise.all([
      branch ? gh($, n.root, ['list', '--head', branch, '--state', 'all', '--limit', '30']) : Promise.resolve([]),
      gh($, n.root, ['list', '--state', 'all', '--limit', '30', '--search', 'sort:updated-desc', ...(n.myPrs ? ['--author', '@me'] : [])]),
    ])
    prs = { branch: mine.filter(p => p.head === branch), recent, error: '', loading: false, loaded: true }
  } catch (err) {
    prs = { branch: [], recent: [], error: text(err), loading: false, loaded: false }
  }
  redraw($)
}

/** Selects a baseline. On any failure the pinned baseline stays as it was and the reason is shown. */
async function chooseBase($: E, kind: Base['kind'], pick?: Pr) {
  const n = await get($)
  let pr = pick ?? n.pr
  note = ''
  try {
    if (!git) throw new Error('No Git repository contains this directory.')
    if (kind !== 'head' && kind !== 'prev' && !pr) {
      await discover($, n)
      if (prs.error) throw new Error(prs.error)
      const only = prs.branch.length === 1 ? prs.branch[0] : undefined
      if (!only) {
        note = prs.branch.length
          ? `${prs.branch.length} pull requests match branch ${git.branch}. Select one.`
          : `No pull request found for ${git.branch ? `branch ${git.branch}` : 'a detached HEAD'}. Select one from the recent list, or keep the current baseline.`
        pickTop = 0
        choosing = true
        await put($, { want: kind })
        return redraw($)
      }
      pr = only
    }
    const base = await resolveBase($, n.root, kind, pr)
    choosing = false
    const next = await put($, { base, pr, picker: false, want: kind })
    await loadChanges($, next.root, base)
    build(next)
    if (next.selected) await loadDiff($, next, next.selected)
    redraw($)
  } catch (err) {
    note = `The baseline did not change. ${text(err)}`
    redraw($)
  }
}

async function refreshBase($: E) {
  const n = await get($)
  const kind = n.base?.kind ?? 'head'
  if ((kind === 'head' || kind === 'prev') || !n.pr) return chooseBase($, kind)
  try {
    const [pr] = await gh($, n.root, ['view', String(n.pr.number)])
    return chooseBase($, kind, pr ?? n.pr)
  } catch (err) {
    note = `The baseline did not change. ${text(err)}`
    redraw($)
  }
}

/** Opens or closes the baseline chooser; the pull requests are read the first time it opens. */
async function toggleChooser($: E, p: Partial<Nav> = {}) {
  choosing = p.myPrs === undefined ? !choosing : true
  pickTop = 0
  const n = await put($, { listing: false, ...p })
  redraw($)
  if (choosing && git && (!prs.loaded || p.myPrs !== undefined)) await discover($, n)
  redraw($)
}

// ---------------------------------------------------------------- search

async function cancel(slot: 'grep' | 'filt') {
  seq[slot]++
  if (slot === 'grep') grep.running = false
  else filt.running = false
  await kids[slot]?.return({ code: null, signal: null }).catch(() => undefined)
}

/** Reads a child's lines as they come. Leaving the loop kills the child, so a cancel or a cap stops the work. */
async function stream($: E, slot: 'grep' | 'filt', argv: string[], cwd: string, my: number, onLine: (line: string) => boolean): Promise<string> {
  const child = $.process.spawn({ argv, cwd })
  kids[slot] = child
  let buf = ''
  let err = ''
  let stop = false
  for await (const c of child) {
    if (my !== seq[slot]) return err
    if (c.stream === 'stderr') {
      if (err.length < 2000) err += c.text
      continue
    }
    const parts = (buf + c.text).split('\n')
    buf = parts.pop() ?? ''
    for (const p of parts) {
      if (p && !onLine(p)) {
        stop = true
        break
      }
    }
    build(cur)
    redraw($) // progressive results; the engine folds redraws that come too fast
    if (stop) break
  }
  if (!stop && my === seq[slot] && buf) onLine(buf)
  return err
}

async function runGrep($: E, q: string) {
  await cancel('grep')
  const my = seq.grep
  const n = await put($, { grep: { ...cur.grep, q }, treeTop: 0 })
  grep = { q, running: q !== '', groups: new Map(), hits: 0, capped: false, error: '', tool: 'rg' }
  build(n)
  redraw($)
  if (!q) return
  const inc = splitGlobs(n.grep.include)
  const exc = splitGlobs(n.grep.exclude)
  const rg = ['rg', '--line-number', '--no-heading', '--color', 'never', '--null', '--smart-case', '--fixed-strings', '--max-columns', '300', '--max-columns-preview']
  if (n.grep.hidden) rg.push('--hidden')
  if (n.grep.ignored) rg.push('--no-ignore')
  rg.push(...inc.flatMap(g => ['-g', g]), ...exc.flatMap(g => ['-g', `!${g}`]), '-g', '!.git/', '-e', q, '.')
  const onLine = (rec: string) => {
    const h = parseHit(rec)
    if (!h) return true
    const list = grep.groups.get(h.file)
    if (list) list.push(h)
    else grep.groups.set(h.file, [h])
    grep.capped = ++grep.hits >= HIT_CAP
    return !grep.capped
  }
  let err = ''
  try {
    err = await stream($, 'grep', rg, n.root, my, onLine)
  } catch (e1) {
    if (grep.hits) err = text(e1)
    else {
      // rg did not start. grep reads hidden and ignored files always, and the scope line says so.
      grep.tool = 'grep'
      const smart = q === q.toLowerCase() ? ['-i'] : []
      const argv = ['grep', '-rnI', '--null', '-F', ...smart, '--exclude-dir=.git', ...inc.map(g => `--include=${g}`), ...exc.map(g => `--exclude=${g}`), '-e', q, '.']
      err = await stream($, 'grep', argv, n.root, my, onLine).catch(e2 => `Neither rg nor grep started: ${text(e2)}`)
    }
  }
  if (my !== seq.grep) return
  grep.running = false
  if (!grep.hits && err) grep.error = first(err)
  build(cur)
  redraw($)
}

function hiddenByFilters(p: string, n: Nav): boolean {
  if (n.hide.dot && p.split('/').some(s => s.startsWith('.'))) return true
  if (!n.hide.ignored && !n.hide.untracked) return false
  const b = badgeOf(p, false, status)
  return (n.hide.ignored && b === '!') || (n.hide.untracked && b === '?')
}

async function runFilter($: E, q: string) {
  await cancel('filt')
  const my = seq.filt
  const n = await put($, { fileQuery: q, treeTop: 0 })
  filt = { q, running: q !== '', paths: [], capped: false, error: '' }
  build(n)
  redraw($)
  if (!q) return
  // fzf matches the paths (fuzzy, smart case, its own query syntax). With --no-sort it prints each match as it
  // reads it, so the cap can stop a scan of a large folder. Without fzf: grep, a part of the path in any case.
  // `exec` makes the matcher the child itself: when a newer search stops it, find and sed end at their next write.
  // The query is an argument of the shell, never a part of its text.
  const list = `<(find . -name .git -prune -o \\( -type f -o -type l \\) -print | sed 's|^\\./||')`
  const argv = ['bash', '-c', `if command -v fzf >/dev/null 2>&1; then exec fzf --no-sort --filter "$1" < ${list}; fi; exec grep -iF -- "$1" < ${list}`, 'bash', q]
  const err = await stream($, 'filt', argv, n.root, my, p => {
    if (hiddenByFilters(p, cur)) return true
    filt.paths.push(p)
    filt.capped = filt.paths.length >= FILE_CAP
    return !filt.capped
  }).catch(e => text(e))
  if (my !== seq.filt) return
  filt.running = false
  if (!filt.paths.length && err) filt.error = first(err)
  build(cur)
  redraw($)
}

// ---------------------------------------------------------------- refresh without a watch API

async function hydrate($: E) {
  const n = await sync($, true)
  if (n.base && git) await loadChanges($, n.root, n.base)
  build(n)
  if (n.mode !== 'files' && n.selected) await openFile($, n.selected, { keep: true })
  if (n.fileQuery) go($, () => runFilter($, n.fileQuery))()
  if (n.grep.q) go($, () => runGrep($, n.grep.q))()
  redraw($)
}

/** A hot reload drops what was read while `nav` and the pane stay: a drawing with nothing read asks for it, once. */
function warm($: E, n: Nav) {
  if (warming || !n.root || dirs.has('')) return
  warming = true
  $.clock.after(1, go($, () => hydrate($).finally(() => (warming = false))))
}

/** `$` has no file watch, so open things are compared by modification time; a change reads them again in place. */
async function tick($: E, force = false) {
  if (busy) return
  busy = true
  try {
    const n = await get($)
    if (!n.root || !paneUp) return
    if ((n.pin ?? (await $.session.root())) !== n.root) return void (await refresh($))
    let changed = false
    // while the editor is open the file is not read again: a save checks the disk and asks before it overwrites
    if (n.mode !== 'files' && !dirty && n.selected && doc?.path === n.selected && doc.state !== 'loading') {
      const st = await $.fs.stat(abs(n.root, n.selected)).catch(() => null)
      if ((st ? `${st.mtimeMs}:${st.size}` : 'gone') !== doc.sig) {
        changed = true
        await openFile($, n.selected, { keep: true })
      }
    }
    if (n.mode === 'files') {
      for (const d of ['', ...n.expanded].filter(p => dirs.has(p)).slice(0, 40)) {
        const st = await $.fs.stat(abs(n.root, d)).catch(() => null)
        const sig = String(st?.mtimeMs ?? 'gone')
        const before = dirSig.get(d)
        dirSig.set(d, sig)
        if (before !== undefined && before !== sig) {
          changed = true
          await loadDir($, n.root, d, seq.tree)
        }
      }
      if ((force || changed || ++ticks % 4 === 0) && (await loadStatus($, n.root))) changed = true
    }
    if (changed) {
      build(cur)
      redraw($)
    }
  } finally {
    busy = false
  }
}

// ---------------------------------------------------------------- drawing

function bar(ui: UI, btns: Btn[], W: number): RenderElement[] {
  const { Box, Button } = ui
  const lines: Btn[][] = [[]]
  let used = 0
  for (const b of btns) {
    const w = b.label.length
    if (used && used + 2 + w > W) {
      lines.push([])
      used = 0
    }
    lines[lines.length - 1]?.push(b)
    used += (used ? 2 : 0) + w
  }
  return lines.map(l => (
    <Box height={1} gap={2} overflow="hidden">
      {l.map(b => (
        <Button plain key={b.k} label={b.label} onPress={b.on} />
      ))}
    </Box>
  ))
}

const line = (ui: UI, s: string, style: Style = {}): RenderElement => (
  <ui.Box height={1} overflow="hidden">
    <ui.Text wrap="truncate-end" {...style}>
      {s || ' '}
    </ui.Text>
  </ui.Box>
)

/** A reason or a result, in the warning color. It wraps: it is never cut. */
const noteRow = (ui: UI): RenderElement[] =>
  note
    ? [
        <ui.Text wrap="wrap" color="warning">
          {note}
        </ui.Text>,
      ]
    : []
const noteRows = (W: number) => (note ? Math.ceil(note.length / Math.max(1, W)) : 0)

/**
 * The rows every mode starts with, as in an editor's side bar: the title with Back, Forward and Up, the
 * search field, the mode tabs. These controls are drawn in every mode, in this order, so the focus ring,
 * which keeps its place across a redraw, stays on the control it was on when the mode changes.
 */
function headPart(ui: UI, $: E, n: Nav, W: number, H: number): RenderElement[] {
  const { Box, Text, Button, Input } = ui
  const isText = n.mode === 'files' && n.view === 'search'
  const active = n.mode !== 'files' ? n.find.q : isText ? n.grep.q : n.fileQuery
  const hint = n.mode === 'diff' ? 'Find in diff, or /regex/' : n.mode === 'code' ? 'Find in file, :line, or /regex/' : isText ? 'Search text in files' : 'Find files'
  // `isEnter` is false while the person types: the search applies at each change of the field
  const apply = (raw: string, isEnter: boolean) => {
    const v = raw.replaceAll('\u200b', '')
    if (cur.mode === 'files') return cur.view === 'search' ? runGrep($, v) : runFilter($, v.trim())
    // a line number is not complete until Enter
    if (cur.mode === 'code' && /^:\d*$/.test(v.trim())) return isEnter && v.trim() !== ':' ? gotoLine($, v.trim().slice(1)) : undefined
    // Enter on the text that is applied already, or on an empty field, goes to the next match
    if (isEnter && cur.find.q && (v === '' || v === applied)) return jump($, 1)
    applied = v
    // text is found in any case; /pattern/ is a regular expression, /pattern/i one in any case
    const rx = /^\/(.+)\/(i?)$/.exec(v)
    return setFind($, rx ? { q: rx[1] ?? '', re: true, cs: rx[2] !== 'i' } : { q: v, re: false, cs: false })
  }
  const submit = (raw: string) => {
    liveN++
    afterEnter = true
    return apply(raw, true)
  }
  const live = go($, async () => {
    const my = ++liveN
    const v = typedSearch
    const skip = afterEnter && v === ''
    afterEnter = false
    if (skip) return
    // ponytail: each change starts the search again after a short wait; keep the file list in memory if a large root makes this slow
    await $.clock.sleep(150)
    if (my === liveN) await apply(v, false)
  })
  const clear = () => (cur.mode !== 'files' ? setFind($, { q: '' }) : cur.view === 'search' ? runGrep($, '') : runFilter($, ''))
  const field = (
    <Box overflow="hidden">
      <Box flexGrow={1} overflow="hidden">
        {/* applied while the person types; Enter and the ⏎ button apply it at once */}
        <Input
          key="search"
          placeholder={active ? `${hint}: "${clip(active, 16)}"` : hint}
          value={fieldDrop ? '\u200b' : ''}
          submitLabel="Enter"
          onInput={v => ((typedSearch = v), live())}
          onSubmit={v => go($, async () => ((typedSearch = ''), submit(v)))()}
        />
      </Box>
      {/* the same two actions for the pointer: submit what is typed, clear the search */}
      <Box gap={1} flexShrink={0}>
        <Button
          key="go"
          label="⏎"
          onPress={go($, async () => {
            const v = typedSearch
            dropTyped($)
            return submit(v)
          })}
        />
        <Button key="clear" label="⌫" onPress={go($, async () => (dropTyped($), clear()))} />
      </Box>
    </Box>
  )
  const tabs: [Nav['mode'], string, string][] = [
    ['files', 'Files', '1'],
    ['code', 'Code', '2'],
    ['diff', 'Diff', '3'],
  ]
  return [
    // two cells stay free at the right edge: the engine draws the pane's close mark there
    <Box height={1} width={W - 2} overflow="hidden" justifyContent="space-between">
      <Text bold color="claude">
        EXPLORER
      </Text>
      <Box gap={2} flexShrink={0}>
        <Button plain key="back" label="‹ Back" dimColor={!hist.back.length} onPress={go($, () => travel($, -1))} />
        <Button plain key="fwd" label="Forward ›" dimColor={!hist.fwd.length} onPress={go($, () => travel($, 1))} />
        <Button plain key="up" label="↑ Up" onPress={go($, () => setRoot($, abs(cur.root, '..')))} />
      </Box>
    </Box>,
    // a framed field when the pane has the rows for it
    H >= 22 ? (
      <Box height={3} borderStyle="round" borderColor={active ? 'warning' : 'suggestion'} overflow="hidden">
        {field}
      </Box>
    ) : (
      <Box height={1} overflow="hidden">
        {field}
      </Box>
    ),
    <Box height={1} overflow="hidden" justifyContent="space-between">
      <Box gap={1}>
        {tabs.map(([mode, label, hot]) => (
          // no keys while the editor is on screen: what is typed before the text has the keys must do nothing
          <Button key={`tab:${mode}`} label={label} onPress={go($, () => setMode($, mode))} {...(n.mode === 'code' ? {} : { hotkey: hot })} {...(n.mode === mode ? { variant: 'primary' as const } : {})} />
        ))}
      </Box>
      {/* Save: at the top right, under the search field; in the accent color while there is text to save */}
      {n.mode === 'code' ? (
        <Button
          key="save"
          label="💾"
          onPress={go($, async () => {
            saveN++ // the editor sees the new number and sends its text
            redraw($)
          })}
          {...(dirty ? { variant: 'primary' as const } : {})}
        />
      ) : null}
    </Box>,
  ]
}

function treePart(ui: UI, $: E, n: Nav, W: number, H: number): RenderElement[] {
  const { Box, Text, Button, Input, Client } = ui
  const B = (k: string, label: string, f: () => Promise<unknown>): Btn => ({ k, label, on: go($, f) })
  const hide = (p: Partial<Nav['hide']>) => async () => {
    const next = await put($, { hide: { ...cur.hide, ...p }, treeTop: 0 })
    build(next)
    redraw($)
  }
  const setGrep = (p: Partial<Nav['grep']>) => async () => {
    await put($, { grep: { ...cur.grep, ...p } })
    if (cur.grep.q) await runGrep($, cur.grep.q)
  }
  const isText = n.view === 'search'
  const g = n.grep
  const hidden = [n.hide.dot && 'dotfiles', n.hide.ignored && 'ignored', n.hide.untracked && 'untracked'].filter(Boolean)
  const name = (basename(n.root) || '/').toUpperCase()
  const top: RenderElement[] = [
    // the section header of an editor's explorer: the folder's name, then its actions
    <Box height={1} overflow="hidden" justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text bold color={tints.get('') ?? 'suggestion'}>
          ■{' '}
        </Text>
        <Text bold color="suggestion">
          {name}
        </Text>
        <Text color="magenta">{git ? `  ⎇ ${git.branch || 'detached'}` : ''}</Text>
        {n.pin ? <Text dimColor> · chosen</Text> : null}
      </Text>
    </Box>,
    <Box height={1} overflow="hidden">
      <Text dimColor wrap="truncate-start">
        {n.root || '(not loaded)'} · {where === 'dock' ? 'docked' : 'inline'}
      </Text>
    </Box>,
    // words, not one-cell icons: a one-cell button is too small a target for the pointer
    ...bar(
      ui,
      [
        B('newfile', 'New File', async () => startAsk($, 'newfile')),
        B('newfolder', 'New Folder', async () => startAsk($, 'newfolder')),
        B('refresh', 'Refresh', () => refresh($)),
        B('collapse', 'Collapse', async () => (build(await put($, { expanded: [], treeTop: 0 })), redraw($))),
        B('more', moreOpen ? 'Less' : 'More', async () => ((moreOpen = !moreOpen), redraw($))),
      ],
      W,
    ),
  ]
  if (moreOpen)
    top.push(
      ...bar(
        ui,
        [
          B('rename', 'Rename', async () => startAsk($, 'rename')),
          B('delete', doomed ? 'Delete: confirm' : 'Delete', () => trash($)),
          B('into', 'Set as root', async () => {
            const r = ringRow()
            if (r?.kind === 'dir') return setRoot($, abs(cur.root, r.path))
            note = 'Select a folder first. Then this makes that folder the root.'
            redraw($)
          }),
          B('open', 'Open folder…', async () => startAsk($, 'open')),
          B('home', 'Home', () => setRoot($, null)),
        ],
        W,
      ),
      ...bar(
        ui,
        isText
          ? [
              B('view', '● Text search', async () => (build(await put($, { view: 'files', treeTop: 0 })), redraw($))),
              B('ghid', `${dot(g.hidden)} hidden`, setGrep({ hidden: !g.hidden })),
              B('gign', `${dot(g.ignored)} ignored`, setGrep({ ignored: !g.ignored })),
              B('cancel', 'Stop', async () => (await cancel('grep'), build(cur), redraw($))),
            ]
          : [
              B('view', '○ Text search', async () => (build(await put($, { view: 'search', treeTop: 0 })), redraw($))),
              B('hdot', `${dot(!n.hide.dot)} .files`, hide({ dot: !n.hide.dot })),
              B('hign', `${dot(!n.hide.ignored)} ignored`, hide({ ignored: !n.hide.ignored })),
              B('hunt', `${dot(!n.hide.untracked)} untracked`, hide({ untracked: !n.hide.untracked })),
            ],
        W,
      ),
    )
  if (ask)
    top.push(
      <Box height={1} overflow="hidden">
        <Box flexGrow={1} overflow="hidden">
          <Input
            key="ask"
            label={ask.label}
            placeholder={ask.hint}
            value={ask.value}
            submitLabel="Enter"
            onInput={v => void (ask && (ask.typed = v))}
            onSubmit={v => go($, () => answer($, v))()}
          />
        </Box>
        <Box gap={1} flexShrink={0}>
          <Button key="ask-ok" label="✓" onPress={go($, () => answer($, ask?.typed ?? ask?.value ?? ''))} />
          <Button key="ask-no" label="✕" onPress={go($, async () => ((ask = null), redraw($)))} />
        </Box>
      </Box>,
    )
  if (isText) {
    top.push(
      <Box height={1} overflow="hidden">
        <Input key="inc" label="files to include" placeholder={g.include || 'src/** *.ts'} value="" submitLabel="set" onSubmit={v => go($, setGrep({ include: v }))()} />
      </Box>,
      <Box height={1} overflow="hidden">
        <Input key="exc" label="files to exclude" placeholder={g.exclude || 'dist/** *.min.js'} value="" submitLabel="set" onSubmit={v => go($, setGrep({ exclude: v }))()} />
      </Box>,
      line(
        ui,
        grep.tool === 'grep' ? 'literal text · skips .git, binary (grep reads hidden and ignored files)' : `literal text · smart case · skips .git, binary${g.hidden ? '' : ', hidden'}${g.ignored ? '' : ', Git-ignored'}`,
        { dimColor: true },
      ),
      line(
        ui,
        grep.error ||
          (!g.q
            ? 'Type text in the search field and press Enter.'
            : `"${clip(g.q, 12)}": ${grep.hits} result${grep.hits === 1 ? '' : 's'} in ${grep.groups.size} file${grep.groups.size === 1 ? '' : 's'}${grep.running ? ' · searching…' : grep.capped ? ` · stopped at ${HIT_CAP}` : ''}`),
        { color: grep.error ? 'error' : 'warning' },
      ),
    )
  } else {
    if (hidden.length) top.push(line(ui, `Hidden: ${hidden.join(', ')} (More shows the filters)`, { color: 'warning' }))
    if (n.fileQuery)
      top.push(
        line(
          ui,
          filt.error ||
            `${filt.paths.length} file${filt.paths.length === 1 ? '' : 's'} match "${clip(n.fileQuery, 16)}"${filt.capped ? ` (first ${FILE_CAP}, scan stopped)` : filt.running ? ' (scanning)' : ''}`,
          { color: filt.error ? 'error' : 'warning' },
        ),
      )
  }
  top.push(...noteRow(ui))
  if (H >= 24) top.push(line(ui, '─'.repeat(W), { dimColor: true })) // a rule between the controls and the tree

  const area = Math.max(1, H - top.length - 1 - Math.max(0, noteRows(W) - 1))
  last.tree = area
  const start = treeTop(n)
  const shown = rows.slice(start, start + area)
  const changed = status.map.size
  const empty = isText ? '' : n.fileQuery ? (filt.running ? 'Searching…' : 'No file matches.') : 'This folder is empty.'
  const body = Client ? (
    <Client
      key="tree"
      module="./tree.tsx"
      width={W}
      height={area}
      props={{
        rows: shown.map(r => {
          const type = typeOf(basename(r.path))
          const c = r.kind === 'dir' ? (tints.get(r.path) ?? folderTint([], basename(r.path))) : type.color
          return { k: r.key, d: r.depth, t: r.kind, l: r.label, m: type.mark, c, ...(r.badge ? { b: r.badge } : {}), ...(r.open ? { o: true } : {}), ...(r.error ? { e: brief(r.error) } : {}) }
        }),
        start,
        total: rows.length,
        cursor: ringKey() ?? '',
        selected: n.selected ? `row:${n.selected}` : '',
        cols: W,
        lines: area,
        empty,
      }}
    />
  ) : (
    // a surface without surface modules: the same rows as plain buttons
    <Box flexDirection="column" height={area} overflow="hidden">
      {shown.map(r => (
        <Box height={1} overflow="hidden">
          {r.kind === 'note' ? (
            <Text dimColor>{`${'  '.repeat(r.depth)}  ${r.label}`}</Text>
          ) : (
            <Button plain key={r.key} label={clip(`${'  '.repeat(r.depth)}${r.kind === 'dir' ? (r.open ? '▾ ' : '▸ ') : '  '}${r.label}${r.badge ? `  ${r.badge}` : ''}`, W - 1)} onPress={go($, () => pressRow($, r))} />
          )}
        </Box>
      ))}
    </Box>
  )
  return [
    ...top,
    body,
    // The tree takes the arrow keys only after a click on it. These buttons do the same steps for the pointer,
    // and their keys (k j h l o) work as soon as the pane has the keyboard.
    <Box height={1} overflow="hidden" gap={1}>
      <Button key="nav-up" label="↑" hotkey="k" onPress={go($, () => treeStep($, 'up'))} />
      <Button key="nav-down" label="↓" hotkey="j" onPress={go($, () => treeStep($, 'down'))} />
      <Button key="nav-left" label="←" hotkey="h" onPress={go($, () => treeStep($, 'left'))} />
      <Button key="nav-right" label="→" hotkey="l" onPress={go($, () => treeStep($, 'right'))} />
      <Button key="nav-open" label="⏎" hotkey="o" onPress={go($, () => treeStep($, 'open'))} />
      <Text dimColor wrap="truncate-end">
        {rows.length ? `${start + 1}–${start + shown.length} of ${rows.length}${changed ? ` · ${changed} changed` : ''}` : ''}
      </Text>
    </Box>,
  ]
}

function readerPart(ui: UI, $: E, n: Nav, W: number, H: number): RenderElement[] {
  const { Box, Text, Button, Code, Client } = ui
  const B = (k: string, label: string, f: () => Promise<unknown>): Btn => ({ k, label, on: go($, f) })
  const d = doc
  const x = diff
  const isDiff = n.mode === 'diff'
  const isEditor = !isDiff && d !== null && d.path === n.selected && canEdit() === '' && Client !== undefined
  const total = isDiff ? dlen() : (d?.lines.length ?? 0)
  const topLine = clamp(isDiff ? dtop : (n.scroll[n.selected ?? ''] ?? 0), 0, Math.max(0, total - 1))
  const isPartial = d !== null && d.state === 'ok' && d.loaded < d.size

  // icons, no words: back and next step through the files, the curved arrow takes back one change
  // Diff has a key for each icon. Code has none: there, a key typed before the text has the keyboard must do nothing.
  const icon = (key: string, label: string, hot: string, f: () => Promise<unknown>) => <Button key={key} label={label} onPress={go($, f)} {...(isDiff ? { hotkey: hot } : {})} />
  const icons = [icon('prev', '‹', 'p', () => stepFile($, -1)), icon('next', '›', 'n', () => stepFile($, 1))]
  if (!isDiff)
    icons.push(
      icon('undo', '↶', 'u', async () => {
        undoN++ // the editor sees the new number and takes back its last change
        redraw($)
      }),
    )
  // the next and the previous match: what Enter in the search field does, for the pointer
  icons.push(icon('match-prev', '⌃', 'b', () => jump($, -1)), icon('match-next', '⌄', 'f', () => jump($, 1)))
  if (!isDiff && dirty) icons.push(icon('discard', '✕', 'x', () => revert($)))
  const hunk = (by: number) => async () => {
    const hs = (x?.hunks ?? []).map(dpos)
    const to = by > 0 ? hs.find(at => at > dtop) : [...hs].reverse().find(at => at < dtop)
    if (to !== undefined) await scrollReader($, 0, to)
  }
  const btns: Btn[] = isDiff
    ? [
        B('changes', `${n.listing ? '▾' : '▸'} Changed files (${changes.length})`, async () => {
          pickTop = 0
          choosing = false
          await put($, { listing: !cur.listing })
          redraw($)
        }),
        B('baseline', `${choosing ? '▾' : '▸'} vs ${n.base ? `${clip(n.base.label, 28)} ${n.base.sha.slice(0, 8)}` : 'HEAD'}`, () => toggleChooser($)),
        B('prevhunk', '‹ Hunk', hunk(-1)),
        B('nexthunk', 'Hunk ›', hunk(1)),
        B('split', `${dot(split)} Side by side`, async () => {
          // the window keeps its place: a pair is where its first row is
          if (x) dtop = split ? (x.pairs[dtop]?.l ?? x.pairs[dtop]?.r ?? 0) : (x.at[dtop] ?? 0)
          split = !split
          void resize($)
          redraw($)
        }),
        B('ctx', `Context ${n.ctx > 1000 ? 'all' : n.ctx}`, async () => {
          const next = await put($, { ctx: CONTEXTS[(CONTEXTS.indexOf(cur.ctx) + 1) % CONTEXTS.length] ?? 3 })
          if (next.selected) await loadDiff($, next, next.selected)
        }),
      ]
    : isPartial
      ? [B('more', 'Load more', () => loadMore($))]
      : []

  let info = ''
  if (!isDiff && d?.state === 'ok') info = `${d.lines.length}${isPartial ? '+' : ''} line${d.lines.length === 1 ? '' : 's'} · ${fmtSize(d.size)}${isPartial ? ` · loaded ${fmtSize(d.loaded)}` : ''}`
  if (isDiff && x?.state === 'ok') info = `${x.hunks.length} hunk${x.hunks.length === 1 ? '' : 's'}${x.cut ? ' · diff cut at 4 MiB by the host' : ''}`
  const parts = (n.selected ?? '').split('/')
  const file = parts.pop() ?? ''
  const head: RenderElement[] = [
    // the icons, then the path as breadcrumbs, the file's name last and bright
    <Box height={1} overflow="hidden" gap={1}>
      <Box gap={1} flexShrink={0}>
        {icons}
      </Box>
      <Text wrap="truncate-start">
        <Text dimColor>{parts.length ? `${parts.join(' › ')} › ` : ''}</Text>
        <Text bold color={dirty && !isDiff ? 'warning' : 'suggestion'}>
          {file || 'No file is open'}
        </Text>
        {dirty && !isDiff ? <Text color="warning"> ●</Text> : null}
        <Text dimColor>{info ? `  ${info}` : ''}</Text>
      </Text>
    </Box>,
    ...(btns.length ? bar(ui, btns, W) : []),
  ]
  if (n.find.q && !isEditor) {
    const scope = isDiff ? 'in the diff' : isPartial ? `in the loaded part only (${fmtSize(d?.loaded ?? 0)} of ${fmtSize(d?.size ?? 0)})` : 'in the file'
    const count = found.error ? found.error : found.hits.length ? `${n.find.idx + 1} of ${found.hits.length}${found.capped ? '+' : ''} matches ${scope}` : `No matches ${scope}`
    head.push(line(ui, count, { color: found.error ? 'error' : 'warning' }))
  }
  head.push(...noteRow(ui))

  const area = Math.max(1, H - head.length - Math.max(0, noteRows(W) - 1))
  last.reader = area
  // a state message may be longer than the row: it wraps, never cut
  const msg = (s: string, style: Style = { dimColor: true }) => [
    <Text wrap="wrap" {...style}>
      {s}
    </Text>,
  ]
  const numW = isDiff ? (x?.numW ?? 1) : String(Math.max(1, total)).length
  const num = (v: number | undefined) => (v === undefined ? '' : String(v)).padStart(numW)
  const now = found.hits[n.find.idx]
  const segs = (s: string, i: number): (string | RenderElement)[] => {
    const hs = found.byLine.get(i)
    if (!hs) return [tab(s)]
    const out: (string | RenderElement)[] = []
    let at = 0
    // `h` is the JSX factory in this module: no local may take that name where JSX is written
    for (const hit of hs) {
      if (hit.s >= s.length) break
      if (hit.s > at) out.push(tab(s.slice(at, hit.s)))
      out.push(
        <Text inverse {...(hit === now ? { color: 'warning' } : {})}>
          {tab(s.slice(hit.s, hit.e))}
        </Text>,
      )
      at = hit.e
    }
    if (at < s.length) out.push(tab(s.slice(at)))
    return out
  }
  // every long line wraps at the pane's width
  const textRow = (gutter: string, mark: string, s: string, i: number, style: Style) => (
    <Box>
      <Box flexShrink={0}>
        <Text dimColor>{gutter}</Text>
      </Box>
      <Text wrap="wrap" {...style}>
        {mark}
        {segs(s, i)}
      </Text>
    </Box>
  )
  const pick = (key: string, label: string, f: () => Promise<unknown>) => (
    <Box height={1} overflow="hidden">
      <Button plain key={key} label={clip(label, W - 2)} onPress={go($, f)} />
    </Box>
  )
  const windowOf = (items: RenderElement[]) => {
    pickTop = clamp(pickTop, 0, Math.max(0, items.length - area))
    return items.slice(pickTop, pickTop + area)
  }

  let body: RenderElement[]
  if (isDiff && !git) body = msg('No Git repository contains this folder. Diff is not available. Files and Code work.', { color: 'warning' })
  else if (isDiff && choosing) {
    const kind = n.base?.kind ?? 'head'
    const bases: [Base['kind'], string][] = [
      ['head', git?.hasHead ? 'Latest commit (HEAD)' : 'Latest commit (none: no commit)'],
      ['prev', git?.hasParent ? 'Previous commit (HEAD^)' : 'Previous commit (none: HEAD has no parent)'],
      ['prhead', 'Pull request head: what is pushed'],
      ['prbase', 'Pull request base: the PR and your local edits'],
    ]
    const pr = (p: Pr, pre: string) =>
      pick(`${pre}:${p.number}`, `  #${p.number} ${p.state.toLowerCase()} · ${p.updated.slice(0, 10)} · @${p.author} · ${p.head} → ${p.base} · ${p.title}`, () =>
        chooseBase($, n.want === 'prbase' ? 'prbase' : 'prhead', p),
      )
    body = windowOf([
      line(ui, 'Compare the working tree against:', { bold: true }),
      ...bases.map(([k, label]) => pick(`base:${k}`, `${dot(kind === k)} ${label}`, () => chooseBase($, k))),
      pick('rebase', '⟳ Read this baseline again (it is pinned until you do)', () => refreshBase($)),
      line(ui, prs.error || (prs.loading ? 'Pull requests: loading…' : `Pull requests, most recently updated first (${n.myPrs ? 'only mine' : 'all authors'}):`), prs.error ? { color: 'error' } : { bold: true }),
      pick('mine', `${dot(n.myPrs)} Only my pull requests`, () => toggleChooser($, { myPrs: !cur.myPrs })),
      line(ui, `For ${git?.branch ? `branch ${git.branch}` : 'a detached HEAD'}: ${prs.branch.length || 'none'}`, { dimColor: true }),
      ...prs.branch.map(p => pr(p, 'prb')),
      line(ui, `Recent in this repository: ${prs.recent.length || 'none'}`, { dimColor: true }),
      ...prs.recent.map(p => pr(p, 'prr')),
    ])
  } else if (isDiff && (n.listing || !n.selected)) {
    body = windowOf([
      line(ui, changes.length ? 'Changed files against the baseline. Select one to see its diff.' : 'No file differs from the baseline.', { dimColor: true }),
      ...changes.map(c => pick(`chg:${c.path}`, `${c.code} ${c.old ? `${c.old} → ` : ''}${c.path}`, () => openFile($, c.path, { mode: 'diff' }))),
    ])
  } else if (!n.selected) body = msg('No file is open. Select a file in Files: one click opens it here.')
  else if (isDiff) {
    const vs = n.base ? `${n.base.label} (${n.base.sha.slice(0, 8)})` : 'the baseline'
    if (!x || x.state === 'loading') body = msg('Computing the diff…')
    else if (x.state === 'info') body = msg(x.info, { color: 'warning' })
    else if (x.state === 'same') body = msg(`No changes against ${vs}.`)
    else if (split) {
      // the old file on the left, the new file on the right: a removed line is red, an added line is green
      // ponytail: no unified fallback on a narrow pane; the Side by side button turns it off
      const half = Math.floor((W - 1) / 2)
      const w = Math.max(1, half - numW - 2)
      const len = (i: number | undefined) => (i === undefined ? 0 : (x.rows[i]?.s.length ?? 0))
      // the character budget counts one side: half of it covers both
      const count = fit(i => Math.max(len(x.pairs[i]?.l), len(x.pairs[i]?.r)), x.pairs.length, topLine, area - (x.binary ? 1 : 0), w, true, 4500)
      const side = (i: number | undefined, isOld: boolean) => {
        const r = i === undefined ? undefined : x.rows[i]
        const isChange = r !== undefined && r.t !== 'ctx'
        return (
          <Box width={half} flexShrink={0} {...(isChange ? { backgroundColor: isOld ? DEL_BG : ADD_BG } : {})}>
            <Box flexShrink={0}>
              <Text {...(isChange ? { color: DIFF_FG } : { dimColor: true })}>{`${num(isOld ? r?.o : r?.n)} `}</Text>
            </Box>
            <Text wrap="wrap" {...(isChange ? { color: DIFF_FG } : {})}>
              {r ? (r.t === 'ctx' ? ' ' : isOld ? '-' : '+') : ''}
              {r && i !== undefined ? segs(r.s, i) : ''}
            </Text>
          </Box>
        )
      }
      body = x.pairs.slice(topLine, topLine + count).map(p => {
        const r = p.l === undefined ? undefined : x.rows[p.l]
        if (r && p.l !== undefined && (r.t === 'meta' || r.t === 'hunk')) return textRow('', '', r.s, p.l, r.t === 'hunk' ? { color: 'suggestion' } : { dimColor: true })
        return (
          <Box gap={1}>
            {side(p.l, true)}
            {side(p.r, false)}
          </Box>
        )
      })
      if (x.binary) body.push(line(ui, 'Binary content: Git gives no text diff for this file.', { color: 'warning' }))
    } else {
      const w = Math.max(1, W - 2 * numW - 3)
      const count = fit(i => x.rows[i]?.s.length ?? 0, x.rows.length, topLine, area - (x.binary ? 1 : 0), w, true)
      body = x.rows.slice(topLine, topLine + count).map((r, k) => {
        const flat = r.t === 'meta' || r.t === 'hunk'
        const style: Style = r.t === 'add' ? { color: 'success' } : r.t === 'del' ? { color: 'error' } : r.t === 'hunk' ? { color: 'suggestion' } : r.t === 'meta' ? { dimColor: true } : {}
        return textRow(flat ? ' '.repeat(2 * numW + 2) : `${num(r.o)} ${num(r.n)} `, r.t === 'add' ? '+' : r.t === 'del' ? '-' : flat ? '' : ' ', r.s, topLine + k, style)
      })
      if (x.binary) body.push(line(ui, 'Binary content: Git gives no text diff for this file.', { color: 'warning' }))
    }
  } else if (!d || d.state === 'loading') body = msg('Loading…')
  else if (isEditor && Client)
    body = [
      <Client
        key="editor"
        module="./editor.tsx"
        width={W}
        height={area}
        props={{ id: `${d.path}#${editSeq}`, text: d.text, path: d.path, line: topLine, rows: area, cols: W, save: saveN, undo: undoN, wheel: wheel.n, wheelBy: wheel.by, goto: jumpTo.n, gotoLine: jumpTo.line, find: { q: n.find.q, cs: n.find.cs, re: n.find.re, n: findNav.n, by: findNav.by } }}
      />,
    ]
  else if (d.state === 'empty') body = msg('Empty file (0 bytes).')
  else if (d.state === 'binary') body = msg(`Binary file (${fmtSize(d.size)}). The content is not shown.`)
  else if (d.state === 'deleted') body = msg('This file is not on disk. Select Diff to compare it with the baseline.', { color: 'warning' })
  else if (d.state === 'error') body = msg(`Cannot read this file: ${d.info}`, { color: 'error' })
  else {
    // a file the editor does not take (large, or with control characters): read-only, with the reason
    const why = line(ui, `Read-only: ${canEdit() || 'this surface has no editor.'}`, { dimColor: true })
    const count = fit(i => d.lines[i]?.length ?? 0, d.lines.length, topLine, area - 1, Math.max(1, W - numW - 2), true)
    const win = d.lines.slice(topLine, topLine + count)
    body = [why, ...(n.find.q ? win.map((s, k) => textRow(`${num(topLine + k + 1)} `, '', s, topLine + k, {})) : [<Code source={win.join('\n') || ' '} path={d.path} startLine={topLine + 1} wrap="wrap" />])]
  }
  return [...head, ...body]
}

// ---------------------------------------------------------------- hooks

/** Opens the pane without a request from the person: the explorer is there when the session starts. */
async function appear($: E) {
  const saved = await $.store.get('pins').catch(() => undefined)
  const pin = typeof saved === 'object' && saved !== null ? (saved as Record<string, unknown>)[await $.session.root()] : undefined
  if (typeof pin === 'string' && pin !== (await get($)).pin) await put($, { pin })
  paneUp = (await $.ui.panes()).some(p => p.id === PANE)
  if (!paneUp) {
    const opened = await $.ui.open({ id: PANE, title: 'Files', columns: 46 })
    paneUp = true
    // the host draws a pane nobody asked for only on a wide terminal; /files asks for it
    if (!opened.isPlaced) $.ui.toast('File explorer: the terminal is too narrow to open it unasked. Run /files to open it.')
  }
  if (warming) return // the pane's first drawing already asked for the tree
  warming = true
  await hydrate($).finally(() => (warming = false))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // a reload can run this before the session is bound again; the command of the first load stays registered
    await $.command
      .register({ name: 'files', description: 'File explorer: files, code, diff, search, edit', argumentHint: '[folder | file[:line] | home | close]', immediate: true })
      .catch(err => $.ui.log(`/files was not registered again: ${text(err)}`, { to: 'debug' }))
    if (e.isInteractive) {
      $.clock.every(3000, go($, () => tick($)))
      $.clock.after(1, go($, () => appear($)))
    }
    return next(e)
  })

  on('command.run', { command: 'files' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      if (blocked($)) return { text: note }
      await $.ui.close({ id: PANE })
      return { text: 'File explorer closed. It opens again with /files or in the next session.' }
    }
    asked = wantColumns()
    const opened = await $.ui.open({ id: PANE, title: 'Files', focus: true, columns: asked, rows: 30 })
    paneUp = true
    let n = await sync($, false)
    if (arg === 'home') await setRoot($, null)
    else if (arg) {
      const m = /^(.*?)(?::(\d+))?$/.exec(arg)
      let a = m?.[1] ?? arg
      if (a === '~' || a.startsWith('~/')) a = `${(await $.env.get('HOME')) ?? ''}${a.slice(1)}`
      const full = a.startsWith('/') ? a : abs(n.root, a.replace(/^\.\//, ''))
      const st = await $.fs.stat(full, { resolve: true }).catch(() => null)
      if (st?.kind === 'dir') await setRoot($, full)
      else {
        // a file outside the root: its folder becomes the root, so any repository is one command away
        if (!isAncestor(n.root, full) || full === n.root) await setRoot($, full.slice(0, full.lastIndexOf('/')) || '/')
        n = cur
        const rel = isAncestor(n.root, full) && full !== n.root ? full.slice(n.root.replace(/\/$/, '').length + 1) : basename(full)
        await reveal($, rel)
        await openFile($, rel, { line: m?.[2] ? Number(m[2]) : undefined, mode: 'code' })
      }
    }
    return { text: opened.isPlaced ? `File explorer: ${cur.root}` : `File explorer is open but not drawn. ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const n = await get($)
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>The file explorer needs text fields. The mobile app does not draw them.</Text>
    }
    const table = $.ui.resolve(e)
    const ui: UI = { Box: table.Box, Text: table.Text, Button: table.Button, Input: table.Input, Code: table.Code, ...('Client' in table ? { Client: table.Client } : {}) }
    where = e.props.placement
    paneUp = true
    warm($, n)
    const W = Math.max(20, e.props.bodyColumns)
    const H = Math.max(12, e.props.scroll.bodyRows || 24)
    // the conversation's columns, and beside them the docked pane with its frame
    screen = (e.viewport?.columns ?? 0) + (where === 'dock' ? W + 3 : 0)
    if (!asked) $.clock.after(1, go($, () => resize($))) // the host can keep a width from an earlier session
    try {
      const head = headPart(ui, $, n, W, H)
      const used = head.length + (H >= 22 ? 2 : 0) // the framed search field is three rows
      return (
        <ui.Box flexDirection="column" width={W}>
          {head}
          {n.mode === 'files' ? treePart(ui, $, n, W, H - used) : readerPart(ui, $, n, W, H - used)}
        </ui.Box>
      )
    } catch (err) {
      return <ui.Text color="error">File explorer could not draw: {text(err)}</ui.Text>
    }
  })

  // The tree and the reader are windows this module moves itself, so the wheel and the page keys come here.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person') return next(e)
    const by = e.pointer ? e.by * 3 : e.by
    if (cur.mode === 'files') await scrollTree($, by)
    else if (cur.mode === 'diff' && (choosing || cur.listing)) {
      pickTop = Math.max(0, pickTop + by)
      redraw($)
    } else if (cur.mode === 'code' && !canEdit()) {
      wheel = { n: wheel.n + 1, by } // the editor moves its own window when it sees the new number
      redraw($)
    } else await scrollReader($, by)
    return {}
  })

  // The tree runs on the drawing thread. It posts what the person did there: a click, an arrow key.
  on('ui.message', { element: 'tree' }, async ($, e, next) => {
    const data = typeof e.data === 'object' && e.data !== null ? (e.data as Record<string, unknown>) : {}
    const at = (key: unknown) => rows.findIndex(r => r.key === key)
    const r = rows[at(data.press ?? data.fold ?? data.parent)]
    const menu = rows.find(x => x.key === data.menu)
    grab($)
    await (async () => {
      if (typeof data.to === 'number') return showRow($, data.to)
      if (menu) {
        // the right button: the row is selected and the actions for it are shown
        moreOpen = true
        return showRow($, rows.indexOf(menu))
      }
      if (!r) return
      if (data.press !== undefined) return pressRow($, r)
      if (data.fold !== undefined) return r.kind === 'dir' && Boolean(r.open) !== data.open && !cur.fileQuery ? toggle($, r.path) : undefined
      const up = at(`row:${dirname(r.path)}`) // Left on an entry of the root has no parent row to go to
      return up < 0 ? undefined : showRow($, up)
    })().catch(err => ((note = text(err)), redraw($)))
    return next(e)
  })

  // The editor runs on the drawing thread and holds the text. It posts when the text first changes and when it saves.
  on('ui.message', { element: 'editor' }, async ($, e, next) => {
    const data = typeof e.data === 'object' && e.data !== null ? (e.data as Record<string, unknown>) : {}
    const id = `${doc?.path}#${editSeq}`
    if ((data.dirty === id && !dirty) || (data.clean === id && dirty)) {
      dirty = data.dirty === id
      redraw($)
    }
    // the text came from code, so it is checked: only the open file, only text of a size the editor takes
    if (data.save === id && typeof data.text === 'string' && data.text.length <= EDIT_MAX * 2) await saveFile($, data.text).catch(err => ((note = `The file was not saved. ${text(err)}`), redraw($)))
    return next(e)
  })

  // any press of a control of this pane: the pane takes the keyboard, so the next click on the tree or the text gives it the keys
  on('ui.press', { plugin: 'file-explorer' }, ($, e, next) => {
    grab($)
    return next(e)
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    paneUp = false
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    go($, () => tick($, true))() // Claude's edits of this turn show at once
    return done
  })
}
