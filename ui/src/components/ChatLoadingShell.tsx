/** Neutral startup shell: never mount legacy conversation controls while restoring history. */
export function ChatLoadingShell({ label }: { label: string }) {
  return <section className="chat-pane new-chat-shell flex min-h-0 min-w-0 flex-1 flex-col" aria-busy="true">
    <div className="flex flex-1 items-center justify-center p-6 text-sm text-subtext" role="status">{label}</div>
  </section>;
}
