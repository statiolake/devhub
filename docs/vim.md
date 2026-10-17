# Vim keys are keybindings

DevHub's Vim (`"devhub.vim.enabled": true`) is built into the editor
(`patches/vscode/0008-devhub-vim.patch`, `src/vs/workbench/contrib/devhubVim`).
Every Vim key is an ordinary VS Code keybinding to a `devhubVim.*` command, so
you customise it exactly as any other shortcut: in `keybindings.json` or the
Keyboard Shortcuts editor (search for `devhubVim`). There is no separate
"Vim keymap" setting.

What makes it Vim rather than a pile of shortcuts is that the engine keeps the
grammar between commands — count, register, pending operator, pending text
object, a command waiting for a character, visual range, the last change and
macros — and publishes it as context keys for `when` clauses. Composition
happens in the engine: `d` only marks an operator as pending, and whatever
motion or text object command comes next completes it, whichever key ran it.
So if you rebind a motion, `d`, `c`, `y`, counts and visual mode work with the
new key at once, and `.` and macros keep working because they replay commands,
not keys.

## Context keys

| Key | Values |
| --- | --- |
| `devhubVim.active` | the focused text editor is driven by Vim (`devhubVim.attached` is the old name) |
| `devhubVim.mode` | `normal`, `insert`, `visual`, `visualLine`, `operatorPending`, `cmdline`, `nav` (after `Ctrl-W`), or `''` |
| `devhubVim.acceptsMotion` | a motion, operator, count or action may come next: normal, visual or operator-pending mode, and no key is being captured |
| `devhubVim.hasCount` | a count is being typed (so `0` is a digit, not "line start") |
| `devhubVim.pending` | a command is half built (count, register, operator, `i`/`a`, character argument) |
| `devhubVim.pendingOperator` | `delete`, `change`, `yank`, `indent`, `outdent`, or `''` |
| `devhubVim.textObjectPending` | `inner` or `around` after `i` / `a`, or `''` |
| `devhubVim.awaitingChar` | the next key is a character argument (`f t r " q @` …) |
| `devhubVim.recording` | a macro is being recorded |
| `devhubVim.usShiftedDigits` | Shift+1…0 type `!@#$%^&*()` on this layout (false on JIS); see [Keyboard layouts](#keyboard-layouts) |

The defaults use these `when` clauses (`common/vimKeymap.ts` `VIM_WHEN`); copy
them for your own bindings:

| Name | When |
| --- | --- |
| motion | `editorTextFocus && devhubVim.active && devhubVim.acceptsMotion` |
| normal | motion `&& devhubVim.mode == 'normal'` |
| normal or visual | motion `&& devhubVim.mode != 'operatorPending'` |
| visual | motion `&& (devhubVim.mode == 'visual' \|\| devhubVim.mode == 'visualLine')` |
| text object (after `i`/`a`) | `editorTextFocus && devhubVim.active && devhubVim.textObjectPending` |

## Commands

| Command | Args | Default keys |
| --- | --- | --- |
| `devhubVim.motion` | `{ "motion": name, "char"?: c }` | `h j k l w W b B e E ge gE gg G 0 ^ $ % ; , n N * # + - _ Enter Backspace Space Ctrl-D Ctrl-U`, arrows |
| `devhubVim.operator` | `{ "operator": "delete" \| "change" \| "yank" \| "indent" \| "outdent" }` | `d c y > <` (twice for lines) |
| `devhubVim.textObjectPrefix` | `{ "kind": "inner" \| "around" }` | `i a` after an operator / in visual mode |
| `devhubVim.textObject` | `{ "object": name, "kind"?: "inner" \| "around" }` | `w W " ' `` ` `` ( ) b { } B [ ] < >` after `i`/`a` |
| `devhubVim.count` | `{ "digit": 0-9 }` | `1`–`9`, `0` when `devhubVim.hasCount` |
| `devhubVim.register` | `{ "name": c }` | `"` (via `awaitChar`) |
| `devhubVim.awaitChar` | `{ "then": { "command": id, "args"?: {…} } }` | `f t F T r " q @` |
| `devhubVim.mode` | `{ "to": "normal" \| "insert" \| "visual" \| "visualLine", "at"?: … }` | `i a I A o O v V` |
| `devhubVim.action` | `{ "action": name, "char"?: c }` | `x X D C s S Y p P ~ J u U Ctrl-R . o R Tab q` |
| `devhubVim.cmdline` | `{ "kind": ":" \| "/" \| "?" }` | `: / ?` |
| `devhubVim.search` | `{ "pattern": p, "backwards"?: bool }` | (what `/` runs) |
| `devhubVim.ex` | `{ "command": "w" }` | (run an ex line from a binding) |
| `devhubVim.escape` | — | `Escape` |
| `devhubVim.nav.enter` / `.left` `.down` `.up` `.right` / `.escape` | — | `Ctrl-W` then `h j k l` |

Motions: `left right up down wordForward WORDForward wordBackward
WORDBackward wordEnd WORDEnd wordEndBackward WORDEndBackward lineStart
firstNonBlank lineEnd fileStart fileEnd nextLineStart previousLineStart
currentLineStart halfPageDown halfPageUp matchBracket repeatFind
repeatFindReverse searchNext searchPrevious searchWordForward
searchWordBackward findForward tillForward findBackward tillBackward` (the
last four need `char`).

Text objects: `word WORD doubleQuote singleQuote backtick paren brace bracket
angle` — with counts (`d2iw`, `2daw`, `d2i(`).

`at` for insert: `before after lineEnd firstNonBlank lineBelow lineAbove`.

Actions: `deleteChar deleteCharBefore deleteToLineEnd changeToLineEnd
substituteChar substituteLine yankLine put putBefore replaceChar toggleCase
joinLines undo redo repeat lowercase uppercase swapVisualEnds recordMacro
stopMacro playMacro noHighlight ignore`. In visual mode the same actions act
on the selection (`x` deletes it, `p` replaces it, `J` joins its lines, …).

## Customising keys

`keybindings.json`:

```jsonc
[
  // Colemak-style: move "down" to n, keep it composable (dn, 3n, vn all work)
  { "key": "n", "command": "devhubVim.motion", "args": { "motion": "down" },
    "when": "editorTextFocus && devhubVim.active && devhubVim.acceptsMotion" },
  { "key": "j", "command": "-devhubVim.motion" },

  // H / L to line start / end
  { "key": "shift+h", "command": "devhubVim.motion", "args": { "motion": "firstNonBlank" },
    "when": "editorTextFocus && devhubVim.active && devhubVim.acceptsMotion" },
  { "key": "shift+l", "command": "devhubVim.motion", "args": { "motion": "lineEnd" },
    "when": "editorTextFocus && devhubVim.active && devhubVim.acceptsMotion" },

  // Any VS Code command in normal mode (it does not take a count or an operator)
  { "key": "g d", "command": "editor.action.revealDefinition",
    "when": "editorTextFocus && devhubVim.active && devhubVim.mode == 'normal'" },
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

  // Run an ex command from a key
  { "key": "ctrl+s", "command": "devhubVim.ex", "args": { "command": "w" },
    "when": "editorTextFocus && devhubVim.active && devhubVim.mode == 'normal'" }
]
```

Notes:

* `-devhubVim.motion` with a `key` removes only the default on that key; many
  defaults share the command and differ in `args`.
* Multi-key sequences are ordinary VS Code chords (`"g g"`, `"g e"`). A chord
  has no timeout; in normal mode that is what Vim does too.
* A binding to a plain VS Code command runs it as is: it does not take the
  pending count, operator or register, and it is not part of `.` or a macro.
* `devhubVim.awaitChar` runs `then.command` with `then.args` plus `"char"`;
  the character is the next key typed, or the first character an IME commits.
  Any command can be the target, not just `devhubVim.*` ones.
* A key that no binding takes in a non-insert mode types nothing (the editor
  is modal), and if a command was half built it cancels it, as in Vim.

## Ex commands

Built in: `:w :wa :q :q! :qa :wq :x :sp :vs :bn :bp :noh :nohlsearch`, `:{n}`
and `:$` (go to line). `Tab` in the `:` prompt completes command names (again
for the next match).

Your own commands go in `settings.json`; they can run any command with any
args, like a keybinding. Names must start with an uppercase letter (as Vim's
`:command`); a lowercase name is accepted only to override a built-in one.

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

Syntax: `:[range]Name[!] [args]`. Ranges: `N`, `.`, `$`, `'<`, `'>` (the last
visual selection; `:` in visual mode prefills `'<,'>`), `%`, offsets
(`.+2`), and `a,b`.

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

## Keyboard layouts

Default keys are written in VS Code's US notation. On macOS VS Code dispatches
by physical key (`keyboard.dispatch: code`, the default) but resolves letters
and the punctuation keys **by the character they produce**: `shift+;` means
"the key that types `:`", which on a JIS keyboard is the unshifted `:` key;
`shift+[` is `{`, `shift+'` is `"`, ``shift+` `` is `~`, and so on. Those work on
every layout as Vim expects.

The shifted digits are different: VS Code treats `shift+6` as Shift + the 6
key, whatever it types. On a US-like layout that is `^`; on JIS it is `&`
(and Shift-2 is `"`, Shift-8 is `(`). JIS `^`, `@` and `*` sit on keys VS
Code's notation cannot name other than by scan code (`[Equal]`,
`[BracketLeft]`, `shift+[Quote]`). So:

* The defaults on `shift+0`…`shift+9` (`^ $ % # * @ ( )`) carry
  `&& devhubVim.usShiftedDigits`, which is false when the layout's Shift+digit
  row is not `!@#$%^&*()`.
* On such a layout the editor dispatches those characters **by character**:
  a key that types `^ * @ ( ) $ % #` and that no keybinding takes runs the
  default entry for that character. So `^`, `*`, `@q`, `di(`, `$` work on JIS
  out of the box, and Shift-6 (`&`) is not `^`.
* To rebind one of those characters on JIS, bind the physical key by scan
  code, e.g. `{ "key": "[Equal]", "command": "devhubVim.motion", "args": {
  "motion": "firstNonBlank" }, "when": "…" }` — a binding on the key wins over
  the character fallback.
* `keyboard.dispatch: keyCode` uses the browser's key codes instead; the
  defaults are tested with the default (`code`).

An IME that is on composes as usual in every mode; its keystrokes run no
keybinding. What it commits outside insert mode is used only as a character
argument (`f`, `t`, `r`, `"`, …) or `:`/`/` prompt text, and is dropped
otherwise.

## Limitations

* `.` repeats normal-mode changes (operators, `x`, `p`, `r`, `~`, `J`,
  insert); visual-mode changes are not repeatable (as before).
* Macros and `.` record `devhubVim.*` commands, captured characters, typed
  insert text and ex lines; plain VS Code commands bound to keys are not
  recorded. Insert-mode text is recorded as typed between entering and
  leaving insert mode (moving the caret with the mouse in between confuses
  it).
* Ex commands that run VS Code commands are asynchronous; in a macro the steps
  after them do not wait for them.
* No `:s`, marks, `gu`/`gU`/`g~` in normal mode, paragraph/sentence text objects,
  or block-visual mode.
