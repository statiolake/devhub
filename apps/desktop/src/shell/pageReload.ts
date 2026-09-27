/**
 * Load this page again: the way back from a page that stopped
 * (`PageBoundary`). Its own module so a test can see it asked, since a
 * document cannot reload itself in jsdom.
 */
export function reloadPage(): void {
  window.location.reload();
}
