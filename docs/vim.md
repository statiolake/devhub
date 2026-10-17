# Vim

DevHub's Vim (`"devhub.vim.enabled": true`) is built into the editor
(`patches/vscode/0008-devhub-vim.patch`, `src/vs/workbench/contrib/devhubVim`).
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
(`Y` = `y$`), `o O i I a A gi gI`, `u CTRL-R`, `.` (with a count; after a
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

**Search**: Vim regular expressions (`\v \m \M \V`, `\( \| \+ \= \{n,m}
\< \> \zs \ze \s \d \w \a \u \l \k`, `[[:alpha:]]`, `\c \C`; see
`common/vimRegex.ts`), case sensitive by default ('noignorecase'; `:set ic
scs`), 'wrapscan', 'hlsearch' (every match highlighted until `:noh` /
CTRL-L), 'incsearch' (the match is shown while typing). The prompt has history
(`<Up>` `<Down>`), `CTRL-U CTRL-W CTRL-H CTRL-R {register}`.

**Scrolling**: `CTRL-E CTRL-Y CTRL-D CTRL-U CTRL-F CTRL-B <PageDown>
<PageUp>`, `zt zz zb z<CR> z. z-` (a count is a line number).

**Folds** (VS Code's folding): `zo zO zc zC za zA zv zR zM zj zk [z zf zd zE`.
`j` / `k` move over a closed fold.

**Marks and jumps**: `m{a-zA-Z}`, `` ` `` and `'` to marks; marks follow
inserted and deleted lines (a deleted line takes its marks with it); special
marks `` ` `` / `'` (previous context), `[ ]` (last change / yank), `< >`
(last visual area), `.` (last change), `^` (last insert). `CTRL-O CTRL-I <Tab>`
walk the jump list (at its ends they continue in VS Code's navigation history,
across files), `g; g,` the change list.

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
| `devhubVim.run` | `{ "command": id, "args"?: any, "count"?: "repeat" \| "ignore", "visual"?: "exit" \| "keep" }` or `{ "commands": [{ "command", "args"? }, …] }` | folds, LSP keys, `]d` … |
| `devhubVim.cmdline` | `{ "kind": ":" \| "/" \| "?" }` | `: / ?` |
| `devhubVim.search` | `{ "pattern": p, "backwards"?: bool }` | (what `/` runs) |
| `devhubVim.ex` | `{ "command": "w" }` | `ZZ ZQ`; run any ex line from a binding |
| `devhubVim.insertText` | `{ "text": t }` | (macro replay) |
| `devhubVim.substituteConfirm` | `{ "char": "y" \| "n" \| "a" \| "q" \| "l" }` | (the `:s///c` question) |
| `devhubVim.escape` | `{ "interrupt"?: bool }` | `<Esc> CTRL-[ CTRL-C` |
| `devhubVim.nav.enter` | — | `CTRL-W` |
| `devhubVim.nav.<name>` | — | after `CTRL-W`: `left down up right` (`h j k l`, also with CTRL), `leftArrow downArrow upArrow rightArrow`, `next` (`w`), `previous` (`W`), `lastAccessed` (`p`), `top` (`t`), `bottom` (`b`), `split` / `splitShift` (`s S`), `vsplit` (`v`), `new` (`n`), `close` (`c`), `quit` (`q`), `only` (`o`), `equalize` (`=`), `maximizeHeight` (`_`), `maximizeWidth` (`\|`), `increaseHeight` (`+`), `decreaseHeight` (`-`), `decreaseWidth` (`<`), `increaseWidth` (`>`), `moveFarLeft/Down/Up/Right` (`H J K L`), `diagnostic` (`d`), `definitionSplit` (`]`), `definitionPreview` (`}`), `escape` |

`devhubVim.run` runs a VS Code command as a Vim command: a count runs it that
many times (`"count": "ignore"` once), it is recorded in macros, and in visual
mode it runs with the selection on screen and then leaves visual mode
(`"visual": "keep"` keeps visual mode and takes the selection the command
made, as smart select does).

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
playLastRecorded repeatSubstitute repeatSubstituteAll reselect jumpBack
jumpForward changeOlder changeNewer noHighlight ignore`. In visual mode the
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
| `devhubVim.mode` | `normal`, `insert`, `replace`, `visual`, `visualLine`, `visualBlock`, `operatorPending`, `cmdline`, `nav` (after `CTRL-W`), or `''` |
| `devhubVim.visual` | any visual mode |
| `devhubVim.insert` | insert or replace mode |
| `devhubVim.acceptsMotion` | a motion, operator, count or action may come next: normal, visual or operator-pending mode, and no key is being captured |
| `devhubVim.hasCount` | a count is being typed (so `0` is a digit, not "line start") |
| `devhubVim.pending` | a command is half built (count, register, operator, `i`/`a`, forced motion, character argument) |
| `devhubVim.pendingOperator` | `delete`, `change`, `yank`, `indent`, `outdent`, `reindent`, `lowercase`, `uppercase`, `toggleCase`, `rot13`, `format`, `formatKeep`, `comment`, `fold`, or `''` |
| `devhubVim.textObjectPending` | `inner` or `around` after `i` / `a`, or `''` |
| `devhubVim.awaitingChar` | the next key is a character argument (`f t r " q @ m` …) |
| `devhubVim.recording` | a macro is being recorded |

The defaults use these `when` clauses (`common/vimKeymap.ts` `VIM_WHEN`); copy
them for your own bindings:

| Name | When |
| --- | --- |
| motion | `editorTextFocus && devhubVim.active && devhubVim.acceptsMotion` |
| normal | motion `&& devhubVim.mode == 'normal'` |
| normal or visual | motion `&& devhubVim.mode != 'operatorPending'` |
| not visual | motion `&& !devhubVim.visual` |
| visual | motion `&& devhubVim.visual` |
| operator pending | motion `&& devhubVim.mode == 'operatorPending'` |
| text object (after `i`/`a`) | `editorTextFocus && devhubVim.active && devhubVim.textObjectPending` |
| insert | `editorTextFocus && devhubVim.active && devhubVim.insert && !devhubVim.awaitingChar` |

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
paste, undo / redo, formatting, rename, code actions. Cursor movement and
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
waits for one (`f t r m " @ q` …, `CTRL-R` in insert mode), the text typed
into the `:` / `/` prompt, what an IME commits, and — asked of the dispatcher
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

How: the editor core asks Vim's start policy in the editor's constructor
(`ModalTextInput.setStartPolicy`, `modalTextInput.ts`, given by
`devhubVim.contribution.ts` when it loads, from `devhub.vim.enabled`) and,
when it says yes, starts the editor modal, with the block caret and those two
keys bound in the editor's own context-key scope. The Vim layer is a
`BlockStartup` workbench contribution, so it exists before the workbench
renders any editor, and it attaches to each one in the same constructor
(`ICodeEditorService.onCodeEditorAdd`); attaching *claims* the state (the
editor-scoped keys give way to its global ones) or, for an editor Vim does not
drive (the settings / extensions search boxes), *releases* it. Vim attaches to
every code editor but those search boxes: file editors, diff editors, peek /
inline / embedded editors, and inputs that are editors (SCM message, chat,
debug console).

The one case that is not covered: `devhub.vim.enabled` set only in a remote
(SSH / container) machine's settings. A window starts with the copy of those
cached from its last connection; when there is none yet (the first connection
to that machine) or it is out of date, the editors opened before the remote
settings arrive start as plain editors and become Vim editors when they do.
Put it in your user settings to have Vim from the first key everywhere.

## Customising keys

`keybindings.json`:

```jsonc
[
  // Colemak-style: move "down" to n, keep it composable (dn, 3n, vn all work)
  { "key": "n", "command": "devhubVim.motion", "args": { "motion": "down" },
    "when": "editorTextFocus && devhubVim.active && devhubVim.acceptsMotion" },
  { "key": "j", "command": "-devhubVim.motion" },

  // VS Code's go to definition on gd (Neovim's gd is "go to local declaration")
  { "key": "g d", "command": "devhubVim.run", "args": { "command": "editor.action.revealDefinition", "count": "ignore" },
    "when": "editorTextFocus && devhubVim.active && devhubVim.acceptsMotion && devhubVim.mode == 'normal'" },

  // Space as a leader key (Space alone then no longer moves right)
  { "key": "space f", "command": "workbench.action.quickOpen",
    "when": "editorTextFocus && devhubVim.active && devhubVim.mode == 'normal'" },

  // A sneak-like "s<char>" that composes: ds, also works
  { "key": "s", "command": "devhubVim.awaitChar",
    "args": { "then": { "command": "devhubVim.motion", "args": { "motion": "tillForward" } } },
    "when": "editorTextFocus && devhubVim.active && devhubVim.acceptsMotion" },
  { "key": "s", "command": "-devhubVim.action" },

  // "q" as an extra text object for quotes: diq, vaq
  { "key": "q", "command": "devhubVim.textObject", "args": { "object": "doubleQuote" },
    "when": "editorTextFocus && devhubVim.active && devhubVim.textObjectPending" },

  // <C-w>n: next editor in the group instead of "split with a new file".
  // After CTRL-W the binding for devhubVim.mode == 'nav' runs once and the
  // prefix ends; remove the default on the key so the list stays clear.
  { "key": "n", "command": "workbench.action.nextEditorInGroup",
    "when": "devhubVim.mode == 'nav'" },
  { "key": "n", "command": "-devhubVim.nav.new" },

  // Ctrl-S saves in normal mode (an ex command from a key)
  { "key": "ctrl+s", "command": "devhubVim.ex", "args": { "command": "w" },
    "when": "editorTextFocus && devhubVim.active && devhubVim.mode == 'normal'" }
]
```

Notes:

* `-devhubVim.motion` with a `key` removes only the default on that key; many
  defaults share the command and differ in `args`.
* Multi-key sequences are ordinary VS Code chords (`"g g"`, `"g r n"`). A
  chord has no timeout; in normal mode that is what Vim does too.
* A binding to a plain VS Code command runs it as is: it does not take the
  pending count, operator or register, and it is not part of `.` or a macro.
  Wrap it in `devhubVim.run` to give it a count and visual mode.
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
| `:[range]s[ubstitute]/{pat}/{rep}/[&cegiInp#lr] [count]` | `&` `\0`–`\9` `~` `\u \l \U \L \e \E` `\r` (line break) `\n` (NUL) in `{rep}`; any non-alphanumeric delimiter; empty `{pat}` is the last search; `c` asks `y/n/a/q/l` for every match; `'gdefault'` |
| `:s [flags]` `:&[&]` `:~` | repeat the last `:s` (`:&&` keeps the flags; `:~` with the last search pattern) |
| `:[range]g[lobal][!]/{pat}/{cmd}` `:v[global]` | `{cmd}` any of these (`d`, `s//x/`, `normal …`, `m0`, …); one undo step |
| `:[range]d[elete] [x] [count]` `:[range]y[ank] [x] [count]` | |
| `:[range]m[ove] {address}` `:[range]t` / `:co[py] {address}` | `0` is before the first line |
| `:[range]j[oin][!] [count]` `:[range]> [count]` `:[range]< [count]` | `:>>` shifts twice |
| `:[line]pu[t][!] [x]` | always linewise |
| `:[range]norm[al][!] {keys}` | keys go through the default keymap (as `:normal!`), `<Esc>` ends what is left |
| `:[range]sor[t][!] [i][n][x][u][r] [/{pat}/]` | |
| `:{n}` `:$` `:'a` `:/pat/` `:+3` | go to the line (keeps the column: 'nostartofline') |
| `:noh[lsearch]` `:u[ndo]` `:red[o]` `:ma[rk] {a}` `:k{a}` | |
| `:se[t] {option}` | see [Options](#options) |
| `:reg[isters]` `:di[splay]` `:marks` | shown in the status bar |
| `:@{reg}` `:@:` `:=` `:ret[ab]` `:le[ft]` `:ri[ght]` `:ce[nter]` | |

VS Code commands (`common/vimEx.ts` `BUILTIN_EX_COMMANDS`): `:w[rite]`
`:wa[ll]` `:up[date]` `:q[uit][!]` `:qa[ll][!]` `:wq` `:x[it]` `:exi[t]`
`:xa[ll]` `:sp[lit]` `:vs[plit]` `:new` `:vne[w]` `:e[dit][!] [file]` (quick
open) `:ene[w]` `:tabnew` `:tabe[dit]` `:tabn[ext]` `:tabp[revious]`
`:tabc[lose]` `:tabo[nly]` `:tabfir[st]` `:tabl[ast]` `:bn[ext]` `:bp[revious]`
`:bd[elete][!]` `:bf[irst]` `:bl[ast]` `:ls` `:buffers` `:b[uffer] {name}`
`:sav[eas]` `:clo[se]` `:on[ly]` `:cn[ext]` `:cp[revious]` `:cope[n]`
`:ccl[ose]` `:ter[minal]` `:gr[ep] {text}`. `:{command} | {command}`
runs both (not after `:g` and `:normal`, which take `|` as an argument).
`Tab` in the `:` prompt completes command names; `{count}:` starts with
`.,.+{count-1}`.

Your own commands go in `settings.json`; they can run any command with any
args, like a keybinding. Names must start with an uppercase letter (as Vim's
`:command`); a lowercase name is accepted only to override a built-in one
(any abbreviation names it: `w` and `write` are the same).

```jsonc
"devhub.vim.exCommands": {
  // :Fmt — one command
  "Fmt": "editor.action.formatDocument",
  // :'<,'>Sort — the range's lines are selected while it runs
  "Sort": { "command": "editor.action.sortLinesAscending" },
  // :Grep foo bar — the argument string
  "Grep": { "command": "workbench.action.findInFiles",
            "args": { "query": "${args}", "triggerSearch": true, "isRegex": "${bang}" } },
  // :Term npm test — a sequence, each step awaited
  "Term": [
    { "command": "workbench.action.terminal.focus" },
    { "command": "workbench.action.terminal.sendSequence", "args": { "text": "${args}\n" } }
  ],
  // :Close / :Close! — a different command with !
  "Close": { "run": "workbench.action.closeActiveEditor",
             "bang": "workbench.action.revertAndCloseActiveEditor" },
  // override a built-in name
  "w": ["editor.action.formatDocument", "workbench.action.files.save"]
}
```

Syntax: `:[range]Name[!] [args]`. Ranges: `N`, `.`, `$`, `'x` (any mark,
`'<` `'>` the last visual area; `:` in visual mode prefills `'<,'>`), `%`,
`*`, `/pat/`, `?pat?`, `\/` `\?` `\&`, offsets (`.+2`, `$-1`), `a,b` and
`a;b`.

Placeholders in `args` (a string that is exactly one placeholder becomes the
typed value; inside a longer string it is replaced by its text):

| Placeholder | Value |
| --- | --- |
| `${args}` | the text after the name (string) |
| `${argList}` | that text split on blanks (string[]) |
| `${bang}` | `true` when `!` was typed (in text: `!` or empty) |
| `${range}` | `{ "start": n, "end": m }` 1-based lines, `null` without a range (in text: `n,m`) |
| `${line1}` / `${line2}` | first / last line of the range, the cursor line without one |

With a range the lines are selected while the steps run (so commands that work
on the selection get them), then the caret goes to the range's first line.

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
  "when": "config.devhub.vim.enabled && editorTextFocus && devhubVim.active && devhubVim.acceptsMotion" }
```

`keyboard.dispatch: keyCode` makes VS Code ignore scan codes; keep the default
(`code`).

An IME that is on composes as usual in every mode; its keystrokes run no
keybinding. What it commits outside insert mode is used only as a character
argument (`f`, `t`, `r`, `"`, …) or `:`/`/` prompt text, and is dropped
otherwise.

## Known gaps

* Not implemented: `U` (undo line), `!` / `=` with 'equalprg' (filter
  through a program), `g@` ('operatorfunc'), `gR` (virtual replace),
  `CTRL-V {char}` / `CTRL-K` (literal / digraph input), `gm` `g0` `g$` `g^`
  (screen-line column motions), `[m ]m`, `[* ]*` `[/ ]/`, `zh zl zs ze`
  (horizontal scrolling), `zn zN zi zx`, the command-line window (`q:`), `:let`
  and other Vimscript, `:r[ead]`, `:w {file}`, `:!`, `:make`, the location list
  / tags / argument list, `CTRL-W x r T`, `'scrolloff'` (VS Code's
  `editor.cursorSurroundingLines` applies).
* Patterns are matched one line at a time: `\n` and `\_x` in a pattern never
  match across lines; `\%V`, `\%23l`, `\@<=` and friends are not supported (an
  error says so). Screen columns count a tab as 'tabstop' cells and every
  other character as one (wide CJK characters are one column in blocks).
* Uppercase marks (`mA`) are kept per editor, not across files; the jump list
  is per editor and continues in VS Code's navigation history at its ends.
* Macros and `.` record `devhubVim.*` commands (and `devhubVim.run`),
  captured characters, typed insert text and ex lines; plain VS Code commands
  bound to keys are not recorded. `"ap` after `qa…q` does not paste the macro
  as keys (macros are commands); a register *yanked* as text runs as keys.
  Insert-mode text is recorded as the text between where the insert started
  and where it ended (with backspacing over the start); moving the caret with
  the mouse in between confuses it.
* Ex commands and keys that run VS Code commands (`gc`, `=`, `gq` with a
  formatter, folds, LSP keys) are asynchronous; in a macro the steps after
  them do not wait for them, and `:g` runs only Vim's own commands
  synchronously.
* `gq` uses VS Code's formatter for the whole lines (as Neovim's LSP
  'formatexpr'), so it reformats code rather than wrapping text when the
  language has a range formatter; `gw` always wraps.
* `gd` is Vim's "go to local declaration" (a search), not the language
  server's definition: that is `CTRL-]` (or bind `gd` yourself, see above).
