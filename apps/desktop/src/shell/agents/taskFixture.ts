import type { EscalationWire, TaskWire } from "../../ipc/contract";

/**
 * A task as the board carries it, for tests: 処理中, no links, no agents,
 * no questions, unless `overrides` say otherwise.
 */
export function taskWire(overrides: Partial<TaskWire> = {}): TaskWire {
  return {
    id: 1,
    title: "ログイン画面の 500 エラーを直す",
    status: "in_progress",
    links: [],
    agents: [],
    priority: "normal",
    createdAt: 0,
    updatedAt: 0,
    escalations: [],
    ...overrides,
  };
}

/** A question on task `taskId`, open unless `overrides` answer or withdraw it. */
export function questionWire(
  overrides: Partial<EscalationWire> = {},
): EscalationWire {
  return {
    id: 1,
    taskId: 1,
    title: "どちらの方法で直すか",
    state: "open",
    question: {
      markdown:
        "## 決めてほしいこと\nどちらで直すか\n\n## 人に聞く理由\n挙動が変わる",
      at: 0,
      options: ["案 A", "案 B"],
    },
    links: [],
    createdAt: 0,
    ...overrides,
  };
}

/** A task 回答待ち on one open question. */
export function askingTask(
  id: number,
  overrides: Partial<TaskWire> = {},
): TaskWire {
  return taskWire({
    id,
    status: "answer",
    escalations: [questionWire({ id, taskId: id })],
    ...overrides,
  });
}
