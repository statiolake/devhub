/**
 * File paths in the conversation, drawn as links that open the file in the
 * editor.
 *
 * A word is a link when its spelling says it could be a path (`filePaths.ts`)
 * *and* main says it names a file on the Agent's machine — local, or the host
 * the Agent runs on. The second gate is what keeps "and/or" and "e.g." plain:
 * nothing is linked on a guess. Until main has answered, a candidate is drawn
 * as the text it is, so a link appears where one belongs and nothing else
 * moves.
 *
 * One `PathLinks` per conversation asks, batches and remembers. Every
 * candidate drawn in a tick is asked about in one request; a file, once
 * found, stays a link for as long as the conversation is on the page (a click
 * on one that has gone since is refused by main, and said). A word that named
 * nothing is asked about again once the Agent's turn has ended, because the
 * turn may be what made it (`forgetAbsent`).
 *
 * Where the gate applies: the Agent's prose and inline code once its block
 * has settled, a tool call's title and its output, and a diff's file header.
 * Not a fenced code block in an answer: that is code, and a word in it that
 * happens to be a file is not the Agent pointing at it.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useAgentCwd, useConversationActions } from "./ConversationContext";
import { pathSpans, rangeSuffix, type PathCandidate } from "./filePaths";

/** At most this many paths in one request: a long grep is several. */
const BATCH = 500;

type Resolve = (
  cwd: string | undefined,
  paths: readonly string[],
) => Promise<readonly (string | null)[]>;

export class PathLinks {
  /** A candidate's key → the file's absolute path, or `null` for none. */
  readonly #known = new Map<string, string | null>();
  /** Keys asked about or about to be, by the directory they are relative to. */
  readonly #queued = new Map<string | undefined, Map<string, string>>();
  readonly #asking = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #scheduled = false;

  constructor(
    private readonly resolve: Resolve,
    private readonly reportFailure: (error: unknown) => void,
  ) {}

  /** The file `path` names, `null` for none, `undefined` until main has said. */
  file(cwd: string | undefined, path: string): string | null | undefined {
    return this.#known.get(keyOf(cwd, path));
  }

  /** Ask about `path` in the next batch, unless it is known or being asked. */
  want(cwd: string | undefined, path: string): void {
    const key = keyOf(cwd, path);
    if (this.#known.has(key) || this.#asking.has(key)) return;
    const base = isRelative(path) ? cwd : undefined;
    if (isRelative(path) && cwd === undefined) {
      // Relative to a directory the session has not named yet: nothing to
      // ask about. The key changes when it names one.
      this.#known.set(key, null);
      return;
    }
    this.#asking.add(key);
    const queue = this.#queued.get(base) ?? new Map<string, string>();
    queue.set(key, path);
    this.#queued.set(base, queue);
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => this.#flush());
  }

  /** Forget every word that named nothing: the turn that ended may have made it. */
  forgetAbsent(): void {
    let forgot = false;
    for (const [key, file] of this.#known) {
      if (file !== null) continue;
      this.#known.delete(key);
      forgot = true;
    }
    if (forgot) this.#emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #flush(): void {
    this.#scheduled = false;
    const queued = [...this.#queued];
    this.#queued.clear();
    for (const [cwd, paths] of queued) {
      const entries = [...paths];
      for (let at = 0; at < entries.length; at += BATCH) {
        void this.#ask(cwd, entries.slice(at, at + BATCH));
      }
    }
  }

  async #ask(
    cwd: string | undefined,
    entries: readonly (readonly [string, string])[],
  ): Promise<void> {
    let files: readonly (string | null)[];
    try {
      files = await this.resolve(
        cwd,
        entries.map(([, path]) => path),
      );
      if (files.length !== entries.length) {
        throw new Error(
          `main answered ${files.length} of ${entries.length} paths the conversation asked about`,
        );
      }
    } catch (error: unknown) {
      // Said once, for the batch, and the words stay plain text until the
      // next turn ends: asking again at once would say it again.
      files = entries.map(() => null);
      this.reportFailure(error);
    }
    entries.forEach(([key], index) => {
      this.#asking.delete(key);
      this.#known.set(key, files[index] ?? null);
    });
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

function isRelative(path: string): boolean {
  return !path.startsWith("/") && !path.startsWith("~/");
}

function keyOf(cwd: string | undefined, path: string): string {
  return isRelative(path) ? `${cwd ?? ""}\n${path}` : path;
}

const PathLinksContext = createContext<PathLinks | undefined>(undefined);

export const PathLinksProvider = PathLinksContext.Provider;

function usePathLinks(): PathLinks {
  const links = useContext(PathLinksContext);
  if (!links) {
    throw new Error("a path was drawn outside a ConversationSurface");
  }
  return links;
}

/** The file a candidate names, once main has said; asks if it has not. */
function useFileOf(path: string): string | null | undefined {
  const links = usePathLinks();
  const cwd = useAgentCwd();
  const file = useSyncExternalStore(links.subscribe, () =>
    links.file(cwd, path),
  );
  useEffect(() => {
    if (file === undefined) links.want(cwd, path);
  }, [links, cwd, path, file]);
  return file;
}

/**
 * `children` as a link to a file, when `candidate` names one on the Agent's
 * machine; as themselves until then, or when it does not.
 */
export function PathLink({
  candidate,
  children,
}: {
  readonly candidate: PathCandidate;
  readonly children: ReactNode;
}) {
  const file = useFileOf(candidate.path);
  const { openFile, reportFailure } = useConversationActions();
  if (typeof file !== "string") return <>{children}</>;
  return (
    <a
      // `#` and not the file: a link DevHub does not handle itself would
      // leave through the system (`externalLinks.ts`), and the editor is
      // where this file opens.
      href="#"
      className="conversation-path-link"
      title={`Open ${file}${rangeSuffix(candidate.range)} in the editor`}
      onClick={(event) => {
        // In a tool call's row too: the link is followed, the row stays as
        // it was.
        event.preventDefault();
        event.stopPropagation();
        void openFile(file, candidate.range).catch(reportFailure);
      }}
    >
      {children}
    </a>
  );
}

/** Text with each path in it that names a file drawn as a link to it. */
export function PathText({ text }: { readonly text: string }) {
  const spans = useMemo(() => pathSpans(text), [text]);
  if (spans.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) parts.push(text.slice(at, span.start));
    parts.push(
      <PathLink key={span.start} candidate={span}>
        {text.slice(span.start, span.end)}
      </PathLink>,
    );
    at = span.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
