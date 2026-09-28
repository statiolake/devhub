// @vitest-environment jsdom

/**
 * The MCP panel (`/mcp`): one row per server with how it stands and where it
 * is configured, the actions the adapter offers for the server the person is
 * on — and nothing else — each making its documented request, a request the
 * CLI refused said in the footer, and a sign-in drawn as it runs, its URLs
 * links to the default browser and a line typed under it sent to its prompt.
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_MCP,
  type McpServer,
  type McpSignIn,
  type McpState,
} from "../../model/conversation";
import { McpPanel, type McpPanelActions } from "./McpPanel";

afterEach(cleanup);

function actions(): McpPanelActions & {
  readonly [K in keyof McpPanelActions]: ReturnType<typeof vi.fn>;
} {
  return {
    refresh: vi.fn(() => Promise.resolve()),
    act: vi.fn(() => Promise.resolve()),
    signIn: vi.fn(() => Promise.resolve()),
    signInInput: vi.fn(() => Promise.resolve()),
    cancelSignIn: vi.fn(() => Promise.resolve()),
    dismissSignIn: vi.fn(() => Promise.resolve()),
    openExternalUrl: vi.fn(() => Promise.resolve()),
    reportFailure: vi.fn(),
  };
}

function server(
  name: string,
  status: McpServer["status"],
  actions: McpServer["actions"],
  more: Partial<McpServer> = {},
): McpServer {
  return {
    name,
    status,
    said: status,
    error: undefined,
    source: undefined,
    actions,
    ...more,
  };
}

const SERVERS: readonly McpServer[] = [
  server("docs", "connected", ["reconnect", "disable"], { source: "user" }),
  server("linear", "needs-sign-in", ["sign-in", "reconnect", "disable"], {
    said: "needs-auth",
    source: "claudeai",
  }),
  server("db", "failed", ["reconnect", "disable"], {
    error: "HTTP 503",
    source: "project",
  }),
  server("slow", "connecting", ["disable"], { said: "pending" }),
  server("off", "disabled", ["enable"]),
  server("odd", "unknown", ["reconnect"], { said: "sleeping" }),
];

function draw(
  mcp: McpState,
  calls = actions(),
  signIn: McpSignIn | undefined = undefined,
) {
  const onClose = vi.fn();
  const view = render(
    <McpPanel
      label="Helper"
      mcp={mcp}
      signIn={signIn}
      actions={calls}
      onClose={onClose}
    />,
  );
  return { calls, onClose, view };
}

const rows = () => screen.getAllByRole("option");
const buttons = () =>
  [...document.querySelectorAll(".mcp-detail-actions button")].map(
    (button) => button.textContent,
  );

describe("the MCP panel", () => {
  it("asks the CLI how its servers stand as it opens, and says it is asking until it has said", () => {
    const { calls } = draw(NO_MCP);
    expect(calls.refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("Asking the CLI…");
  });

  it("says so when there are none", () => {
    draw({ ...NO_MCP, servers: [] });
    expect(screen.getByRole("status")).toHaveTextContent(
      "No MCP servers are configured for this Agent.",
    );
  });

  it("lists every server with how it stands and where it is configured", () => {
    draw({ ...NO_MCP, servers: SERVERS });
    expect(rows().map((row) => row.textContent)).toEqual([
      "docsConnected · user",
      "linearNeeds sign-in · claudeai",
      "dbFailed · project",
      "slowConnecting…",
      "offDisabled",
      "oddUnknown (sleeping)",
    ]);
  });

  it("offers for the server the person is on exactly the actions the adapter offers, and says why a failed one failed", () => {
    draw({ ...NO_MCP, servers: SERVERS });
    expect(buttons()).toEqual(["Reconnect", "Disable"]);
    fireEvent.click(rows()[1]!);
    expect(buttons()).toEqual(["Sign In…", "Reconnect", "Disable"]);
    fireEvent.click(rows()[2]!);
    expect(screen.getByText("HTTP 503")).toBeInTheDocument();
    fireEvent.click(rows()[3]!);
    expect(buttons()).toEqual(["Disable"]);
    fireEvent.click(rows()[4]!);
    expect(buttons()).toEqual(["Enable"]);
  });

  it("makes the request each action is, and signs in through the sign-in", () => {
    const { calls } = draw({ ...NO_MCP, servers: SERVERS });
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(calls.act).toHaveBeenCalledWith("reconnect", "docs");
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(calls.act).toHaveBeenCalledWith("disable", "docs");
    fireEvent.click(rows()[4]!);
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(calls.act).toHaveBeenCalledWith("enable", "off");
    fireEvent.click(rows()[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Sign In…" }));
    expect(calls.signIn).toHaveBeenCalledWith("linear");
  });

  it("moves between servers with the arrows and closes on Escape", () => {
    const { onClose } = draw({ ...NO_MCP, servers: SERVERS });
    const sheet = screen.getByRole("dialog");
    fireEvent.keyDown(sheet, { key: "ArrowDown" });
    expect(rows()[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("holds a server's actions while a request about it is being answered", () => {
    draw({
      ...NO_MCP,
      servers: SERVERS,
      working: [{ server: "docs", action: "reconnect" }],
    });
    expect(screen.getByText("Connected — working…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeDisabled();
  });

  it("says a request the CLI refused, and plugins that did not load, in its footer", () => {
    draw({
      ...NO_MCP,
      servers: SERVERS,
      failure: "Reconnecting db failed: Server not found: db",
      pluginErrors: [{ plugin: "broken", message: "needs x@2" }],
    });
    expect(
      screen.getByText("Reconnecting db failed: Server not found: db"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Plugin broken did not load: needs x@2"),
    ).toBeInTheDocument();
  });

  it("hands a call that could not be made to the page's root", async () => {
    const calls = actions();
    const refused = new Error("the conversation has stopped");
    calls.act.mockImplementation(() => Promise.reject(refused));
    draw({ ...NO_MCP, servers: SERVERS }, calls);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    });
    expect(calls.reportFailure).toHaveBeenCalledWith(refused);
  });
});

describe("a sign-in in the MCP panel", () => {
  const URL =
    "https://auth.example.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A43117%2Fcallback";
  const running: McpSignIn = {
    server: "linear",
    phase: "running",
    output: `Open this URL: ${URL}\nPaste the redirect URL: `,
    callback: { kind: "forwarded", port: 43117, to: "build-box" },
    failure: undefined,
  };

  it("opens on the server being signed in to, shows what the command printed with its URL a link to the default browser, and the forward", () => {
    const { calls } = draw({ ...NO_MCP, servers: SERVERS }, actions(), running);
    expect(rows()[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Signing in to linear…")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: URL });
    fireEvent.click(link);
    expect(calls.openExternalUrl).toHaveBeenCalledWith(URL);
    expect(
      screen.getByText(
        "localhost:43117 on this Mac is forwarded to build-box while the sign-in runs, so the browser's redirect reaches it.",
      ),
    ).toBeInTheDocument();
    // One sign-in at a time.
    expect(screen.getByRole("button", { name: "Sign In…" })).toBeDisabled();
  });

  it("sends a line typed under it to the command's prompt, and cancels it", async () => {
    const { calls } = draw({ ...NO_MCP, servers: SERVERS }, actions(), running);
    const field = screen.getByRole("textbox", {
      name: "Type at the sign-in's prompt",
    });
    fireEvent.change(field, {
      target: { value: "http://localhost:43117/callback?code=c0de" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(calls.signInInput).toHaveBeenCalledWith(
      "http://localhost:43117/callback?code=c0de",
    );
    expect(field).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel Sign-In" }));
    expect(calls.cancelSignIn).toHaveBeenCalledOnce();
  });

  it("says why it failed, and why the callback could not be forwarded, and can be put away", () => {
    const { calls } = draw({ ...NO_MCP, servers: SERVERS }, actions(), {
      ...running,
      phase: "failed",
      callback: {
        kind: "unforwarded",
        port: 43117,
        why: "bind: Address already in use",
      },
      failure: "`claude mcp login linear` ended with exit code 1.",
    });
    expect(
      screen.getByText("The sign-in to linear failed"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "`claude mcp login linear` ended with exit code 1.",
    );
    expect(
      screen.getByText(
        /localhost:43117 could not be forwarded: bind: Address already in use/u,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(calls.dismissSignIn).toHaveBeenCalledOnce();
  });
});
