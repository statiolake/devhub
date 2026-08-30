/**
 * VS Code's application, with DevHub's services in place of two of its own.
 *
 * This is composition, not a copy: `CodeApplication` runs exactly as upstream
 * wrote it, and the only difference is which class answers for
 * `IWindowsMainService` and `IDialogMainService`.
 *
 * `initServices` is `private` upstream. TypeScript privacy is not runtime
 * privacy, so the override is installed on the prototype through the typed
 * views below rather than smuggled past the compiler with a suppression. The
 * upstream members named here are what a VS Code bump has to re-check.
 */

import { CodeApplication } from "code-oss-dev/out/vs/code/electron-main/app.js";
import type { IProcessEnvironment } from "code-oss-dev/out/vs/base/common/platform.js";
import type { IInstantiationService } from "code-oss-dev/out/vs/platform/instantiation/common/instantiation.js";
import type { ServiceCollection } from "code-oss-dev/out/vs/platform/instantiation/common/serviceCollection.js";
import { SyncDescriptor } from "code-oss-dev/out/vs/platform/instantiation/common/descriptors.js";
import { IWindowsMainService } from "code-oss-dev/out/vs/platform/windows/electron-main/windows.js";
import { IDialogMainService } from "code-oss-dev/out/vs/platform/dialogs/electron-main/dialogMainService.js";
import type { Client as MessagePortClient } from "code-oss-dev/out/vs/base/parts/ipc/electron-main/ipc.mp.js";
import { DevHubWindowsMainService } from "./services/devhubWindowsMainService.js";
import { DevHubDialogMainService } from "./services/devhubDialogMainService.js";
import { shellController } from "./shell/shellController.js";

/** The members of `CodeApplication` this file reaches for, by their real names. */
interface CodeApplicationInternals {
	readonly userEnv: IProcessEnvironment;
	initServices(
		machineId: string,
		sqmId: string,
		devDeviceId: string,
		sharedProcessReady: Promise<MessagePortClient>,
	): Promise<IInstantiationService>;
}

/** `InstantiationService`'s own collection, so a registration can be replaced. */
interface InstantiationServiceInternals {
	readonly _services: ServiceCollection;
}

export class DevHubApplication extends CodeApplication {}

const upstreamInitServices = (
	CodeApplication.prototype as unknown as CodeApplicationInternals
).initServices;

(
	DevHubApplication.prototype as unknown as CodeApplicationInternals
).initServices = async function (
	this: CodeApplicationInternals,
	machineId,
	sqmId,
	devDeviceId,
	sharedProcessReady,
) {
	const instantiationService = await upstreamInitServices.call(
		this,
		machineId,
		sqmId,
		devDeviceId,
		sharedProcessReady,
	);

	const services = (
		instantiationService as unknown as InstantiationServiceInternals
	)._services;

	// Upstream registers `WindowsMainService` and a `DialogMainService`
	// instance here; both are replaced before anything resolves them.
	services.set(
		IWindowsMainService,
		new SyncDescriptor(
			DevHubWindowsMainService,
			[machineId, sqmId, devDeviceId, this.userEnv],
			false,
		),
	);
	services.set(
		IDialogMainService,
		instantiationService.createInstance(DevHubDialogMainService),
	);

	shellController().setServices({
		windows: () =>
			instantiationService.invokeFunction((accessor) =>
				accessor.get(IWindowsMainService),
			),
		dialogs: () =>
			instantiationService.invokeFunction((accessor) =>
				accessor.get(IDialogMainService),
			),
	});

	return instantiationService;
};
