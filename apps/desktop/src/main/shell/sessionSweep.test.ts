import { describe, expect, it } from "vitest";
import { SessionSweeper, unaccountedSessions } from "./sessionSweep.js";
import type {
	SessionSweepWorld,
	SweepAccounting,
	SweepAdapter,
} from "./sessionSweep.js";
import type { OwnedSessionRecord } from "../terminal/ports.js";
import type { RuntimeId } from "../runtime/runtime.js";

const WORKSPACE_ONE = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_TWO = "22222222-2222-4222-8222-222222222222";
const AGENT_ONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function workspaceSession(workspaceId: string): OwnedSessionRecord {
	return {
		kind: "workspace",
		workspaceId,
		sessionName: `ws-${workspaceId.slice(0, 20)}`,
	};
}

function agentSession(
	agentId: string,
	workspaceId: string,
): OwnedSessionRecord {
	return {
		kind: "agent",
		agentId,
		workspaceId,
		sessionName: `ag-${agentId}`,
	};
}

const SCRATCH: OwnedSessionRecord = {
	kind: "scratch",
	sessionName: "devhub-scratch",
};

function accounting(
	workspaces: readonly string[],
	agents: readonly string[],
): SweepAccounting {
	return { workspaces: new Set(workspaces), agents: new Set(agents) };
}

/**
 * One machine's tmux, as a sweep sees it.
 *
 * `unreachable` is a machine that does not answer at all, which is what an
 * `SshRuntime` whose host is down produces: the adapter never exists.
 */
class FakeMachine implements SweepAdapter {
	adapterAvailable = true;
	unreachable: string | undefined;
	readonly killed: string[] = [];
	listings = 0;

	constructor(public sessions: OwnedSessionRecord[]) {}

	async markedSessions(): Promise<readonly OwnedSessionRecord[]> {
		this.listings += 1;
		return [...this.sessions];
	}

	async closeMarkedSession(record: OwnedSessionRecord): Promise<void> {
		this.killed.push(record.sessionName);
		this.sessions = this.sessions.filter(
			(session) => session.sessionName !== record.sessionName,
		);
	}
}

class FakeWorld implements SessionSweepWorld {
	readonly adapters = new Map<RuntimeId, FakeMachine>();
	remembered_: string[] = [];
	workspaceMachines_: RuntimeId[] = ["local"];
	accounted_: SweepAccounting = accounting([], []);
	readonly forgotten: RuntimeId[] = [];

	async adapterFor(machine: RuntimeId): Promise<SweepAdapter> {
		const found = this.adapters.get(machine);
		if (!found) throw new Error(`DevHub cannot reach ${machine}`);
		if (found.unreachable !== undefined) throw new Error(found.unreachable);
		return found;
	}

	accounted(): SweepAccounting {
		return this.accounted_;
	}

	workspaceMachines(): readonly RuntimeId[] {
		return this.workspaceMachines_;
	}

	remembered(): readonly string[] {
		return this.remembered_;
	}

	forget(machine: RuntimeId): void {
		this.forgotten.push(machine);
		this.remembered_ = this.remembered_.filter((one) => one !== machine);
	}
}

describe("which owned sessions nothing accounts for", () => {
	it("keeps the ones the model still has, and reaps the old scratch anchor", () => {
		const stray = unaccountedSessions(
			[
				SCRATCH,
				workspaceSession(WORKSPACE_ONE),
				agentSession(AGENT_ONE, WORKSPACE_ONE),
			],
			accounting([WORKSPACE_ONE], [AGENT_ONE]),
		);
		// Scratch is a Workspace now; the `scratch` session is accounted for
		// by nothing.
		expect(stray).toEqual([SCRATCH]);
	});

	it("names a terminal session whose Workspace is gone and an Agent's whose Agent is", () => {
		const stray = unaccountedSessions(
			[
				SCRATCH,
				workspaceSession(WORKSPACE_ONE),
				workspaceSession(WORKSPACE_TWO),
				agentSession(AGENT_ONE, WORKSPACE_ONE),
				agentSession(AGENT_TWO, WORKSPACE_TWO),
			],
			accounting([WORKSPACE_ONE], [AGENT_ONE]),
		);
		expect(stray.map((session) => session.sessionName)).toEqual([
			"devhub-scratch",
			`ws-${WORKSPACE_TWO.slice(0, 20)}`,
			`ag-${AGENT_TWO}`,
		]);
	});
});

describe("sweeping the machines DevHub has owned sessions on", () => {
	it("reaps the leftover terminal and Agent sessions on a host no Workspace uses", async () => {
		const world = new FakeWorld();
		const host = new FakeMachine([
			workspaceSession(WORKSPACE_TWO),
			agentSession(AGENT_TWO, WORKSPACE_TWO),
		]);
		world.adapters.set("ssh:example", host);
		world.adapters.set("local", new FakeMachine([SCRATCH]));
		// The Workspace that was on it has been closed, so the machine is only
		// in the persisted set — which is the whole case this exists for.
		world.remembered_ = ["ssh:example"];

		await new SessionSweeper(world).sweepAll();

		expect(host.killed).toEqual([
			`ws-${WORKSPACE_TWO.slice(0, 20)}`,
			`ag-${AGENT_TWO}`,
		]);
		// It stays in the set: something was there this time, so it is asked
		// again next time rather than dropped on the strength of one clean run.
		expect(world.forgotten).toEqual([]);
	});

	it("touches nothing on a machine whose sessions the model still accounts for", async () => {
		const world = new FakeWorld();
		const host = new FakeMachine([
			workspaceSession(WORKSPACE_ONE),
			agentSession(AGENT_ONE, WORKSPACE_ONE),
		]);
		world.adapters.set("ssh:example", host);
		world.adapters.set("local", new FakeMachine([SCRATCH]));
		world.workspaceMachines_ = ["local", "ssh:example"];
		world.accounted_ = accounting([WORKSPACE_ONE], [AGENT_ONE]);

		await new SessionSweeper(world).sweepAll();

		expect(host.killed).toEqual([]);
		expect(world.forgotten).toEqual([]);
	});

	it("never sees a session that is not DevHub's, because the adapter never lists one", async () => {
		// The rule is the runtime's and this is the statement of what it buys:
		// a sweep can only kill what `markedSessions` returned, and that is only
		// what carries DevHub's whole marker tuple on DevHub's own socket. A
		// foreign session — another profile's, or a person's own tmux — is not
		// in the listing at all, so there is no decision here that could go
		// wrong about it.
		const world = new FakeWorld();
		const host = new FakeMachine([]);
		world.adapters.set("ssh:example", host);
		world.adapters.set("local", new FakeMachine([SCRATCH]));
		world.remembered_ = ["ssh:example"];

		await new SessionSweeper(world).sweepAll();

		expect(host.killed).toEqual([]);
	});

	it("drops a machine that came up clean and has no Workspace left", async () => {
		const world = new FakeWorld();
		world.adapters.set("ssh:example", new FakeMachine([]));
		world.adapters.set("local", new FakeMachine([SCRATCH]));
		world.remembered_ = ["ssh:example"];

		await new SessionSweeper(world).sweepAll();

		expect(world.forgotten).toEqual(["ssh:example"]);
		expect(world.remembered_).toEqual([]);
	});

	it("keeps this Mac even when it is clean, because a Workspace is always on it", async () => {
		const world = new FakeWorld();
		world.adapters.set("local", new FakeMachine([SCRATCH]));

		await new SessionSweeper(world).sweepAll();

		expect(world.forgotten).toEqual([]);
	});

	it("keeps an unreachable machine pending, and sweeps it when it comes back", async () => {
		const world = new FakeWorld();
		const host = new FakeMachine([workspaceSession(WORKSPACE_TWO)]);
		host.unreachable = "ssh: connect to host example port 22: Host is down";
		world.adapters.set("ssh:example", host);
		world.adapters.set("local", new FakeMachine([SCRATCH]));
		world.remembered_ = ["ssh:example"];
		const sweeper = new SessionSweeper(world);

		await sweeper.sweepAll();

		expect(sweeper.pending).toEqual(["ssh:example"]);
		expect(host.killed).toEqual([]);
		expect(world.forgotten).toEqual([]);

		host.unreachable = undefined;
		sweeper.machineCameBack("ssh:example");
		await sweeper.sweep("ssh:example");

		expect(host.killed).toEqual([`ws-${WORKSPACE_TWO.slice(0, 20)}`]);
		expect(sweeper.pending).toEqual([]);
	});

	it("ignores a machine coming back that nothing is waiting on", async () => {
		const world = new FakeWorld();
		const host = new FakeMachine([]);
		world.adapters.set("ssh:example", host);
		const sweeper = new SessionSweeper(world);

		sweeper.machineCameBack("ssh:example");
		await Promise.resolve();

		expect(host.listings).toBe(0);
	});

	it("asks a machine with no tmux nothing, and calls it clean", async () => {
		const world = new FakeWorld();
		const host = new FakeMachine([]);
		host.adapterAvailable = false;
		world.adapters.set("ssh:example", host);
		world.adapters.set("local", new FakeMachine([SCRATCH]));
		world.remembered_ = ["ssh:example"];

		await new SessionSweeper(world).sweepAll();

		expect(host.listings).toBe(0);
		expect(world.forgotten).toEqual(["ssh:example"]);
	});

	it("asks every machine even when one of them fails", async () => {
		const world = new FakeWorld();
		const good = new FakeMachine([workspaceSession(WORKSPACE_TWO)]);
		world.adapters.set("ssh:good", good);
		world.adapters.set("local", new FakeMachine([SCRATCH]));
		// `ssh:bad` has no adapter at all, which is a machine that cannot be
		// reached.
		world.remembered_ = ["ssh:bad", "ssh:good"];
		const sweeper = new SessionSweeper(world);

		await sweeper.sweepAll();

		expect(good.killed).toEqual([`ws-${WORKSPACE_TWO.slice(0, 20)}`]);
		expect(sweeper.pending).toEqual(["ssh:bad"]);
	});

	it("skips a persisted name that spells no machine, and sweeps the rest", async () => {
		const world = new FakeWorld();
		world.adapters.set("local", new FakeMachine([SCRATCH]));
		world.remembered_ = ["not a machine"];
		const sweeper = new SessionSweeper(world);

		expect(sweeper.machines()).toEqual(["local"]);
		await sweeper.sweepAll();
		expect(sweeper.pending).toEqual([]);
	});
});
