export type Pr = {
  number: number
  title: string
  state: string
  head: string
  headOid: string
  base: string
  baseOid: string
  updated: string
  url: string
  author: string
}

/** A comparison baseline. `sha` stays pinned until the person refreshes or selects again. */
export type Base = { kind: 'head' | 'prev' | 'prhead' | 'prbase'; sha: string; label: string }

/** Navigation state: small, JSON, kept by the host across hot reloads. Paths are relative to `root`. */
export type Nav = {
  root: string
  /** The directory the person chose as the root; null follows the session's directory. */
  pin: string | null
  expanded: string[]
  selected: string | null
  cursor: string | null
  treeTop: number
  view: 'files' | 'search'
  hide: { dot: boolean; ignored: boolean; untracked: boolean }
  fileQuery: string
  /** What the pane shows: the tree, the selected file's code, or its diff. */
  mode: 'files' | 'code' | 'diff'
  wrap: boolean
  scroll: Record<string, number>
  find: { q: string; cs: boolean; re: boolean; idx: number }
  grep: { q: string; hidden: boolean; ignored: boolean; include: string; exclude: string }
  base: Base | null
  pr: Pr | null
  want: Base['kind']
  ctx: number
  listing: boolean
  picker: boolean
  myPrs: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'file-explorer': { nav: Nav }
  }
}
