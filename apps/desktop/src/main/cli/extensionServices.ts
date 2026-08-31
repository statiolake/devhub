/**
 * Where the main process gets an extension management service.
 *
 * VS Code splits extension management in two, and DevHub keeps the split:
 *
 * - The **shared process** owns the extensions directory. It is the only
 *   process that installs, uninstalls and scans, and it publishes
 *   `IExtensionManagementService` on its `extensions` channel. A workbench
 *   window talks to it over exactly that channel; so does this. Nothing here
 *   opens the directory itself, so there is no second writer and no second set
 *   of built-in protections to keep in step.
 * - The **gallery lookup** — turning `publisher.name` into an extension the
 *   shared process can install — runs wherever the asking is done, from
 *   `IProductService.extensionsGallery`. In a workbench window that is the
 *   renderer; here it is the main process. DevHub's gallery is Open VSX, set in
 *   `product-overrides.json` and merged into `product.json` in every process,
 *   so the answer is the same one the workbench's Extensions view gets.
 *
 * The four services below are what `ExtensionManagementCLI` asks for that the
 * main process does not already have. Everything else it needs —
 * `IProductService`, `IRequestService`, `IConfigurationService`, `IFileService`,
 * `ILogService`, `IEnvironmentService`, `ITelemetryService` — is registered by
 * `main.ts` and `app.ts` before this is called.
 *
 * The registrations are the same ones `vs/code/node/cliProcessMain.ts` makes
 * for the standalone `code --install-extension`, minus its own copy of the
 * management service. That is the list to re-check on a VS Code bump.
 */

import { AllowedExtensionsService } from "code-oss-dev/out/vs/platform/extensionManagement/common/allowedExtensionsService.js";
import { ExtensionGalleryManifestService } from "code-oss-dev/out/vs/platform/extensionManagement/common/extensionGalleryManifestService.js";
import { ExtensionGalleryServiceWithNoStorageService } from "code-oss-dev/out/vs/platform/extensionManagement/common/extensionGalleryService.js";
import { ExtensionManagementCLI } from "code-oss-dev/out/vs/platform/extensionManagement/common/extensionManagementCLI.js";
import { ExtensionManagementChannelClient } from "code-oss-dev/out/vs/platform/extensionManagement/common/extensionManagementIpc.js";
import {
	IAllowedExtensionsService,
	IExtensionGalleryService,
	IExtensionManagementService,
} from "code-oss-dev/out/vs/platform/extensionManagement/common/extensionManagement.js";
import { IExtensionGalleryManifestService } from "code-oss-dev/out/vs/platform/extensionManagement/common/extensionGalleryManifest.js";
import { getDelayedChannel } from "code-oss-dev/out/vs/base/parts/ipc/common/ipc.js";
import type { Client as MessagePortClient } from "code-oss-dev/out/vs/base/parts/ipc/electron-main/ipc.mp.js";
import { SyncDescriptor } from "code-oss-dev/out/vs/platform/instantiation/common/descriptors.js";
import { ServiceCollection } from "code-oss-dev/out/vs/platform/instantiation/common/serviceCollection.js";
import type { IInstantiationService } from "code-oss-dev/out/vs/platform/instantiation/common/instantiation.js";
import { IProductService } from "code-oss-dev/out/vs/platform/product/common/productService.js";
import { IUserDataProfilesService } from "code-oss-dev/out/vs/platform/userDataProfile/common/userDataProfile.js";
import type { ILogger } from "code-oss-dev/out/vs/platform/log/common/log.js";
import type { URI } from "code-oss-dev/out/vs/base/common/uri.js";
import type { ExtensionCliHost } from "./extensionCommands.js";

/** DevHub's version, VS Code's, and the commit VS Code was built from. */
export interface VersionReport {
	readonly vscodeVersion: string;
	readonly commit: string | undefined;
}

export interface ExtensionSupport extends ExtensionCliHost {
	version(): VersionReport;
}

export function createExtensionSupport(
	instantiationService: IInstantiationService,
	sharedProcessReady: Promise<MessagePortClient>,
): ExtensionSupport {
	const gallerySide = new ServiceCollection();
	gallerySide.set(
		IAllowedExtensionsService,
		new SyncDescriptor(AllowedExtensionsService, undefined, true),
	);
	gallerySide.set(
		IExtensionGalleryManifestService,
		new SyncDescriptor(ExtensionGalleryManifestService, undefined, true),
	);
	gallerySide.set(
		IExtensionGalleryService,
		new SyncDescriptor(
			ExtensionGalleryServiceWithNoStorageService,
			undefined,
			true,
		),
	);
	const withGallery = instantiationService.createChild(gallerySide);

	// A delayed channel, because the shared process comes up on the first
	// workbench connection and a `devhub --list-extensions` may arrive before
	// it. Waiting is the same answer the App Shell gives everywhere else about
	// startup order (see `mainServices.ts`): "not yet" is a duration, not an
	// outcome.
	const client = new ExtensionManagementChannelClient(
		getDelayedChannel(
			sharedProcessReady.then((connection) =>
				connection.getChannel("extensions"),
			),
		),
		withGallery.invokeFunction((accessor) => accessor.get(IProductService)),
		withGallery.invokeFunction((accessor) =>
			accessor.get(IAllowedExtensionsService),
		),
	);
	const managementSide = new ServiceCollection();
	managementSide.set(IExtensionManagementService, client);
	const services = withGallery.createChild(managementSide);

	return {
		cli: (logger: ILogger): ExtensionManagementCLI =>
			// The first argument is upstream's `extensionsForceVersionByQuality`,
			// which pins a named extension to the quality's version. DevHub has
			// no quality channels, so nothing is pinned.
			services.createInstance(ExtensionManagementCLI, [], logger),
		profileLocation: (): URI =>
			services.invokeFunction(
				(accessor) =>
					accessor.get(IUserDataProfilesService).defaultProfile
						.extensionsResource,
			),
		version: (): VersionReport => {
			const product = services.invokeFunction((accessor) =>
				accessor.get(IProductService),
			);
			return { vscodeVersion: product.version, commit: product.commit };
		},
	};
}
