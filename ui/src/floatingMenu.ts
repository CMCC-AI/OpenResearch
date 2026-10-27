/** Keep composer menus inside the visible workspace, including its header. */
export function floatingMenuPlacement(anchor: { top: number; bottom: number; right: number }, viewport: { width: number; height: number }, topInset = 8) {
  const gap = 8;
  const width = Math.min(288, Math.max(0, viewport.width - gap * 2));
  const above = Math.max(0, anchor.top - topInset - gap);
  const below = Math.max(0, viewport.height - anchor.bottom - gap * 2);
  const upwards = above >= Math.min(320, below);
  return {
    position: "fixed" as const, width,
    left: Math.max(gap, Math.min(anchor.right - width, viewport.width - width - gap)),
    maxHeight: Math.min(400, upwards ? above : below),
    ...(upwards ? { bottom: viewport.height - anchor.top + gap } : { top: anchor.bottom + gap }),
  };
}
