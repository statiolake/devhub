/**
 * The entry point of one Editor frame.
 *
 * Everything the Workbench assumes about owning a document is true here, and
 * true only here. What leaves the frame is one message saying whether it came
 * up; the App Shell decides what to show for either answer.
 */
import { getService, IFileService } from "@codingame/monaco-vscode-api";
import * as monaco from "monaco-editor";
import { UserFacingFailure } from "../app/failure";
import type { WorkbenchFrameMessage } from "./frameProtocol";
import { trace } from "./trace";
import { raiseWorkbench } from "./workbench";

const report = (message: WorkbenchFrameMessage) => {
  window.parent.postMessage(message, window.location.origin);
};

/**
 * The translations for one display language.
 *
 * Language packs ship with the app rather than being fetched, so a chosen
 * language works with no network — and the import has to happen before the
 * Workbench is raised, because it reads its strings while coming up.
 */
const languagePacks: Record<string, () => Promise<unknown>> = {
  cs: () => import("@codingame/monaco-vscode-language-pack-cs"),
  de: () => import("@codingame/monaco-vscode-language-pack-de"),
  es: () => import("@codingame/monaco-vscode-language-pack-es"),
  fr: () => import("@codingame/monaco-vscode-language-pack-fr"),
  it: () => import("@codingame/monaco-vscode-language-pack-it"),
  ja: () => import("@codingame/monaco-vscode-language-pack-ja"),
  ko: () => import("@codingame/monaco-vscode-language-pack-ko"),
  pl: () => import("@codingame/monaco-vscode-language-pack-pl"),
  "pt-br": () => import("@codingame/monaco-vscode-language-pack-pt-br"),
  "qps-ploc": () => import("@codingame/monaco-vscode-language-pack-qps-ploc"),
  ru: () => import("@codingame/monaco-vscode-language-pack-ru"),
  tr: () => import("@codingame/monaco-vscode-language-pack-tr"),
  "zh-hans": () => import("@codingame/monaco-vscode-language-pack-zh-hans"),
  "zh-hant": () => import("@codingame/monaco-vscode-language-pack-zh-hant"),
};

const container = document.getElementById("workbench");
const parameters = new URLSearchParams(window.location.search);
const authority = parameters.get("authority");
const connectionToken = parameters.get("connectionToken");
const folder = parameters.get("folder") ?? undefined;
const locale = parameters.get("locale");

if (!container || !authority || !connectionToken) {
  // The frame is addressed by the shell, so this is a broken build rather
  // than anything a user did.
  report({
    kind: "workbench-failed",
    summary: "The editor could not start.",
    detail: "The editor frame was opened without a server to connect to.",
  });
} else {
  if (locale != null && locale !== "en") {
    const pack = languagePacks[locale];
    if (pack) {
      await pack();
    } else {
      // The shell offered a language this build has no strings for. English
      // is what it will show; saying so is better than looking translated
      // and not being.
      trace("frame: no language pack", locale);
    }
  }
  raiseWorkbench(container, {
    remote: { authority, connectionToken, commit: "" },
    folder,
  }).then(
    () => {
      // A source build gets one way to ask the Workbench what it can see.
      // "The tree is empty" and "the filesystem is unreachable" look identical
      // from outside, and only one of them is a bug in the shell.
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__devhubWorkbench = {
          async read(path: string) {
            const files = await getService(IFileService);
            const uri = monaco.Uri.from({
              scheme: "vscode-remote",
              authority,
              path,
            });
            const stat = await files.resolve(uri);
            return (stat.children ?? []).map((child) => child.name);
          },
        };
      }
      report({ kind: "workbench-ready" });
    },
    (error: unknown) => {
      report({
        kind: "workbench-failed",
        summary:
          error instanceof UserFacingFailure
            ? error.message
            : "The editor could not start.",
        detail:
          error instanceof UserFacingFailure
            ? error.detail
            : error instanceof Error
              ? error.message
              : undefined,
      });
    },
  );
}
