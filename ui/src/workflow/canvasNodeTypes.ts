import { SystemNodeCard } from "./SystemNode";
import { AgentNodeCard, ExperimentNodeCard, ForeachNodeCard, FrameNodeCard, HumanNodeCard, RouteNodeCard, WaitNodeCard } from "./canvasNodes";

// 单独成文件：卡片模块只导出组件，画布与运行视图共用这一份节点类型映射。
export const workflowNodeTypes = { agent: AgentNodeCard, system: SystemNodeCard, route: RouteNodeCard, frame: FrameNodeCard, foreach: ForeachNodeCard, human: HumanNodeCard, experiment: ExperimentNodeCard, wait: WaitNodeCard };
