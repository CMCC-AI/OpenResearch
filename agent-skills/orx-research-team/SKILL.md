---
name: orx-research-team
description: "Research studies, expert consultations, independent review, human decisions, and research packages. Use when a research context is present or the user requests expert collaboration."
---

# Research team

## Original preset workflows

Research team mode defaults to automatic routing. Users do not have to pick a
workflow. First identify primary/secondary intent, current research stage,
actual materials and expected deliverables. Use the injected trigger rules to
choose a preset semantically; do not route by keywords alone. If the user has
explicitly selected a preset, respect that selection. For automatic sessions,
record the selected preset as `workflow` in the versioned plan JSON, with a
reason in `summary`. For composite research outside one preset use
`workflow:null` and dynamically select the necessary experts and dependencies.
A single-paper explanation or simple feasibility question may need only the
relevant experts, rather than a full preset pipeline.

All W1–W4 definitions and trigger conditions are injected in automatic sessions;
manual sessions receive the selected profile. They share definitions with the
UI and plan validator. Follow a selected preset's required roles and dependency
skeleton; tailor briefs, inputs and outputs to the actual topic.
Do not substitute design/diagnosis/review consultations for these workflows.

- W1 系统文献综述: scope → search strategy → discovery → per-paper evidence
  (parallel papers allowed) → synthesis → outline → writing → independent
  review → citation audit → user confirmation and archive. Skip method and
  experiment groups.
- W2 论文复现: audit feasibility/code/hardware → paper claims → reproduction
  design → code/data → approved real run → result comparison → report/editing
  → independent review → citation audit → confirmation and archive. Diagnose
  failures with as-experiment-diagnostician, preserving logs before bounded
  REFINE / versioned PIVOT / STOP. Original paper numbers are not measured results.
- W3 实验数据分析报告: audit existing assets → result analysis → outline →
  evidence writing → figure/citation editing → independent review and citation
  audit → user confirmation and archive. Use existing evidence, without new runs.
- W4 Idea 到实验方案: feasibility → novelty search and synthesis → methodology
  → experiment design → G3 plan confirmation and Experiment Plan delivery.
  Do not automatically run experiments or require a manuscript/review pipeline.

These are the original team SOP routes adapted to native OpenResearch execution.
G1 confirms scope before dispatch. W2 uses native prepare-run G2/G3 approval
AFTER code is committed, binding the actual revision, command and resources;
explain the design before implementation when needed. W4 uses G3 to confirm
the completed plan, without granting execution permission. Missing essential
materials require clarification, not fabricated inputs or a nominal run.

The per-turn research context is authoritative. It includes the Study ID, your
role, the code worktree, and a shared study artifact directory. Never write in
another study's directory. Use committed experiment branches for code and the
artifact directory for reports. Never copy environments between worktrees.

The lead coordinates real helper sessions, never simulates experts. Members do
their own work and cannot dispatch helpers. Use only `orx research dispatch`
for this study, not native task/subagent tools or `orx agent spawn`.

Users may submit only a plain-language topic. The lead owns intent recognition, workflow routing and task planning,
role allocation, task contracts and evidence requirements. Never ask users to
name experts, supply DAGs, use CLI commands or specify G1–G4 in their prompt.
First summarize the research question, available materials, desired outputs and
constraints in ordinary language. Ask only for missing information that changes
the plan, and offer an explicit proposed assumption when the user does not know.
Do not invent data access, budget or execution permission. Explain each requested
decision in terms of what the user is agreeing to, then register the native plan.

1. `orx research status` reads the current plan, tasks, gates, runs and evidence.
2. The lead submits a JSON plan using `orx research plan --file <path>`:
   `{"workflow":"literature","summary":"route rationale, goal, scope, resources, evaluation, limits and stopping conditions",
   "tasks":[{"id":"design","role":"as-experiment-designer","brief":"...",
   "dependsOn":[],"outputs":["methodology/plan.md"]}]}`.
   Call `orx research roles` for available roles. Use only needed experts.
   Plans are versioned; a changed plan invalidates previous approvals. Maximum
   40 tasks per plan; parallel live helpers are bounded by the native limit.
3. G1 is requested automatically. Explain the plan and end the turn while the
   user decides in the research panel. Never fabricate decisions or call the
   browser approval API. A decision resumes the lead with a durable message.
4. `orx research dispatch <task-id>` checks dependencies and gates, then queues
   one fresh helper in its own worktree. Repeating dispatch returns the existing
   session. Completion wakes the lead through native OpenResearch machinery.
5. Experiment code is developed and committed before launch approval. Use
   `orx create-experiment <project-id> --parent <id> --title <title>` and normal
   Git tools. Set the fixed project run command through `orx project edit`.
   The lead runs `orx research prepare-run <task-id> <experiment-id> --backend local`
   (or another configured backend with explicit resource options). This binds
   code revision, command and launch options and requests G2/G3. One prepared
   execution task permits one run. For a retry, revise the plan explicitly.
6. After G2/G3 approval dispatch the execution expert, who uses exactly the
   approved `orx exp run <experiment-id> --backend <backend>` and options.
   Never execute experimental workloads directly in a shell. Read `orx logs`
   and reconcile terminal states; an exit code of zero is not scientific support.
7. Members use `orx research finish --file <path>` with JSON
   `{"summary":"...","success":true}` after writing ALL declared output files.
   On failure use `success:false` with an honest summary. The lead may finish
   a failed/incomplete child after checking its return, but cannot claim a task
   succeeded without its dispatched session and declared artifacts. Use
   `--task <task-id>` for lead-side validation.
8. Register claims with `orx research claim --file <path>`:
   `{"text":"...","support":"paper|experiment|inference","source":"...",
   "location":"page/section","runId":null,"lineStart":null,"lineEnd":null}`.
   Experiment claims require a same-project real run, inclusive log line range
   and nonempty source explanation; the platform records commit and log hash.
   Review negative and inconclusive results without inventing support.
9. W1–W3, legacy full studies and independent reviews need separate `as-independent-reviewer`
   and `as-quality-citation-auditor` tasks. Reviewers receive artifacts and
   evidence, not a copied author conversation. They must report blocking issues
   as task failure and require a revised plan; do not self-review.
10. `orx research package` requests G4 (G3 for W4 plan delivery) after tasks and registered outputs pass
    validation. Explain limitations and unresolved claims before approval.
    The user can download a draft package or an approved package from the panel.
    Approval authorizes this package version, not external publication.

For non-experimental work G2 and run-launch G3 are not triggered. W4 still
requires G3 confirmation of its completed Experiment Plan. Only W2 (and legacy
full studies) may run experiments. For method/data/evaluation changes create a new plan and,
where comparisons would change, a new experiment series. Preserve old evidence.
Do not silently retry, alter the evaluation contract, or select only good runs.
