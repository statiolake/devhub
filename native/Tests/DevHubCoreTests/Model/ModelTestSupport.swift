// Port of apps/desktop/src/model/testWorkspaces.ts and the small helpers the
// model tests share.

import Foundation
@testable import DevHubCore

/// Where the tests' Scratch lives. Not a real folder; nothing touches it.
let scratchPath = "/scratch-test/junk/20260923"

func newUuid() -> String { UUID().uuidString.lowercased() }

func localWorkspace(_ path: String, id: String = newUuid()) -> Workspace {
    Workspace(id: WorkspaceId(unchecked: id), location: .local(path: path), selectedPath: path)
}

func scratchWorkspace(_ path: String = scratchPath) -> Workspace { localWorkspace(path) }

/// A model whose only Workspace is its Scratch.
func scratchModel(_ path: String = scratchPath) -> AppModel { AppModel(scratch: scratchWorkspace(path)) }

/// The Sidebar's order for a model none of whose folders git has answered about.
let drawnWithoutGit: DrawnOrder = { snapshot in Projection.drawnWorkspaceOrder(snapshot, { _ in nil }) }

func drawn(_ model: AppModel) -> [WorkspaceId] { drawnWithoutGit(model.snapshot()) }

func coordinatorFor(_ model: AppModel) -> AppCoordinator { AppCoordinator(model: model, drawnOrder: drawnWithoutGit) }

func wid(_ raw: String) -> WorkspaceId { WorkspaceId(unchecked: raw) }
func aid(_ raw: String) -> AgentId { AgentId(unchecked: raw) }

/// `codeOf`: the domain code a throw carried, or nil.
func codeOf(_ body: () throws -> Void) -> DomainErrorCode? {
    do { try body() } catch let error as DomainError { return error.code } catch { return nil }
    return nil
}

func profile(
    _ id: String = "codex", _ name: String = "Codex", kind: AgentProfileKind = .codex, command: String? = nil,
    args: [String] = [], presentation: AgentPresentation = .tui
) -> AgentProfile {
    try! AgentProfile.create(id: id, displayName: name, kind: kind, command: command ?? kind.rawValue, args: args, presentation: presentation)
}
