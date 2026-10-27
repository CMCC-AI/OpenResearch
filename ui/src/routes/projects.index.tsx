import { createFileRoute } from "@tanstack/react-router";
import { ProjectsPage } from "../routePages";

export interface ProjectsSearch {
  new?: boolean;
  project?: string;
}

export function parseProjectsSearch(search: Record<string, unknown>): ProjectsSearch {
  return {
    new: search.new === true || search.new === "true" || undefined,
    ...(typeof search.project === "string" && search.project ? { project: search.project } : {}),
  };
}

export const Route = createFileRoute("/projects/")({
  validateSearch: parseProjectsSearch,
  component: ProjectsPage,
});
