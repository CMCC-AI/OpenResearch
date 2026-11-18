let scope = new AbortController();
export function cancelRuntimeRequests() {
  scope.abort(new DOMException("Workspace changed", "AbortError"));
  scope = new AbortController();
}

const retryDelaysMs = [400, 700, 1000, 1500];

/** Only a gateway response issued BEFORE forwarding may be retried. Network
 * errors and responses from the executor are never automatically replayed. */
export async function runtimeFetch(url: string, init?: RequestInit): Promise<Response> {
  const write = !["GET", "HEAD"].includes(init?.method?.toUpperCase() || "GET");
  const deadline = write ? Date.now() + 180000 : Infinity;
  const signal = init?.signal ? AbortSignal.any([scope.signal, init.signal]) : scope.signal;
  let attempt = 0;
  while (true) {
    signal.throwIfAborted();
    const response = await fetch(url, init);
    if (response.status !== 503 || response.headers.get("x-orx-runtime-pending") !== "1"
      || init?.body instanceof ReadableStream || init?.keepalive || Date.now() >= deadline) return response;
    await response.body?.cancel();
    const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)];
    attempt++;
    await pause(delay, signal);
  }
}

function pause(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
