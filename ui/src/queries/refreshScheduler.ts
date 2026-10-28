/** Coalesce streaming events without postponing refresh forever during a reply. */
export function refreshScheduler(refresh: () => void, interval: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule() {
      timer ??= setTimeout(() => { timer = undefined; refresh(); }, interval);
    },
    cancel() { clearTimeout(timer); timer = undefined; },
  };
}
