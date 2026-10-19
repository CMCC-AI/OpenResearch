import { createFileRoute } from "@tanstack/react-router";
import { CaseDetailPage } from "../product/FeaturedCases";
import { parsePane, type Pane } from "../workspaceState";
export const Route = createFileRoute("/cases/$caseId")({ validateSearch: (search): { session?: string; pane?: Pane; preview?: boolean } => ({ ...(typeof search.session === "string" ? {session:search.session} : {}), pane:parsePane(search.pane), ...(search.preview === true || search.preview === 1 || search.preview === "1" ? {preview:true} : {}) }), component: Page });
function Page() { return <CaseDetailPage caseId={Route.useParams().caseId} adminPreview={Route.useSearch().preview} />; }
