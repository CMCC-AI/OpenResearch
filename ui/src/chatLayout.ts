/** Layout follows the conversation, not transient loading/error states. */
export function isNewChatLayout({
  mainView, embedded, activeId, historyLoaded, hasMessages, busy, sideChat,
}: {
  mainView: string;
  embedded: boolean;
  activeId: string | null;
  historyLoaded: boolean;
  hasMessages: boolean;
  busy: boolean;
  sideChat: boolean;
}): boolean {
  return mainView === "chat" && !embedded && !hasMessages && !busy && !sideChat
    && (!activeId || historyLoaded);
}

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
