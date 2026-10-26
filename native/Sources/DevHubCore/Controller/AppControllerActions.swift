// Port of the agent-action half of apps/desktop/src/main/shell/appController.ts
// (`runAgentAction`, `runAutomaticActions`, `sayToAgent`, `queueIssuePrompt`,
// and the injection review sheet's answers): what DevHub says to an Agent
// that is already running, and the one path every template goes through.

import Foundation

extension AppController {
    /// `runAgentAction`: say one of the configured actions to a running
    /// Agent — a Smart Button, the actions sheet, or an automatic action.
    /// Every way this can fail is a refusal with words.
    @discardableResult
    public func runAgentAction(agentId: String, actionId: String) throws -> IntentOutcome {
        guard let agent = coordinator.model.workspaces.flatMap(\.agents).first(where: { $0.id.rawValue == agentId }) else {
            throw CodedFailure.workspace("That agent is not running.")
        }
        guard let action = config?.agentActions.first(where: { $0.id == actionId && $0.enabled }) else {
            throw CodedFailure.workspace("There is no agent action called `\(actionId)` in the configuration.")
        }
        // Sent by hand, it answers whatever its trigger stands for now, so an
        // automatic action does not send it a second time.
        automaticActions.answered(agentId: agent.id.rawValue, trigger: action.trigger)
        // The values come from the same projection the Smart Buttons were drawn
        // from, so the message names what the person was looking at.
        try sayToAgent(agent.id, kind: agent.profile.kind, action: action,
                       values: SmartButtons.values(repositoryFacts.status(agent.workspaceId.rawValue)))
        return .updated(coordinator.snapshot())
    }

    /// `runAutomaticActions`: send whatever automatic actions are due, the
    /// way a Smart Button sends. One that cannot be sent says why, app-wide.
    func runAutomaticActions() {
        guard let config else { return }
        let actions = config.agentActions.filter(\.enabled).map { AutomaticActionChoice(id: $0.id, trigger: $0.trigger) }
        let agents = coordinator.model.workspaces.flatMap(\.agents).map { agent in
            AutomaticAgent(
                agentId: agent.id.rawValue, status: agent.status, queued: agent.injection.queued,
                automaticActions: agent.automaticActions, repository: repositoryFacts.status(agent.workspaceId.rawValue))
        }
        let firings = automaticActions.observe(agents, actions: actions)
        for firing in firings {
            log("[devhub] automatic action \(firing.actionId) for \(firing.agentId) (\(firing.trigger.rawValue))")
            do {
                try runAgentAction(agentId: firing.agentId, actionId: firing.actionId)
            } catch {
                publishError(errorWire(error))
            }
        }
    }

    /// `sayToAgent`: compose one action for one Agent and queue it. Whether
    /// it is looked at first is the action's `confirm_before_send`, and the
    /// sheet goes up now, over an Agent that may still be starting.
    func sayToAgent(_ agentId: AgentId, kind: AgentProfileKind, action: ConfiguredAgentAction, values: [String: String]) throws {
        let text = try AgentActions.render(
            id: action.id, displayName: action.displayName, template: action.template, values: values, kind: kind)
        let review = action.confirmBeforeSend
        guard let agents else { return }
        let injectionId = try agents.queueInjection(agentId, text: text, review: review)
        if !review { return }
        openModal(.injectionReview(agentId: agentId.rawValue, injectionId: injectionId, actionName: action.displayName, text: text))
    }

    /// `queueIssuePrompt`: tell the Agent just started for an Issue what it is
    /// for. The action chosen in the flow, and nothing else.
    func queueIssuePrompt(before: Set<AgentId>, issueUrl: String, number: Int, actionId: String?) {
        guard let started = newAgent(before), let actionId,
              let agent = coordinator.model.agent(started),
              let action = config?.agentActions.first(where: { $0.id == actionId && $0.enabled })
        else { return }
        do {
            try sayToAgent(started, kind: agent.profile.kind, action: action, values: ["ISSUE_URL": issueUrl, "ISSUE_NO": String(number)])
        } catch {
            // The Workspace is open and the Agent running, which is the whole of
            // what the flow was for: the person types the URL themselves.
            log("[devhub] the Issue prompt for \(started.rawValue) could not be composed: \(failureText(error))")
        }
    }

    /// The review sheet's Send, with the wording as the person left it.
    public func confirmInjection(agentId: String, injectionId: String, text: String) throws -> Bool {
        guard let agents else { throw ControlRefusal("DevHub's agents are not running yet.") }
        return try agents.confirmInjection(AgentId(unchecked: agentId), injectionId: injectionId, text: text)
    }

    /// The review sheet's Cancel.
    public func cancelInjection(agentId: String, injectionId: String) -> Bool {
        agents?.cancelInjection(AgentId(unchecked: agentId), injectionId: injectionId) ?? false
    }
}
