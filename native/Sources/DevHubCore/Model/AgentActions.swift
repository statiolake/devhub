// Port of apps/desktop/src/model/agentActions.ts (the parts the settings file
// and the action sheet need: triggers, the shipped actions and their wording,
// variables, template filling and skill notation).
//
// Not here yet, for WP2: `smartButtonTriggers` and `smartButtonValues`, which
// read the Sidebar's repository projection (`model/wire.ts`), and the
// `AgentActionEmpty` notice wiring (`errorWireAt("agent_action_empty")`).
//
// What DevHub says to an Agent on the person's behalf.
//
// Starting an Agent on an Issue is DevHub typing the first message: "read this
// Issue and implement it", with the URL. That sentence is a *setting*, because
// it is the person's own instructions to their own agent — how they want work
// started, which skill to invoke, what to call the branch — and no wording
// DevHub ships is right for everybody.
//
// **Actions are built in; their wording is configured.** DevHub decides that
// there is such a thing as "assigning an Issue" and when it happens; the config
// decides what gets said. Adding a Smart Button is adding a trigger, its rule
// in `smartButtonTriggers` and its entry in `builtInActions` — the config
// schema does not move, and a person's existing wording is untouched.
//
// Two things happen to a template before it is sent, and both are here so that
// they cannot be done differently in two places: the variables are filled in,
// and the skill notation is translated for whichever agent is being spoken to.

import Foundation

/// What makes DevHub say an action.
///
/// `issue` is also what an action DevHub has never heard of is treated as. A
/// person who works two ways — implement it, review it — writes a second
/// action and picks between them where the Issue flow asks; the Smart Buttons
/// have no picker, because a button *is* the choice.
public enum AgentActionTrigger: String, CaseIterable, Codable, Sendable, Hashable {
    case issue
    case commit
    case push
    case pullRequest = "pull_request"
    case draftPullRequest = "draft_pull_request"
    case unresolvedReviewComments = "unresolved_review_comments"
    case ciFailing = "ci_failing"
    case always

    /// Every trigger there is, in the order a person meets them.
    ///
    /// The list the config file's `[agent_actions.<trigger>]` keys are checked
    /// against, the order the Settings tree draws its groups in, and the order
    /// the Smart Buttons stand in. One list, so a trigger cannot be spellable in
    /// the file and invisible in the window.
    public static let ordered: [AgentActionTrigger] = [
        .issue, .commit, .push, .pullRequest, .draftPullRequest,
        .unresolvedReviewComments, .ciFailing, .always,
    ]

    /// Whether a trigger is a Smart Button's: every one but the Issue flow.
    public var isSmartButton: Bool { self != .issue }

    /// What each trigger is, in one line, for the group headings in Settings.
    public var displayName: String {
        switch self {
        case .issue: return "Assigning an Issue"
        case .commit: return "Uncommitted changes"
        case .push: return "Commits to push"
        case .pullRequest: return "A branch with no pull request"
        case .draftPullRequest: return "A draft pull request"
        case .unresolvedReviewComments: return "Unresolved review comments"
        case .ciFailing: return "Failing CI"
        case .always: return "Always"
        }
    }

    /// The names a template may use, without the braces, per trigger.
    ///
    /// A property of the trigger and not of the wording: the Issue flow knows a
    /// URL and a number, and a Smart Button fired from a Workspace knows the
    /// branch it is standing on and the pull request out from it. Committing is
    /// offered nothing, and that is not an oversight: it happens entirely
    /// inside the working tree.
    public var variables: [String] {
        switch self {
        case .issue: return ["ISSUE_URL", "ISSUE_NO"]
        case .commit: return []
        case .push: return ["BRANCH"]
        case .pullRequest: return ["BRANCH"]
        case .draftPullRequest: return ["PR_URL", "PR_NO", "BRANCH"]
        case .unresolvedReviewComments: return ["PR_URL", "PR_NO", "UNRESOLVED", "BRANCH"]
        case .ciFailing: return ["PR_URL", "PR_NO", "BRANCH", "FAILING"]
        case .always: return []
        }
    }
}

/// One action DevHub ships.
public struct BuiltInAgentAction: Equatable, Sendable {
    public let id: String
    public let displayName: String
    public let template: String
    public let trigger: AgentActionTrigger
    public let confirmBeforeSend: Bool
}

public enum AgentActions {
    /// The action DevHub ships for the Issue flow, and the id it ships it under.
    public static let defaultActionId = "issue_assignment"
    public static let defaultActionName = "Work on the Issue"

    /// The Issue assignment prompt.
    ///
    /// It asks for the branch by name because the branch is the whole of the
    /// link between a workspace and its Issue: DevHub makes `feature/128-wip` so
    /// that work can start immediately, and the Agent is asked to rename it to
    /// something that says what it is.
    public static let issueAssignmentTemplate = """
        このIssueを読み、実装をしてください。
        {{ISSUE_URL}}
        ブランチ名は feature/{{ISSUE_NO}}-<short-name> としてデフォルトブランチから切ってください。
        feature/{{ISSUE_NO}}-wip となっている場合は、適切な名前に変えてください。

        """

    public static let defaultActionTemplate = issueAssignmentTemplate

    // The wording DevHub ships for the Smart Buttons. Short, and in the
    // language the Issue default is written in, because they say one thing
    // each and the person reading them is an agent already standing in the
    // repository.
    static let commitTemplate = """
        ここまでの変更をコミットしてください。
        関連する変更ごとに、意味のある単位に分けてください。

        """

    static let pushTemplate = """
        コミット済みの変更を {{BRANCH}} にプッシュしてください。

        """

    static let pullRequestTemplate = """
        {{BRANCH}} からプルリクエストを作成してください。
        まだプッシュしていない場合は、先にプッシュしてください。
        タイトルと説明は、このブランチでの変更内容から書いてください。

        """

    static let draftPullRequestTemplate = """
        ドラフトのプルリクエスト #{{PR_NO}} を仕上げてください。
        {{PR_URL}}
        {{BRANCH}} に残っている作業を終わらせてプッシュし、レビューできる状態になったら Ready for review にしてください。

        """

    static let unresolvedReviewCommentsTemplate = """
        プルリクエスト #{{PR_NO}} のレビューコメントに対応してください。
        {{PR_URL}}
        未解決のコメントが {{UNRESOLVED}} 件あります。対応した変更は {{BRANCH}} にコミットしてプッシュしてください。

        """

    static let okTemplate = "OK"

    static let ciFailingTemplate = """
        プルリクエスト #{{PR_NO}} の CI が失敗しています。原因を調べて直してください。
        {{PR_URL}}
        失敗しているチェックは {{FAILING}} 件です。修正は {{BRANCH}} にコミットしてプッシュしてください。

        """

    /// Every action DevHub ships, with what fires it and whether it is shown first.
    ///
    /// **Why `confirmBeforeSend` differs between them.** A Smart Button is the
    /// whole sentence: "Commit the changes" is what the button says and what it
    /// sends, and a review sheet in front of it asks a person to approve the
    /// text on the button they just pressed. The Issue action keeps its sheet,
    /// because its text is not on the button: it is a filled-in template about
    /// a specific Issue, and seeing what is about to be sent is the only place
    /// a wrong Issue can be caught before an Agent starts working on it.
    public static let builtIn: [BuiltInAgentAction] = [
        BuiltInAgentAction(id: defaultActionId, displayName: "Work on the Issue", template: issueAssignmentTemplate, trigger: .issue, confirmBeforeSend: true),
        BuiltInAgentAction(id: "commit_changes", displayName: "Commit the changes", template: commitTemplate, trigger: .commit, confirmBeforeSend: false),
        BuiltInAgentAction(id: "push_commits", displayName: "Push the commits", template: pushTemplate, trigger: .push, confirmBeforeSend: false),
        BuiltInAgentAction(id: "open_pull_request", displayName: "Open a pull request", template: pullRequestTemplate, trigger: .pullRequest, confirmBeforeSend: false),
        BuiltInAgentAction(id: "ready_draft_pull_request", displayName: "Get the draft PR ready", template: draftPullRequestTemplate, trigger: .draftPullRequest, confirmBeforeSend: false),
        BuiltInAgentAction(id: "address_review_comments", displayName: "Address review comments", template: unresolvedReviewCommentsTemplate, trigger: .unresolvedReviewComments, confirmBeforeSend: false),
        BuiltInAgentAction(id: "fix_ci", displayName: "Fix CI", template: ciFailingTemplate, trigger: .ciFailing, confirmBeforeSend: false),
        BuiltInAgentAction(id: "send_ok", displayName: "OK", template: okTemplate, trigger: .always, confirmBeforeSend: false),
    ]

    /// What fired an action DevHub shipped, by its id.
    ///
    /// Only for reading a configuration written before the trigger was spelled
    /// in the file, where the id was the only thing that said which action an
    /// entry was.
    public static func triggerOf(_ id: String) -> AgentActionTrigger {
        builtIn.first { $0.id == id }?.trigger ?? .issue
    }

    /// `{{NAME}}`, replaced.
    ///
    /// A name with no value is left as it was written rather than becoming an
    /// empty string: a prompt with a hole where the number should be is easier
    /// to see than one that quietly lost it.
    public static func fillVariables(_ template: String, values: [String: String]) -> String {
        let scalars = Array(template.unicodeScalars)
        var out = String.UnicodeScalarView()
        var index = 0
        func isNameScalar(_ s: Unicode.Scalar) -> Bool {
            ("A"..."Z").contains(s) || ("0"..."9").contains(s) || s == "_"
        }
        while index < scalars.count {
            if scalars[index] == "{", index + 1 < scalars.count, scalars[index + 1] == "{" {
                var end = index + 2
                while end < scalars.count, isNameScalar(scalars[end]) { end += 1 }
                if end > index + 2, end + 1 < scalars.count, scalars[end] == "}", scalars[end + 1] == "}" {
                    var name = String.UnicodeScalarView()
                    name.append(contentsOf: scalars[(index + 2)..<end])
                    let key = String(name)
                    if let value = values[key] {
                        out.append(contentsOf: value.unicodeScalars)
                    } else {
                        out.append(contentsOf: scalars[index...(end + 1)])
                    }
                    index = end + 2
                    continue
                }
            }
            out.append(scalars[index])
            index += 1
        }
        return String(out)
    }

    /// How each agent is asked to run a skill.
    ///
    /// A template is written once and may be sent to any of them, so the
    /// notation in it is DevHub's — a line beginning `$name` means "run the
    /// skill called name" — and this is where it becomes the notation that
    /// agent actually reads. Claude Code spells it `/name`; Codex spells it
    /// `$name`; every other agent gets the line exactly as it was written.
    ///
    /// Only at the start of a line. `$HOME` in the middle of a sentence is a
    /// variable somebody is talking about, and a price is not a skill.
    public static func applySkillNotation(_ text: String, kind: AgentProfileKind) -> String {
        guard kind == .claude else { return text }
        let scalars = Array(text.unicodeScalars)
        var out = String.UnicodeScalarView()
        func isLetter(_ s: Unicode.Scalar) -> Bool { ("A"..."Z").contains(s) || ("a"..."z").contains(s) }
        for (index, scalar) in scalars.enumerated() {
            // `^` in a multiline JS regex: the start, or after \n, \r, U+2028, U+2029.
            let atLineStart = index == 0 || ["\n", "\r", "\u{2028}", "\u{2029}"].contains(scalars[index - 1])
            if scalar == "$", atLineStart, index + 1 < scalars.count, isLetter(scalars[index + 1]) {
                out.append("/")
            } else {
                out.append(scalar)
            }
        }
        return String(out)
    }

    /// The whole of what is sent: the wording, filled in, in the agent's dialect.
    ///
    /// A wording that comes to nothing — a template somebody left empty in
    /// `settings.toml` — is refused here, naming the action, because there is
    /// nothing to send and the person pressed a button expecting something to be.
    public static func render(
        id: String,
        displayName: String,
        template: String,
        values: [String: String],
        kind: AgentProfileKind
    ) throws -> String {
        let text = applySkillNotation(fillVariables(template, values: values), kind: kind)
        if JSString.trim(text).isEmpty {
            throw AgentActionEmpty(
                reason: "The agent action “\(displayName)” (\(id)) has no wording: its template in settings.toml comes to nothing, so there is nothing to send."
            )
        }
        return text
    }
}

/// An agent action whose wording comes to nothing (`AgentActions.render`).
/// WP2 turns it into the `agent_action_empty` notice.
public struct AgentActionEmpty: Error, Equatable, CustomStringConvertible {
    public let reason: String
    public var description: String { reason }
}
