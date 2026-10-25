import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../src/queries/client";
import { Transcript } from "../../src/components/ChatPanel";
import type { ChatMessage } from "../../src/api";
import "../../src/tailwind.css";

// Development-only acceptance page. All messages are synthetic; no API or models.
function messages(prefix: string): ChatMessage[] {
  return Array.from({ length: 120 }, (_, index) => ({
    id: `${prefix}-${index}`, role: index % 2 ? "assistant" : "user",
    createdAt: index + 1, completedAt: index + 2,
    parts: [
      ...(index % 10 === 9 ? [{ id: "work", type: "tool", tool: "bash", state: {
        status: "completed", input: { command: "synthetic check" }, output: "Synthetic output\n".repeat(12),
      } }] : []),
      { id: "text", type: "text", text: `Message ${prefix}-${index}\n\n` +
        "Synthetic research transcript for scrolling and resize acceptance. ".repeat(4 + index % 9 * 7) },
    ],
  }));
}

function Fixture() {
  const [chats, setChats] = useState(() => ({ A: messages("A"), B: messages("B") }));
  const [active, setActive] = useState<"A" | "B">("A");
  const [narrow, setNarrow] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [metrics, setMetrics] = useState("Ready: 120 synthetic messages per chat");
  const [sampling, setSampling] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const scrollToEndRef = useRef<(() => void) | null>(null);
  const stickToBottom = useRef(true);
  const [, setAtBottom] = useState(true);
  const pinToBottom = useCallback(() => { stickToBottom.current = true; scrollToEndRef.current?.(); }, []);
  useEffect(() => {
    const observer = new ResizeObserver(() => { if (stickToBottom.current) scrollToEndRef.current?.(); });
    observer.observe(scrollRef.current!);
    observer.observe(innerRef.current!);
    return () => observer.disconnect();
  }, []);
  function sample(label: string) {
    setSampling(true);
    const observations: { height: number; top: number; gap: number; blank: boolean; rows: number }[] = [];
    function frame() {
      const scroller = scrollRef.current!;
      const viewport = scroller.getBoundingClientRect();
      const rows = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")];
      const visible = rows.map(row => row.getBoundingClientRect())
        .filter(rect => rect.bottom > viewport.top && rect.top < viewport.bottom)
        .sort((a, b) => a.top - b.top);
      observations.push({ height: scroller.scrollHeight, top: scroller.scrollTop,
        gap: Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop), rows: rows.length,
        blank: !visible.length || visible[0].top > viewport.top + 3 || visible.at(-1)!.bottom < viewport.bottom - 3 });
      if (observations.length < 24) { requestAnimationFrame(frame); return; }
      const heights = observations.map(row => row.height);
      setMetrics(JSON.stringify({ label, frames: observations.length,
        blankFrames: observations.filter(row => row.blank).length,
        heightRange: Math.max(...heights) - Math.min(...heights),
        scrollTopRange: Math.round(Math.max(...observations.map(row => row.top)) - Math.min(...observations.map(row => row.top))),
        maxBottomGap: Math.max(...observations.map(row => row.gap)),
        finalBottomGap: observations.at(-1)!.gap,
        peakMountedRows: Math.max(...observations.map(row => row.rows)),
      }, null, 2));
      setSampling(false);
    }
    requestAnimationFrame(frame);
  }
  function append(finish = false) {
    setChats(current => ({ ...current, [active]: current[active].map((message, index) => index === 119
      ? { ...message, completedAt: finish ? Date.now() : null,
        parts: [{ id: "text", type: "text", text: `${message.parts.at(-1)!.text}\n\nStreamed synthetic paragraph. `.repeat(2) }] }
      : message) }));
    setStreaming(!finish);
    sample(finish ? "finish streaming" : "append stream");
  }
  const button = "border border-border rounded-sm px-3 py-1 bg-background cursor-pointer disabled:opacity-50";
  return <main className="p-4 bg-background text-text">
    <h1>Synthetic transcript acceptance</h1>
    <p>Active chat {active}; width {narrow ? 420 : 840}; streaming {String(streaming)}</p>
    <div className="flex flex-wrap gap-2 my-3">
      <button className={button} disabled={sampling} onClick={() => { setActive(active === "A" ? "B" : "A"); sample("switch chat"); }}>Switch chat</button>
      <button className={button} disabled={sampling} onClick={() => { setNarrow(!narrow); sample("resize"); }}>Resize panel</button>
      <button className={button} disabled={sampling} onClick={() => { stickToBottom.current = false; scrollRef.current!.scrollTop -= 1400; sample("read older"); }}>Read older</button>
      <button className={button} disabled={sampling} onClick={() => { stickToBottom.current = true; scrollToEndRef.current?.(); sample("scroll bottom"); }}>Scroll bottom</button>
      <button className={button} disabled={sampling} onClick={() => append()}>Append stream</button>
      <button className={button} disabled={sampling} onClick={() => append(true)}>Finish stream</button>
      <button className={button} disabled={sampling} onClick={() => sample("sample current")}>Sample current</button>
    </div>
    <pre aria-label="Acceptance metrics">{sampling ? "Sampling" : metrics}</pre>
    <div ref={scrollRef} style={{ width: narrow ? 420 : 840, height: 420 }}
      className="overflow-y-auto border border-border relative" onScroll={event => {
        const atBottom = event.currentTarget.scrollHeight - event.currentTarget.clientHeight - event.currentTarget.scrollTop < 60;
        stickToBottom.current = atBottom; setAtBottom(atBottom);
      }}>
      <div ref={innerRef}>
      <Transcript key={active} messages={chats[active]} allMessages={chats[active]} scrollRef={scrollRef}
        scrollToEndRef={scrollToEndRef} stickToBottom={stickToBottom}
        onPinToBottom={pinToBottom}
        canFork={false} onFork={() => {}} onSelectFork={() => {}} busy={streaming} />
      </div>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><Fixture /></QueryClientProvider>);
