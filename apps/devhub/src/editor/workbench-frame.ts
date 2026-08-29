/**
 * The entry point of one Editor frame.
 *
 * It does one thing before anything else: load the display language. VS Code
 * reads its strings while its modules are imported, so a language pack applied
 * afterwards only reaches whatever had not been loaded yet — which is why most
 * of the Workbench stayed English while parts of it turned Japanese. Nothing
 * here may import the Workbench, statically or otherwise, until the pack is in
 * place.
 */
import { trace } from "./trace";

/**
 * The translations for one display language.
 *
 * Language packs ship with the app rather than being fetched, so a chosen
 * language works with no network.
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

const locale = new URLSearchParams(window.location.search).get("locale");
if (locale != null && locale !== "en") {
  const pack = languagePacks[locale];
  if (pack) {
    await pack();
  } else {
    // The shell offered a language this build has no strings for. English is
    // what it will show; saying so is better than looking translated and not
    // being.
    trace("frame: no language pack", locale);
  }
}

// Only now: importing this brings in the Workbench, strings and all.
await import("./workbench-boot");
