// Port of apps/desktop/src/main/agent/conversation/toolTitle.ts
//
// A tool call's title, `Tool: what it does`, for either CLI: the tool's name,
// and the one argument that says what this call does.
//
// A well-known tool has its argument named here. An MCP tool
// (`mcp__server__tool`) is named by its server and tool. Any other tool, and
// an MCP tool, is titled by its most telling argument — the first of
// `TELLING` it has, else its first argument in words — so a transcript of
// calls to tools DevHub has never heard of still reads as what they did, not
// as a wall of their names.

import Foundation

private func field(_ key: String) -> @Sendable (JsonObject) -> String? {
    { input in firstLineText(input[key]) }
}

/// Each well-known tool's title, from its input; nil when the input lacks the word.
private let TITLES: [String: @Sendable (JsonObject) -> String?] = [
    "Bash": field("command"),
    "Read": field("file_path"),
    "Edit": field("file_path"),
    "MultiEdit": field("file_path"),
    "Write": field("file_path"),
    "NotebookEdit": field("notebook_path"),
    "Glob": field("pattern"),
    "Grep": field("pattern"),
    "WebFetch": field("url"),
    "WebSearch": field("query"),
    "Task": field("description"),
    "Agent": field("description"),
    "Skill": field("skill"),
    "SendMessage": { input in
        guard let to = firstLineText(input["to"]) ?? firstLineText(input["recipient"]) else { return nil }
        guard let summary = firstLineText(input["summary"]) else { return to }
        return "\(to) — \(summary)"
    },
    "Monitor": { input in firstLineText(input["description"]) ?? firstLineText(input["command"]) },
    "TaskStop": { input in firstLineText(input["task_id"]) ?? firstLineText(input["shell_id"]) },
    "TaskOutput": field("task_id"),
    "TaskGet": field("taskId"),
    "TaskCreate": { input in firstLineText(input["subject"]) ?? firstLineText(input["description"]) },
    "TaskUpdate": { input in
        guard let id = firstLineText(input["taskId"]) else { return nil }
        guard let status = firstLineText(input["status"]) else { return id }
        return "\(id) → \(status)"
    },
    "ToolSearch": field("query"),
    "AskUserQuestion": { input in
        guard case .array(let questions)? = input["questions"], case .object(let first)? = questions.first else {
            return nil
        }
        return firstLineText(first["question"])
    },
    // Tools whose title is their name: they take nothing that says more.
    "ListAgents": { _ in nil },
    "ExitPlanMode": { _ in nil },
    "TodoWrite": { input in
        guard let plan = todoPlan(input) else { return nil }
        return "\(plan.filter { $0.status == .completed }.count) of \(plan.count) done"
    },
]

/// The arguments that most often say what a call does, most telling first.
private let TELLING = [
    "description", "command", "file_path", "path", "url", "query", "action", "name", "subject", "pattern", "prompt",
    "text",
]

public func toolTitle(_ name: String, _ input: JsonObject) -> String {
    var shown = name
    var isMcp = false
    if name.hasPrefix("mcp__") {
        // /^mcp__(.+?)__(.+)$/: the server is the shortest run up to the next `__`
        // that leaves a tool name behind it.
        let rest = name.dropFirst(5)
        if let separator = rest.dropFirst().range(of: "__"), separator.upperBound < rest.endIndex {
            let server = rest[rest.startIndex..<separator.lowerBound]
            let tool = rest[separator.upperBound...]
            shown = "\(server) · \(tool)"
            isMcp = true
        }
    }
    let what: String?
    if !isMcp, let known = TITLES[name] {
        what = known(input)
    } else {
        what = TELLING.lazy.compactMap { firstLineText(input[$0]) }.first
            ?? input.values.lazy.compactMap { firstLineText($0) }.first
    }
    guard let what else { return shown }
    return "\(shown): \(what)"
}

/// The plan a TodoWrite call sets: each todo's words — in its present form
/// while it is under way — and status. Nil for an input of another shape,
/// which is then drawn only as the input it is.
public func todoPlan(_ input: JsonObject) -> [PlanStep]? {
    guard case .array(let todos)? = input["todos"] else { return nil }
    var steps: [PlanStep] = []
    for each in todos {
        guard case .object(let todo) = each, case .string(let content)? = todo["content"],
              case .string(let statusText)? = todo["status"], let status = PlanStatus(rawValue: statusText)
        else { return nil }
        if status == .inProgress, case .string(let activeForm)? = todo["activeForm"] {
            steps.append(PlanStep(text: activeForm, status: status))
        } else {
            steps.append(PlanStep(text: content, status: status))
        }
    }
    return steps
}

/// A value's first line, when it is words.
private func firstLineText(_ value: JsonValue?) -> String? {
    guard case .string(let text)? = value else { return nil }
    let first = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
    let line = JSString.trim(first)
    return line.isEmpty ? nil : line
}
