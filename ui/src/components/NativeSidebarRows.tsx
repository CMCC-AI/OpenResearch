import { useEffect, useRef, useState } from "react";
import { Check, MoreHorizontal, SlidersHorizontal, Users } from "lucide-react";
import type { ChatSession } from "../api";
import { m } from "../paraglide/messages.js";
import { HARNESS_LABELS, usePopover } from "./ModelPicker";
import { IconButton, MenuItem } from "./ui";

export type SessionFilter = "active" | "archived" | "all";

const SESSION_FILTERS: { id: SessionFilter; label: () => string; railLabel: () => string }[] = [
  { id: "archived", label: m.chat_panel_archived, railLabel: m.chat_panel_archived },
  { id: "active", label: m.chat_panel_active, railLabel: m.chat_recents },
  { id: "all", label: m.chat_panel_all, railLabel: m.chat_all_sessions },
];

/** Filter control beside the "Recents" label: Active (default) / Archived / All. */
export function SessionFilterMenu({
  value,
  onChange,
  grouping,
  onGroupingChange,
}: {
  value: SessionFilter;
  onChange: (next: SessionFilter) => void;
  grouping: "projects" | "list";
  onGroupingChange: (next: "projects" | "list") => void;
}) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="rail-filter relative inline-flex" ref={ref}>
      <IconButton size="small"
        className="rail-filter-btn text-subtext"
        active={value !== "active"}
        title={m.chat_panel_filter_sessions()}
        aria-label={m.chat_panel_filter_sessions()}
        onClick={() => setOpen((v) => !v)}
      >
        <SlidersHorizontal size={15} className="text-subtext" />
      </IconButton>
      {open && (
        <div className="option-menu absolute bottom-[calc(100%_+_8px)] start-0 max-h-95 flex flex-col bg-background border border-border rounded-lg shadow-menu z-50 overflow-hidden min-w-40 p-1 [&.align-right]:start-auto [&.align-right]:end-0 [&.drop-down]:bottom-auto [&.drop-down]:top-[calc(100%_+_4px)] [&.session-menu]:start-auto [&.session-menu]:end-1.5 [&.session-menu]:top-[calc(100%_-_2px)] [&.session-menu]:min-w-35 drop-down align-right">
          <div className="px-2 py-0.5 text-sm text-subtext">{m.sidebar_group_by()}</div>
          {(["projects", "list"] as const).map((mode) => (
            <MenuItem size="compact" className="text-sm" key={mode} onClick={() => { onGroupingChange(mode); setOpen(false); }}>
              <span>{mode === "projects" ? m.projects_home_projects() : m.sidebar_one_list()}</span>
              {grouping === mode && <Check size={13} />}
            </MenuItem>
          ))}
          <div className="my-1 border-t border-border" />
          <div className="px-2 py-0.5 text-sm text-subtext">{m.sidebar_filter()}</div>
          {SESSION_FILTERS.map((f) => (
            <MenuItem
              size="compact" className="text-sm"
              key={f.id}

              onClick={() => {
                onChange(f.id);
                setOpen(false);
              }}
            >
              <span>{f.label()}</span>
              {value === f.id && <Check size={13} />}
            </MenuItem>
          ))}
        </div>
      )}
    </div>
  );
}

/** Per-character stagger, and the ceiling on the whole run — a long title
 * shouldn't take a second and a half to finish arriving. */
const TITLE_CHAR_STAGGER_MS = 14;
const TITLE_STAGGER_CAP_MS = 500;
/** How long the reveal flag stays set: the capped stagger plus one character's
 * 240ms animation, plus slack. After this the title renders as plain text. */
export const TITLE_REVEAL_CLEAR_MS = 1200;

/** A session title that materializes character by character when a
 * harness-generated one replaces the first-line placeholder. `animate` is false
 * everywhere else (initial load, renames, re-renders), and then this renders the
 * bare string — the animated form is deliberately the exception.
 *
 * The characters are `aria-hidden` and the whole title rides an `aria-label`:
 * a screen reader must hear one title, not forty single-letter spans. */
export function TitleReveal({ title, animate }: { title: string; animate: boolean }) {
  if (!animate) return <>{title}</>;
  return (
    <span className="title-reveal" aria-label={title}>
      {Array.from(title).map((ch, i) =>
        // Spaces stay plain inline boxes: the animated characters must be
        // inline-block (transform doesn't apply to inline boxes), but an
        // inline-block space collapses to zero width and eats the word gap.
        ch === " " ? (
          <span key={i} aria-hidden>
            {ch}
          </span>
        ) : (
          <span
            key={i}
            aria-hidden
            className="title-reveal-char inline-block animate-[title-char-in_240ms_ease-out_both] [@media((prefers-reduced-motion:_reduce))]:animate-none"
            style={{
              animationDelay: `${Math.min(i * TITLE_CHAR_STAGGER_MS, TITLE_STAGGER_CAP_MS)}ms`,
            }}
          >
            {ch}
          </span>
        ),
      )}
    </span>
  );
}

/** One Recents row. Hover swaps the timestamp for a three-dot menu with
 * Rename, Archive/Unarchive, and Delete (Claude-desktop style). Rename turns
 * the title into an inline input. */
export function SessionRow({
  session,
  active,
  unread,
  busy,
  waiting,
  revealTitle,
  onOpen,
  onRename,
  onSetArchived,
  onDelete,
  readOnly = false,
}: {
  session: ChatSession;
  active: boolean;
  unread: boolean;
  busy: boolean;
  /** Turn held on an unanswered card: steady dot, not the working pulse. */
  waiting: boolean;
  /** Nonce set while this row's freshly auto-generated title should play its
   * reveal; it doubles as the remount key so a second retitle replays it.
   * Undefined the rest of the time (static title). */
  revealTitle: number | undefined;
  onOpen: () => void;
  onRename: (title: string) => void;
  onSetArchived: (archived: boolean) => void;
  onDelete: () => void;
  readOnly?: boolean;
}) {
  const { open, setOpen, ref } = usePopover();
  const title = session.title?.trim() || "Untitled";
  const [editing, setEditing] = useState(false);
  // Seeded by startEditing() before the input mounts; "" is just a placeholder.
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function startEditing() {
    setDraft(session.title?.trim() || "");
    setEditing(true);
  }
  function commit() {
    const next = draft.trim();
    setEditing(false);
    // Only persist a real change; an empty title would be rejected server-side.
    if (next && next !== (session.title?.trim() || "")) onRename(next);
  }

  // Focus + select the input once the row enters edit mode.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // Not a <button>: the kebab is a real button and can't nest inside one.
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      className={`session-row relative flex items-center gap-2 w-full text-start py-[7px] ps-2.5 pe-1.5 rounded-md text-sm text-text cursor-pointer select-none [&:hover:not(.active)]:bg-surface [&.active]:bg-panel [&.active]:font-medium [&_.session-dot:empty]:hidden [&_.session-dot]:w-4 [&_.session-dot]:inline-flex [&_.session-dot]:items-center [&_.session-dot]:justify-center [&_.session-dot]:shrink-0 [&_.session-title]:flex-1 [&_.session-title]:min-w-0 [&_.session-title]:overflow-hidden [&_.session-title]:[mask-image:linear-gradient(to_right,black_calc(100%_-_16px),transparent)] [&_.session-title]:whitespace-nowrap [&_.session-menu-btn]:hidden [&_.session-menu-btn]:items-center [&_.session-menu-btn]:justify-center [&_.session-menu-btn]:w-4 [&_.session-menu-btn]:h-4 [&_.session-menu-btn]:-my-0.5 [&_.session-menu-btn]:mx-0 [&_.session-menu-btn]:rounded-sm [&_.session-menu-btn]:text-muted [&_.session-menu-btn]:shrink-0 [&_.session-menu-btn:hover]:text-text [&_.session-menu-btn:hover]:bg-panel [&:hover_.session-menu-btn]:inline-flex [&:focus-visible_.session-menu-btn]:inline-flex [&_.session-menu-btn:focus-visible]:inline-flex [&.menu-open_.session-menu-btn]:inline-flex [&:hover_.session-dot]:hidden [&:focus-visible_.session-dot]:hidden [&:has(.session-menu-btn:focus-visible)_.session-dot]:hidden [&.menu-open_.session-dot]:hidden [&_.busy-dot]:w-[7px] [&_.busy-dot]:h-[7px] [&_.busy-dot]:rounded-full [&_.busy-dot]:bg-primary [&_.busy-dot]:animate-[or-pulse_1.2s_infinite] [&_.busy-dot]:shrink-0 [&_.unread-dot]:w-[7px] [&_.unread-dot]:h-[7px] [&_.unread-dot]:rounded-full [&_.unread-dot]:bg-primary [&_.unread-dot]:shrink-0 [&_.busy-dot.waiting]:animate-none [&_.session-title-input]:flex-1 [&_.session-title-input]:min-w-0 [&_.session-title-input]:py-px [&_.session-title-input]:px-[5px] [&_.session-title-input]:-my-0.5 [&_.session-title-input]:mx-0 [&_.session-title-input]:[font:inherit] [&_.session-title-input]:text-text [&_.session-title-input]:bg-background [&_.session-title-input]:border [&_.session-title-input]:border-primary [&_.session-title-input]:rounded-sm [&_.session-title-input]:outline-none [&.editing]:bg-surface [&.editing]:cursor-default [&.editing_.session-menu-btn]:hidden [&.editing_.session-dot]:hidden ${active ? "active" : ""}  ${unread ? "unread" : ""}  ${open ? "menu-open" : ""}  ${
        editing ? "editing" : ""
        }`}
      title={`${HARNESS_LABELS[session.harness]}${session.model ? ` · ${session.model}` : ""}${
        session.parentSessionId ? m.chat_spawned_by_agent() : ""
        }`}
      onClick={() => {
        // While editing, a body click is a no-op; blur/Enter/Esc drive it.
        if (editing) return;
        // With the menu open, a body click just dismisses it — switching
        // sessions underneath an open menu would leave it orphaned.
        if (open) setOpen(false);
        else onOpen();
      }}
      onKeyDown={(e) => {
        // Only keys aimed at the row itself: the kebab, menu items, and the
        // rename input are descendants, and preventDefault here would cancel
        // their activation.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          // Mirror the click branch: dismiss an open menu instead of
          // navigating underneath it.
          if (open) setOpen(false);
          else onOpen();
        }
      }}
    >
      {session.parentSessionId && !editing && (
        <Users className="text-muted shrink-0" size={12} aria-hidden />
      )}
      {editing ? (
        <input
          ref={inputRef}
          className="session-title-input"
          aria-label={m.chat_panel_session_title()}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="session-title">
          <TitleReveal
            key={revealTitle ?? "static"}
            title={title}
            animate={revealTitle !== undefined}
          />
        </span>
      )}
      <span className="session-dot">
        {busy ? (
          <span className={`busy-dot ${waiting ? "waiting" : ""}`} />
        ) : (
          unread && <span className="unread-dot" />
        )}
      </span>
      {!readOnly && <button
        className="session-menu-btn"
        title={m.chat_panel_session_options()}
        aria-label={m.chat_panel_session_options()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <MoreHorizontal size={14} />
      </button>}
      {!readOnly && open && (
        <div className="option-menu absolute bottom-[calc(100%_+_8px)] start-0 max-h-95 flex flex-col bg-background border border-border rounded-lg shadow-menu z-50 overflow-hidden min-w-47.5 p-1.5 [&.align-right]:start-auto [&.align-right]:end-0 [&.drop-down]:bottom-auto [&.drop-down]:top-[calc(100%_+_4px)] [&.session-menu]:start-auto [&.session-menu]:end-1.5 [&.session-menu]:top-[calc(100%_-_2px)] [&.session-menu]:min-w-35 drop-down session-menu">
          <MenuItem
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              startEditing();
            }}
          >
            <span>{m.chat_panel_rename()}</span>
          </MenuItem>
          <MenuItem
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onSetArchived(!session.archived);
            }}
          >
            <span>{session.archived ? m.chat_unarchive() : m.chat_archive()}</span>
          </MenuItem>
          <MenuItem danger
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete();
            }}
          >
            <span>{m.chat_panel_delete()}</span>
          </MenuItem>
        </div>
      )}
    </div>
  );
}

