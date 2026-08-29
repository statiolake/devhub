/**
 * The Workbench's web workers.
 *
 * VS Code asks its host for a worker by label and has no fallback: without an
 * answer it logs and carries on degraded — syntax highlighting without a
 * tokenizer, an Output panel that retries link detection every second and
 * fails every time. So every label the registered services can ask for is
 * answered here, and a label nobody anticipated is an error rather than one
 * more quiet degradation.
 *
 * Imported for its side effect, and it has to run before the services are
 * initialised, because the first worker is asked for during startup.
 */

import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import LanguageDetectionWorker from "@codingame/monaco-vscode-language-detection-worker-service-override/worker?worker";
import NotebookEditorWorker from "@codingame/monaco-vscode-notebook-service-override/worker?worker";
import OutputLinkDetectionWorker from "@codingame/monaco-vscode-output-service-override/worker?worker";
import LocalFileSearchWorker from "@codingame/monaco-vscode-search-service-override/worker?worker";
import TextMateWorker from "@codingame/monaco-vscode-textmate-service-override/worker?worker";

/**
 * Every label, and the worker that answers it. The labels are the ones the
 * services spell out for themselves — `label: "TextMateWorker"` and its
 * siblings — so this list grows exactly when a service override is added.
 */
const workers: Record<string, new () => Worker> = {
  editorWorkerService: EditorWorker,
  LanguageDetectionWorker,
  LocalFileSearchWorker,
  NotebookEditorWorker,
  OutputLinkDetectionWorker,
  TextMateWorker,
};

window.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string): Worker {
    const worker = workers[label];
    if (!worker) {
      throw new Error(
        `The editor asked for a worker this build has none for: ${label}`,
      );
    }
    return new worker();
  },
};
