// Port of apps/desktop/src/model/projectStatus.ts.
//
// An Issue's place on GitHub Projects (v2) boards: the lane (the "Status"
// single-select) it sits in, per board. Pure, and shared by the reader (which
// parses the GraphQL answer) and the Sidebar (which draws the letter and the
// tooltip), so the two cannot disagree.

import Foundation

/// One board the Issue is on, and the lane it is in there.
public struct ProjectLane: Hashable, Sendable, Codable {
    public var project: String
    /// The Status option's name; absent when the item has no Status set.
    public var status: String?
    /// GitHub's colour name for the option (`GREEN`, `YELLOW`, ...).
    public var color: String?

    public init(project: String, status: String? = nil, color: String? = nil) {
        self.project = project
        self.status = status
        self.color = color
    }
}

public enum ProjectStatus {
    /// What `projectItems` is asked for, spliced into a query by the reader.
    public static let projectItemsSelection = """
    projectItems(first:10){ nodes{
          project{ title }
          fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name color } }
        } }
    """

    /// Boards from an answer (`projectItems`); items GitHub could not describe
    /// are dropped.
    public static func parseLanes(_ items: JsonValue?) -> [ProjectLane] {
        var lanes: [ProjectLane] = []
        for node in items?["nodes"]?.arrayValue ?? [] {
            guard let project = node["project"]?["title"]?.stringValue.map(JSString.trim), !project.isEmpty else { continue }
            let status = node["fieldValueByName"]?["name"]?.stringValue.map(JSString.trim)
            let color = node["fieldValueByName"]?["color"]?.stringValue.map(JSString.trim)
            let named = status.flatMap { $0.isEmpty ? nil : $0 }
            let coloured = named == nil ? nil : color.flatMap { $0.isEmpty ? nil : $0.uppercased() }
            lanes.append(ProjectLane(project: project, status: named, color: coloured))
        }
        return lanes
    }

    private static let separators = TextPattern("[\\s\\p{P}\\p{S}]+")
    private static let wordy = TextPattern("[\\p{L}\\p{N}]")

    /// The first letter of the status's last word, upper-cased: "In Progress"
    /// is P. Words split on whitespace, punctuation and symbols (so emoji are
    /// skipped). A Japanese name has no spaces, so it is its first character.
    public static func statusLetter(_ status: String?) -> String? {
        guard let status, !status.isEmpty else { return nil }
        let words = separators.split(status).filter { wordy.matches($0) }
        guard let last = words.last else { return nil }
        guard let first = last.first(where: { wordy.matches(String($0)) }) else { return nil }
        return String(first).uppercased()
    }

    /// The board the badge speaks for: one named like the repository, else the
    /// first with a status.
    public static func primaryLane(_ lanes: [ProjectLane]?, repository: String? = nil) -> ProjectLane? {
        guard let lanes, !lanes.isEmpty else { return nil }
        let withStatus = lanes.filter { statusLetter($0.status) != nil }
        if let repository, let named = withStatus.first(where: { $0.project.lowercased() == repository.lowercased() }) {
            return named
        }
        return withStatus.first
    }

    /// "Projects: DevHub Roadmap — In Review; Triage".
    public static func tooltip(_ lanes: [ProjectLane]) -> String {
        "Projects: " + lanes.map { lane in lane.status.map { "\(lane.project) — \($0)" } ?? lane.project }.joined(separator: "; ")
    }

    /// Shown in the tooltip when the token cannot read Projects.
    public static let scopeHint = "Project status unavailable: run `gh auth refresh -s read:project`"

    /// GitHub colour name to a theme token (the CSS variable name the TS uses;
    /// WP8's `DevHubTheme` names the same tokens).
    private static let colorTokens: [String: String] = [
        "GREEN": "--status-idle",
        "BLUE": "--status-waiting",
        "YELLOW": "--status-working",
        "ORANGE": "--status-working",
        "RED": "--danger",
        "PINK": "--danger",
        "PURPLE": "--status-done",
    ]

    /// Token for a GitHub colour name; `nil` (muted) when unknown or GRAY.
    public static func laneColorToken(_ color: String?) -> String? {
        guard let color else { return nil }
        return colorTokens[color.uppercased()]
    }
}
