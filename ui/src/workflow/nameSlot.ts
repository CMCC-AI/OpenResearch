import { createContext } from "react";

/**
 * 工作流名称在全局页头里的落点。编辑器把改名输入框投进这个槽位，
 * 由 App 在「科研首页 / 工作流」之后提供；库页没有编辑器时槽位保持为空。
 */
export const WorkflowNameSlot = createContext<HTMLElement | null>(null);
