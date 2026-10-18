import { createFileRoute } from "@tanstack/react-router";
import { CaseDetailPage } from "../product/FeaturedCases";
export const Route = createFileRoute("/cases/$caseId")({ component: Page });
function Page() { return <CaseDetailPage caseId={Route.useParams().caseId} />; }
