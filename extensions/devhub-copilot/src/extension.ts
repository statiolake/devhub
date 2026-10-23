/**
 * The extension's entry point, and all of it that runs while Copilot is off.
 *
 * Copilot starts off in every window and is turned on for one window at a
 * time, by **Copilot: Enable in This Window** or a click on the status item.
 * Off means nothing but the status item and the commands: no language server
 * process (about a gigabyte each, one per window's extension host), no
 * providers, no timers, and `./controller`, which is everything else, not even
 * loaded. It is a separate file in `dist/` (scripts/build.mjs) required when
 * Copilot is turned on. Off again disposes of the controller, which stops the
 * server.
 *
 * Whether it is on is this extension host's memory and nothing else: a
 * reload, a restart or a workbench put to sleep comes back with it off.
 */
import * as vscode from "vscode";
import type { Controller } from "./controller";

let window: CopilotWindow | undefined;

export function activate(context: vscode.ExtensionContext): void {
  window = new CopilotWindow(context);
}

export async function deactivate(): Promise<void> {
  await window?.dispose();
  window = undefined;
}

class CopilotWindow {
  private readonly statusBar = vscode.window.createStatusBarItem(
    "devhub.copilot.status",
    vscode.StatusBarAlignment.Right,
    100,
  );
  private readonly richHover = supportsRichHover(this.statusBar);
  private output?: vscode.OutputChannel;
  private controller?: Controller;
  /** Turning on and off, one at a time. */
  private transition: Promise<void> = Promise.resolve();

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar.name = "Copilot";
    // Commands that need the server turn Copilot on first; the rest have
    // nothing to act on while it is off.
    const turningOn =
      (run: (controller: Controller) => Promise<void>) => async () => {
        await this.enable();
        if (this.controller !== undefined) {
          await run(this.controller);
        }
      };
    const whenOn = (run: (controller: Controller) => void) => () => {
      if (this.controller !== undefined) {
        run(this.controller);
      }
    };
    context.subscriptions.push(
      vscode.commands.registerCommand("devhub.copilot.enable", () =>
        this.enable(),
      ),
      vscode.commands.registerCommand("devhub.copilot.disable", () =>
        this.disable(),
      ),
      vscode.commands.registerCommand(
        "devhub.copilot.signIn",
        turningOn((controller) => controller.signIn()),
      ),
      vscode.commands.registerCommand(
        "devhub.copilot.signOut",
        turningOn((controller) => controller.signOut()),
      ),
      vscode.commands.registerCommand(
        "devhub.copilot.restart",
        // Off, turning on is the start a restart would be.
        () => this.controller?.restartServer() ?? this.enable(),
      ),
      vscode.commands.registerCommand(
        "devhub.copilot.showMenu",
        turningOn((controller) => controller.showMenu()),
      ),
      vscode.commands.registerCommand(
        "devhub.copilot.snooze",
        whenOn((controller) => controller.snooze()),
      ),
      vscode.commands.registerCommand(
        "devhub.copilot.cancelSnooze",
        whenOn((controller) => controller.cancelSnooze()),
      ),
      vscode.commands.registerCommand("devhub.copilot.showOutput", () =>
        this.output?.show(true),
      ),
      this.statusBar,
    );
    this.showOff();
  }

  public async dispose(): Promise<void> {
    await this.disable();
    this.output?.dispose();
  }

  private enable(): Promise<void> {
    return this.serialize(async () => {
      if (this.controller !== undefined) {
        return;
      }
      // Loaded here, so a window that never turns Copilot on never loads it.
      const { Controller } =
        require("./controller") as typeof import("./controller");
      this.output ??= vscode.window.createOutputChannel("Copilot");
      this.controller = new Controller(
        this.context,
        this.statusBar,
        this.richHover,
        this.output,
      );
      await this.controller.start();
    });
  }

  private disable(): Promise<void> {
    return this.serialize(async () => {
      const controller = this.controller;
      if (controller === undefined) {
        return;
      }
      this.controller = undefined;
      await controller.dispose();
      this.showOff();
    });
  }

  /** Off: the icon, and a click turns Copilot on. No dashboard. */
  private showOff(): void {
    if (this.richHover) {
      this.statusBar.hover = undefined;
    }
    this.statusBar.text = "$(copilot-unavailable)";
    this.statusBar.tooltip =
      "Copilot is off in this window. Click to turn it on.";
    this.statusBar.command = "devhub.copilot.enable";
    this.statusBar.accessibilityInformation = {
      label: "Copilot is off in this window",
      role: "button",
    };
    this.statusBar.show();
  }

  private serialize(task: () => Promise<void>): Promise<void> {
    const next = this.transition.then(task, task);
    this.transition = next.catch(() => undefined);
    return next;
  }
}

function supportsRichHover(item: vscode.StatusBarItem): boolean {
  if (!("hover" in item)) {
    return false; // a workbench without DevHub's devhubStatusBarHover
  }
  try {
    void item.hover; // throws when the proposal is not enabled for us
    return true;
  } catch {
    return false;
  }
}
