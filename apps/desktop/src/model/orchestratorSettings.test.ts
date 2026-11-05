import { describe, expect, it } from "vitest";
import {
  CONFIG_SCHEMA_VERSION,
  configDocument,
  defaultConfig,
  interpretConfig as interpretDocument,
} from "./config.js";

const interpretConfig = (document: Record<string, unknown>) =>
  interpretDocument({ version: CONFIG_SCHEMA_VERSION, ...document });
import {
  DEFAULT_ORCHESTRATOR,
  DEFAULT_ORCHESTRATOR_EVENTS,
  eventAllowed,
  eventPatternProblem,
  formatInterval,
  orchestratorProblem,
  parseInterval,
  githubHealth,
  parseProjectRef,
  projectUrl,
  renderEventPrompt,
  usageThresholdsProblem,
} from "./orchestratorSettings.js";

describe("[orchestrator] settings", () => {
  it("defaults root to ~/orchestrator, and does not write the default back", () => {
    expect(DEFAULT_ORCHESTRATOR.root).toBe("~/orchestrator");
    expect(interpretConfig({}).orchestrator.root).toBe("~/orchestrator");
    expect(
      interpretConfig({ orchestrator: { root: "~/workspace/work/x" } })
        .orchestrator.root,
    ).toBe("~/workspace/work/x");
    expect(configDocument(defaultConfig())["orchestrator"]).toEqual({
      event_prompt: DEFAULT_ORCHESTRATOR.event_prompt,
    });
  });

  it("reads events, [orchestrator.github] and [[orchestrator.timers]]", () => {
    const config = interpretConfig({
      orchestrator: {
        events: ["github.*", "!github.checks", "agent.turn_ended"],
        github: { projects: ["my-org/7"], interval: "2m" },
        timers: [{ name: "tick", interval: "5m" }],
      },
    });
    expect(config.orchestrator.events).toEqual([
      "github.*",
      "!github.checks",
      "agent.turn_ended",
    ]);
    expect(config.orchestrator.github).toEqual({
      projects: ["my-org/7"],
      interval: "2m",
    });
    expect(config.orchestrator.timers).toEqual([
      { name: "tick", interval: "5m" },
    ]);
    expect(orchestratorProblem(config.orchestrator)).toBeUndefined();
    // And writes them back as tables.
    expect(configDocument(config)["orchestrator"]).toMatchObject({
      events: ["github.*", "!github.checks", "agent.turn_ended"],
      github: { projects: ["my-org/7"], interval: "2m" },
      timers: [{ name: "tick", interval: "5m" }],
    });
    expect(interpretConfig({}).orchestrator.events).toEqual(
      DEFAULT_ORCHESTRATOR_EVENTS,
    );
  });

  it("refuses what does not read, by the key it is about", () => {
    const with_ = (patch: Partial<typeof DEFAULT_ORCHESTRATOR>) =>
      orchestratorProblem({ ...DEFAULT_ORCHESTRATOR, ...patch });
    expect(with_({ events: ["GitHub!"] })).toBe("events");
    expect(with_({ github: { projects: ["my-org"], interval: "90s" } })).toBe(
      "github.projects",
    );
    expect(with_({ github: { projects: [], interval: "5s" } })).toBe(
      "github.interval",
    );
    expect(
      with_({
        timers: [
          { name: "tick", interval: "5m" },
          { name: "tick", interval: "1h" },
        ],
      }),
    ).toBe("timers[1].name");
    expect(with_({ timers: [{ name: "t", interval: "5" }] })).toBe(
      "timers[0].interval",
    );
  });

  it("reads usage_thresholds, defaults it to 80 and 95, and refuses what is not a percent", () => {
    expect(interpretConfig({}).orchestrator.usage_thresholds).toEqual([80, 95]);
    expect(DEFAULT_ORCHESTRATOR_EVENTS).toContain("usage.threshold");
    expect(
      interpretConfig({ orchestrator: { usage_thresholds: [50, 90] } })
        .orchestrator.usage_thresholds,
    ).toEqual([50, 90]);
    expect(
      interpretConfig({ orchestrator: { usage_thresholds: [] } }).orchestrator
        .usage_thresholds,
    ).toEqual([]);
    for (const bad of [[0], [101], [80.5], [80, 80]])
      expect(() =>
        interpretConfig({ orchestrator: { usage_thresholds: bad } }),
      ).toThrow();
    expect(() =>
      interpretConfig({ orchestrator: { usage_thresholds: ["80"] } }),
    ).toThrow();
    expect(
      orchestratorProblem({ ...DEFAULT_ORCHESTRATOR, usage_thresholds: [120] }),
    ).toBe("usage_thresholds");
    expect(usageThresholdsProblem([95, 80])).toBe(false);
    expect(
      configDocument({
        ...defaultConfig(),
        orchestrator: { ...DEFAULT_ORCHESTRATOR, usage_thresholds: [70] },
      })["orchestrator"],
    ).toMatchObject({ usage_thresholds: [70] });
  });

  it("reads wait_reminder_interval, defaults it to 1h, and refuses what is not an interval", () => {
    expect(interpretConfig({}).orchestrator.wait_reminder_interval).toBe("1h");
    expect(
      interpretConfig({ orchestrator: { wait_reminder_interval: "30m" } })
        .orchestrator.wait_reminder_interval,
    ).toBe("30m");
    for (const bad of ["30s", "1", "soon", "8d"])
      expect(
        orchestratorProblem({
          ...DEFAULT_ORCHESTRATOR,
          wait_reminder_interval: bad,
        }),
      ).toBe("wait_reminder_interval");
    expect(() =>
      interpretConfig({ orchestrator: { wait_reminder_interval: "10s" } }),
    ).toThrow();
    expect(
      configDocument(defaultConfig())["orchestrator"] ?? {},
    ).not.toHaveProperty("wait_reminder_interval");
    expect(
      configDocument({
        ...defaultConfig(),
        orchestrator: { ...DEFAULT_ORCHESTRATOR, wait_reminder_interval: "2h" },
      })["orchestrator"],
    ).toMatchObject({ wait_reminder_interval: "2h" });
  });

  it("defaults the events to the 待機中 and 停滞 ones, without 不明; an old unaccounted pattern is valid and matches nothing", () => {
    for (const type of [
      "escalation.stalled",
      "escalation.wait_due",
      "escalation.waiting_reminder",
    ])
      expect(eventAllowed(type, DEFAULT_ORCHESTRATOR_EVENTS)).toBe(true);
    expect(DEFAULT_ORCHESTRATOR_EVENTS).not.toContain("unaccounted");
    expect(DEFAULT_ORCHESTRATOR_EVENTS).not.toContain("escalation.taken");
    expect(eventPatternProblem("unaccounted")).toBe(false);
    expect(
      interpretConfig({ orchestrator: { events: ["init", "unaccounted"] } })
        .orchestrator.events,
    ).toEqual(["init", "unaccounted"]);
  });

  it("filters by the last matching pattern, and always lets init through", () => {
    const patterns = ["github.*", "!github.checks", "agent.turn_ended"];
    expect(eventAllowed("github.assigned", patterns)).toBe(true);
    expect(eventAllowed("github.checks", patterns)).toBe(false);
    expect(eventAllowed("agent.turn_ended", patterns)).toBe(true);
    expect(eventAllowed("agent.started", patterns)).toBe(false);
    expect(eventAllowed("init", [])).toBe(true);
    expect(eventAllowed("custom.deploy", ["*"])).toBe(true);
    expect(eventPatternProblem("timer.*")).toBe(false);
    expect(eventPatternProblem("!agent.started")).toBe(false);
    expect(eventPatternProblem("a b")).toBe(true);
    // The default leaves out the chatter.
    expect(eventAllowed("agent.started", DEFAULT_ORCHESTRATOR_EVENTS)).toBe(
      false,
    );
    expect(eventAllowed("github.pr_merged", DEFAULT_ORCHESTRATOR_EVENTS)).toBe(
      true,
    );
  });

  it("reads intervals and project references", () => {
    expect(parseInterval("90s")).toBe(90_000);
    expect(parseInterval("1h30m")).toBe(5_400_000);
    expect(parseInterval("5")).toBeUndefined();
    expect(formatInterval(5_400_000)).toBe("1h30m");
    expect(parseProjectRef("my-org/7")).toEqual({ owner: "my-org", number: 7 });
    expect(parseProjectRef("my-org/0")).toBeUndefined();
  });

  it("renders {EVENT} and {EVENT_JSON}, and appends the event when neither is there", () => {
    expect(renderEventPrompt("/go {EVENT}", "E", "[1]")).toBe("/go E");
    expect(renderEventPrompt("{EVENT}\n{EVENT_JSON}", "E", "[1]")).toBe(
      "E\n[1]",
    );
    expect(renderEventPrompt("/go {EVENT_JSON}", "E", '[{"type":"x"}]')).toBe(
      '/go [{"type":"x"}]',
    );
    expect(renderEventPrompt("handle it", "E")).toBe("handle it\n\nE");
  });
});

describe("GitHub polling's health", () => {
  it("is the mode, unless an active one failed or is short of rate limit", () => {
    expect(githubHealth({ state: "idle" })).toEqual({ health: "idle" });
    expect(githubHealth({ state: "suspended", problem: "x" })).toEqual({
      health: "suspended",
    });
    expect(
      githubHealth({
        state: "active",
        rateLimit: { remaining: 4000, limit: 5000 },
      }),
    ).toEqual({ health: "active" });
    expect(githubHealth({ state: "active", problem: "HTTP 502" })).toEqual({
      health: "backing_off",
      why: "HTTP 502",
    });
    expect(
      githubHealth({
        state: "active",
        rateLimit: { remaining: 50, limit: 5000 },
      }),
    ).toEqual({ health: "backing_off", why: "rate limit low (50 left)" });
    expect(
      githubHealth({
        state: "active",
        rateLimit: { remaining: 1000, limit: 5000 },
      }).why,
    ).toBe("rate limit at 20%: polling slower");
  });

  it("links a board to its page", () => {
    expect(projectUrl("acme/7")).toBe(
      "https://github.com/orgs/acme/projects/7",
    );
    expect(projectUrl("nope")).toBeUndefined();
  });
});
