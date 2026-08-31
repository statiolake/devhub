/**
 * When the App Shell may reach into VS Code's main process, and how it waits.
 *
 * DevHub's shell exists before VS Code does. The window, the model, the
 * runtimes and the control socket are all up while the DI container that
 * builds `IWindowsMainService` and friends is still being assembled — that
 * ordering is deliberate, because the first workbench needs somewhere to go.
 * So there is a stretch of every launch during which "open a workbench" is a
 * reasonable thing to ask and an impossible thing to do.
 *
 * There is exactly one answer to that, and it is *wait*. Not "return early",
 * not "throw": both of those make the caller responsible for knowing which
 * stretch of startup it is in, and a caller that guesses wrong either drops
 * the request silently or crashes the process. The failure this replaced was
 * both at once — the Agent reconciler's first round changed the projection,
 * the projection opened a workbench, and the invariant error that came back
 * had no reader but `unhandledRejection`.
 *
 * The gate opens at one point: `AppController.markReady`, once
 * `CodeApplication.startup()` has finished. The services themselves exist
 * earlier — the DI container hands them over mid-startup — but "they exist"
 * and "they may be driven" are not the same moment, and this is the second
 * one.
 *
 * One gate, one way through it. Nothing else may ask whether it is open: an
 * `isReady()` here would immediately grow a second set of call-site policies
 * about what to do when the answer is no, and the whole point is that there
 * is only one.
 */

import type { IWindowsMainService } from "code-oss-dev/out/vs/platform/windows/electron-main/windows.js";
import type { IDialogMainService } from "code-oss-dev/out/vs/platform/dialogs/electron-main/dialogMainService.js";
import type { ILifecycleMainService } from "code-oss-dev/out/vs/platform/lifecycle/electron-main/lifecycleMainService.js";

/**
 * The three main-process services the shell drives. They are resolved on
 * demand: VS Code's DI container builds them lazily, and the shell exists
 * before it.
 */
export interface MainServices {
	windows(): IWindowsMainService;
	dialogs(): IDialogMainService;
	/** Closing a workbench is an unload, and an unload can be vetoed. */
	lifecycle(): ILifecycleMainService;
}

export class MainServicesGate {
	#announce: ((services: MainServices) => void) | undefined;
	#registered = false;
	readonly #ready: Promise<MainServices>;

	constructor() {
		this.#ready = new Promise<MainServices>((resolve) => {
			this.#announce = resolve;
		});
	}

	/**
	 * Hand the services over. Once, at the one point in startup where VS Code
	 * has them; a second call is a bootstrap that ran twice, which is a bug
	 * about the process and not a thing to paper over by taking the newer set.
	 */
	register(services: MainServices): void {
		if (this.#registered) {
			throw new Error("the main services were registered twice");
		}
		this.#registered = true;
		this.#announce?.(services);
	}

	/**
	 * The services, when there are some.
	 *
	 * Resolves immediately once registered, so this is what every caller says
	 * whether it runs during startup or an hour later — the two look the same
	 * on purpose, because a caller that could tell them apart would be asked to
	 * behave differently in each.
	 */
	wait(): Promise<MainServices> {
		return this.#ready;
	}
}
