// Port of apps/desktop/src/model/automaticActions.ts
//
// Automatic actions: a Smart Button an Agent presses for itself.
//
// A Smart Button is offered while its trigger's condition holds and the Agent
// is idle (`SmartButtons.triggers`). A person may tick one of them as automatic
// for one Agent, and from then on the moment that button would appear is the
// moment its action is sent.
//
// **Which.** Only the triggers that stand for something happening to the work
// from outside, or for a step that follows every turn the same way.
//
// **Per Agent, for this run of DevHub, off by default.**
//
// **Once per event, not once per poll.** Each trigger's condition is read as a
// sequence of events — an *episode* begins each time it starts to hold, and
// for review comments a rise in the count of unresolved threads is a new event
// within one — and each event is acted on once. Ticking the box while the
// condition already holds counts as such an event. An event a person already
// answered by pressing the button is not sent.
//
// Nothing is sent to an Agent that is not idle or that already has something
// waiting for it: the event is kept, and sent once the Agent is free. One
// trigger at a time, in trigger order.

import Foundation

/// What `AutomaticActions.observe` reads about one Agent.
public struct AutomaticAgent: Sendable {
    public var agentId: String
    public var status: AgentStatus
    /// Instructions already waiting for it (`AgentInjection.queued`).
    public var queued: Int
    /// The ids of the actions ticked as automatic for it.
    public var automaticActions: [String]
    public var repository: WorkspaceRepositoryWire?

    public init(agentId: String, status: AgentStatus, queued: Int, automaticActions: [String], repository: WorkspaceRepositoryWire?) {
        self.agentId = agentId
        self.status = status
        self.queued = queued
        self.automaticActions = automaticActions
        self.repository = repository
    }
}

/// An action as far as firing it goes.
public struct AutomaticActionChoice: Hashable, Sendable {
    public var id: String
    public var trigger: AgentActionTrigger

    public init(id: String, trigger: AgentActionTrigger) {
        self.id = id
        self.trigger = trigger
    }
}

/// One action to send to one Agent, now.
public struct AutomaticFiring: Hashable, Sendable {
    public var agentId: String
    public var actionId: String
    public var trigger: AgentActionTrigger

    public init(agentId: String, actionId: String, trigger: AgentActionTrigger) {
        self.agentId = agentId
        self.actionId = actionId
        self.trigger = trigger
    }
}

public struct AutomaticActions: Sendable {
    /// The triggers an action may be automatic for.
    public static let triggers: [AgentActionTrigger] = [.commit, .push, .unresolvedReviewComments, .ciFailing]

    public static func isAutomatic(_ trigger: AgentActionTrigger) -> Bool { triggers.contains(trigger) }

    /// The triggers in the order the Settings and the box list them.
    public static func inOrder() -> [AgentActionTrigger] { AgentActionTrigger.ordered.filter(isAutomatic) }

    private struct TriggerState: Sendable {
        var holding = false
        var episode = 0
        /// The most unresolved review threads seen in this episode.
        var count = 0
        /// The pull request the condition is about, for the two that are.
        var pullRequest: Int?
        /// The event last sent or answered, by `eventKey`.
        var handled: String?
    }

    private var states: [String: [AgentActionTrigger: TriggerState]] = [:]
    private var stateOrder: [String] = []
    private var ticked: [String: Set<String>] = [:]

    public init() {}

    /// Read every Agent's repository again, and say what to send.
    public mutating func observe(_ agents: [AutomaticAgent], actions: [AutomaticActionChoice]) -> [AutomaticFiring] {
        var firings: [AutomaticFiring] = []
        let present = Set(agents.map(\.agentId))
        for id in stateOrder where !present.contains(id) {
            states[id] = nil
            ticked[id] = nil
        }
        stateOrder.removeAll { !present.contains($0) }
        for agent in agents {
            let keys = advance(agent)
            let nowTicked = Set(agent.automaticActions)
            let before = ticked[agent.agentId] ?? []
            ticked[agent.agentId] = nowTicked
            // A box ticked just now: the event standing at this moment, if any,
            // is news to it and is sent once, like any other.
            for actionId in agent.automaticActions where !before.contains(actionId) {
                guard let trigger = actions.first(where: { $0.id == actionId })?.trigger, Self.isAutomatic(trigger) else { continue }
                mutate(agent.agentId, trigger) { $0.handled = nil }
            }
            if agent.status != .idle || agent.queued > 0 { continue }
            for trigger in Self.triggers {
                let state = self.state(agent.agentId, trigger)
                guard let key = keys[trigger], key != state.handled else { continue }
                let chosen = actions.filter { $0.trigger == trigger && nowTicked.contains($0.id) }
                if chosen.isEmpty { continue }
                mutate(agent.agentId, trigger) { $0.handled = key }
                for action in chosen {
                    firings.append(AutomaticFiring(agentId: agent.agentId, actionId: action.id, trigger: trigger))
                }
                break
            }
        }
        return firings
    }

    /// A person sent this trigger's action themselves: the event standing now
    /// has been answered, and is not sent again on its own.
    public mutating func answered(agentId: String, trigger: AgentActionTrigger) {
        guard Self.isAutomatic(trigger) else { return }
        let state = self.state(agentId, trigger)
        if state.holding { mutate(agentId, trigger) { $0.handled = Self.eventKey(trigger, $0) } }
    }

    /// Each automatic trigger's current event for this Agent, if it holds.
    private mutating func advance(_ agent: AutomaticAgent) -> [AgentActionTrigger: String] {
        var keys: [AgentActionTrigger: String] = [:]
        // Nothing read about the repository yet, or not any more: no news
        // either way, so every condition stays where it was.
        guard let repository = agent.repository else {
            for trigger in Self.triggers {
                let state = self.state(agent.agentId, trigger)
                if state.holding { keys[trigger] = Self.eventKey(trigger, state) }
            }
            return keys
        }
        let holding = Set(SmartButtons.triggers(status: .idle, repository: repository))
        let pullRequest = repository.pullRequest?.number
        for trigger in Self.triggers {
            let about = trigger == .unresolvedReviewComments || trigger == .ciFailing ? pullRequest : nil
            var state = self.state(agent.agentId, trigger)
            // Another pull request is another event.
            if state.holding && state.pullRequest != about { state.holding = false }
            state.pullRequest = about
            if !holding.contains(trigger) {
                state.holding = false
                state.count = 0
                store(agent.agentId, trigger, state)
                continue
            }
            if !state.holding {
                state.holding = true
                state.episode += 1
                state.count = 0
            }
            if trigger == .unresolvedReviewComments {
                let conversations = repository.pullRequest?.conversations
                let count = (conversations?.unresolved ?? 0) + (conversations?.uncounted ?? 0)
                state.count = max(state.count, count)
            }
            store(agent.agentId, trigger, state)
            keys[trigger] = Self.eventKey(trigger, state)
        }
        return keys
    }

    private mutating func state(_ agentId: String, _ trigger: AgentActionTrigger) -> TriggerState {
        if states[agentId] == nil {
            states[agentId] = [:]
            stateOrder.append(agentId)
        }
        if let state = states[agentId]![trigger] { return state }
        let fresh = TriggerState()
        states[agentId]![trigger] = fresh
        return fresh
    }

    private mutating func store(_ agentId: String, _ trigger: AgentActionTrigger, _ state: TriggerState) {
        _ = self.state(agentId, trigger)
        states[agentId]![trigger] = state
    }

    private mutating func mutate(_ agentId: String, _ trigger: AgentActionTrigger, _ body: (inout TriggerState) -> Void) {
        var state = self.state(agentId, trigger)
        body(&state)
        store(agentId, trigger, state)
    }

    /// Which event a holding condition is: its episode, and for review
    /// comments how many threads were unresolved at most.
    private static func eventKey(_ trigger: AgentActionTrigger, _ state: TriggerState) -> String {
        trigger == .unresolvedReviewComments ? "\(state.episode):\(state.count)" : String(state.episode)
    }
}
