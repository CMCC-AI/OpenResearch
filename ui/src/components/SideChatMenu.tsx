import { useState } from "react";
import { MessagesSquare, Plus } from "lucide-react";
import { type ChatSession, timeAgo } from "../api";
import { m } from "../paraglide/messages.js";
import { MenuItem, Spinner } from "./ui";

/** Persistent children of one chat, inside the existing workspace tools menu. */
export function SideChatMenu({ parentId, sessions, onCreate, onSelect }: {
  parentId: string;
  sessions: ChatSession[];
  onCreate: () => void;
  onSelect: (sessionId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const children = sessions.filter((session) => session.sideParentSessionId === parentId)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const visible = children.filter((session) => (session.title?.trim() || m.side_chat_untitled())
    .toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return (
    <div role="group" aria-label={m.side_chat_list({ count: children.length })}>
      <MenuItem role="menuitem" onClick={onCreate}>
        <span className="flex items-center gap-2.5"><Plus size={15} />{m.side_chat_new()}</span>
      </MenuItem>
      {children.length > 0 && <>
        <div className="border-t border-border px-2 pt-2 pb-1 text-sm text-subtext">
          {m.side_chat_list({ count: children.length })}
        </div>
        <input aria-label={m.side_chat_search()} placeholder={m.side_chat_search()}
          value={search} onChange={(event) => setSearch(event.target.value)}
          className="mb-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-text outline-none focus:border-primary" />
        {visible.map((session) => (
          <MenuItem key={session.id} role="menuitem" onClick={() => onSelect(session.id)}>
            <span className="flex min-w-0 items-center gap-2.5">
              {session.busy ? <Spinner /> : <MessagesSquare size={15} className="shrink-0" />}
              <span className="flex min-w-0 flex-col items-start gap-0.5">
                <span className="max-w-60 truncate">{session.title?.trim() || m.side_chat_untitled()}</span>
                <span className="text-xs text-subtext">{timeAgo(session.updatedAt)}</span>
              </span>
            </span>
          </MenuItem>
        ))}
      </>}
    </div>
  );
}
