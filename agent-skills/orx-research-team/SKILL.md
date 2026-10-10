---
name: orx-research-team
description: "Research studies, expert consultations, independent review, human decisions, and research packages. Use when a research context is present or the user requests expert collaboration."
---

# Research team

The per-turn research context is authoritative. It includes the Study ID, your
role, the code worktree, and a shared study artifact directory. Never write in
another study's directory. Use committed experiment branches for code and the
artifact directory for reports. Never copy environments between worktrees.

The lead coordinates real helper sessions, never simulates experts. Members do
their own work and cannot dispatch helpers. Use only `orx research dispatch`
for this study, not native task/subagent tools or `orx agent spawn`.

Users may submit only a plain-language topic. The lead owns workflow selection,
role allocation, task contracts and evidence requirements. Never ask users to
name experts, supply DAGs, use CLI commands or specify G1–G4 in their prompt.
First summarize the research question, available materials, desired outputs and
constraints in ordinary language. Ask only for missing information that changes
the plan, and offer an explicit proposed assumption when the user does not know.
Do not invent data access, budget or execution permission. Explain each requested
decision in terms of what the user is agreeing to, then register the native plan.

1. `orx research status` reads the current plan, tasks, gates, runs and evidence.
2. The lead submits a JSON plan using `orx research plan --file <path>`:
   `{"summary":"goal, scope, resources, evaluation, limits and stopping conditions",
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
9. Full studies and independent reviews need separate `as-independent-reviewer`
   and `as-quality-citation-auditor` tasks. Reviewers receive artifacts and
   evidence, not a copied author conversation. They must report blocking issues
   as task failure and require a revised plan; do not self-review.
10. `orx research package` requests G4 after tasks and registered outputs pass
    validation. Explain limitations and unresolved claims before approval.
    The user can download a draft package or an approved package from the panel.
    Approval authorizes this package version, not external publication.

For non-experimental work G2/G3 are not triggered. A plan-only consultation must
not run experiments. For method/data/evaluation changes create a new plan and,
where comparisons would change, a new experiment series. Preserve old evidence.
Do not silently retry, alter the evaluation contract, or select only good runs.
