import { createRoot } from "react-dom/client";
import { ConversationActionsProvider } from "./conversation/ConversationContext";
import { Markdown } from "./conversation/Markdown";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./conversation/conversation.css";

declare global {
  interface Window {
    copied: unknown[];
    menu: unknown;
    choose?: string;
    saved: unknown[];
    FIXTURE?: string;
    files?: Record<string, string>;
  }
}
window.copied = [];
window.saved = [];
const actions = new Proxy({} as Record<string, unknown>, {
  get(_t, key: string) {
    switch (key) {
      case "writeClipboard":
        return (text: string) => {
          window.copied.push({ text });
          return Promise.resolve();
        };
      case "writeClipboardRich":
        return (c: unknown) => {
          window.copied.push(c);
          return Promise.resolve();
        };
      case "writeClipboardImage":
        return (png: Uint8Array) => {
          window.copied.push({
            png: [...png.slice(0, 4)],
            length: png.length,
            data: png,
          });
          return Promise.resolve();
        };
      case "showContextMenu":
        return (req: unknown) => {
          window.menu = req;
          const c = window.choose;
          window.choose = undefined;
          return Promise.resolve(c);
        };
      case "saveSlidesPdf":
        return (r: unknown) => {
          window.saved.push(r);
          return Promise.resolve("/tmp/x.pdf");
        };
      case "saveSlideImages":
        return (r: { images: Uint8Array[] }) => {
          window.saved.push({ count: r.images.length, first: r.images[0] });
          return Promise.resolve([]);
        };
      case "resolvePaths":
        return (_cwd: unknown, paths: string[]) =>
          Promise.resolve(
            paths.map((p) =>
              (window.files && p in window.files) || p.startsWith("/")
                ? p
                : null,
            ),
          );
      case "reportFailure":
        return (e: unknown) => console.error("failure", e);
      default:
        return () => Promise.resolve(undefined);
    }
  },
});
const source =
  window.FIXTURE ??
  (await (
    await fetch(
      `/fixture/${new URLSearchParams(location.search).get("case") ?? "previews"}.md`,
    )
  ).text());
createRoot(document.getElementById("root")!).render(
  <ConversationActionsProvider value={actions as never}>
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: 16,
        background: "var(--surface)",
        color: "var(--primary)",
      }}
      className="conversation-entry"
    >
      <Markdown source={source} streaming={false} />
    </div>
  </ConversationActionsProvider>,
);
