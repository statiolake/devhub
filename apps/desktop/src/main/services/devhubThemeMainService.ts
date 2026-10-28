/**
 * VS Code's theme service, with the window splash in DevHub's theme.
 *
 * Upstream keeps one window splash — the colours and the part layout the last
 * workbench to save one was showing — and hands it to every window it loads,
 * which paints it before any of the workbench has run; the view behind the
 * page takes its background from it too. Every workbench wears the theme
 * DevHub names, so that splash is right as long as the theme has not changed
 * since it was saved. When it has (the settings changed while every
 * workbench was asleep, the appearance flipped, a profile's first start), the
 * window would open in the last theme's colours.
 *
 * So each save is stamped with the theme it was saved in, and a splash in any
 * other theme is replaced, on the way to a window, by one made from the theme
 * being worn. See `../shell/workbenchStartTheme.ts`.
 *
 * Composition: `ThemeMainService` does all of the work. Registered for
 * `IThemeMainService` in `codeMain.ts`; a VS Code bump re-checks the three
 * signatures below.
 */

import { ThemeMainService } from "code-oss-dev/out/vs/platform/theme/electron-main/themeMainServiceImpl.js";
import type { IPartsSplash } from "code-oss-dev/out/vs/platform/theme/common/themeService.js";
import type {
	ISingleFolderWorkspaceIdentifier,
	IWorkspaceIdentifier,
} from "code-oss-dev/out/vs/platform/workspace/common/workspace.js";
import {
	currentWorkbenchStart,
	splashForWorkbench,
	stampSplash,
} from "../shell/workbenchStartTheme.js";

type Workspace = IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier;

export class DevHubThemeMainService extends ThemeMainService {
	override saveWindowSplash(
		windowId: number | undefined,
		workspace: Workspace | undefined,
		splash: IPartsSplash,
	): void {
		super.saveWindowSplash(
			windowId,
			workspace,
			stampSplash(splash, currentWorkbenchStart()),
		);
	}

	override getWindowSplash(
		workspace: Workspace | undefined,
	): IPartsSplash | undefined {
		// DevHub's own splash has no layout and only the colours the page
		// paints without one; the rest of `colorInfo` is absent, which is what
		// the page reads as "none".
		return splashForWorkbench(
			super.getWindowSplash(workspace),
			currentWorkbenchStart(),
		) as IPartsSplash | undefined;
	}

	/**
	 * The ground of a view before its page has painted: the splash's, so the
	 * view and the page it is about to show are one colour.
	 */
	override getBackgroundColor(): string {
		if (!currentWorkbenchStart()) return super.getBackgroundColor();
		return (
			this.getWindowSplash(undefined)?.colorInfo.background ??
			super.getBackgroundColor()
		);
	}
}
