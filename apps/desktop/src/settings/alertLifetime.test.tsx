// @vitest-environment jsdom

/**
 * The Settings window's two rules about what an arriving snapshot may do.
 *
 * It used to have neither. `adopt` ended with `setDraft(...)` and
 * `setError(undefined)`, so a push caused by something else entirely — another
 * window saving, a file watcher firing — both erased the refusal the person was
 * reading and threw away the half-typed value that caused it. That is the named
 * anti-pattern: an unrelated event retiring an error is an error nobody sees.
 *
 * So there are two rules now, and they are the ones every other DevHub window
 * follows:
 *
 * - A refusal is retired by the person dismissing it, by the person starting
 *   another action, or by a *different* refusal. Never by an arrival.
 * - A snapshot becomes what is shown, unless the person is part-way through an
 *   edit. Edited fields are theirs until the edit is saved or reset.
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsError, SettingsSnapshot } from "../ipc/settings";
import type { SettingsClient } from "./client";
import { SettingsApp } from "./SettingsApp";
import { testClient, testConfig, testSnapshot } from "./testHarness";

Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

const REFUSAL: SettingsError = {
  code: "invalid_config",
  diagnostic: {
    code: "invalid_socket_name",
    path: "runtimes.tmux_socket_name",
  },
};

/**
 * Settings with a transport that can be pushed to, and that refuses saves on
 * demand — the two things this file is about.
 */
function harness({ refuse = false }: { refuse?: boolean } = {}) {
  const base = testClient(testConfig());
  let attempts = 0;
  const attempted = () => attempts;
  let refusal: SettingsError = REFUSAL;
  let push: ((next: SettingsSnapshot) => void) | undefined;
  const client: SettingsClient = {
    ...base.client,
    save: (request) => {
      attempts += 1;
      return refuse ? Promise.reject(refusal) : base.client.save(request);
    },
    subscribe: (listener) => {
      push = listener;
      return () => {
        push = undefined;
      };
    },
  };
  render(<SettingsApp client={client} />);
  return {
    saves: base.saves,
    /** What the next save is refused with. */
    refuseWith: (next: SettingsError) => {
      refusal = next;
    },
    /**
     * Change a value and let the debounced save land — the only way this
     * window produces a refusal. The debounce is 400ms and `waitFor`'s budget
     * is longer, so real timers are enough and the window's own asynchrony is
     * left alone.
     */
    refuseASave: async ({
      expectAlert = true,
    }: { expectAlert?: boolean } = {}) => {
      const toggle = await screen.findByRole("checkbox", {
        name: /login shell/iu,
      });
      const before = base.saves.length;
      fireEvent.click(toggle);
      await waitFor(
        () => {
          if (expectAlert)
            expect(screen.getByRole("alert")).toBeInTheDocument();
          else expect(attempted()).toBeGreaterThan(before);
        },
        { timeout: 2_000 },
      );
    },
    /** DevHub says what it has, unasked. */
    push: async (sequence: number, socketName = "devhub-elsewhere") => {
      await act(async () => {
        push?.(
          testSnapshot(
            testConfig({
              runtimes: {
                ...testConfig().runtimes,
                tmuxSocketName: socketName,
              },
            }),
            sequence,
          ),
        );
      });
    },
  };
}

/** The socket field on the Terminal screen — a plain value, typed in place. */
async function socketField(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("tab", { name: "Terminal" }));
  return screen.findByRole("textbox", { name: /socket/iu });
}

describe("what an arriving snapshot may do to the Settings window", () => {
  it("does not erase the refusal the person is reading", async () => {
    const { push, refuseASave } = harness({ refuse: true });
    await refuseASave();
    expect(screen.getByRole("alert")).toHaveTextContent(/socket/iu);

    // Something else changed the file. The refusal is still the answer to what
    // this person did, and it stays.
    await push(9);
    expect(screen.getByRole("alert")).toHaveTextContent(/socket/iu);
  });

  it("does not overwrite a field that is being edited", async () => {
    const { push } = harness();
    const field = await socketField();
    fireEvent.change(field, { target: { value: "devhub-mine" } });

    await push(9, "devhub-elsewhere");

    expect(await socketField()).toHaveValue("devhub-mine");
  });

  it("does replace a field nobody is editing", async () => {
    const { push } = harness();
    await socketField();

    await push(9, "devhub-elsewhere");

    const field = await socketField();
    await waitFor(() => {
      expect(field).toHaveValue("devhub-elsewhere");
    });
  });

  it("is ignored when it is older than what the window already has", async () => {
    const { push } = harness();
    await push(9, "devhub-newer");
    const field = await socketField();
    await waitFor(() => {
      expect(field).toHaveValue("devhub-newer");
    });

    await push(2, "devhub-older");

    expect(field).toHaveValue("devhub-newer");
  });
});

describe("how long a refusal stays on the Settings window", () => {
  it("goes when the person puts it away", async () => {
    const { refuseASave } = harness({ refuse: true });
    await refuseASave();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("goes when the person starts something else, and comes back if it is still true", async () => {
    const { refuseASave } = harness({ refuse: true });
    await refuseASave();

    // Every action retires what is on screen — that is the second of the three
    // gestures, and it is why a refusal never outlives the thing it was about.
    // This one is still true, so it is raised again by its own save.
    await refuseASave();
    expect(screen.getByRole("alert")).toHaveTextContent(/socket/iu);
  });

  it("is replaced by a different refusal", async () => {
    const { refuseASave, refuseWith } = harness({ refuse: true });
    await refuseASave();
    expect(screen.getByRole("alert")).toHaveTextContent(/socket/iu);

    refuseWith({ code: "external_edit_conflict" });
    await refuseASave();
    expect(screen.getByRole("alert")).not.toHaveTextContent(/socket/iu);
  });
});
