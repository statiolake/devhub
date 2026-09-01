/**
 * VS Code's application, with DevHub's services in place of two of its own.
 *
 * This is composition, not a copy: `CodeApplication` runs exactly as upstream
 * wrote it, and the only difference is which class answers for
 * `IWindowsMainService`, `IDialogMainService` and
 * `IWorkspacesHistoryMainService`.
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
import type { ServicesAccessor } from "code-oss-dev/out/vs/platform/instantiation/common/instantiation.js";
import { IAuxiliaryWindowsMainService } from "code-oss-dev/out/vs/platform/auxiliaryWindow/electron-main/auxiliaryWindows.js";
import { SyncDescriptor } from "code-oss-dev/out/vs/platform/instantiation/common/descriptors.js";
import { IWindowsMainService } from "code-oss-dev/out/vs/platform/windows/electron-main/windows.js";
import { IDialogMainService } from "code-oss-dev/out/vs/platform/dialogs/electron-main/dialogMainService.js";
import { ILifecycleMainService } from "code-oss-dev/out/vs/platform/lifecycle/electron-main/lifecycleMainService.js";
import type { Client as MessagePortClient } from "code-oss-dev/out/vs/base/parts/ipc/electron-main/ipc.mp.js";
import { DevHubWindowsMainService } from "./services/devhubWindowsMainService.js";
import { DevHubDialogMainService } from "./services/devhubDialogMainService.js";
import { IWorkspacesHistoryMainService } from "code-oss-dev/out/vs/platform/workspaces/electron-main/workspacesHistoryMainService.js";
import { DevHubWorkspacesHistoryMainService } from "./services/devhubWorkspacesHistoryMainService.js";
import { appController } from "./shell/appController.js";
import { createExtensionSupport } from "./cli/extensionServices.js";

/** The members of `CodeApplication` this file reaches for, by their real names. */
interface CodeApplicationInternals {
	readonly userEnv: IProcessEnvironment;
	initServices(
		machineId: string,
		sqmId: string,
		devDeviceId: string,
		sharedProcessReady: Promise<MessagePortClient>,
	): Promise<IInstantiationService>;
	windowsMainService: unknown;
	auxiliaryWindowsMainService: unknown;
	openFirstWindow(
		accessor: ServicesAccessor,
		initialProtocolUrls: unknown,
	): Promise<unknown[]>;
}

/** `InstantiationService`'s own collection, so a registration can be replaced. */
interface InstantiationServiceInternals {
	readonly _services: ServiceCollection;
}

export class DevHubApplication extends CodeApplication {}

/**
 * DevHub starts with no workbench.
 *
 * This is the architectural rule, not a startup optimisation: DevHub is the
 * thing *outside* VS Code, and VS Code is mounted inside it. Upstream's
 * `openFirstWindow` decides what to restore or create before anything asks —
 * it would open a window DevHub's own model never chose, so it opens nothing.
 * The App Shell decides when a workbench view exists, and the "empty window"
 * VS Code wants is exactly DevHub's scratch editor: the Global context's
 * Editor activity, created on first selection and kept alive after.
 *
 * `startup()` discards the return value, so opening nothing costs nothing —
 * but upstream also caches the two window services here, and the rest of the
 * class reads them, so those assignments stay. They are the only part of
 * upstream's body this keeps, and a VS Code bump has to re-check that.
 */
(
	DevHubApplication.prototype as unknown as CodeApplicationInternals
).openFirstWindow = async function (
	this: CodeApplicationInternals,
	accessor: ServicesAccessor,
) {
	this.windowsMainService = accessor.get(IWindowsMainService);
	this.auxiliaryWindowsMainService = accessor.get(IAuxiliaryWindowsMainService);
	console.log("[devhub] startup: no workbench window — the App Shell decides");
	return [];
};

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
	// Upstream registers `WorkspacesHistoryMainService` here too. DevHub's
	// sidebar and workspace picker are the history, so VS Code's copy of it is
	// replaced by one that is always empty — see the service's own file.
	services.set(
		IWorkspacesHistoryMainService,
		new DevHubWorkspacesHistoryMainService(),
	);

	// Extension management for the `devhub` command. Built here because this is
	// the one place that holds both the container and `sharedProcessReady`, and
	// built once: it owns a channel client, and a second one would be a second
	// listener on every install event.
	const extensions = createExtensionSupport(
		instantiationService,
		sharedProcessReady,
	);

	appController().setServices({
		extensions: () => extensions,
		windows: () =>
			instantiationService.invokeFunction((accessor) =>
				accessor.get(IWindowsMainService),
			),
		dialogs: () =>
			instantiationService.invokeFunction((accessor) =>
				accessor.get(IDialogMainService),
			),
		lifecycle: () =>
			instantiationService.invokeFunction((accessor) =>
				accessor.get(ILifecycleMainService),
			),
	});

	return instantiationService;
};
