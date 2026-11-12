/** The viewer is the one `.player-root` on screen; fullscreen is a DOM affair, not store state. */
export function togglePlayerFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return;
  }
  const root = document.querySelector<HTMLElement>('.player-root');
  if (root) void root.requestFullscreen();
}
