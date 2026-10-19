# Vim

DevHub's Vim (`"devhub.vim.enabled": true`) is built into the editor. Where
the code lives: the engine, its workbench contribution and their tests are new
files, kept as files under
[`patches/vscode-overlay/`](../patches/vscode-overlay)
(`src/vs/workbench/contrib/devhubVim/`, the editor's modal input switch
`src/vs/editor/browser/controller/editContext/modalTextInput.ts`, its caret
rule `src/vs/editor/common/cursor/modalCursor.ts`, and the editor tests
beside them); the hooks it needs in VS Code's own files are
[`patches/vscode/0008-devhub-vim.patch`](../patches/vscode/0008-devhub-vim.patch).
Edit them in `vscode/` and write them back with
`scripts/vscode-submodule.sh export`.
It follows **Neovim's defaults** (0.11 / 0.12: `:help vim-differences`,
`:help default-mappings`, `:help lsp-defaults`): `Y` is `y$`, `Q` replays
the last recorded macro, `&` is `:&&`, `gc` comments, `grn` renames, CTRL-L
clears the search highlight, 'hlsearch' and 'incsearch' are on,
'startofline' is off, 'joinspaces' is off, 'nrformats' is `bin,hex`. Where
Neovim asks a language server, DevHub asks VS Code's language features
(see [Neovim defaults and VS Code](#neovim-defaults-and-vs-code)).

Every Vim key is an ordinary VS Code keybinding to a `devhubVim.*` command, so
you customise it exactly as any other shortcut: in `keybindings.json` or the
Keyboard Shortcuts editor (search for `devhubVim`). There is no separate
"Vim keymap" setting.

What makes it Vim rather than a pile of shortcuts is that the engine keeps the
grammar between commands — count, register, pending operator, pending text
object, a forced motion type (`dv`), a command waiting for a character,
visual range, marks, the jump list, the last change and macros — and
publishes it as context keys for `when` clauses. Composition happens in the
engine: `d` only marks an operator as pending, and whatever motion or text
object command comes next completes it, whichever key ran it. So if you rebind
a motion, `d`, `c`, `y`, `gU`, `gc`, counts and visual mode work with the new
key at once, and `.` and macros keep working because they replay commands,
not keys.

## What is supported

Keys in Vim notation; all of them are default keybindings you can change.

**Motions** (all take a count, work after an operator and in visual mode):
`h j k l` `<BS> <Space>` (they wrap over line ends: 'whichwrap' `b,s`), arrows,
`CTRL-H CTRL-J CTRL-N CTRL-P`, `w W b B e E ge gE`, `0 ^ $ g_ | gM`, `gg G`
`{count}G` `{count}%`, `+ - _ <CR>`, `H M L`, `f F t T ; ,`, `%` (brackets
inside a `"string"` on the line are skipped, as in Vim), `( )` sentences,
`{ }` paragraphs, `[[ ]] [] ][` sections, `[( [{ ]) ]}` unmatched brackets,
`/ ? n N` with offsets (`/foo/e+1`, `/foo/+2`), `* # g* g#`, `gd gD`,
`` `{mark} '{mark} `` (with `` `` `` and `''`), `gj gk` (screen lines), `gn gN`.
Words end where the script changes, as in Vim (`漢字` / `ひらがな` / `カタカナ`
/ `ＡＢＣ１２３` / `abc`, see [Words between scripts](#words-between-scripts));
`W B E` stay whitespace-delimited.
Inclusive / exclusive / linewise follow `:help exclusive` and
`:help exclusive-linewise`; `cw` is `ce` on a word; `dw` on the last word of
a line stops at the line end; `dv` `dV` `d<C-v>` force the motion type.

**Operators**: `d c y < > =` (VS Code's reindent), `gu gU g~ g?`, `gq`
(VS Code's range formatter when the language has one, like Neovim's LSP
'formatexpr'; otherwise Vim's own formatting at 'textwidth', 79 when 0), `gw`
(always Vim's own, cursor kept), `gc` (comment toggle, Neovim `gc-default`),
`zf` (create a fold). Doubled for lines: `dd cc yy >> << == guu gugu gUU g~~
g?? gqq gww gcc`. In visual mode the same keys act on the selection.

**Text objects** after `i` / `a`: `w W s p` (word, WORD, sentence,
paragraph), `" ' `` ` ``, `( ) b`, `{ } B`, `[ ]`, `< >`, `t` (XML/HTML tag),
with counts (`d2i(`, `2daw`, `d2it`); `gc` after an operator is the block of
commented lines (`dgc`, `gcgc` uncomments it); `an` / `in` in visual mode
(Neovim 0.12) grow / shrink the selection with VS Code's smart select.
Repeating `i(` / `iw` / `ip` in visual mode extends the selection, as in Vim.

**Changes**: `x X <Del> s S r r<CR> R` (replace mode, `<BS>` puts the old text
back), `J gJ` (`:help J` spacing rules), `p P gp gP ]p [p ]P [P` (linewise,
characterwise, blockwise), `~` (`:set tildeop` makes it an operator), `C D Y`
(`Y` = `y$`), `o O i I a A gi gI`, `u CTRL-R` (VS Code's undo / redo, see
[Undo](#undo)), `.` (with a count; after a
visual change it repeats on the same amount of text; `"1p...` steps through
the numbered registers), `CTRL-A CTRL-X` (decimal with `-`, `0x` hex, `0b`
binary, leading zeros kept), `[<Space> ]<Space>` (blank lines), `&` `g&`,
`ZZ ZQ`.

**Registers**: `"a`–`"z`, `"A`–`"Z` (append; linewise text goes on its own
line), `"0` (last yank), `"1`–`"9` (deletes of a line or more, and the `%` `(`
`)` `` ` `` `/` `?` `n` `N` `{` `}` motions, shifting), `"-` (small deletes),
`""`, `"_`, `"+` / `"*` (the system clipboard), read-only `".` `":` `"/` `"%`.
A register holding text (`"ayy`) can be run with `@a`: its keys go through the
default keymap.

**Visual mode**: `v V CTRL-V`, `{count}v`, `o O` (other end / other corner),
`gv`, `I A` (block: on every line; short lines are skipped by `I` and padded
by `A`; `$A` appends to every line end; in characterwise/linewise mode they
insert at the start / end of the lines), `c C s S R d x D X y Y r J gJ u U ~ >
< = gq gw gc g? gu gU g~ p P CTRL-A CTRL-X g_CTRL-A g_CTRL-X : * # @`.

**Insert mode**: `<Esc> CTRL-[ CTRL-C`, `CTRL-W` / `CTRL-U` (with Neovim's
undo break first), `CTRL-H`, `CTRL-R {register}`, `CTRL-O {command}`, `CTRL-T` /
`CTRL-D` (indent), `CTRL-E` / `CTRL-Y` (character below / above; `CTRL-E`
with the completion menu open closes it, see [Esc](#esc)), `CTRL-]` (dismiss
the inline suggestion), `CTRL-A`
(last inserted text), `CTRL-S` (signature help, Neovim `i_CTRL-S`),
`CTRL-N` / `CTRL-P` / `CTRL-X CTRL-O` (VS Code's suggestions). Counts repeat
the insert (`3ix<Esc>`, `3oab<Esc>`).

**Search**: patterns are **JavaScript regular expressions, exactly as in
VS Code's find widget** with "Use Regular Expression" on — not Vim's regex
dialect. `/ ? n N * # gn`, `:s`, `:g` / `:v`, `:sort /pat/` and `/pat/`
ranges are all VS Code's find (`TextModel.findMatches` / `findNextMatch` /
`findPreviousMatch`) on the editor's model, so they match what Cmd+F matches:

| Vim | here (JavaScript, VS Code's find) |
| --- | --- |
| `\<foo\>` | `\bfoo\b` (ASCII words; `*` / `#` use VS Code's Match Whole Word, which also ends a word where the script changes, 漢字 / かな) |
| `\(ab\)\+` | `(ab)+` |
| `a\{2,3}` `a\=` `a\{-}` | `a{2,3}` `a?` `a*?` |
| `\zs` `\ze` | `(?<=…)` `(?=…)` |
| `\v` `\V` | (none: write the regex, or escape: `foo\(`) |
| `\_s` `\n` | `\s` `\n` — a pattern with `\n` matches across lines, as in the find widget |
| `\c` `\C` | `:set ic` / `scs`, or `:s` flags `i` / `I` |
| `~` (last replacement) | (none) |

Case: 'ignorecase' / 'smartcase' decide VS Code's Match Case (with
'smartcase' an uppercase letter in the pattern makes it match case; the
letters of escapes such as `\W` `\S` `\p{Lu}` do not count), `*` / `#`
follow 'ignorecase' only. An invalid pattern is an error (`E383`) and changes
nothing. 'wrapscan', 'hlsearch' (every match highlighted until `:noh` /
CTRL-L, drawn with VS Code's find colours), 'incsearch' (the match is shown
while typing). `/` and `?` type
into the prompt line at the bottom of the window (see [The prompt](#the-prompt)):
history, `CTRL-U CTRL-W CTRL-R {register}`, and `d/foo<CR>` / `c?bar<CR>`
keep their operator, count and register.

**Scrolling**: `CTRL-E CTRL-Y CTRL-D CTRL-U CTRL-F CTRL-B <PageDown>
<PageUp>`, `zt zz zb z<CR> z. z-` (a count is a line number). They follow
`editor.smoothScrolling` as VS Code's own scroll commands do: animated when it
is on, at once when it is off. Each is one scroll: the window's target and the
cursor (the same number of lines for `CTRL-D` / `CTRL-U`, `'scroll'` being
half the window or the count) are worked out first, the cursor is put there
without a reveal of its own, and the window goes to the target. Pressed again
(or held) while the last one still animates, a scroll goes on from where that
one ends, not from the frame on screen. A cursor that leaves the window by a
motion is revealed with the same scroll type. A jump (`/` `?` `n` `N` `*` `#`
`G` `gg` `%` a mark `:{n}` `:s` …) is revealed as VS Code's find widget
reveals a match — in the center if it is outside the window, not at all if it
is inside — and so is the 'incsearch' preview: Enter after `/foo` lands on
the match the preview showed and the view does not move again. Esc in the
prompt puts the view back exactly where it was before the pattern was typed
(the cursor never moved). Other motions (`j`, `w`, `}` …) scroll just enough.

**Folds** (VS Code's folding): `zo zO zc zC za zA zv zR zM zj zk [z zf zd zE`.
`j` / `k` move over a closed fold.

**Marks and jumps**: `m{a-zA-Z}`, `` ` `` and `'` to marks; marks follow
inserted and deleted lines (a deleted line takes its marks with it); special
marks `` ` `` / `'` (previous context), `[ ]` (last change / yank), `< >`
(last visual area), `.` (last change), `^` (last insert).

**Jumps are VS Code's history.** There is no jump list or change list of
Vim's own: `CTRL-O` / `CTRL-I` (and `<Tab>`) are VS Code's Go Back / Go
Forward (`workbench.action.navigateBack` / `navigateForward`), `g;` / `g,`
Go Back / Go Forward in Edit Locations
(`workbench.action.navigateBackInEditLocations` / `navigateForwardInEditLocations`),
each with a count (`3<C-o>`), across files and editor groups as
`workbench.editor.navigationScope` says. Vim's jumps — `G` `gg` `:{n}` `/`
`?` `n` `N` `*` `#` `%` `(` `)` `{` `}` `[(` `[[` `H` `M` `L` `gd` `gD` `:s` and
marks (`` `a `` `'a` `` `` `` `''`) — put the cursor as a jump (`TextEditorSelectionSource.JUMP`,
what Go to Definition uses), so the history records where each came from and
where it went even when it is only a few lines away, and they also set the
`` ` `` / `'` mark. Every other cursor move (`j`, `w`, `CTRL-D`, a click,
VS Code's own commands) is recorded as VS Code records any move: replacing
the current entry, or a new one 10 lines or more away. So `CTRL-O` also
goes back over VS Code's Go to Definition, Go to Symbol, a search in the
find widget or a click in another file, and Go Back (`ctrl+-`) over Vim's
jumps: one history, not two.

**Macros**: `q{reg}` … `q` (`qA` appends), `@{reg}`, `@@`, `@:`, `Q`
(Neovim: the last recorded register), counts, visual `@{reg}` (runs it on
every selected line, Neovim `v_@-default`).

**Windows** after `CTRL-W` (one-shot, workbench-wide): `h j k l` and arrows
(move between parts), `w W p t b` (editor groups), `s v n` (split above /
left, as 'nosplitbelow' 'nosplitright'; `n` with a new file), `c` (close the
group), `q` (close the editor), `o` (only this group), `=` (equal sizes), `_ |`
(maximise), `+ - < >` (resize), `H J K L` (move the group), `d` (the
diagnostic at the cursor, Neovim `CTRL-W_d-default`), `]` / `}` (definition in
a split / peek). In insert mode `CTRL-W` deletes a word, as in Vim. Any
other command can follow `CTRL-W` too: whatever the key is bound to while
`devhubVim.mode == 'nav'` runs once and the prefix ends, as with the defaults
(see [Customising keys](#customising-keys)); a key bound to nothing only ends
the prefix. Nav mode is not insert mode, so `CTRL-W <BS>` / `<Tab>` / `<Del>`
edit nothing (see [Typing keys are insert-mode keys](#typing-keys-are-insert-mode-keys)).

## Neovim defaults and VS Code

| Keys | Neovim | DevHub runs |
| --- | --- | --- |
| `Y` | `y$` (`Y-default`) | `devhubVim.action yankToLineEnd` |
| `CTRL-L` | `:nohlsearch` + redraw | `devhubVim.action noHighlight` |
| `&` | `:&&` | `devhubVim.action repeatSubstitute` |
| `Q` | replay the last recorded register | `devhubVim.action playLastRecorded` |
| `{Visual}*` `{Visual}#` | search the selection | `devhubVim.action visualSearchForward` / `visualSearchBackward` |
| `{Visual}@{reg}` | run the register on each line | `devhubVim.action visualPlayMacro` |
| `gc{motion}` `gcc` `{Visual}gc` | toggle comments | `devhubVim.operator comment` → `editor.action.commentLine` on the lines |
| `o_gc` (`dgc`, `gcgc`) | the comment block | `devhubVim.textObject comment` |
| `i_CTRL-W` `i_CTRL-U` | with an undo break | `devhubVim.insert deleteWordBefore` / `deleteLineBefore` |
| `K` | LSP hover | `editor.action.showHover` |
| `grn` | rename | `editor.action.rename` |
| `gra` (normal, visual) | code action | `editor.action.quickFix` |
| `grr` | references | `editor.action.goToReferences` |
| `gri` | implementation | `editor.action.goToImplementation` |
| `grt` | type definition (0.12) | `editor.action.goToTypeDefinition` |
| `grx` | run code lens (0.12) | `codelens.showLensesInCurrentLine` |
| `gO` | document symbols | `workbench.action.gotoSymbol` |
| `i_CTRL-S` | signature help | `editor.action.triggerParameterHints` |
| `CTRL-]` `CTRL-W ]` `CTRL-W }` | tag jump via 'tagfunc' (LSP) | `editor.action.revealDefinition` / `revealDefinitionAside` / `peekDefinition` |
| `CTRL-T` | back in the tag stack | `workbench.action.navigateBack` |
| `CTRL-O` `CTRL-I` `<Tab>` | the jump list | `workbench.action.navigateBack` / `navigateForward` (a count repeats) |
| `g;` `g,` | the change list | `workbench.action.navigateBackInEditLocations` / `navigateForwardInEditLocations` (a count repeats) |
| `gq` | LSP 'formatexpr' | `editor.action.formatSelection` on the lines (Vim's formatting when there is no formatter) |
| `]d` `[d` | next / previous diagnostic | `editor.action.marker.next` / `.prev` (a count repeats) |
| `]D` `[D` | last / first diagnostic | `gg` then `editor.action.marker.prev` / `G` then `.next` |
| `CTRL-W d` `CTRL-W CTRL-D` | diagnostic float | `editor.action.showHover` |
| `]q` `[q` | `:cnext` `:cprevious` | `editor.action.marker.nextInFiles` / `.prevInFiles` (problems across files) |
| `]b` `[b` `]B` `[B` | `:bnext` `:bprevious` `:blast` `:bfirst` | `workbench.action.nextEditor` / `previousEditor` / `lastEditorInGroup` / `firstEditorInGroup` |
| `[<Space>` `]<Space>` | blank line above / below | `devhubVim.action blankLineAbove` / `blankLineBelow` |
| `{Visual}an` `{Visual}in` | outer / inner syntax node (0.12) | `editor.action.smartSelect.expand` / `.shrink` |
| `gx` | open the link | `editor.action.openLink` |
| `gt` `gT` | next / previous tab page | `workbench.action.nextEditor` / `previousEditor` |
| `CTRL-^` | alternate file | `workbench.action.openPreviousRecentlyUsedEditorInGroup` |

Neovim's `[l ]l [t ]t [a ]a [Q ]Q` (location list, tags, argument list,
first / last quickfix) have no VS Code counterpart and are not bound.
(Neovim's development branch turns `Q` into a multicursor toggle; DevHub
follows the 0.11 / 0.12 release behaviour.)

## The prompt

`:`, `/` and `?` open Vim's command line: one line at the bottom of the
window, the whole width, just above the status bar (at the bottom edge when
the status bar is hidden), whatever the editor groups and panels are. It shows
the prompt character and the line; it is there only while you type a command
and lies over the bottom of whatever is below it. It takes the editor's font
and the editor's colours (`devhubVim.cmdline.background`, `.foreground`,
`.prefixForeground`, `.border` in `workbench.colorCustomizations`; they
default to `editor.background`, `editor.foreground` and `panel.border`).

The line is an ordinary one-line editor, always in insert mode (it is not a
Vim editor: `i`, `<Esc>` to normal mode and the Vim keymap do not apply in
it): the caret, editing in the middle, selection, the clipboard, an IME,
`Cmd+Z` / `Ctrl+Z` work as in any input. The focus goes back to the editor the
prompt came from when the line is run or abandoned; clicking elsewhere
abandons it.

What it starts with is Vim's: `:` in visual mode starts with `'<,'>`,
`{count}:` with `.,.+{count-1}`; `/` and `?` after an operator (`d/foo<CR>`),
a count or a register keep them for the search. While a pattern is typed the
match is shown in the editor ('incsearch'), and while a `:s` is typed what it
would do ('inccommand', below). Enter runs the line as
`devhubVim.ex` / `devhubVim.search` in the editor it came from (so `:sp`,
`:w`, `:'<,'>s/a/b/` act there).

Its keys are default keybindings like every other Vim key (`when`:
`devhubVim.cmdlineFocus`, Keyboard Shortcuts editor: search for
`devhubVim.cmdline`):

| Key | Command | Does |
| --- | --- | --- |
| `Enter` `CTRL-M` `CTRL-J` | `devhubVim.cmdline.submit` | run the line exactly as typed; with a match picked in the completion menu (`Tab`, `<Down>`, `CTRL-N`), take it first, then run. A menu that showed by itself as you type has nothing picked, so `:w` Enter is `:w` whatever it lists |
| `Esc` `CTRL-C` `CTRL-[` | `devhubVim.cmdline.cancel` | abandon the line, with the completion menu if it is open (one `Esc`, as Vim's wildmenu) |
| `<BS>` `CTRL-H` on an empty line | `devhubVim.cmdline.cancel` | abandon it, as in Vim (otherwise they delete a character) |
| `<Up>` / `<Down>` | `devhubVim.cmdline.historyPrev` / `historyNext` | older / newer history entry that starts with the text before the caret (`:` and the searches each have their own history). With the completion menu open, `<Down>` picks in it, and `<Up>` does once a match is picked; before that `<Up>` is the history (and closes the menu) |
| `CTRL-P` / `CTRL-N`, `<S-Up>` / `<S-Down>`, `<PageUp>` / `<PageDown>` | `devhubVim.cmdline.historyPrev` / `historyNext` `{ "filter": false }` | older / newer entry, any (with the completion menu open `CTRL-N` / `CTRL-P` step through it) |
| `CTRL-R {register}` | `devhubVim.cmdline.insertRegister` | insert a register at the caret (`"` shows at the caret while it waits; `{ "register": "a" }` inserts `"a` without waiting) |
| `CTRL-W` | `devhubVim.cmdline.deleteWord` | delete the word before the caret |
| `CTRL-U` | `devhubVim.cmdline.deleteToStart` | delete everything before the caret |
| `Tab` / `Shift+Tab` (`:` only) | `devhubVim.cmdline.complete` (`{ "direction": "previous" }`) | complete: with the menu open, pick the next / previous match in it (shown in the line); otherwise one match goes straight into the line, and more show the menu with the first picked |
| `CTRL-Y` (menu open) | `acceptSelectedSuggestion` | take the match and keep typing (into a directory: its files show next) |
| `CTRL-B` / `CTRL-E` | `cursorHome` / `cursorEnd` | caret to the start / end |

Tab completes, by what is at the caret (the line read as Enter runs it, so
after a `|` it is the next command's): ex command names after the range
(Vim's with their abbreviation and what they run, and your
`devhub.vim.exCommands`); in an argument what the command says it completes
(`complete`): file names after `:e` `:sp` `:vs` `:new` `:vne`
`:tabnew` `:tabe` `:sav` `:w` (the entries of the directory typed so far, relative
to the workspace folder, `/` for absolute paths; a bare name also finds the
workspace's files that match it); option names after `:set` (with `no` /
`inv` once typed, and the current value); open editors after `:b`; for your
own commands, what their `complete` names (`command:<id>`: what that command
returns). In `/` and `?` Tab is typed.

In a `:` line the menu also shows by itself as you type, as IntelliSense does
in an editor (after a letter, and after a blank or `/`, so `:e ` lists the
directory and `:e src/` what is in `src`), with nothing picked in it: it only
shows what `Tab` would complete, and `Enter` still runs what you typed. `Tab`,
`<Down>` or `CTRL-N` pick a match, `CTRL-Y` takes it and lets you go on typing,
`Enter` takes it and runs the line, `Esc` abandons the line (with the menu,
in one press). File names are the entries of the directory typed so far, as
Vim lists them (`:e ` the workspace folder's, `:e src/foo/` those of
`src/foo`; `~/`, `/abs/` and `%:h/` resolve as `:e` resolves them, in a remote
workspace on the remote side); the workspace is not searched. `"devhub.vim.cmdline.autoComplete": false` turns the menu as
you type off: then it shows on `Tab` only, as before. `/` and `?` have no
completion.

The line's context keys (set inside the line, so they hold while it has the
focus): `devhubVim.cmdlineFocus`, `devhubVim.cmdlineKind` (`:` `/` `?`),
`devhubVim.cmdlineEmpty`, `devhubVim.cmdlineAwaitingRegister`, and
`devhubVim.mode == 'cmdline'`. For example, `CTRL-A` / `CTRL-E` as in a shell
on Windows and Linux:

```jsonc
{ "key": "ctrl+a", "command": "cursorHome", "when": "devhubVim.cmdlineFocus" }
```

`Esc` abandons the line even while the completion menu shows: its weight is
above the menu's own `Esc` (and every other `Esc` an editor widget binds).
To close only the menu, take the match with `CTRL-Y` or keep typing; or, if
you want `Esc` to close the menu first as in VS Code's inputs, bind it in
`keybindings.json` (your own bindings win over every default):

```jsonc
{ "key": "escape", "command": "hideSuggestWidget", "when": "devhubVim.cmdlineFocus && suggestWidgetVisible" }
```

Keys that `:normal` and a register run with `@` feed (`:normal /foo<CR>`)
go through the same keybindings, as if the line had the focus; a register
that leaves the prompt open (`/foo` without `<CR>`) leaves it open in the
line.

## Commands

These are the names keybindings use; they and their arguments are stable.

| Command | Args | Default keys |
| --- | --- | --- |
| `devhubVim.motion` | `{ "motion": name, "char"?: c }` | the motions above |
| `devhubVim.operator` | `{ "operator": name }` | `d c y > < = gu gU g~ g? gq gw gc zf` (twice for lines) |
| `devhubVim.textObjectPrefix` | `{ "kind": "inner" \| "around" }` | `i a` after an operator / in visual mode |
| `devhubVim.textObject` | `{ "object": name, "kind"?: "inner" \| "around" }` | `w W s p " ' `` ` `` ( ) b { } B [ ] < > t n` after `i`/`a`; `gc` `gn` `gN` |
| `devhubVim.forceMotion` | `{ "type": "char" \| "line" \| "block" }` | `v V CTRL-V` after an operator |
| `devhubVim.count` | `{ "digit": 0-9 }` | `1`–`9`, `0` when `devhubVim.hasCount` |
| `devhubVim.register` | `{ "name": c }` | `"` (via `awaitChar`) |
| `devhubVim.mark` | `{ "char": c }` | `m` (via `awaitChar`) |
| `devhubVim.awaitChar` | `{ "then": { "command": id, "args"?: {…} } }` | `f t F T r " q @ m ' `` ` ``, insert `CTRL-R` |
| `devhubVim.mode` | `{ "to": "normal" \| "insert" \| "replace" \| "visual" \| "visualLine" \| "visualBlock", "at"?: … }` | `i a I A gI gi o O R v V CTRL-V` |
| `devhubVim.action` | `{ "action": name, "char"?: c }` | see the list below |
| `devhubVim.scroll` | `{ "by": "line" \| "halfPage" \| "page", "direction": "up" \| "down" }` or `{ "to": "top" \| "center" \| "bottom", "firstNonBlank"?: bool }` | `CTRL-E CTRL-Y CTRL-D CTRL-U CTRL-F CTRL-B zt zz zb z<CR> z. z-` |
| `devhubVim.insert` | `{ "action": name, "char"?: c }` | insert-mode `CTRL-W CTRL-U CTRL-T CTRL-D CTRL-E CTRL-Y CTRL-A CTRL-O CTRL-R`, replace-mode `<BS>` |
| `devhubVim.run` | `{ "command": id, "args"?: any, "visual"?: "exit" \| "keep" }` or `{ "commands": [{ "command", "args"? }, …] }` | folds, LSP keys, `K` … |
| `devhubVim.repeat` | `{ "command": id, "args"?: any, "count": number \| "${count}" }` | `u CTRL-R` (of `undo` / `redo`); `]d [d ]q [q ]b [b gt gT zo zc …` (as `devhubVim.repeat` of `devhubVim.run`) |
| `devhubVim.cmdline` | `{ "kind": ":" \| "/" \| "?" }` | `: / ?` (opens [the prompt](#the-prompt)) |
| `devhubVim.cmdline.submit` `.cancel` `.historyPrev` `.historyNext` `.insertRegister` `.deleteWord` `.deleteToStart` `.complete` | see [the prompt](#the-prompt) | in the prompt line |
| `devhubVim.search` | `{ "pattern": p, "backwards"?: bool }` | (what `/` runs) |
| `devhubVim.ex` | `{ "command": "w" }` | `ZZ ZQ`; run any ex line from a binding |
| `devhubVim.insertText` | `{ "text": t }` | (macro replay) |
| `devhubVim.substituteConfirm` | `{ "char": "y" \| "n" \| "a" \| "q" \| "l" }` | (the `:s///c` question) |
| `devhubVim.escape` | `{ "interrupt"?: bool }` | `<Esc> CTRL-[ CTRL-C` |
| `devhubVim.nav.enter` | — | `CTRL-W` |
| `devhubVim.nav.<name>` | — | after `CTRL-W`: `left down up right` (`h j k l`, also with CTRL), `leftArrow downArrow upArrow rightArrow`, `next` (`w`), `previous` (`W`), `lastAccessed` (`p`), `top` (`t`), `bottom` (`b`), `split` / `splitShift` (`s S`), `vsplit` (`v`), `new` (`n`), `close` (`c`), `quit` (`q`), `only` (`o`), `equalize` (`=`), `maximizeHeight` (`_`), `maximizeWidth` (`\|`), `increaseHeight` (`+`), `decreaseHeight` (`-`), `decreaseWidth` (`<`), `increaseWidth` (`>`), `moveFarLeft/Down/Up/Right` (`H J K L`), `diagnostic` (`d`), `definitionSplit` (`]`), `definitionPreview` (`}`), `escape` |

### Counts, `devhubVim.run` and `devhubVim.repeat`

A count is typed with ordinary keybindings: `1`–`9` (and `0` once a count is
being typed, `devhubVim.hasCount`) run `devhubVim.count { digit }`. Vim's own
commands (motions, operators, text objects, `x`, `p`, …) compose with it as
in Vim: `2d3w` deletes six words, `3j`, `v3j`, `d2i(`.

For any other command the count is an **argument**, put in where the key
runs the command. When a key (or a macro replay) runs `devhubVim.run` or
`devhubVim.repeat`, these placeholders in its args — anywhere in the tree,
in strings or as whole values — are replaced once, and the pending count and
register are consumed:

| Placeholder | Value |
| --- | --- |
| `${count}` | the count, or 1 |
| `${rawCount}` | the count, or `null` |
| `${register}` | the register given with `"x`, or `"` |
| `${char}` | the character an `awaitChar` got (in its `then` args), or empty |

A string that is exactly one placeholder becomes the value (`"${count}"` is
the number 3); inside a longer string it is text (`"tab ${count}"`). After
that the commands are plain functions of their args:

* `devhubVim.run { command, args? }` (or `{ commands: [...] }`, run in order)
  runs it as a Vim action: it is recorded in macros (with the values the
  placeholders had), and in visual mode it runs with the selection on screen
  and then leaves visual mode (`"visual": "keep"` keeps visual mode and takes
  the selection the command made, as smart select does). It does not repeat.
* `devhubVim.repeat { command, args?, count }` runs `command` `count` times,
  in order (each awaited). `count` is a number or `"${count}"`; 0 runs
  nothing (at most 1000). In each iteration `${it}` is 1, 2, … and `${index}`
  0, 1, … in its `args`. A nested repeat's `args` see only their own loop's
  `${it}` (its `count` may use the outer one). Repeating `devhubVim.run` is one
  Vim action: visual mode ends once, after the last iteration.

The defaults that a count repeats (`3]d`) are `devhubVim.repeat` of
`devhubVim.run` with `"count": "${count}"`; the ones it does not (`3K`) are
plain `devhubVim.run`. Examples:

```jsonc
// Vim's {count}gt: go to editor {count}
{ "key": "g t", "command": "devhubVim.run",
  "args": { "command": "workbench.action.openEditorAtIndex", "args": "${count}" },
  "when": "textInputFocus && devhubVim.active && devhubVim.acceptsMotion && devhubVim.mode == 'normal'" },
// 3<C-n>: the third next problem
{ "key": "ctrl+n", "command": "devhubVim.repeat",
  "args": { "command": "editor.action.marker.next", "count": "${count}" },
  "when": "textInputFocus && devhubVim.active && devhubVim.mode == 'normal'" },
// always three lines down, whatever the count
{ "key": "g j", "command": "devhubVim.repeat",
  "args": { "command": "devhubVim.motion", "args": { "motion": "down" }, "count": 3 },
  "when": "textInputFocus && devhubVim.active && devhubVim.acceptsMotion" },
// repeat of run: fold {count} times, on the visual selection too, leaving visual mode once
{ "key": "z c", "command": "devhubVim.repeat",
  "args": { "command": "devhubVim.run", "args": { "command": "editor.fold" }, "count": "${count}" },
  "when": "textInputFocus && devhubVim.active && devhubVim.acceptsMotion && devhubVim.mode != 'operatorPending'" }
```

Motions: `left right charBackward charForward up down displayUp displayDown
wordForward WORDForward wordBackward WORDBackward wordEnd WORDEnd
wordEndBackward WORDEndBackward lineStart firstNonBlank lineEnd lastNonBlank
column middleOfLine fileStart fileEnd nextLineStart previousLineStart
currentLineStart screenTop screenMiddle screenBottom matchBracket
unmatchedParenBackward unmatchedParenForward unmatchedBraceBackward
unmatchedBraceForward sentenceForward sentenceBackward paragraphForward
paragraphBackward sectionForward sectionBackward sectionEndForward
sectionEndBackward repeatFind repeatFindReverse searchNext searchPrevious
searchWordForward searchWordBackward searchWordForwardPartial
searchWordBackwardPartial localDeclaration globalDeclaration`, and with
`char`: `findForward tillForward findBackward tillBackward mark markLine`.
(`halfPageDown` / `halfPageUp` still work and scroll like CTRL-D / CTRL-U.)

Operators: `delete change yank indent outdent reindent lowercase uppercase
toggleCase rot13 format formatKeep comment fold`.

Text objects: `word WORD sentence paragraph doubleQuote singleQuote backtick
paren brace bracket angle tag comment searchMatch searchMatchBackward
syntaxNode` — with counts (`d2iw`, `2daw`, `d2i(`).

`at` for insert: `before after lineEnd firstNonBlank lineStart lastInsert
lineBelow lineAbove`.

Actions (normal mode): `deleteChar deleteCharBefore deleteToLineEnd
changeToLineEnd substituteChar substituteLine yankLine yankToLineEnd put
putBefore putAfterCursorEnd putBeforeCursorEnd putIndented putIndentedBefore
replaceChar toggleCase joinLines joinLinesRaw increment decrement
blankLineAbove blankLineBelow undo redo repeat recordMacro stopMacro playMacro
playLastRecorded repeatSubstitute repeatSubstituteAll reselect noHighlight
ignore`. In visual mode the
same actions act on the selection (`x` deletes it, `p` replaces it, `J` joins
its lines, …) and there are also `lowercase uppercase swapVisualEnds
swapVisualCorner incrementProgressive decrementProgressive visualInsert
visualAppend visualSearchForward visualSearchBackward visualPlayMacro`.

Insert actions: `deleteWordBefore deleteLineBefore backspace insertRegister
indent outdent copyFromAbove copyFromBelow insertLastInserted oneCommand`.

## Context keys

| Key | Values |
| --- | --- |
| `devhubVim.active` | the focused text editor is driven by Vim (`devhubVim.attached` is the old name) |
| `devhubVim.mode` | `normal`, `insert`, `replace`, `visual`, `visualLine`, `visualBlock`, `operatorPending`, `cmdline` (the prompt line has the focus), `nav` (after `CTRL-W`), or `''` |
| `devhubVim.visual` | any visual mode |
| `devhubVim.insert` | insert or replace mode |
| `devhubVim.acceptsMotion` | a motion, operator, count or action may come next: normal, visual or operator-pending mode, and no key is being captured |
| `devhubVim.hasCount` | a count is being typed (so `0` is a digit, not "line start") |
| `devhubVim.pending` | a command is half built (count, register, operator, `i`/`a`, forced motion, character argument) |
| `devhubVim.pendingOperator` | `delete`, `change`, `yank`, `indent`, `outdent`, `reindent`, `lowercase`, `uppercase`, `toggleCase`, `rot13`, `format`, `formatKeep`, `comment`, `fold`, or `''` |
| `devhubVim.textObjectPending` | `inner` or `around` after `i` / `a`, or `''` |
| `devhubVim.awaitingChar` | the next key is a character argument (`f t r " q @ m` …) |
| `devhubVim.recording` | a macro is being recorded |
| `devhubVim.cmdlineFocus` | the prompt line has the focus |
| `devhubVim.cmdlineKind` | `:`, `/` or `?` in the prompt line, or `''` |
| `devhubVim.cmdlineEmpty` | the prompt line is empty |
| `devhubVim.cmdlineAwaitingRegister` | `CTRL-R` in the prompt line waits for a register name |

The defaults use these `when` clauses (`common/vimKeymap.ts` `VIM_WHEN`); copy
them for your own bindings. They start with `textInputFocus`, not
`editorTextFocus`: VS Code never sets `editorTextFocus` in an input that is an
editor (the SCM commit message, the debug console, chat), so a binding on it
does not apply there although the input is a Vim editor (`devhubVim.active`):

| Name | When |
| --- | --- |
| motion | `textInputFocus && devhubVim.active && devhubVim.acceptsMotion` |
| normal | motion `&& devhubVim.mode == 'normal'` |
| normal or visual | motion `&& devhubVim.mode != 'operatorPending'` |
| not visual | motion `&& !devhubVim.visual` |
| visual | motion `&& devhubVim.visual` |
| operator pending | motion `&& devhubVim.mode == 'operatorPending'` |
| text object (after `i`/`a`) | `textInputFocus && devhubVim.active && devhubVim.textObjectPending` |
| insert | `textInputFocus && devhubVim.active && devhubVim.insert && !devhubVim.awaitingChar` |

A key that is the second half of a doubled operator has its own entry, e.g.
`u` → `devhubVim.operator lowercase` when `devhubVim.pendingOperator ==
'lowercase'` (so `guu` works), and `c` / `w` / `?` are not `change` / the
word motion / search back while `comment` / `formatKeep` / `rot13` is
pending.

## Typing keys are insert-mode keys

A key that types or erases at the caret is character input, so it applies
only where typed text reaches the buffer: in insert mode (and replace mode,
where Vim's insert-mode keys work too). In normal, visual, operator-pending,
`:` / `/` and nav mode such a key resolves to the Vim binding on it, or to
nothing, by its `when` clause like any other binding: there is no special
case for it in the Vim layer, and no weight that has to outrank the editor.

VS Code's own defaults for those keys carry the clause (`EditorContextKeys.
devhubVimAllowsTyping` in the editor core; the Keyboard Shortcuts editor shows
it in their `when`):

| Keys (VS Code defaults) | Command |
| --- | --- |
| `Backspace`, `Shift+Backspace`; macOS `Ctrl+H`, `Ctrl+Backspace` | `deleteLeft` |
| `Delete`; macOS `Ctrl+D`, `Ctrl+Delete` | `deleteRight` |
| `Tab` / `Shift+Tab` | `tab` / `outdent` |
| macOS `Ctrl+O` (line break, the caret stays) | `lineBreakInsert` |
| `Ctrl+Backspace` / `Ctrl+Delete`; macOS `Alt+Backspace` / `Alt+Delete` | `deleteWordLeft` / `deleteWordRight` |
| macOS `Ctrl+Alt+Backspace` / `Ctrl+Alt+Delete` | `deleteWordPartLeft` / `deleteWordPartRight` |
| macOS `Cmd+Backspace` | `deleteAllLeft` |
| macOS `Cmd+Delete`, `Ctrl+K` | `deleteAllRight` |
| `Ctrl+Enter` / `Ctrl+Shift+Enter` (macOS `Cmd`) | `editor.action.insertLineAfter` / `insertLineBefore` |
| macOS `Ctrl+T` | `editor.action.transposeLetters` |

`Enter` and printable keys have no keybinding: they are typed text, which a
Vim editor outside insert mode never takes (see the design note in
`devhubVim.contribution.ts`). Line-level and selection commands are not
character input and run in every mode: delete / move / copy lines
(`Ctrl+Shift+K`, `Alt+Up/Down`, `Shift+Alt+Up/Down`), indent / outdent lines
(`Ctrl+]` / `Ctrl+[`), comments (`Ctrl+/`, `Shift+Alt+A`), cut / copy /
paste ([The clipboard](#the-clipboard)), undo / redo, formatting, rename, code actions. Cursor movement and
selection keys are not gated either: where Vim binds them (arrows, `Home`
`End` `PageUp` `PageDown`) Vim's binding wins by weight.

Write your own text-editing bindings the same way, so that they leave normal
mode alone and work as before without Vim:

```jsonc
{ "key": "ctrl+k", "command": "deleteAllRight",
  "when": "textInputFocus && (!devhubVim.active || devhubVim.mode == 'insert')" }
```

(The defaults also hold in replace mode and never after `CTRL-W`:
`devhubVim.mode == 'insert' || devhubVim.mode == 'replace' ||
!devhubVim.active && devhubVim.mode != 'nav'`.) Outside insert mode the Vim
keymap binds `<BS>` (`h`, wrapping), `<Del>` (`x`), `<CR>` (`+`), `<Tab>`
(`CTRL-I` in normal mode) and `<S-Tab>`; where Vim has no meaning for `<Tab>`
/ `<S-Tab>` (visual and operator-pending mode, after `i` / `a`) they do
nothing and cancel a pending operator, rather than move the focus out of the
editor.

## Every key is a keybinding

Every Vim key is a native VS Code keybinding: shown in the Keyboard Shortcuts
editor, overridable and removable in `keybindings.json`, resolved by the
same rules as any other binding (its `when` clause, then its weight). Vim's
defaults get no other precedence. The keystrokes the Vim layer reads itself
are only those no keybinding can express: the character after a command that
waits for one (`f t r m " @ q` …, `CTRL-R` in insert mode and in the
prompt line), what an IME commits, and — asked of the dispatcher
first, only when no binding takes the key — a printable key while a command is
half built, which cancels it as in Vim. While `CTRL-W` waits, its next key is
resolved by the keybinding service before the focused widget sees it (as a
chord's second key is).

Weights above the editor's own (`EditorContrib`) exist only where a VS Code
default would otherwise win:

| Weight | Where | Why |
| --- | --- | --- |
| `EditorContrib` | most keys | above the editor's cursor keys (`EditorCore`), below the widgets' keys (suggest, find, …) |
| `WorkbenchContrib + 50` | `CTRL-` keys, `<Tab>` | workbench-wide defaults on them (Open Recent on `CTRL-R` on macOS, Quick Open on `CTRL-O`, inline suggestion accept on `<Tab>`, Outdent Lines on `CTRL-[`); the `CTRL-W` prefix and its keys |
| `EditorCore + 50` | `<Esc>` outside insert mode | below every widget's Esc, so the widget closes first |
| `WorkbenchContrib + 60` | `<Esc>` `CTRL-[` `CTRL-C` in insert mode | above every widget's Esc ([Esc](#esc)) |

## Esc

In insert and replace mode one `<Esc>` (or `CTRL-[`, `CTRL-C`) is always back
in normal mode, whatever editor widget is showing: it outranks every Esc an
editor widget binds (its weight is `WorkbenchContrib + 60`, above the peek
view's `WorkbenchContrib + 50`) and closes the transient insert-mode widgets
on its way out: the completion menu (`hideSuggestWidget`), the inline
suggestion / next edit suggestion (`editor.action.inlineSuggest.hide`),
signature help (`closeParameterHints`), an editor message
(`leaveEditorMessage`) and linked editing (`cancelLinkedEditingInput`). A
snippet session is not closed (its placeholders stay, and it ends when the
caret leaves them, as with LuaSnip or Neovim's `vim.snippet`); the find widget
and a peek view stay open too, and the next `<Esc>`, in normal mode, closes
them.

Outside insert mode `<Esc>` is as before: an editor widget's Esc (hover, peek,
find, the problem widget, a snippet, the completion menu) comes first (Vim's
Esc has `EditorCore + 50`), and Vim's Esc cancels one pending thing. `CTRL-[`
there has `WorkbenchContrib + 50`: no widget binds it, but on Windows and
Linux VS Code's Outdent Lines does.

To close a widget and stay in insert mode:

| Key (insert / replace mode) | When | Does |
| --- | --- | --- |
| `CTRL-E` | the completion menu shows | closes it (Vim's `complete_CTRL-E`); otherwise `CTRL-E` inserts the character below |
| `CTRL-]` | an inline suggestion / next edit suggestion shows | dismisses it (copilot.vim's `<Plug>(copilot-dismiss)`); otherwise VS Code's `CTRL-]` (indent lines) |

On Windows and Linux `CTRL-C` in insert mode is Vim's (leave insert mode), not
copy; copy in normal or visual mode (`y`, or `CTRL-C` there as before).

## From the first key

An editor Vim drives is in normal mode from the moment it exists: it is
modal, has the block caret and `devhubVim.active` / `devhubVim.mode ==
'normal'` before it can show a frame or take a key, the editors restored at
startup included. There is no moment after startup (or after a split, a peek
or diff editor opening) where a key types into the buffer or a `Backspace`
erases.

How: the Vim layer is a `BlockStartup` workbench contribution, so it exists
before the workbench renders any editor, and it attaches its engine to each
editor inside that editor's constructor: `ICodeEditorService.onCodeEditorAdd`
fires synchronously at its end, before the editor can have focus, take a key
or paint. Attaching makes the editor modal (`modalTextInput.ts`) in normal mode
with the block caret right there; the context keys follow the focused editor.
Editors that exist when Vim is turned on are attached at that moment. Vim
attaches to every code editor but the settings / extensions search boxes:
file editors, diff editors, peek / inline / embedded editors, and inputs that
are editors (SCM message, chat, debug console, comments). There is no other
mechanism, so an editor is either a Vim editor with its engine (`i` enters
insert mode) or a plain one — never modal without an engine. (An earlier
version made editors modal in their constructor, with context keys of their
own, until the engine claimed them; an editor left in that state — reported in
the SCM commit message box — was stuck: nothing typed and `i` did nothing.
The keymap's `when` clauses then still said `editorTextFocus`, which VS Code
sets for full editors only, so in those inputs the engine was attached but no
Vim key applied; they say `textInputFocus` now.) An input's own keys that the
Vim keymap does not bind still apply in every mode (`Ctrl+Enter` commits from
the SCM message).

The one case that is not covered: `devhub.vim.enabled` set only in a remote
(SSH / container) machine's settings. A window starts with the copy of those
cached from its last connection; when there is none yet (the first connection
to that machine) or it is out of date, the editors opened before the remote
settings arrive start as plain editors and become Vim editors when they do.
Put it in your user settings to have Vim from the first key everywhere.

## The caret

Outside insert and replace mode the caret is on a character, as in Vim: it is
never after the last character of a line, except on an empty line (column 1;
'virtualedit' is not supported). That holds however the caret is put there,
not only by Vim's own commands: a click past the end of a line lands on the
last character, and so does a caret restored at the end of a line (reopening a
file, switching back to an editor), undo putting back where a change began,
an edit pushing the caret, multiple cursors, a column selection, and any
other command or extension that sets the position (go to definition,
references, search results, the outline, breadcrumbs). The last character is
the whole last cell: a wide character, an emoji, a letter with its combining
marks.

It is a rule of the editor core, not a correction made afterwards: every
cursor state is checked where the editor makes it
(`modalCursor.ts`, called from the cursor's own `_setState`), so no event,
frame or saved view state ever has the caret past the end, and the block caret
never flickers there first. A selection is not changed: visual mode's
selection may end at the end of the line (its end is exclusive in VS Code). A
drag past the end of the line selects up to and including the last character.

In the visual modes the block caret is on the character the Vim cursor is on,
as in Vim, not one cell to its right. The selection is VS Code's, with an
exclusive end, so it holds exactly the text Vim selected (copying it, or any
command that reads the selection, gets that text), and VS Code would draw its
caret at the selection's end: after the last character. DevHub draws it on
the cursor's character instead, and leaves the selection as it is:

- `v` puts the block on the character under it; `l` / `h` move it one cell at
  a time, also where the selection turns around the start; `o` puts it on the
  other end's character.
- `V` keeps it on the cursor's column although whole lines are selected, and
  moves it with `h` `l` `w` `$` ... though the selected lines stay the same.
- `CTRL-V`: as in Vim there is one cursor: a single block caret, on the corner
  the cursor is on (`o` and `O` move it to the other corners). The block's
  per-line selections are only there for the highlight (they are what copy and
  the commands read), so no caret is drawn on the other lines; leave block mode
  and multiple cursors you add yourself are drawn one caret each, as before.
  Plain `v` and `V` are unchanged.
- `$` puts it on the last character of the line. On an empty line it is at
  column 1 of that line, not at the start of the next one (where the selection
  ends, to take in the empty line's newline).
- A wide character, an emoji or a letter with combining marks is one block; a
  wrapped line has it on the screen line the character is on.
- A mouse drag and `gv` have it on the cursor's character as well, the same
  one `o` and the next motion start from.

The window scrolls to that character, and the active (and relative) line
numbers are its line's (in block mode, the one caret's). Where the caret is
drawn is all that changes: the selection, the cursor position extensions and commands read, the screen
reader's cursor and the caret style (block, unless your settings say
otherwise) are VS Code's. It is a hook in the editor's caret drawing
(`ModalCursor.viewPositions` in `modalCursor.ts`, called from
`viewCursors.ts` and `lineNumbers.ts`), set by the Vim engine's mode.

In insert mode the caret is VS Code's: `A`, `a` on the last character and a
click put it after the last character, and `<Esc>` moves it one left, once.
`CTRL-O` puts it on the last character for its one command and back after it.

## Undo

Undo is VS Code's: `u` is the `undo` command and `CTRL-R` the `redo`
command (`devhubVim.repeat { "command": "undo", "count": "${count}" }`, so
`3u` undoes three steps), the same as `Cmd+Z` / `Shift+Cmd+Z` and the Edit
menu, on the model's own undo stack. So an undo step is whatever VS Code made
one: the edits format on save made are a step of their own after the change
you saved, and so are a refactoring, a code action or a rename (across files,
as VS Code undoes them).

The steps are Vim's where Vim decides them: the engine closes VS Code's undo
step where a Vim change begins and where it ends, so

* each normal-mode change (`dw`, `x`, `p`, `>>`, `:s`, a visual `c`, `.`) is
  one step, and `:g` with all it runs is one;
* an insert is **not** one step: while you type in it, undo stops are VS
  Code's, as in any editor (about a word, a newline, `Tab` or `Backspace`
  typed), so `u` takes back a word or a line of what you typed, not the whole
  insert. The insert as a whole does not run into the change before it or the
  one after it: the step is closed where the insert begins and where it ends
  (`<Esc>`). A count's repeats (`3ix<Esc>`) are added when the insert ends,
  in the same step as the last of the typing.
* `CTRL-W` / `CTRL-U` break the insert first (before they delete), as in
  Neovim, so their deletion is a step of its own; moving the caret (arrows, a
  click) breaks it as in VS Code, and so do accepting a completion, a snippet
  or an inline suggestion, format on type and `Alt+Backspace`.

After an undo or redo — from `u`, `CTRL-R`, `:undo`, `Cmd+Z` or the menu — the
caret is where VS Code puts it back (the selection the change started from),
and outside insert mode the editor is in normal mode with one collapsed caret:
a selection put back (after a visual-mode change) collapses to its start,
where the change began, and a visual mode that was on when you pressed
`Cmd+Z` ends. The caret rule keeps it on a character. `Cmd+Z` in insert mode
undoes and stays in insert mode, as in VS Code.

## The clipboard

`Cmd+C` / `Cmd+X` / `Cmd+V` are VS Code's clipboard actions in every mode, as
in any GUI editor: the same keybindings, the Edit menu and the context menu,
with nothing of Vim's in between. (On Windows and Linux, where the modifier
is `Ctrl`, `CTRL-V` and `CTRL-X` outside insert mode are Vim's: visual block
and decrement; `Shift+Insert` / `Shift+Delete` paste and cut there.) Vim's own registers are unchanged (`"+y`, `"+p`, `"*`).

| Mode | `Cmd+C` | `Cmd+X` | `Cmd+V` |
| --- | --- | --- | --- |
| normal | the line (VS Code's `editor.emptySelectionClipboard`) | cuts the line | pastes at the caret as VS Code does: before the character the block is on, the caret after the pasted text (on a character); a copied whole line goes in above the current line. One undo step; normal mode stays |
| visual (`v` `V` `CTRL-V`) | copies the selected text; **visual mode stays** | cuts the selection, back to normal mode | replaces the selection, back to normal mode |
| insert / replace | VS Code's | VS Code's | VS Code's (with VS Code's undo stops) |

Visual mode stays after `Cmd+C` because a GUI copy changes nothing: the
selection is still there to act on (`d`, `>`, `Cmd+X`) or to leave with
`Esc`, as in VS Code itself. `y` (or `"+y`) is Vim's copy that ends visual
mode. A cut or paste ends it because the selection is gone, as Vim's `d` and
`p` do: whatever command writes over the whole visual selection (a paste
with a paste-as provider too) is back in normal mode, with the caret where VS
Code put it; an edit elsewhere (moving lines with `Alt+Up`) leaves visual
mode alone. A half-built command (`d` waiting for its motion) is dropped by
the paste. The modal input layer (`modalTextInput.ts`) still keeps typed
text and IME compositions out of the buffer outside insert mode; a paste is
a command, like undo, and is no longer swallowed there.

Dropping text or files onto the editor (from another app or the explorer)
still only works in insert mode: a drop puts text where the mouse is, which
outside insert mode would be an edit no Vim command made, and an accidental
drop onto a modal editor would go unnoticed.

## Words between scripts

Japanese has no spaces between words, so a word of VS Code's is a whole
run like `日本語の文章をカタカナで`. With `devhub.editor.wordBoundariesByScript`
(on by default) a word ends where the script changes, as Vim's `utf_class`
has it: 日本語 / の / 文章 / を / カタカナ / で. The classes are kanji (with 々
〆), hiragana, katakana (with ー, and ー after hiragana belongs to the
hiragana: すごーい), fullwidth letters and digits (ＡＢＣ１２３), CJK
punctuation (、。「」・ and the fullwidth symbols), hangul, emoji (a ZWJ
sequence or a flag is one), blanks (the ideographic space `　` is one), and
the rest: letters and digits of other scripts (`abc`, `é`, Greek, ...) and
ASCII punctuation.

The same rule is used by Vim and by VS Code's own word commands, in every
editor, Vim on or off:

| Where | What changes |
| --- | --- |
| Vim `w b e ge`, `iw aw`, `cw` | stop at each class change (CJK punctuation and ASCII punctuation are one class, as in Vim); `W B E iW aW` are unchanged (blanks only, the ideographic space included) |
| Vim `*` `#` `g*` `g#` | the word under the cursor is the run in one script (`*` on 漢字 of 漢字かな searches 漢字 with VS Code's Match Whole Word, which ends a word where the script changes) |
| `Alt+Left` / `Alt+Right` (`cursorWordLeft` / `cursorWordEndRight` …), `Alt+Backspace` / `Alt+Delete` (`deleteWordLeft` / `deleteWordRight`) | move / delete one script run |
| double-click | selects the script run |
| the word under the cursor: `Cmd+D` (`editor.action.addSelectionToNextFindMatch`), the word highlight, the find widget's seed, completion's word | the script run at the cursor |
| whole-word matches (`Cmd+D`'s next match, the highlight's occurrences, find with "Match Whole Word") | a match also ends where the script changes |

What it leaves to VS Code: a line of ASCII only is untouched, and so is any
change between letters / digits and ASCII punctuation (`foo-bar`, `a.b`),
which stays `editor.wordSeparators`' and the language's word definition's.
`editor.wordSeparators` still applies (a character in it is a separator in
Japanese text too). With `editor.wordSegmenterLocales` (`["ja"]`, VS Code's
dictionary-based Intl.Segmenter words) VS Code's word commands use its words
split at script changes as well (これ / は / テスト / です rather than
これは / テスト / です); Vim's motions use the script rule only. Turn the
setting off to have VS Code's words (and Vim's previous ones, where a
letter of any script is a keyword character) back.

It is the editor's core (`editor/common/core/scriptWordBoundaries.ts`, with a
line or two in `wordCharacterClassifier.ts`, `wordHelper.ts` and
`textModelSearch.ts`:
[`patches/vscode/0010-devhub-word-boundaries-by-script.patch`](../patches/vscode/0010-devhub-word-boundaries-by-script.patch)).

## Customising keys

`keybindings.json`:

```jsonc
[
  // Colemak-style: move "down" to n, keep it composable (dn, 3n, vn all work)
  { "key": "n", "command": "devhubVim.motion", "args": { "motion": "down" },
    "when": "textInputFocus && devhubVim.active && devhubVim.acceptsMotion" },
  { "key": "j", "command": "-devhubVim.motion" },

  // VS Code's go to definition on gd (Neovim's gd is "go to local declaration")
  { "key": "g d", "command": "devhubVim.run", "args": { "command": "editor.action.revealDefinition" },
    "when": "textInputFocus && devhubVim.active && devhubVim.acceptsMotion && devhubVim.mode == 'normal'" },

  // Space as a leader key (Space alone then no longer moves right)
  { "key": "space f", "command": "workbench.action.quickOpen",
    "when": "textInputFocus && devhubVim.active && devhubVim.mode == 'normal'" },

  // A sneak-like "s<char>" that composes: ds, also works
  { "key": "s", "command": "devhubVim.awaitChar",
    "args": { "then": { "command": "devhubVim.motion", "args": { "motion": "tillForward" } } },
    "when": "textInputFocus && devhubVim.active && devhubVim.acceptsMotion" },
  { "key": "s", "command": "-devhubVim.action" },

  // "q" as an extra text object for quotes: diq, vaq
  { "key": "q", "command": "devhubVim.textObject", "args": { "object": "doubleQuote" },
    "when": "textInputFocus && devhubVim.active && devhubVim.textObjectPending" },

  // <C-w>n: next editor in the group instead of "split with a new file".
  // After CTRL-W the binding for devhubVim.mode == 'nav' runs once and the
  // prefix ends; remove the default on the key so the list stays clear.
  { "key": "n", "command": "workbench.action.nextEditorInGroup",
    "when": "devhubVim.mode == 'nav'" },
  { "key": "n", "command": "-devhubVim.nav.new" },

  // Ctrl-S saves in normal mode (an ex command from a key)
  { "key": "ctrl+s", "command": "devhubVim.ex", "args": { "command": "w" },
    "when": "textInputFocus && devhubVim.active && devhubVim.mode == 'normal'" }
]
```

Notes:

* `-devhubVim.motion` with a `key` removes only the default on that key; many
  defaults share the command and differ in `args`.
* Multi-key sequences are ordinary VS Code chords (`"g g"`, `"g r n"`). A
  chord has no timeout; in normal mode that is what Vim does too.
* A binding to a plain VS Code command runs it as is: it does not take the
  pending count, operator or register, and it is not part of `.` or a macro.
  Wrap it in `devhubVim.run` for visual mode, macros and the count as
  `${count}`, in `devhubVim.repeat` to repeat it (see above).
* After `CTRL-W` (`devhubVim.mode == 'nav'`) the next key runs whatever it
  resolves to there, as the keybinding dispatcher would (any command, with
  its `args`), and the prefix is over before it runs. The editor's typing
  keys do not apply in nav mode, so `CTRL-W <BS>` deletes nothing; a key
  bound to nothing only ends the prefix. Only a single key, not a chord,
  follows `CTRL-W`.
* `devhubVim.awaitChar` runs `then.command` with `then.args` plus `"char"`;
  the character is the next key typed, or the first character an IME commits.
  Any command can be the target, not just `devhubVim.*` ones.
* A key that no binding takes in a non-insert mode types nothing (the editor
  is modal), and if a command was half built it cancels it, as in Vim.

## Ex commands

Vim's own (run on the buffer, with ranges, counts and abbreviations):

| Command | |
| --- | --- |
| `:[range]s[ubstitute]/{pat}/{rep}/[&cegiInp#lr] [count]` | `{pat}` a JavaScript regex (multiline as VS Code's find), only matches that start in the range; `{rep}` the find widget's replace string: `$1`–`$99` `$&` (the match) `$$` `\n` (line break) `\t` `\\`, and `\u \U \l \L` before a `$n` (`\u$1`); `&` and `~` are plain characters. Any non-alphanumeric delimiter (`\/` is the delimiter); empty `{pat}` is the last search; `c` asks `y/n/a/q/l` for every match; `i` / `I` ignore / match case; `n` counts; `e` no error; `'gdefault'`. One undo step |
| `:s [flags]` `:&[&]` `:~` | repeat the last `:s` (`:&&` keeps the flags; `:~` with the last search pattern) |
| `:[range]g[lobal][!]/{pat}/{cmd}` `:v[global]` | `{cmd}` any of these (`d`, `s//x/`, `normal …`, `m0`, …); one undo step |
| `:[range]d[elete] [x] [count]` `:[range]y[ank] [x] [count]` | |
| `:[range]m[ove] {address}` `:[range]t` / `:co[py] {address}` | `0` is before the first line |
| `:[range]j[oin][!] [count]` `:[range]> [count]` `:[range]< [count]` | `:>>` shifts twice |
| `:[line]pu[t][!] [x]` | always linewise |
| `:[range]norm[al][!] {keys}` | keys go through the default keymap (as `:normal!`), `<Esc>` ends what is left |
| `:[range]sor[t][!] [i][n][x][u][r] [/{pat}/]` | `{pat}` a JavaScript regex |
| `:{n}` `:$` `:'a` `:/pat/` `:+3` | go to the line (keeps the column: 'nostartofline') |
| `:noh[lsearch]` `:u[ndo]` `:red[o]` `:ma[rk] {a}` `:k{a}` | |
| `:se[t] {option}` | see [Options](#options) |
| `:reg[isters]` `:di[splay]` `:marks` | shown in the status bar |
| `:@{reg}` `:@:` `:=` `:ret[ab]` `:le[ft]` `:ri[ght]` `:ce[nter]` | |

VS Code commands (`common/vimEx.ts` `BUILTIN_EX_SPECS`): `:w[rite]`
`:wa[ll]` `:up[date]` `:q[uit][!]` `:qa[ll][!]` `:wq` `:x[it]` `:exi[t]`
`:xa[ll]` `:sp[lit] [file]` `:vs[plit] [file]` `:new [file]` `:vne[w] [file]`
`:e[dit][!] [file]` `:ene[w]` `:tabnew [file]` `:tabe[dit] [file]` (see
[File names](#file-names)) `:tabn[ext]` `:tabp[revious]`
`:tabc[lose]` `:tabo[nly]` `:tabfir[st]` `:tabl[ast]` `:bn[ext]` `:bp[revious]`
`:bd[elete][!]` `:bf[irst]` `:bl[ast]` `:ls` `:buffers` `:b[uffer] {name}`
`:sav[eas]` `:clo[se]` `:on[ly]` `:cn[ext]` `:cp[revious]` `:cope[n]`
`:ccl[ose]` `:ter[minal]` `:gr[ep] {text}`. `:{command} | {command}`
runs both, the second after the first has finished (not after `:g` and
`:normal`, which take `|` as an argument; see [How a `:` line
runs](#how-a--line-runs)). `Tab` in the `:` prompt completes command names,
file names, `:set` options and `:b` buffers, and the menu of them shows as you
type (see [The prompt](#the-prompt)); `{count}:` starts with
`.,.+{count-1}`.

### File names

`:e {file}`, `:sp {file}`, `:vs {file}`, `:new {file}`, `:vne {file}`,
`:tabe {file}` and `:tabnew {file}` open the file itself:

* A relative name is relative to Vim's current directory, which is the
  workspace folder of the file you are in (in a multi-root workspace the
  folder that contains it, otherwise the first folder; without a workspace
  the file's own directory). `/…` is absolute, `~` / `~/…` is the home
  directory, `%` is the current file with Vim's `:p` `:h` `:t` `:r` `:e`
  modifiers (`:e %:h/test.ts`, `:sp %:r.css`), and `\ ` `\%` `\*` are a
  literal blank, `%` and `*`.
* In a remote workspace (SSH, a container) the name is a path on the remote
  machine: it is put into the workspace folder's URI, never read as a local
  path.
* A file that does not exist opens as a new file for that path (Vim's new
  buffer): it is untitled until you save, and saving writes it there without
  asking for a name.
* A name with `*` opens quick open with it; a directory opens quick open in
  that directory.
* `:e` without a name reads the current file again; when it has unsaved
  changes that is `E37: No write since last change (add ! to override)`, and
  `:e!` drops the changes and reads it again.
* `:sp {file}` / `:vs {file}` / `:new {file}` split (above / left, as
  'nosplitbelow' 'nosplitright') and open the file in the new group in place
  of the copy the split made; without a name they keep the copy (`:new` /
  `:vne`: a new untitled file).

They are two commands that an override can use too:
`devhubVim.edit { "file": "${args}", "bang": "${bang}" }` (`:e`) and
`devhubVim.open { "file": "${args}", "replace": true, "untitled": true }` (the
file in the active group; `replace`: instead of its active editor, the copy a
split just made; `untitled`: with no file, a new untitled one). An override of
`split` / `vsplit` / `new` / `vnew` that splits the other way passes the file
on like this:

```jsonc
"devhub.vim.exCommands": {
  // 'splitbelow' 'splitright'
  "split": { "commands": ["workbench.action.splitEditorDown", { "command": "devhubVim.open", "args": { "file": "${args}", "replace": true } }] },
  "vsplit": { "commands": ["workbench.action.splitEditorRight", { "command": "devhubVim.open", "args": { "file": "${args}", "replace": true } }] },
  "new": { "commands": ["workbench.action.splitEditorDown", { "command": "devhubVim.open", "args": { "file": "${args}", "replace": true, "untitled": true } }] },
  "vnew": { "commands": ["workbench.action.splitEditorRight", { "command": "devhubVim.open", "args": { "file": "${args}", "replace": true, "untitled": true } }] }
}
```

(An override without the `devhubVim.open` step only splits, and `:sp {file}`
drops the name.) `:w {file}` and `:sav {file}` do not take a name: `:w`
writes the current file, `:sav` asks for one (see [Known gaps](#known-gaps)).

### How a `:` line runs

Every `:` command — Vim's and yours — is one entry in one registry
(`common/vimEx.ts`), and one parser reads the line, as Vim does: the range,
the name, `!`, then the argument as that command takes it, and, when the
command takes `|`, the next command after it. The `:` prompt's completion
reads the line with the same parser, so it always agrees with what Enter
runs.

* **Names.** Vim's built-ins answer to Vim's abbreviations (`:s` `:su` …
  `:substitute`, `:sp[lit]`, `:norm[al]`, `:setl[ocal]`); a built-in's name is
  letters only, so `:d3` is `:d 3` and `:ka` is `:k a`. Your commands answer
  to their name or any unique prefix of it (`:Fo` runs `Format` when no
  other command of yours starts with `Fo`; `E464: Ambiguous use of
  user-defined command` when several do; a full name wins over the longer
  names it is a prefix of).
* **`|`** ends a command and starts the next (`\|` is a `|` in the argument).
  `:g` `:v` `:normal` (and your commands with `"bar": false`) take the rest
  of the line, `|` included.
* **In order, waiting.** A command that runs a VS Code command (`:w`, `:sp`,
  your own) is awaited before the next command of the line runs, and so is
  each line's command in `:g`, each step of a macro (`@q`, an ex line or a
  key bound to a VS Code command in it), each key of `:normal`. A command
  that fails stops the line (Vim's message, `E…`, in the status bar).
* **One undo step.** What the engine changes for one `:` line — every command
  of it, every line of `:g`, every key of `:normal` — is one undo step. A
  VS Code command makes its own (the editor's undo stops), so an edit after
  waiting for one is a step of its own.
* **The editor is fixed when `:` is pressed.** The range, the lines, `%`, the
  cursor and the current directory are those of the editor the prompt was
  opened from, even after a command of the line moved the focus (`:sp |
  s/a/b/` changes the original editor's lines; a VS Code command runs on
  whatever has the focus, as from a keybinding).
* **Errors** are Vim's, in the status bar: `E492: Not an editor command`,
  `E477: No ! allowed`, `E481: No range allowed`, `E488: Trailing
  characters`, `E471: Argument required`, `E464`, `E16: Invalid range`,
  `E20: Mark not set`, and those of each command.
* No command modifiers (`:silent`, `:vertical`, `:keepjumps` …) and no
  comments (`"`) yet.

### Your own commands

`devhub.vim.exCommands` in your user `settings.json` (local, or the remote
machine's user settings; **a workspace's `.vscode/settings.json` or
`.code-workspace` is never read**: the setting is machine-scoped and DevHub
reads only the user values, so opening a folder cannot define or redefine a
`:` command). Settings Sync does not sync machine-scoped settings; keep it in
your dotfiles.

A name starts with an uppercase letter (as Vim's `:command`: `E183`
otherwise) and may have digits; a lowercase name is accepted only to override
a built-in (any abbreviation names it: `w` and `write` are the same). An
override keeps the attributes of the built-in it does not set (an override of
`split` still takes a file and completes file names).

The value is a command id, or a spec (validated as you type by the
settings' JSON schema, with IntelliSense for every key):

| Key | Value | Vim's | |
| --- | --- | --- | --- |
| `command`, `args` | a command id and its args | | one command, as a keybinding runs it |
| `commands` | `[ "id", { "command", "args"?, "ifBang"? }, … ]` | | several, in order, each awaited; `"ifBang": true` runs a step only for `:Name!`, `false` only without `!` |
| `nargs` | `"none"` (`"0"`), `"1"`, `"?"`, `"*"`, `"+"` | `-nargs` | how many arguments: `none` errors with E488 when one is given, `1` / `+` with E471 without one; `1` and `?` take the whole argument, blanks included, `*` and `+` split it on blanks (`\ ` is a blank in one). Default: `*` when `args` uses `${args}` or `${argList}`, otherwise `none` |
| `range` | `"none"`, `"line"`, `"range"`, `"count"` | `-range`, `-count` | what may stand before the name: nothing (E481, the default), one line (`:5Name`), a range (`:'<,'>Name`, `:%Name`; the lines are selected while the commands run, then the caret goes to the first), a count (`:3Name` or `:Name 3`) |
| `defaultRange` | `"."`, `"%"`, a number | `-range=%`, `-count=N` | without a typed range: the cursor line (default), the whole file; the count (default 0) |
| `bang` | `true` | `-bang` | it takes `!` (E477 otherwise) |
| `register` | `true` | `-register` | the first argument may be a register name (`:Name x …`) |
| `complete` | `"file"`, `"command"`, `"option"`, `"buffer"`, `"command:<id>"` | `-complete` | what Tab completes in the argument; `command:<id>` runs that command with `{ typed, line, caret }` and shows the strings (or `{ label, detail? }`) it returns |
| `bar` | `false` | `-bar` | `\|` is part of the argument (default `true`: it starts the next command) |
| `description` | text | | shown in the prompt's completion |

Placeholders in `args` (a string that is exactly one placeholder becomes the
typed value; inside a longer string it is replaced by its text):

| Placeholder | Value | Vim's |
| --- | --- | --- |
| `${args}` | the argument (string) | `<args>` |
| `${argList}` | the arguments (string[]: split on blanks for `*` / `+`, the whole argument for `1` / `?`) | `<f-args>` |
| `${bang}` | `true` when `!` was typed (in text: `!` or empty) | `<bang>` |
| `${range}` | `{ "start": n, "end": m }` 1-based lines as typed, `null` without a typed range (in text: `n,m`) | `<range>` |
| `${line1}` / `${line2}` | first / last line (1-based) of the typed range, or of `defaultRange` | `<line1>` `<line2>` |
| `${count}` | the count (range `count`), else `null` | `<count>` |
| `${register}` | the register named first (`register`), or `""` | `<reg>` |

```jsonc
"devhub.vim.exCommands": {
  // :Fmt — one command
  "Fmt": "editor.action.formatDocument",
  // :'<,'>Sort, :%Sort — the range's lines are selected while it runs
  "Sort": { "command": "editor.action.sortLinesAscending", "range": "range" },
  // :Grep foo bar, :Grep! foo — the argument string, ! as a flag
  "Grep": { "command": "workbench.action.findInFiles",
            "args": { "query": "${args}", "triggerSearch": true, "isRegex": "${bang}" },
            "nargs": "+", "bang": true },
  // :Term npm test — a sequence, each step awaited
  "Term": { "commands": [
    "workbench.action.terminal.focus",
    { "command": "workbench.action.terminal.sendSequence", "args": { "text": "${args}\n" } }
  ], "nargs": "+", "bar": false },
  // :Close / :Close! — a different command with !
  "Close": { "commands": [
    { "command": "workbench.action.closeActiveEditor", "ifBang": false },
    { "command": "workbench.action.revertAndCloseActiveEditor", "ifBang": true }
  ], "bang": true },
  // :Down, :5Down, :Down 5 — a count
  "Down": { "command": "cursorMove", "args": { "to": "down", "value": "${count}" },
            "range": "count", "defaultRange": 1 },
  // override a built-in name (the built-in's nargs / complete are kept)
  "w": { "commands": ["editor.action.formatDocument", "workbench.action.files.save"] }
}
```

The format before (a bare list of steps, `{ "run": …, "bang": … }`) is not
read any more: such an entry says what it became when you use it.

### 'inccommand'

While `:[range]s/{pat}/{rep}/[flags]` is typed in the prompt, the editor it
came from shows what it would do, as Neovim's `inccommand=nosplit`: every
match in the range on the lines on screen (and 50 around them, at most
1000) struck through, with its replacement after it; `g` decides whether
every match on a line or only the first; while only `{pat}` is typed the
matches are highlighted. A pattern still half typed (`(foo`) shows nothing
and no error. Esc takes it all away; Enter replaces, as one undo step.
`"devhub.vim.inccommand": ""` turns it off (default `"nosplit"`).

## Options

`:set` knows these (Neovim's defaults); `devhub.vim.options` in
`settings.json` sets them at startup, e.g. `{ "ignorecase": true, "smartcase":
true }`. `:set opt` `:set noopt` `:set invopt` `:set opt!` `:set opt?` `:set
opt&` `:set opt=val` `+=` `-=` work, with the short names.

| Option | Default | |
| --- | --- | --- |
| `ignorecase` `ic` | off | |
| `smartcase` `scs` | off | |
| `hlsearch` `hls` | on | |
| `incsearch` `is` | on | |
| `wrapscan` `ws` | on | |
| `startofline` `sol` | off | G, gg, H, M, L, CTRL-D …, dd, >>, :{n} keep the column |
| `joinspaces` `js` | off | |
| `tildeop` `top` | off | |
| `gdefault` `gd` | off | |
| `textwidth` `tw` | 0 | gq / gw width (79 when 0) |
| `nrformats` `nf` | `bin,hex` | add `alpha` for letters |
| `report` | 2 | |

Indentation (`>>`, `CTRL-T`, `:retab`) uses the editor's tab size and
"insert spaces" settings ('shiftwidth', 'tabstop', 'expandtab').

## Keyboard layouts

The default keymap targets the **Apple JIS keyboard** (macOS, JIS hardware,
with the ABC / 英数 input source). Letters, digits, `ctrl+…` letters and the
named keys are the same on every layout; every symbol key is bound to the
physical JIS key that types it, in scan-code notation (`vimKeymap.ts`
`JIS_KEYS`):

| Vim | JIS key | Vim | JIS key | Vim | JIS key |
| --- | --- | --- | --- | --- | --- |
| `!` | `shift+[Digit1]` | `"` | `shift+[Digit2]` | `#` | `shift+[Digit3]` |
| `$` | `shift+[Digit4]` | `%` | `shift+[Digit5]` | `&` | `shift+[Digit6]` |
| `'` | `shift+[Digit7]` | `(` | `shift+[Digit8]` | `)` | `shift+[Digit9]` |
| `-` | `[Minus]` | `=` | `shift+[Minus]` | `^` | `[Equal]` |
| `~` | `shift+[Equal]` | `\|` | `shift+[IntlYen]` | `@` | `[BracketLeft]` |
| `` ` `` | `shift+[BracketLeft]` | `[` | `[BracketRight]` | `{` | `shift+[BracketRight]` |
| `;` | `[Semicolon]` | `+` | `shift+[Semicolon]` | `:` | `[Quote]` |
| `*` | `shift+[Quote]` | `]` | `[Backslash]` | `}` | `shift+[Backslash]` |
| `,` `<` | `[Comma]`, `shift+[Comma]` | `.` `>` | `[Period]`, `shift+[Period]` | `/` `?` | `[Slash]`, `shift+[Slash]` |
| `_` | `[IntlRo]` (also with Shift) | `CTRL-[` | `ctrl+[BracketRight]` | `CTRL-]` | `ctrl+[Backslash]` |

Chords are ordinary chords: `g*` is `g shift+[Quote]`, `[(` is
`[BracketRight] shift+[Digit8]`, `])` is `[Backslash] shift+[Digit9]`. These are
the keys you see, change and remove in the Keyboard Shortcuts editor (it shows
them by the character your layout gives them). There is no character fallback
and no layout context key: a key does what its binding says.

The keymap source is written by character (US notation, `shift+8` for `*`)
and turned into the JIS keys when it is registered, so the table above is
the whole layout dependence.

On another layout, rebind the symbol keys by scan code in `keybindings.json`
(remove the JIS one and add yours), e.g. `^` on a US keyboard:

```jsonc
{ "key": "[Equal]", "command": "-devhubVim.motion" },
{ "key": "shift+[Digit6]", "command": "devhubVim.motion", "args": { "motion": "firstNonBlank" },
  "when": "config.devhub.vim.enabled && textInputFocus && devhubVim.active && devhubVim.acceptsMotion" }
```

`keyboard.dispatch: keyCode` makes VS Code ignore scan codes; keep the default
(`code`).

An IME that is on composes as usual in every mode; its keystrokes run no
keybinding. What it commits outside insert mode is used only as a character
argument (`f`, `t`, `r`, `"`, …), and is dropped
otherwise.

## Known gaps

* The prompt line lies over the bottom row of the part below it while it is
  open (the parts do not move), so a match 'incsearch' shows on that row is
  under it. `CTRL-R CTRL-W` / `CTRL-R CTRL-A` (the word under the cursor),
  `CTRL-V` (literal input), `CTRL-K` (digraphs), abbreviations and Tab
  completion in `/` / `?` are not there. In file names `#` (the alternate
  file), `**` and `` `cmd` `` are not expanded, and `+cmd` / `++opt` are read
  as part of the name.
* `:w {file}` writes the current file (the name is not used: Vim would write
  a copy there), and `:sav[eas] {file}` asks for the name in VS Code's save
  dialog.
* Not implemented: `U` (undo line), `!` / `=` with 'equalprg' (filter
  through a program), `g@` ('operatorfunc'), `gR` (virtual replace),
  `CTRL-V {char}` / `CTRL-K` (literal / digraph input), `gm` `g0` `g$` `g^`
  (screen-line column motions), `[m ]m`, `[* ]*` `[/ ]/`, `zh zl zs ze`
  (horizontal scrolling), `zn zN zi zx`, the command-line window (`q:`), `:let`
  and other Vimscript, `:r[ead]`, `:!`, `:make`, the location list
  / tags / argument list, `CTRL-W x r T`, `'scrolloff'` (VS Code's
  `editor.cursorSurroundingLines` applies).
* Patterns are JavaScript regular expressions (VS Code's find), not Vim's:
  `\%V`, `\%23l`, `\v` and the other Vim-only atoms do not exist. A match
  must lie inside the `:s` / `:g` range (Vim lets it run past the last line),
  `?` / `N` find a match that ends before the cursor (VS Code's Find
  Previous), and `/<Up>` after `*` recalls the word without the whole-word
  condition. Screen columns count a tab as 'tabstop' cells and every
  other character as one (wide CJK characters are one column in blocks).
* Uppercase marks (`mA`) are kept per editor, not across files. The jump
  list and change list are VS Code's history (see Marks and jumps): `:jumps`,
  `:changes` and `:clearjumps` do not exist, a big move that is no Vim jump
  (`20j`, `CTRL-D`) is an entry when it goes 10 lines or more, as in VS Code,
  and entries a few lines apart on separate lines are not merged as Vim's are.
* Macros and `.` record `devhubVim.*` commands (and `devhubVim.run` /
  `devhubVim.repeat`, in macros, with the values their placeholders had),
  captured characters, typed insert text and ex lines; plain VS Code commands
  bound to keys are not recorded. `"ap` after `qa…q` does not paste the macro
  as keys (macros are commands); a register *yanked* as text runs as keys.
  Insert-mode text is recorded as the text between where the insert started
  and where it ended (with backspacing over the start); moving the caret with
  the mouse in between confuses it.
* Ex commands and keys that run VS Code commands (`gc`, `=`, `gq` with a
  formatter, folds, LSP keys) are asynchronous. What comes after them in a
  macro, a `:g`, a `|` line or `:normal` waits for them; keys you type
  meanwhile do not (Vim would hold them back), and `.` replays without
  waiting.
* `gq` uses VS Code's formatter for the whole lines (as Neovim's LSP
  'formatexpr'), so it reformats code rather than wrapping text when the
  language has a range formatter; `gw` always wraps.
* `gd` is Vim's "go to local declaration" (a search), not the language
  server's definition: that is `CTRL-]` (or bind `gd` yourself, see above).
