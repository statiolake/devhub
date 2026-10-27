/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: there is no secondary side bar. The side of the workbench it would
// take is where DevHub's own panes (the Agents) are, so everything it would
// hold is in the primary side bar instead (docs/window-and-pages.md).
//
// The patch (patches/vscode/0012-no-secondary-side-bar.patch) does the parts
// nothing outside the workbench can reach: the layout never shows or
// maximizes the part, a view container registered for it has the primary side
// bar as its default location (Chat, an extension's `secondarySidebar`
// contribution), and the menus and Command Palette entries that would show
// it or move something into it are gone.
//
// This contribution does the rest:
//
// - a view container that is in the secondary side bar anyway — a location
//   saved before DevHub had this, a view moved there by a command or an
//   extension (`vscode.moveViews`, "Move Panel Views To Secondary Side Bar"),
//   another window's move arriving through the shared storage — is moved to
//   the primary side bar, saved the way a person's move is;
// - the commands that showed or focused the secondary side bar, which a
//   keybinding of the person's or an extension may still run, do that to the
//   primary side bar.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../common/views.js';

/** The `reason` DevHub's moves are logged with. */
export const NO_AUXILIARY_BAR_MOVE_REASON = 'devhubNoAuxiliaryBar';

/** Move every view container in the secondary side bar to the end of the primary side bar, in their order; returns them. */
export function moveAuxiliaryBarToSidebar(viewDescriptorService: Pick<IViewDescriptorService, 'getViewContainersByLocation' | 'moveViewContainerToLocation'>): ViewContainer[] {
	const containers = viewDescriptorService.getViewContainersByLocation(ViewContainerLocation.AuxiliaryBar);
	for (const container of containers) {
		viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.Sidebar, undefined, NO_AUXILIARY_BAR_MOVE_REASON);
	}
	return containers;
}

export class DevhubNoAuxiliaryBar extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.devhubNoAuxiliaryBar';

	private moveScheduled = false;

	constructor(
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
	) {
		super();

		// Before any part is created (BlockStartup), so nothing has opened in it yet.
		moveAuxiliaryBarToSidebar(this.viewDescriptorService);

		// Afterwards, a microtask after whatever put it there: the other
		// listeners of that same event (the composite bars, the views service)
		// see the container arrive before they see it leave.
		this._register(this.viewDescriptorService.onDidChangeViewContainers(({ added }) => {
			if (added.some(({ location }) => location === ViewContainerLocation.AuxiliaryBar)) {
				this.scheduleMove();
			}
		}));
		this._register(this.viewDescriptorService.onDidChangeContainerLocation(({ to }) => {
			if (to === ViewContainerLocation.AuxiliaryBar) {
				this.scheduleMove();
			}
		}));
	}

	private scheduleMove(): void {
		if (this.moveScheduled) {
			return;
		}
		this.moveScheduled = true;
		queueMicrotask(() => {
			this.moveScheduled = false;
			if (!this._store.isDisposed) {
				moveAuxiliaryBarToSidebar(this.viewDescriptorService);
			}
		});
	}
}

registerWorkbenchContribution2(DevhubNoAuxiliaryBar.ID, DevhubNoAuxiliaryBar, WorkbenchPhase.BlockStartup);

// The newest registration of a command id is the one that runs, and these
// replace the ones in browser/parts/auxiliarybar/auxiliaryBarActions.ts,
// which the workbench imports before any DevHub contribution.
CommandsRegistry.registerCommand('workbench.action.toggleAuxiliaryBar', accessor => accessor.get(ICommandService).executeCommand('workbench.action.toggleSidebarVisibility'));
CommandsRegistry.registerCommand('workbench.action.focusAuxiliaryBar', accessor => accessor.get(ICommandService).executeCommand('workbench.action.focusSideBar'));
