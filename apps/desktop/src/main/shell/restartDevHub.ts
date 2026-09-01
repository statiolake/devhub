/**
 * The one question only DevHub can ask: may the whole application restart?
 *
 * A workbench asking to restart is asking about itself — it has no idea that
 * the same process is holding four other workspaces, a set of terminals whose
 * work is running right now, and the Agents. DevHub knows, so DevHub asks, and
 * the workbench's request becomes a proposal rather than a command. See
 * `services/devhubLifecycleMainService.ts` for who asks and why.
 *
 * This is a native sheet on the App Shell window, not a modal drawn by the
 * page, and that is the same rule the dialog service follows: a question about
 * *one workbench* is drawn over that workbench so the rest of DevHub stays
 * live, and a question about *the application* is presented by the
 * application. Everything is about to stop either way, so there is nothing
 * left for the person to do behind it.
 */

import { electron } from "../electron.js";
import { shellWindowIfCreated } from "./shellWindow.js";

const RESTART = 0;
const CANCEL = 1;

/**
 * Ask, and wait for the answer.
 *
 * There is no default and no timeout: nobody but the person can weigh a
 * running Agent against a setting that wants a restart.
 */
export async function askToRestartDevHub(): Promise<boolean> {
	const options: Electron.MessageBoxOptions = {
		type: "question",
		message: "Restart DevHub?",
		detail:
			"An editor asked for a restart to apply a change. DevHub has to restart as a whole: every workspace and editor will reload, and running Agents and terminals will be disconnected.",
		buttons: ["Restart", "Cancel"],
		defaultId: RESTART,
		cancelId: CANCEL,
		noLink: true,
	};
	const shell = shellWindowIfCreated();
	// No shell window means the ask arrived before DevHub had one, which is
	// early enough that there is no workspace behind it to protect; the sheet
	// is shown as an application-modal dialog instead of not at all.
	const answer = shell
		? await electron.dialog.showMessageBox(shell.window, options)
		: await electron.dialog.showMessageBox(options);
	return answer.response === RESTART;
}
