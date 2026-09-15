/**
 * The Settings window's page, and its entry point.
 *
 * Its own entry, like every other page DevHub has. It was the last surface
 * that decided what it was at runtime: one `index.html` served both this
 * window and the shell window, and `?window=settings` was the switch. So this
 * page loaded the App Shell's code, took the App Shell's subscriptions, and
 * had to be told which of the two it was before it could render — and the
 * shell window had to refuse its own page's title, because the page could not
 * say which window it was in.
 *
 * None of that is a question any more. Which page this is, is which file main
 * loaded, and a page carries exactly the contract its own header states.
 *
 * What every DevHub page installs, installed here too: the palette it was
 * served wearing, the selection guard, and the root failure handler. Settings
 * draws what that handler catches in its own window (`SettingsApp`'s app
 * failure slot) rather than on the shell window's notices — a report about the
 * thing the person is looking at, drawn on a window they are not looking at,
 * is a report nobody reads. See `main/shell/publishAudience.ts`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SettingsApp } from "./SettingsApp";
import { installPalette } from "../shell/appearance";
import { installRootFailureHandler } from "../shell/failure";
import { PageBoundary } from "../shell/PageBoundary";
import { installSelectionGuard } from "../shell/selection";
import { WINDOW_TITLES } from "../ipc/windowTitles";

const container = document.getElementById("root");
if (!container) {
  throw new Error("the Settings page has no #root element");
}

// Installed outside React so no remount can drop any of them. The palette is
// one of these: the page was served wearing it, and this is only what keeps it
// current when a workbench changes theme.
installRootFailureHandler();
installSelectionGuard(document);
installPalette(document);

// Electron gives a window its page's title. Main names the window when it
// creates it, so the name it chose lasts only until this line — which is why
// the name is stated once, where both processes can read it.
document.title = WINDOW_TITLES.settings;

// One boundary per page, and this is where this one begins. It is the only
// catch React can reach — a component that throws while rendering takes the
// tree with it, and the window handler that would report it has nothing left
// to report into. See `PageBoundary.tsx`.
createRoot(container).render(
  <StrictMode>
    <PageBoundary>
      <SettingsApp />
    </PageBoundary>
  </StrictMode>,
);
