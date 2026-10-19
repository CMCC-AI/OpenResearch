import { createContext, useContext } from "react";
import type { Run, ChatMessage } from "../api";
import type { ResearchStudy } from "../research";

export interface SavedResearch { study: ResearchStudy | null; runs: Run[] }
export interface ReadOnlyWorkspaceData { native?: boolean; preview?: boolean; caseId?: string; initialSessionId?: string; research: Record<string, SavedResearch>; messages: Record<string, ChatMessage[]> }
export const ReadOnlyWorkspaceContext = createContext<ReadOnlyWorkspaceData | null>(null);
export const useReadOnlyWorkspace = () => useContext(ReadOnlyWorkspaceContext);
