/**
 * VS Code's theme service, with one addition: it says so out loud.
 *
 * Upstream stores the window splash and offers `getWindowSplash()` to read it
 * back, but nothing to subscribe to — the only consumer is a window being
 * created, which reads it once. DevHub has a window that is already open and
 * has to recolour while a workbench changes theme underneath it, so the write
 * is announced as well as stored.
 *
 * This is composition, not a copy: `ThemeMainService` does all of the work and
 * this class only forwards. Registered for `IThemeMainService` in `codeMain.ts`
 * in place of upstream's own registration — that line is what a VS Code bump
 * has to re-check, along with the signature of `saveWindowSplash`.
 */

import { ThemeMainService } from "code-oss-dev/out/vs/platform/theme/electron-main/themeMainServiceImpl.js";
import type { IPartsSplash } from "code-oss-dev/out/vs/platform/theme/common/themeService.js";
import type {
	ISingleFolderWorkspaceIdentifier,
	IWorkspaceIdentifier,
} from "code-oss-dev/out/vs/platform/workspace/common/workspace.js";
import { shellTheme } from "../shell/shellTheme.js";

export class DevHubThemeMainService extends ThemeMainService {
	override saveWindowSplash(
		windowId: number | undefined,
		workspace:
			| IWorkspaceIdentifier
			| ISingleFolderWorkspaceIdentifier
			| undefined,
		splash: IPartsSplash,
	): void {
		super.saveWindowSplash(windowId, workspace, splash);
		shellTheme().reportSplash(windowId, splash);
	}
}
