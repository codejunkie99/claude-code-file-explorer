import { expect, test } from 'claude-code/testing'

import { badgeOf, findMatches, fit, flatten, folderTint, typeOf, pairRows, parseDiff, parseHit, parseNameStatus, parseStatus, remoteFor, rowsFromPaths, sortEntries } from '../hooks/lib'
import type { Dir } from '../hooks/lib'

const f = (name: string, kind: 'file' | 'dir' = 'file') => ({ name, kind, isLink: false, size: 1 })

test('directories come first, then files, each alphabetical', () => {
  expect(sortEntries([f('b.ts'), f('Zeta', 'dir'), f('a.ts'), f('alpha', 'dir')]).map(e => e.name)).toEqual(['alpha', 'Zeta', 'a.ts', 'b.ts'])
})

test('git status gives badges; ignored and untracked directories pass theirs down', () => {
  const s = parseStatus('MM both.txt\0R  src/lib/after.ts\0src/lib/before.ts\0?? notes.txt\0!! node_modules/\0D  docs/gone.md\0', '')
  expect(s.map.get('both.txt')).toBe('M')
  expect(s.map.get('src/lib/after.ts')).toBe('R')
  expect(s.map.has('src/lib/before.ts')).toBe(false)
  expect(badgeOf('node_modules/pkg/index.js', false, s)).toBe('!')
  expect(badgeOf('src', true, s)).toBe('•')
  expect(badgeOf('clean.ts', false, s)).toBe('')
  expect(parseStatus(' M sub/dir/x.ts\0 M other/y.ts\0', 'sub/dir/').map.get('x.ts')).toBe('M')
})

test('the tree shows every entry, filters hide on request, a loop link never expands, an error stays on its row', () => {
  const dirs = new Map<string, Dir>([
    ['', { entries: sortEntries([f('src', 'dir'), f('.env'), f('locked', 'dir'), { name: 'loop', kind: 'dir' as const, isLink: true, size: 0, target: '/r', loop: true }]) }],
    ['src', { entries: [f('a.ts')] }],
    ['locked', { entries: [], error: 'EACCES: permission denied' }],
  ])
  const s = parseStatus('', '')
  const all = flatten(dirs, new Set(['src', 'locked', 'loop']), { dot: false, ignored: false, untracked: false }, s)
  expect(all.map(r => r.key)).toEqual(['row:locked', 'row:loop', 'row:src', 'row:src/a.ts', 'row:.env'])
  expect(all[0]?.error).toBe('EACCES: permission denied')
  expect(all[1]?.open).toBe(false)
  expect(all[1]?.label).toContain('⟲ loop')
  const noDot = flatten(dirs, new Set(), { dot: true, ignored: false, untracked: false }, s)
  expect(noDot.some(r => r.path === '.env')).toBe(false)
})

test('a file filter keeps the ancestors of each match', () => {
  const rows = rowsFromPaths(['src/lib/util.ts', 'README.md', 'src/app.ts'], parseStatus('', ''))
  expect(rows.map(r => `${r.depth}:${r.path}`)).toEqual(['0:src', '1:src/lib', '2:src/lib/util.ts', '1:src/app.ts', '0:README.md'])
})

test('name-status reads renames with their historical path', () => {
  expect(parseNameStatus('M\0both.txt\0R071\0src/lib/before.ts\0src/lib/after.ts\0D\0docs/gone.md\0')).toEqual([
    { code: 'M', path: 'both.txt' },
    { code: 'R', old: 'src/lib/before.ts', path: 'src/lib/after.ts' },
    { code: 'D', path: 'docs/gone.md' },
  ])
})

test('a unified diff becomes rows with old and new line numbers', () => {
  const p = parseDiff(
    'diff --git a/both.txt b/both.txt\nindex 2bec907..da10ff6 100644\n--- a/both.txt\n+++ b/both.txt\n@@ -1,3 +1,4 @@\n-staged and unstaged base\n+STAGED first line\n middle\n end\n+UNSTAGED last line\n\\ No newline at end of file\n',
  )
  expect(p.hunks).toEqual([1])
  expect(p.rows[0]).toEqual({ t: 'meta', s: 'diff --git a/both.txt b/both.txt' })
  expect(p.rows.slice(2)).toEqual([
    { t: 'del', o: 1, s: 'staged and unstaged base' },
    { t: 'add', n: 1, s: 'STAGED first line' },
    { t: 'ctx', o: 2, n: 2, s: 'middle' },
    { t: 'ctx', o: 3, n: 3, s: 'end' },
    { t: 'add', n: 4, s: 'UNSTAGED last line' },
    { t: 'meta', s: '\\ No newline at end of file' },
  ])
  expect(parseDiff('diff --git a/x b/x\nBinary files /dev/null and b/x differ\n').binary).toBe(true)
  // a removed line that looks like a file header stays a removed line
  expect(parseDiff('@@ -1,2 +1 @@\n--- a\n keep\n').rows.map(r => r.t)).toEqual(['hunk', 'del', 'ctx'])
})

test('side by side: a removed line and the added line that replaces it share one pair', () => {
  const { rows } = parseDiff('@@ -1,4 +1,4 @@\n keep\n-old a\n-old b\n+new a\n end\n+tail\n')
  const { pairs, at } = pairRows(rows)
  // rows: 0 hunk, 1 keep, 2 old a, 3 old b, 4 new a, 5 end, 6 tail
  expect(pairs).toEqual([{ l: 0, r: 0 }, { l: 1, r: 1 }, { l: 2, r: 4 }, { l: 3 }, { l: 5, r: 5 }, { r: 6 }])
  expect(at).toEqual([0, 1, 2, 3, 2, 4, 5])
  // the "no newline" note between the two sides does not part them
  const end = pairRows(parseDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n').rows)
  expect(end.pairs[1]).toEqual({ l: 1, r: 3 })
})

test('find counts matches, honours case and regex, and reports a bad regex', () => {
  const lines = ['a Needle', 'needle needle', 'x']
  expect(findMatches(lines, 'needle', { cs: false, re: false }).hits).toHaveLength(3)
  expect(findMatches(lines, 'needle', { cs: true, re: false }).hits).toHaveLength(2)
  expect(findMatches(lines, 'n.{2}dle$', { cs: false, re: true }).hits).toEqual([
    { line: 0, s: 2, e: 8 },
    { line: 1, s: 7, e: 13 },
  ])
  expect(findMatches(lines, '(', { cs: false, re: true }).error).toMatch(/Invalid/)
  expect(findMatches(lines, 'x*', { cs: false, re: true }).hits).toEqual([{ line: 2, s: 0, e: 1 }])
  expect(findMatches(lines, 'absent', { cs: false, re: false }).hits).toEqual([])
})

test('the window never passes the rows on screen or the character budget', () => {
  expect(fit(() => 10, 100, 0, 5, 80, false)).toBe(5)
  expect(fit(() => 200, 100, 0, 6, 80, true)).toBe(2)
  expect(fit(() => 2000, 100, 0, 30, 80, false)).toBe(4)
  expect(fit(() => 10, 3, 2, 5, 80, false)).toBe(1)
})

test('search records and remotes parse', () => {
  expect(parseHit('./src/index.ts\x005:needle here')).toEqual({ file: 'src/index.ts', line: 5, text: 'needle here' })
  expect(parseHit('no separator')).toBe(null)
  const remotes = 'upstream\tgit@github.com:Acme/App.git (fetch)\nfork\thttps://github.com/me/app (fetch)\n'
  expect(remoteFor(remotes, 'https://github.com/acme/app/pull/12')).toBe('upstream')
  expect(remoteFor(remotes, 'https://github.com/other/repo/pull/3')).toBe('https://github.com/other/repo.git')
})

test('a folder takes the color of the language most of its files are in, else a color for its name', () => {
  const ts = typeOf('a.ts').color
  const py = typeOf('a.py').color
  expect(ts).not.toBe(py)
  expect(folderTint(['a.ts', 'b.tsx', 'c.py', 'package.json', 'README.md'], 'app')).toBe(ts)
  expect(folderTint(['x.py', 'y.py', 'z.ts'], 'app')).toBe(py)
  // settings and data files are not a language: they do not decide the color
  expect(folderTint(['a.json', 'b.json', 'c.json', 'main.rs'], 'app')).toBe(typeOf('main.rs').color)
  expect(folderTint(['data.json'], '.git')).not.toBe(folderTint(['data.json'], 'docs'))
  expect(folderTint([], 'anything')).toBe(folderTint(['notes.txt'], 'other'))
  expect(typeOf('Makefile').mark).toBe('$')
})
