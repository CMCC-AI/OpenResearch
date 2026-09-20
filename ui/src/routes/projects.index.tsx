import { createFileRoute } from "@tanstack/react-router";
import { ProjectsPage } from "../routePages";

export interface ProjectsSearch {
  new?: boolean;
  paper?: string;
}

export function parseProjectsSearch(search: Record<string, unknown>): ProjectsSearch {
  const paper = typeof search.paper === "string"
    ? search.paper.replace(/^arxiv:/, "").trim()
    : typeof search.paper === "number"
      ? String(search.paper)
      : "";
  return {
    new: search.new === true || search.new === "true" || undefined,
    paper: paper || undefined,
  };
}

export const Route = createFileRoute("/projects/")({
  validateSearch: parseProjectsSearch,
  component: ProjectsPage,
});
