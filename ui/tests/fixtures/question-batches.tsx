import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../src/queries/client";
import { Message } from "../../src/components/ChatPanel";
import type { ChatMessage, ChatPart, PromptAnswer } from "../../src/api";
import "../../src/tailwind.css";

// Development-only real card rendering; callbacks record synthetic answers locally.
function questions(scope: "question" | "form"): ChatPart[] {
  return ["Color?", "Shape?", "Size?"].map((question, index) => ({
    id: `synthetic:${index}`, type: "prompt", prompt: {
      kind: "question", question, resolved: false, skipScope: scope,
      nativeId: JSON.stringify(["batch", index]),
      options: [{ label: "A" }, { label: "B" }], multiSelect: index === 2,
    },
  }));
}
function Fixture() {
  const [parts, setParts] = useState(() => questions("question"));
  const [answers, setAnswers] = useState<PromptAnswer[]>([]);
  const [narrow, setNarrow] = useState(false);
  const [note, setNote] = useState("");
  const [epoch, setEpoch] = useState(0);
  const respond = (answer: PromptAnswer) => {
    setAnswers((prior) => [...prior, answer]);
    setParts((prior) => prior.map((part) => part.id === answer.promptId ? {
      ...part, prompt: { ...part.prompt!, resolved: true, approved: answer.approve ?? true,
        answers: answer.answers, note: answer.note },
    } : part));
  };
  const message: ChatMessage = { id: "synthetic", role: "assistant", parts, createdAt: 1 };
  const pending = parts.find((part) => !part.prompt?.resolved);
  return <main className="h-screen overflow-y-auto p-4 flex flex-col gap-4">
    <h1>Synthetic question batch acceptance</h1>
    <p>Real Message cards; synthetic data only. No API, account or model calls.</p>
    <div className="flex flex-wrap gap-3">
      <button onClick={() => { setParts(questions("question")); setAnswers([]); setEpoch((value) => value + 1); }}>Reset V1 batch</button>
      <button onClick={() => { setParts(questions("form")); setAnswers([]); setEpoch((value) => value + 1); }}>Show V2 form labels</button>
      <button onClick={() => setNarrow((value) => !value)}>Toggle width</button>
    </div>
    <div style={{ width: narrow ? 420 : 840, maxWidth: "100%" }}>
      <Message key={epoch} message={message} activePermissionId={null} onRespond={respond} busy
        forkDisabled branchDisabled onFork={() => {}} onSelectFork={() => {}} />
    </div>
    <div className="flex gap-2">
      <input aria-label="Synthetic custom answer" value={note} onChange={(event) => setNote(event.target.value)} />
      <button disabled={!pending || !note.trim()} onClick={() => {
        respond({ promptId: pending!.id, answers: [], note }); setNote("");
      }}>Record custom answer</button>
    </div>
    <pre aria-label="Synthetic callback results">{JSON.stringify(answers, null, 2)}</pre>
  </main>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><Fixture /></QueryClientProvider>);
