import { useQuery } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { decideMcpProposal, listPendingMcpProposals } from "../api";
import { queryClient, workspaceKey } from "../queries/client";
import { Button, showAlert } from "./ui";
import type { McpProposal } from "../workflow/model";

/** 研究负责人提交的 MCP 提案确认卡：批准才写入登记表并启用，拒绝只留历史。
 * 环境变量只显示键名，值不回显到聊天里。 */
export function McpProposalCards({ sessionId }: { sessionId: string }) {
  const proposalsQuery = useQuery({
    queryKey: workspaceKey("mcpProposals", sessionId),
    queryFn: ({ signal }) => listPendingMcpProposals(sessionId, signal),
    refetchInterval: 4000,
  });
  const proposals = proposalsQuery.data ?? [];
  if (!proposals.length) return null;

  async function decide(proposal: McpProposal, approve: boolean) {
    try {
      await decideMcpProposal(proposal.id, approve);
      void queryClient.invalidateQueries({ queryKey: workspaceKey("mcpProposals", sessionId) });
      void queryClient.invalidateQueries({ queryKey: workspaceKey("mcpServers") });
    } catch (error) {
      showAlert(error instanceof Error ? error.message : String(error), "error");
    }
  }

  return <div className="flex flex-col gap-2 px-3 pb-1" aria-label="MCP 服务提案">
    {proposals.map((proposal) => {
      const payload = proposal.payload;
      return <div key={proposal.id} className="rounded-md border border-border bg-surface p-3 text-sm">
        <p className="m-0 flex items-center gap-2 font-medium text-text"><Plug size={14} className="shrink-0 text-subtext" />AI 提议接入 MCP 服务「{proposal.name}」</p>
        {payload && <p className="mb-0 mt-1.5 break-all font-mono text-xs leading-relaxed text-subtext">
          {payload.transport === "stdio"
            ? [payload.command, ...payload.args].join(" ")
            : payload.url}
          {Object.keys(payload.env ?? {}).length > 0 && <span className="ms-2">（环境变量：{Object.keys(payload.env).join("、")}）</span>}
        </p>}
        {proposal.rationale && <p className="mb-0 mt-1.5 leading-relaxed text-subtext">{proposal.rationale}</p>}
        <p className="mb-0 mt-1.5 text-xs text-subtext">批准后会登记并启用该服务，可挂到自定义专家上，挂上后该专家即可使用。</p>
        <div className="mt-2.5 flex items-center gap-2">
          <Button variant="primary" onClick={() => void decide(proposal, true)}>批准接入</Button>
          <Button onClick={() => void decide(proposal, false)}>拒绝</Button>
        </div>
      </div>;
    })}
  </div>;
}
