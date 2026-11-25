import { deleteChatSession, endResearchStudy, getResearchStudy } from "./api";

/** 后端在会话关联的研究仍活动时拒绝删除；用它的文案识别这一种失败。 */
export const researchBlocksSessionDelete = (message: string) => message.includes("研究还没结束");

/**
 * 结束会话关联的研究后再删除会话。
 * 结束研究有副作用（专家任务不再自动开始、不能再修订计划），调用方必须先取得用户同意。
 */
export async function deleteSessionEndingResearch(sessionId: string, personal = false) {
  // 研究读取要和删除走同一作用域：个人空间里的会话不能读到只读案例的快照。
  const { study } = await getResearchStudy(sessionId, undefined, personal);
  // 守卫触发时必然有研究；查不到就重试删除，让后端给出原始原因。
  if (!study) return deleteChatSession(sessionId, personal);
  await endResearchStudy(study.id, study.plans.at(-1)?.version ?? 0);
  return deleteChatSession(sessionId, personal);
}
