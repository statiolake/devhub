/**
 * Recognised skill and command names in the person's words, drawn as pills.
 *
 * The names are the Agent's own (`SessionFacts.commands`: Claude's
 * `slash_commands`/`skills`, Codex's skills), so a `/foo` the Agent does not
 * know stays plain. A `/` counts only as the message's first word, as both
 * CLIs read one; a `$` after any whitespace. The composer draws the same
 * tokens under its textarea (`SkillBackdrop`); the transcript draws them in
 * a sent message (`SkillText`).
 */

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import type { SlashCommand } from "../../model/conversation";

export interface TextSegment {
  readonly text: string;
  /** Whether this run is a recognised command or skill name. */
  readonly skill: boolean;
}

const TRAILING = /[.,;:!?)\]}"'`]+$/u;

/** `trigger + name` for every command, to look a typed word up. */
export function skillWords(
  commands: readonly SlashCommand[],
): ReadonlySet<string> {
  return new Set(
    commands.map((command) => `${command.trigger}${command.name}`),
  );
}

/**
 * `text` cut into plain and recognised runs that together read as `text`
 * exactly (so a mirror of a textarea lines up character for character).
 */
export function tokenizeSkills(
  text: string,
  words: ReadonlySet<string>,
): readonly TextSegment[] {
  if (words.size === 0 || text === "") return [{ text, skill: false }];
  const segments: TextSegment[] = [];
  let plain = 0;
  const flush = (end: number) => {
    if (end > plain)
      segments.push({ text: text.slice(plain, end), skill: false });
  };
  for (const match of text.matchAll(/(?<=^|\s)[/$]\S*/gu)) {
    const start = match.index;
    if (match[0][0] === "/" && start !== 0) continue;
    let word = match[0];
    if (!words.has(word)) {
      word = word.replace(TRAILING, "");
      if (!words.has(word)) continue;
    }
    flush(start);
    segments.push({ text: word, skill: true });
    plain = start + word.length;
  }
  flush(text.length);
  return segments;
}

const SkillWordsContext = createContext<ReadonlySet<string>>(new Set());

/** The Agent's commands, for the person's messages in this surface. */
export function SkillWordsProvider({
  commands,
  children,
}: {
  readonly commands: readonly SlashCommand[];
  readonly children: ReactNode;
}) {
  const words = useMemo(() => skillWords(commands), [commands]);
  return (
    <SkillWordsContext.Provider value={words}>
      {children}
    </SkillWordsContext.Provider>
  );
}

export function useSkillWords(): ReadonlySet<string> {
  return useContext(SkillWordsContext);
}

/** `text` with its recognised names as pills; the same characters as `text`. */
export function SkillText({ text }: { readonly text: string }) {
  const words = useSkillWords();
  const segments = useMemo(() => tokenizeSkills(text, words), [text, words]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.skill ? (
          <span key={index} className="conversation-skill">
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </>
  );
}

/**
 * The composer's mirror: the field's own words in the field's own metrics,
 * behind it, with only the recognised names tinted. It draws nothing when no
 * name is recognised, takes no pointer, and follows the field's scroll, so
 * the caret, selection, IME composition and autosizing stay the field's.
 */
export function SkillBackdrop({
  text,
  input,
}: {
  readonly text: string;
  readonly input: RefObject<HTMLTextAreaElement | null>;
}) {
  const words = useSkillWords();
  const segments = useMemo(() => tokenizeSkills(text, words), [text, words]);
  const backdrop = useRef<HTMLDivElement>(null);
  const shown = segments.some((segment) => segment.skill);
  useLayoutEffect(() => {
    const field = input.current;
    const mirror = backdrop.current;
    if (!field || !mirror) return;
    const follow = () => {
      mirror.scrollTop = field.scrollTop;
    };
    follow();
    field.addEventListener("scroll", follow);
    return () => field.removeEventListener("scroll", follow);
  }, [input, shown, text]);
  if (!shown) return null;
  return (
    <div
      ref={backdrop}
      className="conversation-composer-backdrop"
      aria-hidden="true"
    >
      {segments.map((segment, index) =>
        segment.skill ? (
          <mark key={index} className="conversation-skill">
            {segment.text}
          </mark>
        ) : (
          segment.text
        ),
      )}
      {"​"}
    </div>
  );
}
