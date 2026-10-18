import { createFileRoute } from "@tanstack/react-router";
import { CasesPage } from "../product/FeaturedCases";
export const Route = createFileRoute("/cases/")({ component: CasesPage });
