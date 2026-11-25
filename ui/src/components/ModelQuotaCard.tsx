import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { modelLabel, switchResearchModel, type ChatSession } from "../api";
import { getChatMessagesQuery, listChatSessionsQuery } from "../queries/chat";
import { workspaceKey } from "../queries/client";
import type { ResearchStudy } from "../research";
import { ModelPicker, type ModelSelection } from "./ModelPicker";
import { Badge, Button, showAlert, Spinner } from "./ui";

/** A quota-exhausted model stops the whole study. This card is the recovery
 * path: it switches the lead's model (experts that inherit follow), clears the
 * block, resumes the study and lets the server start the continuation turn. */
export function ModelQuotaCard({ study, session, onSwitched }: { study: ResearchStudy; session?: ChatSession; onSwitched?: (selection: ModelSelection) => void }) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const block = study.modelBlock;
  if (!block || study.status === "stopped") return null;

  const current: ModelSelection | null = picked ?? (session ? {
    harness: session.harness,
    model: session.model,
    serviceTier: session.serviceTier,
    permissionMode: session.permissionMode,
    reasoningLevel: session.reasoningLevel,
  } : null);
  const blocked = block.model ? modelLabel(block.model) : "当前模型";
  const pickable = session?.harness === "opencode";

  const submit = async () => {
    if (!current?.model || working) return;
    setWorking(true);
    setError(null);
    try {
      const result = await switchResearchModel(study.id, {
        model: current.model,
        serviceTier: current.serviceTier,
        reasoningLevel: current.reasoningLevel,
      });
      void queryClient.invalidateQueries({ queryKey: workspaceKey("researchStudy", study.sessionId) });
      void queryClient.invalidateQueries({ queryKey: listChatSessionsQuery(study.projectId).queryKey });
      void queryClient.invalidateQueries({ queryKey: getChatMessagesQuery(study.sessionId).queryKey });
      onSwitched?.(current);
      if (result.resumeError) showAlert(`模型已切换，但自动继续没有启动：${result.resumeError}`, "error");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  return (
    <section
      aria-label="模型额度已用完"
      className="model-quota-card mb-2 flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-control"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="error" size="small">额度用完</Badge>
        <strong className="text-sm font-medium text-text">模型额度已用完</strong>
      </div>
      <p className="m-0 text-sm text-subtext">
        「{blocked}」无法继续运行，工作流已暂停。换一个有额度的模型后会接着跑。
      </p>
      {pickable ? (
        <div className="flex flex-wrap items-center gap-2">
          <ModelPicker value={current} onSelect={setPicked} lockHarness />
          <Button
            variant="primary"
            size="small"
            disabled={!current?.model || working}
            onClick={() => void submit()}
          >
            {working && <Spinner aria-hidden="true" />}
            切换并继续
          </Button>
        </div>
      ) : (
        <p className="m-0 text-sm text-subtext">请先在设置里配置一个可用模型。</p>
      )}
      {error && <p role="alert" className="m-0 text-xs text-accent-red">{error}</p>}
    </section>
  );
}
