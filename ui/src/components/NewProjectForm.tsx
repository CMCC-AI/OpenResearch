import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "../queries/client";
import { githubAccountQuery, githubProjectRepoPreviewQuery, getProjectPathStatusQuery } from "../queries/projects";
import { getHarnessesQuery, getProjectDefaultsQuery } from "../queries/settings";
import { m } from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";
import { ltr } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { createProject, type Project, type AgentSelection } from "../api";
import { Button } from "./ui";
import { defaultSelection } from "./ModelPicker";

function useDebouncedValue(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function slugify(text: string, maxLength?: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Distinguish Chinese project titles when ASCII slugging removes the whole name.
  let hash = 0;
  for (const character of text) hash = (Math.imul(hash, 31) + character.codePointAt(0)!) >>> 0;
  return (maxLength ? slug.slice(0, maxLength) : slug) || (text.trim() ? `research-${hash.toString(36)}` : "research-project");
}

export function NewProjectForm({ onCreated, onCancel, preferredAgent, initialName }: {
  onCreated: (project: Project, githubPublicationError: string | null) => void;
  onCancel?: () => void;
  preferredAgent: AgentSelection | null;
  initialName?: string;
}) {
  const { data: harnesses = [] } = useQuery(getHarnessesQuery());
  const starterSelection = defaultSelection(harnesses, preferredAgent);
  const starterHarness = starterSelection?.harness;
  const starterModel = starterSelection?.model ?? null;
  const starterAgent = starterHarness ? { harness: starterHarness, model: starterModel } : undefined;
  const [name, setName] = useState<string>(initialName ?? "");
  const [path, setPath] = useState("");
  const [pathTouched, setPathTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [githubSyncEnabled, setGithubSyncEnabled] = useState(false);
  const projectPath = pathTouched ? path : name.trim() ? `~/MobileSci/${slugify(name, 48)}` : "";
  const checkedPath = useDebouncedValue(projectPath.trim(), 200);
  const pathQuery = useQuery({ ...getProjectPathStatusQuery(checkedPath), enabled: Boolean(checkedPath) && checkedPath === projectPath.trim() });
  const pathStatus = checkedPath === projectPath.trim() ? pathQuery.data ?? null : null;
  const pathError = checkedPath === projectPath.trim() ? pathQuery.error?.message ?? null : null;
  const checkingPath = Boolean(projectPath.trim()) && (checkedPath !== projectPath.trim() || pathQuery.isFetching);
  const accountQuery = useQuery(githubAccountQuery());
  const githubLogin = accountQuery.data?.login ?? (accountQuery.isPending ? undefined : null);
  const defaultsQuery = useQuery(getProjectDefaultsQuery());
  const appliedDefaults = useRef(false);
  useEffect(() => {
    if (appliedDefaults.current || !defaultsQuery.data) return;
    appliedDefaults.current = true;
    setGithubSyncEnabled(defaultsQuery.data.githubForNewProjects);
  }, [defaultsQuery.data]);
  const previewName = useDebouncedValue(name.trim(), 150);
  const previewQuery = useQuery({ ...githubProjectRepoPreviewQuery(previewName), enabled: previewName === name.trim() });
  const githubRepoName = previewName === name.trim() ? previewQuery.data?.repo ?? slugify(name, 48) : slugify(name, 48);
  const githubRepoPreviewPending = previewName !== name.trim() || previewQuery.isFetching;
  const githubRepository = `github.com/${githubLogin ?? "you"}/${githubRepoName}`;
  const githubDecisionPending = githubLogin === undefined || githubRepoPreviewPending;
  const createMutation = useMutation({ mutationFn: createProject });
  const gitMissing = pathStatus?.gitVersion === null;
  const existingBlankFolder = pathStatus?.exists === true;
  const invalidProjectDestination = pathStatus?.exists === true && pathStatus.directory === false;
  const blankDestinationError = pathTouched && !projectPath.trim()
    ? m.new_project_location_required()
    : invalidProjectDestination
      ? m.new_project_destination_is_file()
      : existingBlankFolder ? m.new_project_folder_exists() : null;
  const canCreate = Boolean(name.trim() && projectPath.trim()) && !pending && !checkingPath &&
    pathStatus !== null && !pathError && !gitMissing && !blankDestinationError &&
    (!githubSyncEnabled || (typeof githubLogin === "string" && !githubRepoPreviewPending));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    setPending(true);
    setError(null);
    try {
      const status = await queryClient.fetchQuery({ ...getProjectPathStatusQuery(projectPath.trim()), staleTime: 0 });
      if (status.exists && status.directory === false) throw new Error(m.new_project_destination_is_file());
      if (status.exists) throw new Error(m.new_project_folder_exists());
      const result = await createMutation.mutateAsync({
        name: name.trim(), path: projectPath.trim(), creationMode: "blank",
        createFolder: true, requireNewFolder: true, initializeGit: true,
        githubSyncEnabled, locale: getLocale(), starterAgent,
      });
      onCreated(result.project, result.githubPublicationError);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="form new-project-form flex flex-col gap-4.5" onSubmit={submit}>
      <label className="flex flex-col gap-2 text-base font-medium text-text">
        {m.new_project_form_project_name()}
        <input className="text-sm font-normal" data-initial-focus value={name} onChange={(event) => setName(event.target.value)} placeholder={m.new_project_form_my_research()} />
      </label>
      {name.trim() && <label className="flex flex-col gap-2 text-base font-medium text-text">
        {m.new_project_form_project_location()}
        <input className="text-sm font-normal" value={projectPath} onChange={(event) => { setPathTouched(true); setPath(event.target.value); }} placeholder="~/MobileSci/my-research" aria-describedby={blankDestinationError ? "blank-destination-description" : undefined} spellCheck={false} />
        {checkingPath && <span className="sr-only" role="status" aria-live="polite">{m.new_project_form_checking_project_location()}</span>}
        {blankDestinationError && <span id="blank-destination-description" className="text-sm font-normal text-accent-red" role="alert">{blankDestinationError}</span>}
      </label>}
      {gitMissing && <div className="text-sm text-accent-red">{m.new_project_form_git_is_required_for_experiments_but_is_not()}</div>}
      {pathError && <div className="text-sm text-accent-red" role="alert">{pathError}</div>}
      {error && <div className="whitespace-pre-wrap text-sm text-accent-red" role="alert">{error}</div>}
      {projectPath && name.trim() && (
        <div className="flex w-full flex-col items-start gap-2">
          <button
            type="button"
            className={`inline-flex items-center gap-1 text-sm font-medium${githubSyncEnabled && githubLogin === null ? " text-accent-red" : " text-text"}`}
            aria-expanded={advancedOpen}
            aria-controls="new-project-advanced-settings"
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            {githubSyncEnabled
              ? githubLogin === null
                ? m.new_project_advanced_connect_github()
                : m.new_project_advanced_sync_on()
              : m.new_project_advanced()}
            <ChevronDown className={advancedOpen ? "rotate-180" : ""} size={16} />
          </button>
          {advancedOpen && (
            <label id="new-project-advanced-settings" className="flex w-full flex-col items-stretch gap-[7px] font-normal">
              <span className="flex flex-row items-center gap-[9px]">
                <input
                  className="m-0"
                  type="checkbox"
                  checked={githubSyncEnabled}
                  onChange={(event) => setGithubSyncEnabled(event.target.checked)}
                  disabled={pending}
                />
                <strong className="text-base font-medium leading-[1.3] text-text">
                  {m.new_project_form_sync_experiments_to_git_hub()}
                </strong>
              </span>
              <span className="flex flex-col gap-[3px] font-sans text-sm font-normal leading-[1.4] text-subtext">
                <span>
                  {githubDecisionPending
                    ? m.new_project_github_checking({ repository: ltr(githubRepository) })
                    : m.new_project_github_creates({ repository: ltr(githubRepository) })}
                </span>
                <span>{m.new_project_form_experiment_branches_will_be_pushed_to_the_remote()}</span>
                {githubLogin === null && <span>{m.new_project_run_before_create({ command: ltr("gh auth login") })}</span>}
              </span>
            </label>
          )}
        </div>
      )}
      <div className="mt-2.5 flex items-center justify-start gap-2.5">
        {onCancel && <Button type="button" onClick={onCancel}>{m.new_project_form_cancel()}</Button>}
        <Button variant="primary" className="ms-auto" disabled={!canCreate}>{pending ? m.new_project_creating() : m.new_project_create()}</Button>
      </div>
    </form>
  );
}
