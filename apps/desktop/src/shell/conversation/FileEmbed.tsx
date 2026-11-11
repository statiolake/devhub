/**
 * A file an answer embeds instead of repeating it: a Markdown image whose
 * target is a file on the Agent's machine, `![sales](out/sales.png)`, alone
 * in its paragraph.
 *
 * The file is found as a link's is — relative to the Agent's directory (or,
 * inside an embedded Markdown file, to that file's folder), absolute, or
 * `~/…` (`resolvePaths`) — and its bytes are read from that machine by main
 * (`readEmbedFile`, `main/agent/conversation/embedFiles.ts`). It is then drawn
 * as the kind its name and contents say (`previewKindOfFile`): a picture, an
 * SVG, a Markdown document or a Marp deck, a Mermaid diagram, a diff, a page,
 * a chart — through the same `FencePreview` a fence of that kind is, with the
 * file's path in the header as a button that opens it in the editor.
 *
 * While the embed is on screen it asks main every two seconds whether the file
 * has changed (`embedSignature`: its size, time and checksum) and, when it
 * has, reads it again and draws it in place — so an Agent that edits a chart
 * file again and again is seen editing it. A file that is not there, or that
 * may not be embedded, is one quiet line naming it.
 */

import {
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { EmbedFileWire } from "../../ipc/conversation";
import { useAgentCwd, useConversationActions } from "./ConversationContext";
import {
  EmbedBaseContext,
  EmbedSourceContext,
  type EmbedSource,
} from "./embedContext";
import { imageUrl } from "./EntryParts";
import { FencePreview } from "./Preview";
import { Lightbox, LightboxPicture, opensLightbox } from "./Lightbox";
import { Picture } from "./Picture";
import {
  extensionOf,
  previewKindOfFile,
  previewKindsOfPath,
  type PreviewKind,
} from "./previewKinds";

/** How often an embed on screen asks whether its file has changed. */
export const EMBED_POLL_MS = 2000;

/** The fence word a file of each kind would be written under, for its source's colours. */
const LANGUAGE: Record<PreviewKind["id"], string> = {
  svg: "svg",
  mermaid: "mermaid",
  markdown: "markdown",
  marp: "markdown",
  diff: "diff",
  html: "html",
  "vega-lite": "json",
  image: "image",
};

type State =
  | { readonly kind: "reading" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly error: string }
  | {
      readonly kind: "file";
      readonly absolute: string;
      readonly file: EmbedFileWire;
    };

export function base64Of(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(text);
}

/** Whether `src` names a file rather than a page: no scheme, not `//host`. */
export function isLocalSource(src: string | undefined): src is string {
  return (
    src !== undefined &&
    src.trim() !== "" &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(src.trim()) &&
    !src.trim().startsWith("//") &&
    !src.trim().startsWith("#")
  );
}

/** Whether a file of this name can be embedded at all. */
export function isEmbeddable(path: string): boolean {
  return previewKindsOfPath(path).length > 0;
}

function Note({ children }: { readonly children: ReactNode }) {
  return (
    <p className="conversation-embed-note" role="note">
      {children}
    </p>
  );
}

/** The header a file being read has: its name, which opens nothing yet. */
function readingSource(path: string): EmbedSource {
  return { shown: path, absolute: path, open: () => undefined };
}

/** Whether `element` is on screen, and the page shown. */
function useOnScreen(element: RefObject<HTMLElement | null>): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const target = element.current;
    if (target === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) =>
      setShown(entry?.isIntersecting === true),
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return shown;
}

export const FileEmbed = memo(function FileEmbed({
  path,
  alt,
  depth,
  renderMarkdown,
}: {
  readonly path: string;
  readonly alt: string;
  readonly depth: number;
  readonly renderMarkdown: (source: string) => ReactNode;
}) {
  const {
    resolvePaths,
    readEmbedFile,
    embedSignature,
    openFile,
    reportFailure,
  } = useConversationActions();
  const agentCwd = useAgentCwd();
  const base = useContext(EmbedBaseContext);
  const cwd = base ?? agentCwd;
  const [state, setState] = useState<State>({ kind: "reading" });
  const box = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(box);
  const embeddable = isEmbeddable(path);

  useEffect(() => {
    if (!embeddable) return;
    let current = true;
    void (async () => {
      const [absolute] = await resolvePaths(cwd, [path]);
      if (typeof absolute !== "string") {
        if (current) setState({ kind: "missing" });
        return;
      }
      const file = await readEmbedFile(absolute);
      if (!current) return;
      setState(
        file === null ? { kind: "missing" } : { kind: "file", absolute, file },
      );
    })().catch((error: unknown) => {
      if (current)
        setState({
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
    });
    return () => {
      current = false;
    };
  }, [embeddable, cwd, path, resolvePaths, readEmbedFile]);

  // While it is on screen and the page is shown, look for a change.
  const watched = state.kind === "file" ? state : undefined;
  useEffect(() => {
    if (watched === undefined || !onScreen) return;
    let current = true;
    let busy = false;
    const timer = window.setInterval(() => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      void (async () => {
        const signature = await embedSignature(watched.absolute);
        if (!current || signature === watched.file.signature) return;
        if (signature === null) {
          setState({ kind: "missing" });
          return;
        }
        const file = await readEmbedFile(watched.absolute);
        if (!current) return;
        setState(
          file === null
            ? { kind: "missing" }
            : { kind: "file", absolute: watched.absolute, file },
        );
      })()
        .catch(() => {
          // A look that failed (the machine away for a moment) is tried again.
        })
        .finally(() => {
          busy = false;
        });
    }, EMBED_POLL_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [watched, onScreen, embedSignature, readEmbedFile]);

  const drawn = useMemo(() => {
    if (state.kind !== "file") return undefined;
    const { file, absolute } = state;
    const [binary] = previewKindsOfPath(absolute).filter(
      (k) => k.binary === true,
    );
    if (binary !== undefined) {
      const url = imageUrl({
        mediaType: file.mediaType.startsWith("image/")
          ? file.mediaType
          : `image/${extensionOf(absolute).slice(1).replace("jpg", "jpeg")}`,
        source: { kind: "data", base64: base64Of(file.bytes) },
        label: alt,
      });
      return url === undefined ? undefined : { kind: binary, code: url };
    }
    const text = new TextDecoder("utf-8").decode(file.bytes);
    const kind = previewKindOfFile(absolute, text, depth);
    return kind === undefined ? undefined : { kind, code: text };
  }, [state, alt, depth]);

  const source: EmbedSource | undefined = useMemo(
    () =>
      state.kind === "file"
        ? {
            shown: path,
            absolute: state.absolute,
            open: () => {
              void openFile(state.absolute, undefined).catch(reportFailure);
            },
          }
        : undefined,
    [state, path, openFile, reportFailure],
  );

  let body: ReactNode;
  if (!embeddable) {
    body = (
      <Note>
        Not embedded: <code>{path}</code> is not a kind of file DevHub draws
        {extensionOf(path) === "" ? "" : ` (${extensionOf(path)})`}.
      </Note>
    );
  } else if (state.kind === "reading") {
    // A picture's figure is drawn while its file is read, its picture's box
    // already in place (`RasterPreview`), so its bytes arriving fill it
    // rather than push everything under it down.
    const [picture] = previewKindsOfPath(path).filter((k) => k.binary === true);
    body =
      picture === undefined ? (
        <div className="conversation-embed-reading" aria-busy="true" />
      ) : (
        <EmbedSourceContext.Provider value={readingSource(path)}>
          <FencePreview
            key={picture.id}
            kind={picture}
            code=""
            info={alt || path}
            depth={depth}
            renderMarkdown={renderMarkdown}
          />
        </EmbedSourceContext.Provider>
      );
  } else if (state.kind === "missing") {
    body = (
      <Note>
        Not embedded: there is no file <code>{path}</code>.
      </Note>
    );
  } else if (state.kind === "failed") {
    body = (
      <Note>
        Not embedded: <code>{path}</code> — {state.error}
      </Note>
    );
  } else if (drawn === undefined) {
    body = (
      <Note>
        Not embedded: <code>{path}</code> is not one DevHub can draw.
      </Note>
    );
  } else {
    const folder =
      state.absolute.slice(0, state.absolute.lastIndexOf("/")) || "/";
    body = (
      <EmbedSourceContext.Provider value={source}>
        <EmbedBaseContext.Provider value={folder}>
          <FencePreview
            // A file that changed kind (an .md that became a deck) starts again.
            key={drawn.kind.id}
            kind={drawn.kind}
            code={drawn.code}
            info={
              drawn.kind.binary === true ? alt || path : LANGUAGE[drawn.kind.id]
            }
            depth={depth}
            renderMarkdown={renderMarkdown}
          />
        </EmbedBaseContext.Provider>
      </EmbedSourceContext.Provider>
    );
  }
  return (
    <div className="conversation-embed" ref={box} data-path={path}>
      {body}
    </div>
  );
});

/** The pictures a line of text, or a table cell, draws in place. */
const INLINE_PICTURES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

/** Whether a local image inside a line (a table cell) is drawn in place. */
export function isInlinePicture(path: string): boolean {
  return extensionOf(path) in INLINE_PICTURES;
}

/**
 * A local picture inside a line of text or a table cell — a screenshot in a
 * comparison table — drawn in place from its bytes (read as an embed is:
 * `resolvePaths`, `readEmbedFile`), in a box at most the cell's width and a
 * modest height, there before the file is read, its aspect kept; a click
 * opens it large. What is not a picture,
 * or not there, is `fallback`: a link to the file, as before.
 */
export const InlineImage = memo(function InlineImage({
  path,
  alt,
  fallback,
}: {
  readonly path: string;
  readonly alt: string;
  readonly fallback: ReactNode;
}) {
  const { resolvePaths, readEmbedFile } = useConversationActions();
  const agentCwd = useAgentCwd();
  const base = useContext(EmbedBaseContext);
  const cwd = base ?? agentCwd;
  const picture = isInlinePicture(path);
  // undefined while reading; null when it is not drawn.
  const [url, setUrl] = useState<string | null | undefined>(
    picture ? undefined : null,
  );
  const [enlarged, setEnlarged] = useState(false);
  useEffect(() => {
    if (!picture) return;
    let current = true;
    void (async () => {
      const [absolute] = await resolvePaths(cwd, [path]);
      if (typeof absolute !== "string") return null;
      const file = await readEmbedFile(absolute);
      if (file === null) return null;
      const mediaType = file.mediaType.startsWith("image/")
        ? file.mediaType
        : INLINE_PICTURES[extensionOf(absolute)];
      return mediaType === undefined
        ? null
        : `data:${mediaType};base64,${base64Of(file.bytes)}`;
    })()
      .catch(() => null)
      .then((drawn) => {
        if (current) setUrl(drawn);
      });
    return () => {
      current = false;
    };
  }, [picture, cwd, path, resolvePaths, readEmbedFile]);
  if (url === null) return <>{fallback}</>;
  const label = alt || path;
  // Its box is there while the file is read, and the picture is drawn in
  // it: a box of a fixed shape the picture can only deepen (`Picture.tsx`).
  return (
    <>
      <Picture
        className="conversation-inline-image"
        src={url}
        alt={label}
        title={path}
        boxed
        onClick={(event) => {
          if (url !== undefined && opensLightbox(event)) setEnlarged(true);
        }}
      />
      {enlarged && url !== undefined ? (
        <Lightbox label={label} onClose={() => setEnlarged(false)}>
          <LightboxPicture src={url} alt={label} />
        </Lightbox>
      ) : null}
    </>
  );
});
