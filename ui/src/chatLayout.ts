/** An existing empty-looking session is unresolved until history is available. */
export function isChatLayoutPending({
  mainView, embedded, hasMessages, busy, contentLoading, historyLoading,
}: {
  mainView: string;
  embedded: boolean;
  hasMessages: boolean;
  busy: boolean;
  contentLoading: boolean;
  historyLoading: boolean;
}): boolean {
  return mainView === "chat" && !embedded && !hasMessages && !busy
    && (contentLoading || historyLoading);
}
