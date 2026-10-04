# file-explorer

A Claude Code mod: a file manager in a side pane, modeled on an editor's Explorer. It lists a folder in color, opens a file as editable code, compares it with a Git baseline, searches, and creates, renames, and deletes files. Everything is in the mod's own pane. Nothing is drawn in the conversation, and the mod makes no model calls.

Written in TypeScript against Claude Code 2.1.288. The mods API is early access and can change between releases.

Made by Avid ([@Av1dlive](https://x.com/Av1dlive)).

## Install

This repository is its own plugin marketplace, named `av1dlive`.

```sh
claude plugin marketplace add codejunkie99/claude-code-file-explorer
claude plugin install file-explorer@av1dlive --scope user
```

Start a new session, or run `/reload-plugins` in an open one.

To get a later version: `claude plugin marketplace update av1dlive && claude plugin update file-explorer@av1dlive`.

## It is there when a session starts

The mod opens its pane by itself at the start of every session. On a terminal under 144 columns the host does not draw a pane that nobody asked for; a notice then tells you to run `/files` once.


## The pane

```
EXPLORER                         ‹ Back  Forward ›  ↑ Up
╭──────────────────────────────────────────────────────╮
│ Find files                                           │   search field: its target follows the mode
╰──────────────────────────────────────────────────────╯
[ Files ] [ Code ] [ Diff ]                      [ 💾 ]     the three modes (keys 1, 2, 3); Save, in Code
REPO  ⎇ main                                                the folder and its branch
/Users/you/Projects/repo
New File  New Folder  Refresh  Collapse  More
▾ ■  src                                              •     folder icon: the color of its main language
│   TS index.ts                                       M     names take the Git color
  MD README.md
```

- `‹ Back` and `Forward ›` walk the places you visited: folders, files, modes. With no history, Back leaves a file for the tree.
- `↑ Up` makes the parent folder the root.
- The search field applies while you type: the tree filters, and the matches in a file or a diff show, at each letter. Enter applies it at once. A name field applies on Enter.

### Mouse and keyboard

Every action has a control for the pointer and a way to do it with keys.

| Action | Mouse | Keyboard |
|---|---|---|
| Give the pane the keyboard | Click anywhere in the pane | `/files`, or `ctrl+x tab` |
| Move in the tree | Click a row; wheel; `[ ↑ ] [ ↓ ] [ ← ] [ → ]` under the tree | `k` `j` `h` `l`. After a click on the tree: the arrow keys, PgUp, PgDn, Home, End |
| Open a file, open or close a folder | Click the row, or `[ ⏎ ]` under the tree | `o`. After a click on the tree: Enter, Right, Left |
| Actions for one row | Right-click the row: it is selected and `More` opens | Move to the row, then Tab to `More` |
| Any button, tab, or icon | Click | Tab or the arrow keys move the focus ring, Enter presses. Tabs: `1` `2` `3` (not while the editor is shown) |
| Search | Click the field and type: the result follows each letter. `[ ⌫ ]` clears | Tab to the field and type. Erase the text, or an empty Enter, to clear (Files). Enter goes to the next match (Code, Diff) |
| A name (new file, rename) | Type, then `[ ✓ ]`. `[ ✕ ]` cancels | Type, Enter. An empty Enter cancels |
| Next and previous match | `[ ⌄ ]` `[ ⌃ ]` | Tab to them, Enter. In Diff: `f` `b` |
| Previous and next file | `[ ‹ ]` `[ › ]` | Tab to them, Enter. In Diff: `p` `n` |
| Type in the editor | Click the text | Not possible without one click: the host gives the editor keys only after a click |
| Scroll | Wheel | PgUp, PgDn in the editor and the tree after a click |
| Leave the pane | Click the conversation | Esc, or Left |

Two host rules shape this:

- The tree and the editor take keys only after a click on them. The focus ring (Tab) cannot enter them. So the tree has arrow buttons with letter keys, which work as soon as the pane has the keyboard.
- A click in the pane gives the pane the keyboard. If the prompt had the keyboard before a click on the tree, the arrow keys then move the focus ring: use the letter keys, or click the tree once more.

While the editor is shown, no control has a letter or digit key. Text typed before the editor has the keyboard then does nothing, and cannot press a button by accident.

### Files

| Action | Effect |
|---|---|
| Click a folder | Expands or collapses it |
| Click a file | Opens it in Code mode |
| Arrow keys, after a click in the tree | Up/Down move. Right opens a folder, then steps in. Left closes it, then goes to its parent. Enter opens. PgUp, PgDn, Home, End |
| Wheel | Scrolls |
| Search field | `Find files`: `fzf` matches names and paths, and the tree filters while you type. Letters match in their order (`mnpy` finds `api/main.py`). Words match in any order (`api py`). `'word` is an exact part, `!word` excludes. Lower case matches any case. Matches keep their parent folders. An empty field, or an empty Enter, clears it |
| New File / New Folder | Asks for a name. It goes in the selected folder, or beside the selected file |
| Refresh / Collapse | Reads the folder again / closes every folder |
| More | The second row of actions |

More:

| Action | Effect |
|---|---|
| Rename | A field with the current name. An existing name is refused |
| Delete | Asks once, then moves the entry to the Trash (`~/.Trash`). Nothing is removed for good |
| Set as root | The selected folder becomes the root |
| Open folder… | A field for a path: absolute, `~/…`, or relative to the root |
| Home | Back to the session's directory |
| Text search | The search field searches text in files (literal, smart case, `rg`). Fields for files to include and exclude appear. `hidden` and `ignored` widen the search. A result opens the file at that line |
| .files / ignored / untracked | Hide or show those entries |

"Selected" is the row with the bar: the last row you clicked or moved to.

Colors:

- A folder's icon `■` has the color of the language most of its files are in (its own files and the files one level down): TypeScript blue, JavaScript yellow, Python blue-green, Rust tan, Go cyan, Swift orange, and so on. A folder with no code takes a color from its name (`.git`, `docs`, `tests`, `assets`, `scripts`, build output) or the default tan. The first 80 folders of a listing are read for this; the rest take the name color.
- A file has a two-letter mark in its language's color (`TS`, `PY`, `RS`, `GO`, `MD`, `{}`).
- Names take the Git color: modified yellow `M`, added and untracked green `A` `?`, deleted red `D`, conflict red `U`, renamed blue `R`, ignored dim `!`, a folder with changes `•`.
- A line `│` per level shows the nesting. The selected row and the row under the pointer are a bar across the pane.
- A link to a folder that contains it shows `⟲ loop` and does not expand. A folder that cannot be read shows the reason on its row.

### Code

A file opens as an editor, with syntax colors on every line. Click the text, then type.

The toolbar has icons only:

| Icon | Action |
|---|---|
| `[ 💾 ]` at the top right, under the search field | Save. It takes the accent color while there is text to save. `ctrl+s` in the text saves too |
| `[ ‹ ]` `[ › ]` | The previous or next file, in the tree's order. At the end of a folder the step goes on into the next folder, however deep, and opens its first file. Folders that are not expanded are read on the way. Git's own folder and Git-ignored folders are skipped |
| `[ ↶ ]` | Undo: takes back one change, up to 300 |
| `[ ✕ ]` (only while there is unsaved text) | Drops every unsaved change |

- Keys in the text: arrows, Home, End, PgUp, PgDn, Enter (keeps the indent), Backspace, Delete, Tab. Pasted text goes in whole.
- A dot `●` after the file name marks text that is not saved. The mod does not leave such a file: it asks for Save, Undo, or `✕` first.
- If the file changed on disk after you opened it, the first Save refuses and says so. A second Save overwrites.
- Search field: find in the file, any case, while you type. `/pattern/` is a regular expression, `/pattern/i` one in any case. Enter goes to the next match. `:120` and Enter goes to line 120.
- Long lines wrap at the pane's width. Nothing is cut.
- Line endings and the final newline are kept.

A file over 60,000 characters, a partly loaded file (over 256 KB), or a file with control characters is shown read-only, with the reason. `Load more` reads the next part of a large file.

### Diff

The current side is always the file in the working tree: the net result of staged and unstaged edits.

- `Changed files (N)` lists modified, added, deleted, renamed, and untracked files. Deleted files are selectable there.
- `vs HEAD · main 1881bbc3` shows the pinned baseline. Select it to choose another:

| Compare against | Baseline commit |
|---|---|
| Latest commit (default) | `HEAD` |
| Previous commit | The first parent of `HEAD`. Refused with a reason when there is none |
| Pull request head | The head commit of the pull request: what changed since the version pushed to the PR |
| Pull request base | `git merge-base <PR base> <PR head>`: the PR's changes and your local changes beyond it |

- The baseline's SHA changes only when you select a baseline or `Read this baseline again`.
- The PR for the current branch comes from `gh pr list --head <branch>`. One match is selected. With several or none, you choose from the list in the chooser.
- A missing commit is fetched with `git fetch --no-tags --no-write-fetch-head <remote> <sha>`: objects only, no ref, no checkout, no change to working files.
- When `gh` is missing, not authenticated, or offline, the reason is shown and the pinned baseline stays.
- `[ ‹ ]` `[ › ]` go to the previous or next changed file. `‹ Hunk`, `Hunk ›` move between hunks. `Context` changes the context: 3, 10, 30, all.
- `● Side by side` (on at the start) shows the baseline on the left and the working tree on the right. A removed line has a red bar, an added line has a green bar. A removed line and the added line that replaces it are on one row. Select it again for the unified view.

```
1  def add(a, b):                 1  def add(a, b):
2 -    return a + b               2 +    return int(a) + int(b)
3                                 3
                                  4 +def sub(a, b):
```

The red and the green are fixed colors with light text, the same on every theme. A file that the baseline does not have (a new file) has an empty left side.

## Which folder it shows

The root is the session's directory until you choose another folder (`Set as root`, `Open folder…`, `↑ Up`, or the command). The choice is remembered for that session directory, across sessions.

| Command | Effect |
|---|---|
| `/files` | Gives the pane the keyboard |
| `/files ~/Projects/my-app` | That folder becomes the root |
| `/files src/app.ts:120` | Opens that file at line 120 |
| `/files home` | Back to the session's directory |
| `/files close` | Closes the pane until the next session or `/files` |

Git status, diff, and pull requests use the repository that contains the root.

## Width and wrapping

In Code and Diff mode the mod asks the host for a pane as wide as the longest line, up to 60% of the terminal; Files asks for 46 columns. The host treats this as a request. A width that you set by dragging the pane's edge wins, and the host keeps it (`pluginPanes.dockColumns` in `~/.claude.json`). At any width, a line that does not fit wraps.

## Refresh

`$` has no file watch API. While the pane is open the mod compares modification times every 3 seconds: the open file (not while it has unsaved text), and up to 40 expanded folders. Git status is read again every 12 seconds, after each change found, and when a turn of Claude ends.

## Dependencies

`git` for status and diff. Optional: `gh` (authenticated) for pull requests, `rg` for text search (falls back to `grep`), `fzf` for the file-name search (without it: `grep`, a part of the path in any case). `bash`, `find`, `sed`, `dd`, `mkdir`, `mv` (macOS and Linux have them). Delete needs `~/.Trash`.

## Host limits and known limitations

- The host places panes. A mod cannot put anything below the prompt and cannot dock two panes side by side, so code, diff, and the editor are modes of the one pane.
- On a terminal under 110 columns, or not in fullscreen, the host puts the pane inline above the prompt at about a third of the terminal's height.
- The tree and the editor take keys only after a click on them, and the focus ring cannot enter them. Esc gives the keyboard back to the prompt. After a file opens, the keyboard is at the prompt until you click the text.
- Double click is the same as a click: the host reports presses, not click counts. A right-click selects the row and opens `More`; there is no pop-up menu.
- There is no drag selection and no copy in the editor.
- Wrapping breaks a line at the pane's edge, not at a word.
- The editor counts every character as one cell wide. A wrapped line is colored piece by piece, so a token cut at the pane's edge can lose its color.
- `ctrl+z` is not Undo: the host suspends Claude Code on it. Use the `[ ↶ ]` icon.
- A click on an icon takes the keyboard from the text: click the text again to type.
- The diff view has no syntax colors. Side by side pairs the lines of one change by their position, not by their likeness.
- The file-name search stops at 500 matches and does not list `.git` contents. Text search stops at 1000 results. Both say so.
- The mobile app has no text fields, so the mod shows a notice there. Desktop and VS Code were not opened; only the terminal was checked live.

## Develop

```sh
git clone https://github.com/codejunkie99/claude-code-file-explorer
cd claude-code-file-explorer
claude plugin validate .
claude plugin test .
```

- `hooks/register.tsx`: hooks, file and process work, the pane's frame.
- `hooks/tree.tsx`: the tree, a surface module (colors, pointer, arrow keys).
- `hooks/editor.tsx`: the editor, a surface module.
- `hooks/lib.ts`: pure logic (sorting, Git output parsing, diff rows, find).
- `types/index.d.ts`: the `$.state` contract. Navigation state lives there and survives a hot reload.

Test a change with `claude --plugin-dir` on a copy only while the installed copy is disabled: two copies clash on the pane and on the state.
