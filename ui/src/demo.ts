export const DEMO_PROJECT_ID = "demo_nanochat_v1";
// Bundled demo snapshots reserve this prefix so future demos inherit demo-only UI.
export const isDemoProjectId = (id: string) => id.startsWith("demo_");
export const DEMO_MAIN_SESSION_ID = "chat_demo_nanochat_v1";
export const DEMO_FIGURE_SESSION_ID = "chat_demo_nanochat_figures_v1";
export const DEMO_LITERATURE_SESSION_ID = "chat_demo_nanochat_literature_v1";

/** Stable analytics labels for the bundled demo's recorded conversations. */
export const DEMO_EXPERIMENT_LABELS: Record<string, string> = {
  [DEMO_MAIN_SESSION_ID]: "cpu_end_to_end",
  [DEMO_FIGURE_SESSION_ID]: "figures",
  [DEMO_LITERATURE_SESSION_ID]: "literature",
};
export const DEMO_OVERVIEW_ARTIFACT = "cpu-apple-silicon-pipeline-results.md";
/** Leaf message each recorded demo session is seeded with; a send moves it. */
export const DEMO_SEEDED_LEAF_IDS: Record<string, string> = {
  [DEMO_MAIN_SESSION_ID]: "msg_demo_nanochat_assistant_v1",
  [DEMO_FIGURE_SESSION_ID]: "msg_demo_nanochat_figures_assistant_v1",
  [DEMO_LITERATURE_SESSION_ID]: "msg_demo_nanochat_literature_assistant_v1",
};
export const DEMO_RUN_EXPERIMENT_PROMPT =
  "Run the proposed learning-rate probe experiment. Summarize its results using the recorded validation metric and comparison described by the experiment. If it produces an interactive HTML loss chart, show it inline using image syntax.";
