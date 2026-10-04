// Pure logic of the file explorer: no `$`, no I/O. The hooks module does the reading.
import type { Pr } from '../types'

export type Kind = 'file' | 'dir' | 'other'
export type Entry = { name: string; kind: Kind; isLink: boolean; size: number; target?: string; loop?: boolean }
export type Dir = { entries: Entry[]; error?: string }
export type Row = {
  key: string
  path: string
  depth: number
  kind: Kind | 'note' | 'head' | 'hit' | 'chg'
  label: string
  badge?: string
  open?: boolean
  error?: string
  line?: number
}
export type Status = { map: Map<string, string>; dirty: Set<string> }
export type Hide = { dot: boolean; ignored: boolean; untracked: boolean }
export type Change = { path: string; code: string; old?: string }
export type DiffRow = { t: 'meta' | 'hunk' | 'ctx' | 'add' | 'del'; o?: number; n?: number; s: string }
export type Hit = { line: number; s: number; e: number }

export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
export const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)
export const isAncestor = (a: string, b: string) => a === b || b.startsWith(a.endsWith('/') ? a : `${a}/`)
export const emptyStatus = (): Status => ({ map: new Map(), dirty: new Set() })

/** Directories first, then files, each alphabetical without regard to case. */
export function sortEntries<T extends { name: string; kind: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    const d = Number(b.kind === 'dir') - Number(a.kind === 'dir')
    if (d) return d
    const x = a.name.toLowerCase()
    const y = b.name.toLowerCase()
    return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

export function statusCode(xy: string): string {
  if (xy === '??') return '?'
  if (xy === '!!') return '!'
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'U'
  if (xy.includes('R')) return 'R'
  if (xy.includes('D')) return 'D'
  if (xy.includes('A')) return 'A'
  return 'M'
}

/** Reads `git status --porcelain=v1 -z`; `prefix` is the root's path inside the repository (`sub/dir/` or ``). */
export function parseStatus(z: string, prefix: string): Status {
  const s = emptyStatus()
  const parts = z.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i] ?? ''
    if (rec.length < 4) continue
    const xy = rec.slice(0, 2)
    const full = rec.slice(3)
    if (xy.includes('R') || xy.includes('C')) i++ // the original path follows
    const code = statusCode(xy)
    if (full.endsWith('/') && prefix.startsWith(full)) {
      s.map.set('', code) // the root itself is inside an untracked or ignored directory
      continue
    }
    if (!full.startsWith(prefix)) continue
    const path = full.slice(prefix.length).replace(/\/$/, '')
    if (!path) continue
    s.map.set(path, code)
    if (code !== '!') for (let d = dirname(path); d; d = dirname(d)) s.dirty.add(d)
  }
  return s
}

/** The badge of one entry: its own code, an untracked or ignored ancestor's, or a dot for a directory with changes. */
export function badgeOf(path: string, isDir: boolean, s: Status): string {
  const own = s.map.get(path)
  if (own) return own
  for (let d = dirname(path); ; d = dirname(d)) {
    const up = s.map.get(d)
    if (up === '?' || up === '!') return up
    if (!d) break
  }
  return isDir && s.dirty.has(path) ? '•' : ''
}

const note = (dir: string, depth: number, label: string): Row => ({
  key: `note:${dir}`,
  path: dir,
  depth,
  kind: 'note',
  label,
})

/** The visible tree as rows, children under each expanded directory that is loaded. */
export function flatten(dirs: Map<string, Dir>, expanded: Set<string>, hide: Hide, s: Status): Row[] {
  const out: Row[] = []
  const walk = (dir: string, depth: number) => {
    const d = dirs.get(dir)
    if (!d) return void out.push(note(dir, depth, 'loading…'))
    if (d.error !== undefined) {
      if (!dir) out.push(note(dir, depth, `⚠ ${d.error}`)) // a child's error is on its own row
      return
    }
    let shown = 0
    for (const e of d.entries) {
      const path = join(dir, e.name)
      const isDir = e.kind === 'dir'
      const badge = badgeOf(path, isDir, s)
      if ((hide.dot && e.name.startsWith('.')) || (hide.ignored && badge === '!') || (hide.untracked && badge === '?'))
        continue
      shown++
      const open = isDir && !e.loop && expanded.has(path)
      const link = e.isLink ? `${e.loop ? ' ⟲ loop' : ''} → ${e.target ?? '(broken link)'}` : ''
      out.push({ key: `row:${path}`, path, depth, kind: e.kind, label: e.name + link, badge, open, error: dirs.get(path)?.error })
      if (open) walk(path, depth + 1)
    }
    if (!shown) out.push(note(dir, depth, d.entries.length ? '(all entries hidden by filters)' : '(empty)'))
  }
  walk('', 0)
  return out
}

/** Matched file paths as a tree: every ancestor directory is kept so a result keeps its location. */
export function rowsFromPaths(paths: readonly string[], s: Status): Row[] {
  type Node = { dirs: Map<string, Node>; files: string[] }
  const root: Node = { dirs: new Map(), files: [] }
  for (const p of paths) {
    const parts = p.split('/')
    let n = root
    for (const part of parts.slice(0, -1)) {
      let next = n.dirs.get(part)
      if (!next) n.dirs.set(part, (next = { dirs: new Map(), files: [] }))
      n = next
    }
    n.files.push(parts[parts.length - 1] ?? p)
  }
  const out: Row[] = []
  const walk = (n: Node, dir: string, depth: number) => {
    const list = [
      ...[...n.dirs.keys()].map(name => ({ name, kind: 'dir' as const })),
      ...n.files.map(name => ({ name, kind: 'file' as const })),
    ]
    for (const e of sortEntries(list)) {
      const path = join(dir, e.name)
      const isDir = e.kind === 'dir'
      out.push({ key: `row:${path}`, path, depth, kind: e.kind, label: e.name, badge: badgeOf(path, isDir, s), open: isDir })
      const child = n.dirs.get(e.name)
      if (isDir && child) walk(child, path, depth + 1)
    }
  }
  walk(root, '', 0)
  return out
}

/** Reads `git diff --name-status -M -z`: `M\0path\0`, and for a rename `R100\0old\0new\0`. */
export function parseNameStatus(z: string): Change[] {
  const p = z.split('\0')
  const out: Change[] = []
  for (let i = 0; i < p.length; ) {
    const st = p[i] ?? ''
    const a = p[i + 1]
    const b = p[i + 2]
    if (!st || a === undefined) break
    if ((st[0] === 'R' || st[0] === 'C') && b !== undefined) {
      out.push({ code: st[0], old: a, path: b })
      i += 3
    } else {
      out.push({ code: st[0] === 'T' ? 'M' : (st[0] ?? 'M'), path: a })
      i += 2
    }
  }
  return out
}

/** One line made safe to draw: no carriage return, no control character but tab. */
export const clean = (s: string) => s.replace(/\r$/, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '�')

/** Cuts a very long line and says so in the line itself: never a silent cut. */
export function clampLine(s: string, max: number): string {
  if (s.length <= max) return s
  const c = s.charCodeAt(max - 1)
  const cut = c >= 0xd800 && c <= 0xdbff ? max - 1 : max
  return `${s.slice(0, cut)} …[+${s.length - cut} chars not shown]`
}

export function splitLines(text: string, max: number): string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map(l => clampLine(clean(l), max))
}

/** Unified diff text to rows with old and new line numbers. Hunk sizes decide where a hunk ends. */
export function parseDiff(text: string, max = 2000): { rows: DiffRow[]; hunks: number[]; binary: boolean } {
  const rows: DiffRow[] = []
  const hunks: number[] = []
  let o = 0
  let n = 0
  let left = 0
  let right = 0
  let binary = false
  for (const line of splitLines(text, max + 1)) {
    const c = line[0]
    if ((left > 0 || right > 0) && (c === ' ' || c === '+' || c === '-' || line === '')) {
      const s = line.slice(1)
      if (c === '+') (rows.push({ t: 'add', n: n++, s }), right--)
      else if (c === '-') (rows.push({ t: 'del', o: o++, s }), left--)
      else (rows.push({ t: 'ctx', o: o++, n: n++, s }), left--, right--)
      continue
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (m) {
      o = Number(m[1])
      left = m[2] === undefined ? 1 : Number(m[2])
      n = Number(m[3])
      right = m[4] === undefined ? 1 : Number(m[4])
      hunks.push(rows.length)
      rows.push({ t: 'hunk', s: line })
      continue
    }
    if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') binary = true
    // the blob ids and the ---/+++ pair repeat what `diff --git` and the rename lines say: rows are scarce
    if (!/^(index [0-9a-f]+\.\.|--- |\+\+\+ )/.test(line)) rows.push({ t: 'meta', s: line })
  }
  return { rows, hunks, binary }
}

/** One line of the side-by-side view: the row on the old side and the row on the new side, as indexes of the diff rows. */
export type Pair = { l?: number; r?: number }

/**
 * Diff rows as side-by-side pairs: a removed line is on the left, and the added line that replaces it
 * is on the right of the same pair. `at[i]` is the pair that holds row `i`.
 */
export function pairRows(rows: readonly DiffRow[]): { pairs: Pair[]; at: number[] } {
  const pairs: Pair[] = []
  const at: number[] = []
  let open: number[] = [] // pairs that have a removed line and no added line yet
  rows.forEach((row, i) => {
    const p = row.t === 'add' ? open.shift() : undefined
    const to = p === undefined ? undefined : pairs[p]
    if (to) to.r = i
    else pairs.push(row.t === 'del' ? { l: i } : row.t === 'add' ? { r: i } : { l: i, r: i })
    at.push(p ?? pairs.length - 1)
    if (row.t === 'del') open.push(pairs.length - 1)
    // a meta row here is "\ No newline at end of file": it sits between the two sides of one change
    else if (row.t !== 'add' && row.t !== 'meta') open = []
  })
  return { pairs, at }
}

export function findMatches(
  lines: readonly string[],
  q: string,
  o: { cs: boolean; re: boolean },
  cap = 5000,
): { hits: Hit[]; capped: boolean; error?: string } {
  if (!q) return { hits: [], capped: false }
  let rx: RegExp
  try {
    rx = new RegExp(o.re ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), o.cs ? 'g' : 'gi')
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { hits: [], capped: false, error: why.startsWith('Invalid') ? why : `Invalid regular expression: ${why}` }
  }
  // ponytail: no regex timeout; a pathological pattern on a long line overruns the hook budget and is dropped
  const hits: Hit[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    rx.lastIndex = 0
    for (let m = rx.exec(line); m; m = rx.exec(line)) {
      if (m[0].length === 0) {
        if (++rx.lastIndex > line.length) break
        continue
      }
      hits.push({ line: i, s: m.index, e: m.index + m[0].length })
      if (hits.length >= cap) return { hits, capped: true }
    }
  }
  return { hits, capped: false }
}

/** How many lines from `top` fit in `rows` screen rows and in the character budget of one drawing. */
export function fit(
  len: (i: number) => number,
  total: number,
  top: number,
  rows: number,
  width: number,
  wrap: boolean,
  budget = 9000,
): number {
  let used = 0
  let chars = 0
  let count = 0
  for (let i = top; i < total && used < rows; i++) {
    const l = len(i)
    const need = wrap ? Math.max(1, Math.ceil(l / Math.max(1, width))) : 1
    if (count && (used + need > rows || chars + l + 1 > budget)) break
    used += need
    chars += l + 1
    count++
  }
  return count
}

/** One `rg --null -n` or `grep --null -n` record: `path\0line:text`. */
export function parseHit(rec: string): { file: string; line: number; text: string } | null {
  const z = rec.indexOf('\0')
  const rest = rec.slice(z + 1)
  const c = rest.indexOf(':')
  const line = Number(rest.slice(0, c))
  if (z < 0 || c < 1 || !Number.isInteger(line)) return null
  return { file: rec.slice(0, z).replace(/^\.\//, ''), line, text: clean(rest.slice(c + 1)).trim().slice(0, 200) }
}

export const splitGlobs = (s: string) => s.split(/[,\s]+/).filter(Boolean)

export const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

/** `gh pr list --json ...` or `gh pr view --json ...` to PRs, most recently updated first. */
export function parsePrs(json: string): Pr[] {
  const data: unknown = JSON.parse(json)
  const list: unknown[] = Array.isArray(data) ? data : [data]
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return list
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map(p => ({
      number: Number(p.number),
      title: str(p.title),
      state: str(p.state),
      head: str(p.headRefName),
      headOid: str(p.headRefOid),
      base: str(p.baseRefName),
      baseOid: str(p.baseRefOid),
      updated: str(p.updatedAt),
      url: str(p.url),
      author: str((p.author as { login?: unknown } | null)?.login),
    }))
    .filter(p => Number.isInteger(p.number) && p.headOid !== '')
    .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0))
}

/** Why `gh` failed, in words the person can act on; the first line of its own message is kept. */
export function ghError(stderr: string): string {
  const line = stderr.trim().split('\n')[0] ?? ''
  if (/auth login|not logged in|authentication|HTTP 401/i.test(stderr))
    return `GitHub CLI is not authenticated. Run "gh auth login". (${line})`
  if (/could not resolve host|dial tcp|network|timeout|connection|no such host/i.test(stderr))
    return `GitHub is not reachable. Local comparison still works. (${line})`
  if (/none of the git remotes|not a github|no git remotes/i.test(stderr))
    return `This repository has no GitHub remote that gh knows. (${line})`
  return `gh failed: ${line || 'no message'}`
}

/** The remote whose URL names the PR's repository, else that repository's own URL. */
export function remoteFor(remotes: string, prUrl: string): string {
  const m = /^(https?:\/\/[^/]+)\/([^/]+\/[^/]+)\/pull\//.exec(prUrl)
  if (!m) return 'origin'
  const slug = (m[2] ?? '').toLowerCase()
  for (const line of remotes.split('\n')) {
    const [name, url = ''] = line.split(/\s+/)
    const u = url.toLowerCase().replace(/\.git$/, '')
    if (name && (u.endsWith(`/${slug}`) || u.endsWith(`:${slug}`))) return name
  }
  return `${m[1]}/${m[2]}.git`
}

// ---------------------------------------------------------------- file types and folder colors

/** A language by file name: a two-letter mark and the color the language is known by. */
const LANGS: [RegExp, string, string][] = [
  [/\.(ts|tsx|mts|cts)$/, 'TS', '#3178c6'],
  [/\.(js|jsx|mjs|cjs)$/, 'JS', '#f1e05a'],
  [/\.py$/, 'PY', '#4b8bbe'],
  [/\.rs$/, 'RS', '#dea584'],
  [/\.go$/, 'GO', '#00add8'],
  [/\.swift$/, 'SW', '#f05138'],
  [/\.(kt|kts)$/, 'KT', '#a97bff'],
  [/\.java$/, 'JV', '#e76f00'],
  [/\.(c|h)$/, 'C', '#a8b9cc'],
  [/\.(cc|cpp|cxx|hpp|hh|mm|m)$/, 'C+', '#f34b7d'],
  [/\.cs$/, 'C#', '#68b723'],
  [/\.rb$/, 'RB', '#cc342d'],
  [/\.php$/, 'PH', '#8892bf'],
  [/\.(html|htm|xml|svg)$/, '<>', '#e34c26'],
  [/\.(css|scss|sass|less)$/, '#', '#a86ed4'],
  [/\.(vue)$/, 'VU', '#41b883'],
  [/\.(svelte)$/, 'SV', '#ff3e00'],
  [/\.(sh|bash|zsh|fish)$/, '$', '#89e051'],
  [/\.(sql)$/, 'SQ', '#e38c00'],
  [/\.(dart)$/, 'DT', '#00b4ab'],
  [/\.(lua)$/, 'LU', '#51a0cf'],
  [/\.(zig)$/, 'ZG', '#ec915c'],
  [/\.(ex|exs)$/, 'EX', '#a074c4'],
  [/\.(md|mdx|rst)$/, 'MD', '#519aba'],
]
/** Files that are not a language: they have a mark, and do not count for a folder's color. */
const OTHERS: [RegExp, string, string][] = [
  [/\.(json|jsonl|json5)$/, '{}', '#cbcb41'],
  [/\.(ya?ml)$/, 'YM', '#cb4b16'],
  [/\.(toml|ini|conf|cfg|env)$|^\.[^.]+$/, '⚙', '#8a8f98'],
  [/^(Makefile|Dockerfile|Justfile)$/, '$', '#89e051'],
  [/\.(png|jpe?g|gif|webp|ico|pdf|mp4|mov|mp3|wav)$/, '▣', '#c586c0'],
  [/\.(zip|gz|tar|tgz|bin|woff2?|ttf|otf|dmg)$/, '▤', '#8a8f98'],
  [/\.lock$|^LICENSE|\.txt$|\.log$/, '≡', '#8a8f98'],
]
/** A folder with no language in it takes a color from its name, as icon themes do. */
const FOLDERS: [RegExp, string][] = [
  [/^\.git$/, '#f14e32'],
  [/^node_modules$|^vendor$|^\.venv$|^venv$/, '#6a9955'],
  [/^(dist|build|out|target|coverage|\.next|\.cache)$/, '#8a8f98'],
  [/^(test|tests|__tests__|spec|e2e)$/, '#d7ba7d'],
  [/^(docs?|documentation)$/, '#519aba'],
  [/^(public|assets|static|images?|img|media)$/, '#c586c0'],
  [/^(scripts?|bin|tools)$/, '#89e051'],
  [/^\./, '#7aa2f7'],
]
const FOLDER = '#dcb67a'

export function typeOf(name: string): { mark: string; color: string; isLang: boolean } {
  for (const [rx, mark, color] of LANGS) if (rx.test(name)) return { mark, color, isLang: true }
  for (const [rx, mark, color] of OTHERS) if (rx.test(name)) return { mark, color, isLang: false }
  return { mark: '≡', color: '#8a8f98', isLang: false }
}

/** The color of a folder's icon: the language most of its files are in, else a color for its name. */
export function folderTint(files: readonly string[], folder: string): string {
  const count = new Map<string, number>()
  for (const f of files) {
    const t = typeOf(f)
    if (t.isLang) count.set(t.color, (count.get(t.color) ?? 0) + 1)
  }
  let best = ''
  for (const [color, n] of count) if (n > (count.get(best) ?? 0)) best = color
  if (best) return best
  for (const [rx, color] of FOLDERS) if (rx.test(folder)) return color
  return FOLDER
}
