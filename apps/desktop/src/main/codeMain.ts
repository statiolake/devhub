/*---------------------------------------------------------------------------------------------
 *  DevHub's copy of VS Code's main-process entry point.
 *
 *  Upstream: vscode/src/vs/code/electron-main/main.ts
 *  Pinned at: microsoft/vscode 8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8 (tag 1.129.1)
 *
 *  This file exists to substitute two things and nothing else. Keep it as close
 *  to upstream as possible; a VS Code bump re-applies exactly this list:
 *
 *    1. Imports are rebased from relative paths onto `code-oss-dev/out/...`,
 *       which is the compiled submodule.
 *    2. `CodeApplication` is `DevHubApplication` (../devhubApplication.ts),
 *       which registers DevHub's windows and dialog services.
 *    3. `bootstrapShell(...)` runs before `startup()`, so the App Shell window
 *       exists before the first workbench asks Electron for a window, and it
 *       is handed `IThemeMainService` so the window can be created in the
 *       colour theme the last session quit in. Nothing else in `startup()`
 *       changed.
 *    4. `IThemeMainService` is `DevHubThemeMainService`
 *       (./services/devhubThemeMainService.ts), which is upstream's service
 *       plus an announcement when a workbench saves its window splash.
 *    5. `ILifecycleMainService` is `DevHubLifecycleMainService`
 *       (./services/devhubLifecycleMainService.ts), which translates a
 *       workbench's "restart" into DevHub's terms instead of taking the whole
 *       application down with it. The substitution is here, at the
 *       registration, and not in `DevHubApplication.initServices`: `startup()`
 *       resolves `ILifecycleMainService` before `initServices` runs, so a
 *       later substitution would leave two lifecycle services side by side.
 *       For the same reason the startup-failure path below calls `app.exit`
 *       itself rather than `lifecycleMainService.kill`.
 *    6. `installAppFence()` runs before `startup()`, so the process settings
 *       VS Code writes straight onto `electron.app` — the proxy, the OS recent
 *       items, the Dock badge and menu, the protocol registration, the update
 *       path — stop at DevHub instead. See `shell/appFence.ts`.
 *    7. `--force-disable-user-env` is on, because DevHub resolves the login
 *       shell's environment itself and upstream's copy would be a second
 *       answer to the same question. See `resolveArgs`.
 *
 *  Everything else is upstream, including the copyright below.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'code-oss-dev/out/vs/platform/update/common/update.config.contribution.js';

import { app, dialog } from 'electron';
import { unlinkSync, promises } from 'fs';
import { URI } from 'code-oss-dev/out/vs/base/common/uri.js';
import { coalesce, distinct } from 'code-oss-dev/out/vs/base/common/arrays.js';
import { Promises, retry } from 'code-oss-dev/out/vs/base/common/async.js';
import { toErrorMessage } from 'code-oss-dev/out/vs/base/common/errorMessage.js';
import { ExpectedError, setUnexpectedErrorHandler } from 'code-oss-dev/out/vs/base/common/errors.js';
import { IPathWithLineAndColumn, isValidBasename, parseLineAndColumnAware, sanitizeFilePath } from 'code-oss-dev/out/vs/base/common/extpath.js';
import { Event } from 'code-oss-dev/out/vs/base/common/event.js';
import { getPathLabel } from 'code-oss-dev/out/vs/base/common/labels.js';
import { Schemas } from 'code-oss-dev/out/vs/base/common/network.js';
import { basename, join, resolve } from 'code-oss-dev/out/vs/base/common/path.js';
import { mark } from 'code-oss-dev/out/vs/base/common/performance.js';
import { IProcessEnvironment, isLinux, isMacintosh, isWindows, OS } from 'code-oss-dev/out/vs/base/common/platform.js';
import { cwd } from 'code-oss-dev/out/vs/base/common/process.js';
import { rtrim, trim } from 'code-oss-dev/out/vs/base/common/strings.js';
import { Promises as FSPromises } from 'code-oss-dev/out/vs/base/node/pfs.js';
import { ProxyChannel } from 'code-oss-dev/out/vs/base/parts/ipc/common/ipc.js';
import { Client as NodeIPCClient } from 'code-oss-dev/out/vs/base/parts/ipc/common/ipc.net.js';
import { connect as nodeIPCConnect, serve as nodeIPCServe, Server as NodeIPCServer, XDG_RUNTIME_DIR } from 'code-oss-dev/out/vs/base/parts/ipc/node/ipc.net.js';
import { DevHubApplication } from './devhubApplication.js';
import { bootstrapShell } from './shell/bootstrapShell.js';
import { installAppFence } from './shell/appFence.js';
import { appController } from './shell/appController.js';
import { localize } from 'code-oss-dev/out/vs/nls.js';
import { IConfigurationService } from 'code-oss-dev/out/vs/platform/configuration/common/configuration.js';
import { ConfigurationService } from 'code-oss-dev/out/vs/platform/configuration/common/configurationService.js';
import { IDiagnosticsMainService } from 'code-oss-dev/out/vs/platform/diagnostics/electron-main/diagnosticsMainService.js';
import { DiagnosticsService } from 'code-oss-dev/out/vs/platform/diagnostics/node/diagnosticsService.js';
import { NativeParsedArgs } from 'code-oss-dev/out/vs/platform/environment/common/argv.js';
import { EnvironmentMainService, IEnvironmentMainService } from 'code-oss-dev/out/vs/platform/environment/electron-main/environmentMainService.js';
import { addArg, parseMainProcessArgv } from 'code-oss-dev/out/vs/platform/environment/node/argvHelper.js';
import { createWaitMarkerFileSync } from 'code-oss-dev/out/vs/platform/environment/node/wait.js';
import { IFileService } from 'code-oss-dev/out/vs/platform/files/common/files.js';
import { FileService } from 'code-oss-dev/out/vs/platform/files/common/fileService.js';
import { DiskFileSystemProvider } from 'code-oss-dev/out/vs/platform/files/node/diskFileSystemProvider.js';
import { SyncDescriptor } from 'code-oss-dev/out/vs/platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from 'code-oss-dev/out/vs/platform/instantiation/common/instantiation.js';
import { InstantiationService } from 'code-oss-dev/out/vs/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from 'code-oss-dev/out/vs/platform/instantiation/common/serviceCollection.js';
import { ILaunchMainService } from 'code-oss-dev/out/vs/platform/launch/electron-main/launchMainService.js';
import { ILifecycleMainService } from 'code-oss-dev/out/vs/platform/lifecycle/electron-main/lifecycleMainService.js';
import { BufferLogger } from 'code-oss-dev/out/vs/platform/log/common/bufferLog.js';
import { ConsoleMainLogger, getLogLevel, ILoggerService, ILogService, isDevConsoleLogForwardingEnabled, registerDevConsoleLogForwarder } from 'code-oss-dev/out/vs/platform/log/common/log.js';
import product from 'code-oss-dev/out/vs/platform/product/common/product.js';
import { IProductService } from 'code-oss-dev/out/vs/platform/product/common/productService.js';
import { IProtocolMainService } from 'code-oss-dev/out/vs/platform/protocol/electron-main/protocol.js';
import { ProtocolMainService } from 'code-oss-dev/out/vs/platform/protocol/electron-main/protocolMainService.js';
import { ITunnelService } from 'code-oss-dev/out/vs/platform/tunnel/common/tunnel.js';
import { TunnelService } from 'code-oss-dev/out/vs/platform/tunnel/node/tunnelService.js';
import { IRequestService } from 'code-oss-dev/out/vs/platform/request/common/request.js';
import { RequestService } from 'code-oss-dev/out/vs/platform/request/electron-utility/requestService.js';
import { ISignService } from 'code-oss-dev/out/vs/platform/sign/common/sign.js';
import { SignService } from 'code-oss-dev/out/vs/platform/sign/node/signService.js';
import { IStateReadService, IStateService } from 'code-oss-dev/out/vs/platform/state/node/state.js';
import { NullTelemetryService } from 'code-oss-dev/out/vs/platform/telemetry/common/telemetryUtils.js';
import { IThemeMainService } from 'code-oss-dev/out/vs/platform/theme/electron-main/themeMainService.js';
import { IUserDataProfilesMainService, UserDataProfilesMainService } from 'code-oss-dev/out/vs/platform/userDataProfile/electron-main/userDataProfile.js';
import { IPolicyService, NullPolicyService } from 'code-oss-dev/out/vs/platform/policy/common/policy.js';
import { NativePolicyService } from 'code-oss-dev/out/vs/platform/policy/node/nativePolicyService.js';
import { FilePolicyService } from 'code-oss-dev/out/vs/platform/policy/common/filePolicyService.js';
import { MultiplexPolicyService } from 'code-oss-dev/out/vs/platform/policy/common/multiplexPolicyService.js';
import { GITHUB_COPILOT_MACOS_BUNDLE_ID, GITHUB_COPILOT_WIN32_POLICY_NAME, GITHUB_COPILOT_WIN32_REGISTRY_PATH, INativeManagedSettingsService, IFileManagedSettingsService, MANAGED_SETTINGS_FILE_NAME, MANAGED_SETTINGS_LINUX_FILE_PATH, MANAGED_SETTINGS_MACOS_FILE_PATH, MANAGED_SETTINGS_WINDOWS_DIR, NullNativeManagedSettingsService, NullFileManagedSettingsService } from 'code-oss-dev/out/vs/platform/policy/common/copilotManagedSettings.js';
import { FileManagedSettingsService } from 'code-oss-dev/out/vs/platform/policy/common/fileManagedSettingsService.js';
import { NativeManagedSettingsService } from 'code-oss-dev/out/vs/platform/policy/node/nativeManagedSettingsService.js';
import { DisposableStore } from 'code-oss-dev/out/vs/base/common/lifecycle.js';
import { IUriIdentityService } from 'code-oss-dev/out/vs/platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from 'code-oss-dev/out/vs/platform/uriIdentity/common/uriIdentityService.js';
import { ILoggerMainService, LoggerMainService } from 'code-oss-dev/out/vs/platform/log/electron-main/loggerService.js';
import { LogService } from 'code-oss-dev/out/vs/platform/log/common/logService.js';
import { massageMessageBoxOptions } from 'code-oss-dev/out/vs/platform/dialogs/common/dialogs.js';
import { SaveStrategy, StateService } from 'code-oss-dev/out/vs/platform/state/node/stateService.js';
import { FileUserDataProvider } from 'code-oss-dev/out/vs/platform/userData/common/fileUserDataProvider.js';
import { addUNCHostToAllowlist, getUNCHost } from 'code-oss-dev/out/vs/base/node/unc.js';
import { DevHubThemeMainService } from './services/devhubThemeMainService.js';
import { DevHubLifecycleMainService } from './services/devhubLifecycleMainService.js';
import { LINUX_SYSTEM_POLICY_FILE_PATH } from 'code-oss-dev/out/vs/base/common/policy.js';

/**
 * The main VS Code entry point.
 *
 * Note: This class can exist more than once for example when VS Code is already
 * running and a second instance is started from the command line. It will always
 * try to communicate with an existing instance to prevent that 2 VS Code instances
 * are running at the same time.
 */
class CodeMain {

	main(): void {
		try {
			// DevHub: from here on the process belongs to the workbench world,
			// and the workbench world does not get to write DevHub's process
			// settings. DevHub's own `app.setPath` calls are in `main.ts`,
			// which has finished by the time this module is imported.
			installAppFence();
			this.startup();
		} catch (error) {
			console.error(error.message);
			app.exit(1);
		}
	}

	private async startup(): Promise<void> {

		// Set the error handler early enough so that we are not getting the
		// default electron error dialog popping up
		setUnexpectedErrorHandler(err => console.error(err));

		// Create services
		const [instantiationService, instanceEnvironment, environmentMainService, configurationService, stateMainService, bufferLogger, productService, userDataProfilesMainService] = this.createServices();

		try {

			// Init services
			try {
				await this.initServices(environmentMainService, userDataProfilesMainService, configurationService, stateMainService, productService);
			} catch (error) {

				// Show a dialog for errors that can be resolved by the user
				this.handleStartupDataDirError(environmentMainService, productService, error);

				throw error;
			}

			// Startup
			await instantiationService.invokeFunction(async accessor => {
				const logService = accessor.get(ILogService);
				const lifecycleMainService = accessor.get(ILifecycleMainService);
				const fileService = accessor.get(IFileService);
				const loggerService = accessor.get(ILoggerService);

				// Create the main IPC server by trying to be the server
				// If this throws an error it means we are not the first
				// instance of VS Code running and so we would quit.
				const mainProcessNodeIpcServer = await this.claimInstance(logService, environmentMainService, lifecycleMainService, instantiationService, productService, true);

				// Write a lockfile to indicate an instance is running
				// (https://github.com/microsoft/vscode/issues/127861#issuecomment-877417451)
				FSPromises.writeFile(environmentMainService.mainLockfile, String(process.pid)).catch(err => {
					logService.warn(`app#startup(): Error writing main lockfile: ${err.stack}`);
				});

				// Delay creation of spdlog for perf reasons (https://github.com/microsoft/vscode/issues/72906)
				bufferLogger.logger = loggerService.createLogger('main', { name: localize('mainLog', "Main") });

				// Lifecycle
				Event.once(lifecycleMainService.onWillShutdown)(evt => {
					fileService.dispose();
					configurationService.dispose();
					evt.join('instanceLockfile', promises.unlink(environmentMainService.mainLockfile).catch(() => { /* ignored */ }));
				});

				// Check if Inno Setup is running. Briefly wait for the updating mutex to be released before refusing to launch.
				const innoSetupActive = await this.checkInnoSetupMutex(productService, logService);
				if (innoSetupActive) {
					const message = `${productService.nameShort} is currently being updated. Please wait for the update to complete before launching.`;
					instantiationService.invokeFunction(this.quit, new Error(message));
					return;
				}

				// DevHub: the App Shell window must exist before the first workbench
				// window is asked for, because that request is what becomes a view
				// inside it.
				// A fresh accessor: `accessor` above is only valid for the synchronous
				// part of its own invocation, and this point is several awaits later.
				await bootstrapShell(environmentMainService.userDataPath, environmentMainService.args, instantiationService.invokeFunction(a => a.get(IThemeMainService)));

				const application = instantiationService.createInstance(DevHubApplication, mainProcessNodeIpcServer, instanceEnvironment);
				await application.startup();

				// DevHub: everything the App Shell projects is available once the
				// services behind it are. Until then the page shows "Connecting…"
				// rather than an empty shell that looks like a state.
				appController().markReady();
				return;
			});
		} catch (error) {
			instantiationService.invokeFunction(this.quit, error);
		}
	}

	private createServices(): [IInstantiationService, IProcessEnvironment, IEnvironmentMainService, ConfigurationService, StateService, BufferLogger, IProductService, UserDataProfilesMainService] {
		const services = new ServiceCollection();
		const disposables = new DisposableStore();
		process.once('exit', () => disposables.dispose());

		// Product
		const productService = { _serviceBrand: undefined, ...product };
		services.set(IProductService, productService);

		// Environment
		const environmentMainService = new EnvironmentMainService(this.resolveArgs(), productService);
		const instanceEnvironment = this.patchEnvironment(environmentMainService); // Patch `process.env` with the instance's environment
		services.set(IEnvironmentMainService, environmentMainService);

		// Logger
		const loggerService = new LoggerMainService(getLogLevel(environmentMainService), environmentMainService.logsHome);
		services.set(ILoggerMainService, loggerService);

		// Log: We need to buffer the spdlog logs until we are sure
		// we are the only instance running, otherwise we'll have concurrent
		// log file access on Windows (https://github.com/microsoft/vscode/issues/41218)
		const bufferLogger = new BufferLogger(loggerService.getLogLevel());
		const logService = disposables.add(new LogService(bufferLogger, [new ConsoleMainLogger(loggerService.getLogLevel())]));
		if (!environmentMainService.isBuilt && isDevConsoleLogForwardingEnabled) {
			disposables.add(registerDevConsoleLogForwarder(logService));
		}
		services.set(ILogService, logService);

		// Files
		const fileService = new FileService(logService);
		services.set(IFileService, fileService);
		const diskFileSystemProvider = new DiskFileSystemProvider(logService);
		fileService.registerProvider(Schemas.file, diskFileSystemProvider);

		// URI Identity
		const uriIdentityService = new UriIdentityService(fileService);
		services.set(IUriIdentityService, uriIdentityService);

		// State
		const stateService = new StateService(SaveStrategy.DELAYED, environmentMainService, logService, fileService);
		services.set(IStateReadService, stateService);
		services.set(IStateService, stateService);

		// User Data Profiles
		const userDataProfilesMainService = new UserDataProfilesMainService(stateService, uriIdentityService, environmentMainService, fileService, logService, productService);
		services.set(IUserDataProfilesMainService, userDataProfilesMainService);

		// Use FileUserDataProvider for user data to
		// enable atomic read / write operations.
		fileService.registerProvider(Schemas.vscodeUserData, new FileUserDataProvider(Schemas.file, diskFileSystemProvider, Schemas.vscodeUserData, userDataProfilesMainService, uriIdentityService, logService));

		// Policy
		let policyService: IPolicyService | undefined;
		const policyProductName = isWindows
			? (productService.parentPolicyConfig?.win32RegValueName ?? productService.win32RegValueName)
			: (productService.parentPolicyConfig?.darwinBundleIdentifier ?? productService.darwinBundleIdentifier);
		const policyServices: IPolicyService[] = [];
		if (isWindows && policyProductName) {
			policyServices.push(disposables.add(new NativePolicyService(logService, policyProductName)));
		} else if (isMacintosh && policyProductName) {
			policyServices.push(disposables.add(new NativePolicyService(logService, policyProductName)));
		} else if (isLinux) {
			policyServices.push(disposables.add(new FilePolicyService(URI.file(LINUX_SYSTEM_POLICY_FILE_PATH), fileService, logService)));
		} else if (environmentMainService.policyFile) {
			policyServices.push(disposables.add(new FilePolicyService(environmentMainService.policyFile, fileService, logService)));
		}

		let nativeManagedSettingsService: NativeManagedSettingsService | undefined;
		if (isWindows) {
			nativeManagedSettingsService = disposables.add(new NativeManagedSettingsService(logService, GITHUB_COPILOT_WIN32_POLICY_NAME, { registryPath: GITHUB_COPILOT_WIN32_REGISTRY_PATH }));
		} else if (isMacintosh) {
			nativeManagedSettingsService = disposables.add(new NativeManagedSettingsService(logService, GITHUB_COPILOT_MACOS_BUNDLE_ID));
		}
		if (nativeManagedSettingsService) {
			services.set(INativeManagedSettingsService, nativeManagedSettingsService);
		} else {
			services.set(INativeManagedSettingsService, new NullNativeManagedSettingsService());
		}

		// File-based managed settings
		let fileManagedSettingsPath: string | undefined;
		if (isWindows) {
			const programFiles = process.env['ProgramFiles'];
			if (programFiles) {
				fileManagedSettingsPath = join(programFiles, MANAGED_SETTINGS_WINDOWS_DIR, MANAGED_SETTINGS_FILE_NAME);
			}
		} else if (isMacintosh) {
			fileManagedSettingsPath = MANAGED_SETTINGS_MACOS_FILE_PATH;
		} else if (isLinux) {
			fileManagedSettingsPath = MANAGED_SETTINGS_LINUX_FILE_PATH;
		}
		if (fileManagedSettingsPath) {
			const fileManagedSettingsService = disposables.add(new FileManagedSettingsService(URI.file(fileManagedSettingsPath), fileService, logService));
			services.set(IFileManagedSettingsService, fileManagedSettingsService);
		} else {
			services.set(IFileManagedSettingsService, new NullFileManagedSettingsService());
		}

		if (policyServices.length > 1) {
			policyService = disposables.add(new MultiplexPolicyService(policyServices, logService));
		} else if (policyServices.length === 1) {
			policyService = policyServices[0];
		} else {
			policyService = new NullPolicyService();
		}
		services.set(IPolicyService, policyService);

		// Configuration
		const configurationService = new ConfigurationService(userDataProfilesMainService.defaultProfile.settingsResource, fileService, policyService, logService);
		services.set(IConfigurationService, configurationService);

		// Lifecycle
		services.set(ILifecycleMainService, new SyncDescriptor(DevHubLifecycleMainService, undefined, false));

		// Request
		services.set(IRequestService, new SyncDescriptor(RequestService, undefined, true));

		// Themes
		services.set(IThemeMainService, new SyncDescriptor(DevHubThemeMainService));

		// Signing
		services.set(ISignService, new SyncDescriptor(SignService, undefined, false /* proxied to other processes */));

		// Tunnel
		services.set(ITunnelService, new SyncDescriptor(TunnelService));

		// Protocol (instantiated early and not using sync descriptor for security reasons)
		services.set(IProtocolMainService, new ProtocolMainService(environmentMainService, userDataProfilesMainService, logService));

		return [new InstantiationService(services, true), instanceEnvironment, environmentMainService, configurationService, stateService, bufferLogger, productService, userDataProfilesMainService];
	}

	private patchEnvironment(environmentMainService: IEnvironmentMainService): IProcessEnvironment {
		const instanceEnvironment: IProcessEnvironment = {
			VSCODE_IPC_HOOK: environmentMainService.mainIPCHandle
		};

		['VSCODE_NLS_CONFIG', 'VSCODE_PORTABLE'].forEach(key => {
			const value = process.env[key];
			if (typeof value === 'string') {
				instanceEnvironment[key] = value;
			}
		});

		Object.assign(process.env, instanceEnvironment);

		return instanceEnvironment;
	}

	private async initServices(environmentMainService: IEnvironmentMainService, userDataProfilesMainService: UserDataProfilesMainService, configurationService: ConfigurationService, stateService: StateService, productService: IProductService): Promise<void> {
		await Promises.settled<unknown>([

			// Environment service (paths)
			Promise.all<string | undefined>([
				this.allowWindowsUNCPath(environmentMainService.extensionsPath), // enable extension paths on UNC drives...
				environmentMainService.codeCachePath,							 // ...other user-data-derived paths should already be enlisted from `main.js`
				environmentMainService.logsHome.with({ scheme: Schemas.file }).fsPath,
				userDataProfilesMainService.defaultProfile.globalStorageHome.with({ scheme: Schemas.file }).fsPath,
				environmentMainService.workspaceStorageHome.with({ scheme: Schemas.file }).fsPath,
				environmentMainService.localHistoryHome.with({ scheme: Schemas.file }).fsPath,
				environmentMainService.backupHome
			].map(path => path ? promises.mkdir(path, { recursive: true }) : undefined)),

			// State service
			stateService.init(),

			// Configuration service
			configurationService.initialize()
		]);

		// Initialize user data profiles after initializing the state
		userDataProfilesMainService.init();
	}

	private allowWindowsUNCPath(path: string): string {
		if (isWindows) {
			const host = getUNCHost(path);
			if (host) {
				addUNCHostToAllowlist(host);
			}
		}

		return path;
	}

	private async claimInstance(logService: ILogService, environmentMainService: IEnvironmentMainService, lifecycleMainService: ILifecycleMainService, instantiationService: IInstantiationService, productService: IProductService, retry: boolean): Promise<NodeIPCServer> {

		// Try to setup a server for running. If that succeeds it means
		// we are the first instance to startup. Otherwise it is likely
		// that another instance is already running.
		let mainProcessNodeIpcServer: NodeIPCServer;
		try {
			mark('code/willStartMainServer');
			mainProcessNodeIpcServer = await nodeIPCServe(environmentMainService.mainIPCHandle);
			mark('code/didStartMainServer');
			Event.once(lifecycleMainService.onWillShutdown)(() => mainProcessNodeIpcServer.dispose());
		} catch (error) {

			// Handle unexpected errors (the only expected error is EADDRINUSE that
			// indicates another instance of VS Code is running)
			if (error.code !== 'EADDRINUSE') {

				// Show a dialog for errors that can be resolved by the user
				this.handleStartupDataDirError(environmentMainService, productService, error);

				// Any other runtime error is just printed to the console
				throw error;
			}

			// there's a running instance, let's connect to it
			let client: NodeIPCClient<string>;
			try {
				client = await nodeIPCConnect(environmentMainService.mainIPCHandle, 'main');
			} catch (error) {

				// Handle unexpected connection errors by showing a dialog to the user
				if (!retry || isWindows || error.code !== 'ECONNREFUSED') {
					if (error.code === 'EPERM') {
						this.showStartupWarningDialog(
							localize('secondInstanceAdmin', "Another instance of {0} is already running as administrator.", productService.nameShort),
							localize('secondInstanceAdminDetail', "Please close the other instance and try again."),
							productService
						);
					}

					throw error;
				}

				// it happens on Linux and OS X that the pipe is left behind
				// let's delete it, since we can't connect to it and then
				// retry the whole thing
				try {
					unlinkSync(environmentMainService.mainIPCHandle);
				} catch (error) {
					logService.warn('Could not delete obsolete instance handle', error);

					throw error;
				}

				return this.claimInstance(logService, environmentMainService, lifecycleMainService, instantiationService, productService, false);
			}

			// Tests from CLI require to be the only instance currently
			if (environmentMainService.extensionTestsLocationURI && !environmentMainService.debugExtensionHost.break) {
				const msg = `Running extension tests from the command line is currently only supported if no other instance of ${productService.nameShort} is running.`;
				logService.error(msg);
				client.dispose();

				throw new Error(msg);
			}

			// Show a warning dialog after some timeout if it takes long to talk to the other instance
			// Skip this if we are running with --wait where it is expected that we wait for a while.
			// Also skip when gathering diagnostics (--status) which can take a longer time.
			let startupWarningDialogHandle: Timeout | undefined = undefined;
			if (!environmentMainService.args.wait && !environmentMainService.args.status) {
				startupWarningDialogHandle = setTimeout(() => {
					this.showStartupWarningDialog(
						localize('secondInstanceNoResponse', "Another instance of {0} is running but not responding", productService.nameShort),
						localize('secondInstanceNoResponseDetail', "Please close all other instances and try again."),
						productService
					);
				}, 10000);
			}

			const otherInstanceLaunchMainService = ProxyChannel.toService<ILaunchMainService>(client.getChannel('launch'), { disableMarshalling: true });
			const otherInstanceDiagnosticsMainService = ProxyChannel.toService<IDiagnosticsMainService>(client.getChannel('diagnostics'), { disableMarshalling: true });

			// Process Info
			if (environmentMainService.args.status) {
				return instantiationService.invokeFunction(async () => {
					const diagnosticsService = new DiagnosticsService(NullTelemetryService, productService);
					const mainDiagnostics = await otherInstanceDiagnosticsMainService.getMainDiagnostics();
					const remoteDiagnostics = await otherInstanceDiagnosticsMainService.getRemoteDiagnostics({ includeProcesses: true, includeWorkspaceMetadata: true });
					const diagnostics = await diagnosticsService.getDiagnostics(mainDiagnostics, remoteDiagnostics);
					console.log(diagnostics);

					throw new ExpectedError();
				});
			}

			// Windows: allow to set foreground
			if (isWindows) {
				await this.windowsAllowSetForegroundWindow(otherInstanceLaunchMainService, logService);
			}

			// Send environment over...
			logService.trace('Sending env to running instance...');
			await otherInstanceLaunchMainService.start(environmentMainService.args, process.env as IProcessEnvironment);

			// Cleanup
			client.dispose();

			// Now that we started, make sure the warning dialog is prevented
			if (startupWarningDialogHandle) {
				clearTimeout(startupWarningDialogHandle);
			}

			throw new ExpectedError('Sent env to running instance. Terminating...');
		}

		// Print --status usage info
		if (environmentMainService.args.status) {
			console.log(localize('statusWarning', "Warning: The --status argument can only be used if {0} is already running. Please run it again after {0} has started.", productService.nameShort));

			throw new ExpectedError('Terminating...');
		}

		// Set the VSCODE_PID variable here when we are sure we are the first
		// instance to startup. Otherwise we would wrongly overwrite the PID
		process.env['VSCODE_PID'] = String(process.pid);

		return mainProcessNodeIpcServer;
	}

	private handleStartupDataDirError(environmentMainService: IEnvironmentMainService, productService: IProductService, error: NodeJS.ErrnoException): void {
		if (error.code === 'EACCES' || error.code === 'EPERM') {
			const directories = coalesce([environmentMainService.userDataPath, environmentMainService.extensionsPath, XDG_RUNTIME_DIR]).map(folder => getPathLabel(URI.file(folder), { os: OS, tildify: environmentMainService }));

			this.showStartupWarningDialog(
				localize('startupDataDirError', "Unable to write program user data."),
				localize('startupUserDataAndExtensionsDirErrorDetail', "{0}\n\nPlease make sure the following directories are writeable:\n\n{1}", toErrorMessage(error), directories.join('\n')),
				productService
			);
		}
	}

	private showStartupWarningDialog(message: string, detail: string, productService: IProductService): void {

		// use sync variant here because we likely exit after this method
		// due to startup issues and otherwise the dialog seems to disappear
		// https://github.com/microsoft/vscode/issues/104493

		dialog.showMessageBoxSync(massageMessageBoxOptions({
			type: 'warning',
			buttons: [localize({ key: 'close', comment: ['&& denotes a mnemonic'] }, "&&Close")],
			message,
			detail
		}, productService).options);
	}

	private async windowsAllowSetForegroundWindow(launchMainService: ILaunchMainService, logService: ILogService): Promise<void> {
		if (isWindows) {
			const processId = await launchMainService.getMainProcessId();

			logService.trace('Sending some foreground love to the running instance:', processId);

			try {
				(await import('windows-foreground-love')).allowSetForegroundWindow(processId);
			} catch (error) {
				logService.error(error);
			}
		}
	}

	private quit(accessor: ServicesAccessor, reason?: ExpectedError | Error): void {
		const logService = accessor.get(ILogService);

		let exitCode = 0;

		if (reason) {
			if ((reason as ExpectedError).isExpected) {
				if (reason.message) {
					logService.trace(reason.message);
				}
			} else {
				exitCode = 1; // signal error to the outside

				if (reason.stack) {
					logService.error(reason.stack);
				} else {
					logService.error(`Startup error: ${reason.toString()}`);
				}
			}
		}

		// DevHub calls `app.exit` here rather than `lifecycleMainService.kill`.
		// `kill` is the answer to "a workbench died", and DevHub's answer to
		// that is to keep running and rebuild the workbench. This is the other
		// case: DevHub itself never came up, so there is nothing to keep
		// alive, and exiting is the whole of what has to happen.
		app.exit(exitCode);
	}

	private async checkInnoSetupMutex(productService: IProductService, logService: ILogService): Promise<boolean> {
		if (!(isWindows && productService.win32MutexName && productService.win32VersionedUpdate)) {
			return false;
		}

		try {
			const updatingMutexName = `${productService.win32MutexName}-updating`;
			const mutex = await import('@vscode/windows-mutex');

			if (!mutex.isActive(updatingMutexName)) {
				return false;
			}

			// Wait briefly for setup teardown to release the mutex; Inno's `nowait postinstall` runcode can race the setup process exit.
			const pollIntervalMs = 250, retries = 120; // 30s total
			logService.info(`checkInnoSetupMutex: ${updatingMutexName} is held, waiting up to ${(pollIntervalMs * retries) / 1000}s for setup to finish...`);
			const start = Date.now();
			try {
				await retry(async () => {
					if (mutex.isActive(updatingMutexName)) {
						throw new Error('mutex still held');
					}
				}, pollIntervalMs, retries);
				logService.info(`checkInnoSetupMutex: ${updatingMutexName} released after ${Date.now() - start}ms`);
				return false;
			} catch {
				logService.warn(`checkInnoSetupMutex: ${updatingMutexName} still held after ${Date.now() - start}ms, giving up`);
				return true;
			}
		} catch (error) {
			logService.error('Failed to check Inno Setup mutex:', error);
			return false;
		}
	}

	//#region Command line arguments utilities

	private resolveArgs(): NativeParsedArgs {

		// Parse arguments
		const args = this.validatePaths(parseMainProcessArgv(process.argv));

		// DevHub: DevHub imports the login shell's environment itself, before
		// `startup()`, and puts it on `process.env` — see
		// `shell/loginEnvironment.ts`. Upstream would spawn a second login shell
		// to reach the same answer, ask it from an environment still carrying
		// `VSCODE_DEV`, and skip the whole thing whenever `VSCODE_CLI` is set,
		// which `dev.sh` sets on every source run. One import means one answer,
		// so upstream's is turned off rather than left to disagree with DevHub's.
		args['force-disable-user-env'] = true;

		if (args.wait && !args.waitMarkerFilePath) {
			// If we are started with --wait create a random temporary file
			// and pass it over to the starting instance. We can use this file
			// to wait for it to be deleted to monitor that the edited file
			// is closed and then exit the waiting process.
			//
			// Note: we are not doing this if the wait marker has been already
			// added as argument. This can happen if VS Code was started from CLI.
			const waitMarkerFilePath = createWaitMarkerFileSync(args.verbose);
			if (waitMarkerFilePath) {
				addArg(process.argv, '--waitMarkerFilePath', waitMarkerFilePath);
				args.waitMarkerFilePath = waitMarkerFilePath;
			}
		}

		if (args.chat) {
			if (args.chat['new-window']) {
				// Apply `--new-window` flag to the main arguments
				args['new-window'] = true;
			} else if (args.chat['reuse-window']) {
				// Apply `--reuse-window` flag to the main arguments
				args['reuse-window'] = true;
			} else if (args.chat['profile']) {
				// Apply `--profile` flag to the main arguments
				args['profile'] = args.chat['profile'];
			} else {
				// Unless we are started with specific instructions about
				// new windows or reusing existing ones, always take the
				// current working directory as workspace to open.
				args._ = [cwd()];
			}
		}

		return args;
	}

	private validatePaths(args: NativeParsedArgs): NativeParsedArgs {

		// Track URLs if they're going to be used
		if (args['open-url']) {
			args._urls = args._;
			args._ = [];
		}

		// Normalize paths and watch out for goto line mode
		if (!args['remote']) {
			const paths = this.doValidatePaths(args._, args.goto);
			args._ = paths;
		}

		return args;
	}

	private doValidatePaths(args: string[], gotoLineMode?: boolean): string[] {
		const currentWorkingDir = cwd();
		const result = args.map(arg => {
			let pathCandidate = String(arg);

			let parsedPath: IPathWithLineAndColumn | undefined = undefined;
			if (gotoLineMode) {
				parsedPath = parseLineAndColumnAware(pathCandidate);
				pathCandidate = parsedPath.path;
			}

			if (pathCandidate) {
				pathCandidate = this.preparePath(currentWorkingDir, pathCandidate);
			}

			const sanitizedFilePath = sanitizeFilePath(pathCandidate, currentWorkingDir);

			const filePathBasename = basename(sanitizedFilePath);
			if (filePathBasename /* can be empty if code is opened on root */ && !isValidBasename(filePathBasename)) {
				return null; // do not allow invalid file names
			}

			if (gotoLineMode && parsedPath) {
				parsedPath.path = sanitizedFilePath;

				return this.toPath(parsedPath);
			}

			return sanitizedFilePath;
		});

		const caseInsensitive = isWindows || isMacintosh;
		const distinctPaths = distinct(result, path => path && caseInsensitive ? path.toLowerCase() : (path || ''));

		return coalesce(distinctPaths);
	}

	private preparePath(cwd: string, path: string): string {

		// Trim trailing quotes
		if (isWindows) {
			path = rtrim(path, '"'); // https://github.com/microsoft/vscode/issues/1498
		}

		// Trim whitespaces
		path = trim(trim(path, ' '), '\t');

		if (isWindows) {

			// Resolve the path against cwd if it is relative
			path = resolve(cwd, path);

			// Trim trailing '.' chars on Windows to prevent invalid file names
			path = rtrim(path, '.');
		}

		return path;
	}

	private toPath(pathWithLineAndCol: IPathWithLineAndColumn): string {
		const segments = [pathWithLineAndCol.path];

		if (typeof pathWithLineAndCol.line === 'number') {
			segments.push(String(pathWithLineAndCol.line));
		}

		if (typeof pathWithLineAndCol.column === 'number') {
			segments.push(String(pathWithLineAndCol.column));
		}

		return segments.join(':');
	}

	//#endregion
}

// Main Startup
const code = new CodeMain();
code.main();
