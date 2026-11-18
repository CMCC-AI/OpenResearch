// 输入绑定、任务确认（G5）、结论把关与有界返工的编排语义测试。

fn finish_with_verdict(store: &Store, study: &Study, task: &str, verdict: &str, reasons: &[&str]) {
    let root = store.research_root(study).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join(format!("{task}.md")),
        format!("# {task}\nreal output"),
    )
    .unwrap();
    let reasons_json = reasons
        .iter()
        .map(|reason| format!("\"{reason}\""))
        .collect::<Vec<_>>()
        .join(",");
    std::fs::write(
        root.join(format!("{task}.md.verdict.json")),
        format!("{{\"verdict\":\"{verdict}\",\"reasons\":[{reasons_json}]}}"),
    )
    .unwrap();
    store
        .research_finish(&study.id, task, true, "checked".into())
        .unwrap();
}

#[test]
fn plan_inputs_must_reference_direct_dependency_outputs() {
    let mut input = plan();
    input.tasks[2].inputs = vec!["design.md".into()];
    assert!(validate_plan(&input, "team").is_err());
    input.tasks[2].inputs = vec!["review.md".into()];
    assert!(validate_plan(&input, "team").is_ok());
    input.tasks[2].inputs = vec!["review.md".into(), "review.md".into()];
    assert!(validate_plan(&input, "team").is_err());
}

#[test]
fn rework_config_requires_gating_bounds_and_non_operator() {
    let mut input = plan();
    input.tasks[1].max_rework = 2;
    assert!(validate_plan(&input, "team").is_err());
    input.tasks[1].gate_downstream = true;
    assert!(validate_plan(&input, "team").is_ok());
    input.tasks[1].max_rework = crate::store::research::MAX_REWORK + 1;
    assert!(validate_plan(&input, "team").is_err());
    let mut operator_gates = plan();
    operator_gates
        .tasks
        .insert(1, spec("execute", "as-experiment-operator", &["design"]));
    operator_gates.tasks.last_mut().unwrap().gate_downstream = true;
    assert!(validate_plan(&operator_gates, "team").is_err());
}

#[test]
fn gated_finish_requires_a_verdict_sidecar_and_blocks_downstream() {
    let (_dir, store, study) = setup();
    let mut input = plan();
    input.tasks[1].gate_downstream = true;
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "design", "s1");
    finish(&store, &study, "design");
    bind(&store, &study, "review", "s2");
    let root = store.research_root(&study).unwrap();
    std::fs::write(root.join("review.md"), "# review").unwrap();
    // 缺少结论文件、阻塞缺少原因都必须被拒绝。
    assert!(store
        .research_finish(&study.id, "review", true, "done".into())
        .is_err());
    std::fs::write(
        root.join("review.md.verdict.json"),
        r#"{"verdict":"blocked","reasons":[]}"#,
    )
    .unwrap();
    assert!(store
        .research_finish(&study.id, "review", true, "done".into())
        .is_err());
    std::fs::write(
        root.join("review.md.verdict.json"),
        r#"{"verdict":"blocked","reasons":["第 2 节缺少对照"]}"#,
    )
    .unwrap();
    store
        .research_finish(&study.id, "review", true, "done".into())
        .unwrap();
    let saved = store.research_study(&study.id).unwrap();
    let verdict = saved.task("review").unwrap().verdict.as_ref().unwrap();
    assert_eq!(verdict.status, "blocked");
    assert!(!verdict.sha256.is_empty());
    let error = saved.ready("audit").unwrap_err().to_string();
    assert!(error.contains("阻塞"));
    assert!(error.contains("review"));
}

#[test]
fn pass_verdict_allows_downstream_and_blocked_verdict_refuses_delivery() {
    let (_dir, store, study) = setup();
    let mut input = plan();
    input.tasks[2].gate_downstream = true;
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "design", "s1");
    finish(&store, &study, "design");
    bind(&store, &study, "review", "s2");
    finish_with_verdict(&store, &study, "review", "pass", &[]);
    let saved = store.research_study(&study.id).unwrap();
    // review 未启用结论把关，即使写了结论文件也不参与验收。
    assert!(saved.task("review").unwrap().verdict.is_none());
    assert!(saved.ready("audit").is_ok());
    // 审计任务启用门控并给出阻塞结论后，全部任务已完成但交付必须被拒绝。
    bind(&store, &study, "audit", "s3");
    finish_with_verdict(&store, &study, "audit", "blocked", &["引用定位缺失"]);
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(
        saved
            .task("audit")
            .unwrap()
            .verdict
            .as_ref()
            .unwrap()
            .status,
        "blocked"
    );
    let error = match store.research_prepare_delivery(&saved) {
        Err(error) => error.to_string(),
        Ok(_) => panic!("blocked verdict must refuse delivery"),
    };
    assert!(error.contains("阻塞"));
}

#[test]
fn blocked_verdict_triggers_bounded_rework_with_feedback() {
    let (_dir, store, study) = setup();
    let mut input = plan();
    input.tasks[1].gate_downstream = true;
    input.tasks[1].max_rework = 2;
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "design", "s1");
    finish(&store, &study, "design");
    // 第 1 轮阻塞：设计与审稿一起重置，设计携带返工意见。
    bind(&store, &study, "review", "s2");
    finish_with_verdict(&store, &study, "review", "blocked", &["缺少对照"]);
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("review").unwrap().state, "pending");
    assert_eq!(saved.task("review").unwrap().rework_count, 1);
    assert!(saved
        .task("review")
        .unwrap()
        .previous_sessions
        .contains(&"s2".into()));
    assert_eq!(saved.task("design").unwrap().state, "pending");
    assert!(saved
        .task("design")
        .unwrap()
        .rework_feedback
        .as_deref()
        .unwrap()
        .contains("缺少对照"));
    assert!(saved.ready("audit").is_err());
    // 第 2 轮阻塞：达到上限的临界值，仍自动返工。
    bind(&store, &study, "design", "s3");
    finish(&store, &study, "design");
    bind(&store, &study, "review", "s4");
    finish_with_verdict(&store, &study, "review", "blocked", &["仍旧缺少对照"]);
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("review").unwrap().rework_count, 2);
    // 第 3 轮阻塞：预算用完，保持已完成并写入升级提示。
    bind(&store, &study, "design", "s5");
    finish(&store, &study, "design");
    bind(&store, &study, "review", "s6");
    finish_with_verdict(&store, &study, "review", "blocked", &["依然缺少对照"]);
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("review").unwrap().state, "completed");
    assert_eq!(saved.task("review").unwrap().rework_count, 2);
    assert!(saved
        .task("review")
        .unwrap()
        .summary
        .as_deref()
        .unwrap()
        .contains("返工上限（2 轮）已用完"));
    // 升级后设计不再被反复重置。
    assert_eq!(saved.task("design").unwrap().state, "completed");
    assert!(saved.ready("audit").is_err());
}

#[test]
fn requires_approval_blocks_dispatch_until_gate_approved() {
    let (_dir, store, study) = setup();
    let mut input = plan();
    input.tasks[1].requires_approval = true;
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "design", "s1");
    finish(&store, &study, "design");
    bind(&store, &study, "review", "s2");
    finish(&store, &study, "review");
    let saved = store.research_study(&study.id).unwrap();
    let gate_id = crate::store::research::Study::task_gate_id("review");
    let decision = saved
        .decisions
        .iter()
        .rev()
        .find(|d| d.gate == gate_id)
        .unwrap();
    assert_eq!(decision.status, "pending");
    assert!(saved.ready("audit").is_err());
    store
        .research_decide(
            &study.id,
            &decision.id,
            &decision.scope_hash,
            true,
            "approved".into(),
        )
        .unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert!(saved.ready("audit").is_ok());
}

#[test]
fn plan_revision_inherits_inputs_and_re_requests_task_approval() {
    let (_dir, store, study) = setup();
    let mut input = plan();
    input.tasks[1].requires_approval = true;
    store.research_set_plan(&study.id, input.clone()).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "design", "s1");
    finish(&store, &study, "design");
    bind(&store, &study, "review", "s2");
    finish(&store, &study, "review");
    approve(
        &store,
        &study,
        &crate::store::research::Study::task_gate_id("review"),
    );
    // 相同提交去重；仅 review 的输入变化 → review 重跑、design 继承。
    let (_, deduplicated) = store
        .research_set_plan_idempotent(&study.id, input.clone())
        .unwrap();
    assert!(deduplicated);
    let mut revised = input.clone();
    revised.tasks[1].inputs = vec!["design.md".into()];
    let (version, deduplicated) = store
        .research_set_plan_idempotent(&study.id, revised)
        .unwrap();
    assert!(!deduplicated);
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.plan().unwrap().version, version);
    assert_eq!(saved.task("design").unwrap().state, "completed");
    assert_eq!(saved.task("review").unwrap().state, "pending");
    // 新版本下重新完成 review 后，需要重新批准任务确认才能放行下游。
    let gate_id = crate::store::research::Study::task_gate_id("review");
    let stale = saved
        .decisions
        .iter()
        .filter(|d| d.gate == gate_id && d.version == version)
        .all(|d| d.status != "pending");
    assert!(stale);
}

#[test]
fn dispatch_prompt_injects_inputs_verdict_and_feedback() {
    let (_dir, store, study) = setup();
    let mut input = plan();
    input.tasks[1].inputs = vec!["design.md".into()];
    input.tasks[1].gate_downstream = true;
    input.tasks[1].max_rework = 1;
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "design", "s1");
    finish(&store, &study, "design");
    bind(&store, &study, "review", "s2");
    finish_with_verdict(&store, &study, "review", "blocked", &["缺少对照"]);
    let saved = store.research_study(&study.id).unwrap();
    // 被返工的设计任务：提示词携带返工意见。
    let entry = saved.task("design").unwrap();
    let prompt =
        crate::commands::research_dispatch::task_dispatch_prompt(&store, &saved, entry).unwrap();
    assert!(prompt.contains("返工意见"));
    // 审稿任务：提示词携带输入产物哈希与结论把关要求。
    let entry = saved.task("review").unwrap();
    let prompt =
        crate::commands::research_dispatch::task_dispatch_prompt(&store, &saved, entry).unwrap();
    assert!(prompt.contains("design.md（sha256 前 12 位："));
    assert!(prompt.contains("review.md.verdict.json"));
    assert!(prompt.contains("结论把关"));
} // —— 条件分流、汇合与跳过（批次一，2026-11-16 方案）——

/// 分流测试的标准任务表：design（结论把关）→ brancher（按结论分流）
/// → 成立走 fixpath（综合），不成立走 retrypath（改大纲），
/// 审稿在汇合点之后收束两条分支（跳过的一侧视为已满足），审计收尾。
fn route_plan() -> PlanInput {
    let mut design = spec("design", "as-experiment-designer", &["strategy"]);
    design.gate_downstream = true;
    let brancher = route_spec(
        "brancher",
        &["design"],
        RouteSpec {
            on: "verdict".into(),
            source: "design.md".into(),
            verdict_is: "blocked".into(),
        },
    );
    let mut fixpath = branch_spec("fixpath", "as-research-synthesizer", &["brancher"], "then");
    let mut retrypath = branch_spec("retrypath", "as-outline-architect", &["brancher"], "else");
    let mut review = spec(
        "review",
        "as-independent-reviewer",
        &["fixpath", "retrypath"],
    );
    let mut audit = spec("audit", "as-quality-citation-auditor", &["review"]);
    fixpath.brief = "备用综合".into();
    retrypath.brief = "改写大纲".into();
    review.brief = "审稿".into();
    audit.brief = "审计收束".into();
    PlanInput {
        workflow: None,
        summary: "verdict routing baseline".into(),
        tasks: vec![
            spec("strategy", "as-literature-strategist", &[]),
            design,
            brancher,
            fixpath,
            retrypath,
            review,
            audit,
        ],
    }
}

fn run_route_plan(store: &Store, study: &Study) {
    store.research_set_plan(&study.id, route_plan()).unwrap();
    approve(store, study, "G1");
}

fn route_spec(id: &str, deps: &[&str], route: RouteSpec) -> TaskSpec {
    TaskSpec {
        id: id.into(),
        role: String::new(),
        brief: format!("分流 {id}"),
        depends_on: deps.iter().map(|d| (*d).into()).collect(),
        outputs: vec![],
        force_rerun: false,
        inputs: vec![],
        requires_approval: false,
        gate_downstream: false,
        max_rework: 0,
        kind: "route".into(),
        route: Some(route),
        route_branch: String::new(),
        wait_for: String::new(),
        for_each: None,
        wait_step: None,
    }
}

fn branch_spec(id: &str, role: &str, deps: &[&str], branch: &str) -> TaskSpec {
    let mut task = spec(id, role, deps);
    task.route_branch = branch.into();
    task
}

#[test]
fn route_plans_fail_validation_without_two_branches_or_valid_source() {
    let mut input = route_plan();
    if let Err(error) = validate_plan(&input, "team") {
        panic!("baseline route plan invalid: {error}");
    }
    // 来源任务未开启结论把关：分流没有可读取的结论。
    input.tasks[1].gate_downstream = false;
    assert!(validate_plan(&input, "team").is_err());
    input.tasks[1].gate_downstream = true;
    // 分流节点不能选专家、不能产出文件、不能没有前置。
    let mut with_role = input.clone();
    with_role.tasks[2].role = "as-research-synthesizer".into();
    assert!(validate_plan(&with_role, "team").is_err());
    let mut with_outputs = input.clone();
    with_outputs.tasks[2].outputs = vec!["route.md".into()];
    assert!(validate_plan(&with_outputs, "team").is_err());
    let mut no_deps = input.clone();
    no_deps.tasks[2].depends_on = vec![];
    assert!(validate_plan(&no_deps, "team").is_err());
    // 条件来源必须来自直接前置任务的产物。
    let mut foreign_source = input.clone();
    foreign_source.tasks[2].route.as_mut().unwrap().source = "review.md".into();
    assert!(validate_plan(&foreign_source, "team").is_err());
    // 「成立」与「不成立」两条分支都必须存在（不成立即默认出口）。
    let mut missing_else = input.clone();
    missing_else.tasks[4].route_branch = "then".into();
    assert!(validate_plan(&missing_else, "team").is_err());
    // 分支标记只能挂在分流的直接下游。
    let mut stray_branch = input.clone();
    stray_branch.tasks[5].route_branch = "then".into();
    assert!(validate_plan(&stray_branch, "team").is_err());
    // 失败分流不选来源产物或结论值。
    let mut failure_route = input.clone();
    failure_route.tasks[2].route = Some(RouteSpec {
        on: "failure".into(),
        source: String::new(),
        verdict_is: String::new(),
    });
    assert!(validate_plan(&failure_route, "team").is_ok());
    let mut failure_with_source = failure_route.clone();
    failure_with_source.tasks[2].route.as_mut().unwrap().source = "design.md".into();
    assert!(validate_plan(&failure_with_source, "team").is_err());
    // 汇合「任一完成」至少要两条前置连线。
    let mut join_one = input.clone();
    join_one.tasks[4].wait_for = "any".into();
    assert!(validate_plan(&join_one, "team").is_err());
    join_one.tasks[4].depends_on = vec!["brancher".into(), "design".into()];
    assert!(validate_plan(&join_one, "team").is_ok());
}

#[test]
fn blocked_verdict_routes_to_fallback_and_skips_main_branch() {
    let (_dir, store, study) = setup();
    run_route_plan(&store, &study);
    bind(&store, &study, "strategy", "s0");
    finish(&store, &study, "strategy");
    bind(&store, &study, "design", "s1");
    finish_with_verdict(&store, &study, "design", "blocked", &["需要换方法"]);
    let saved = store.research_study(&study.id).unwrap();
    // 分流节点按阻塞结论走「成立」分支；主分支被跳过。
    let route = saved.task("brancher").unwrap();
    assert_eq!(route.state, "completed");
    assert_eq!(route.route_decision.as_ref().unwrap().outcome, "matched");
    assert_eq!(saved.task("retrypath").unwrap().state, "skipped");
    assert_eq!(saved.task("fixpath").unwrap().state, "pending");
    assert!(saved.ready("fixpath").is_ok());
    // 跳过的任务不再派发：ready 只看资格，绑定会在状态检查处拒绝。
    assert!(store
        .research_bind_task(&study.id, "retrypath", "s9")
        .is_err());
    // 审稿要等「成立」分支跑完（跳过的一侧视为已满足）。
    assert!(saved.ready("review").is_err());
}

#[test]
fn pass_verdict_keeps_main_branch_and_delivery_accepts_skipped_tasks() {
    let (_dir, store, study) = setup();
    run_route_plan(&store, &study);
    bind(&store, &study, "strategy", "s0");
    finish(&store, &study, "strategy");
    bind(&store, &study, "design", "s1");
    finish_with_verdict(&store, &study, "design", "pass", &[]);
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(
        saved
            .task("brancher")
            .unwrap()
            .route_decision
            .as_ref()
            .unwrap()
            .outcome,
        "unmatched"
    );
    assert_eq!(saved.task("retrypath").unwrap().state, "pending");
    assert_eq!(saved.task("fixpath").unwrap().state, "skipped");
    // 主分支走完、审稿审计收束后：跳过任务不拦交付。
    bind(&store, &study, "retrypath", "s2");
    finish(&store, &study, "retrypath");
    bind(&store, &study, "review", "s3");
    finish(&store, &study, "review");
    bind(&store, &study, "audit", "s4");
    finish(&store, &study, "audit");
    let saved = store.research_study(&study.id).unwrap();
    store.research_prepare_delivery(&saved).unwrap();
}

#[test]
fn failed_task_routes_to_failure_fallback_branch() {
    let (_dir, store, study) = setup();
    let mut input = route_plan();
    input.tasks[2].route = Some(RouteSpec {
        on: "failure".into(),
        source: String::new(),
        verdict_is: String::new(),
    });
    input.tasks[1].gate_downstream = false;
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "strategy", "s0");
    finish(&store, &study, "strategy");
    bind(&store, &study, "design", "s1");
    store
        .research_finish(&study.id, "design", false, "专家会话崩溃".into())
        .unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(
        saved
            .task("brancher")
            .unwrap()
            .route_decision
            .as_ref()
            .unwrap()
            .outcome,
        "matched"
    );
    assert_eq!(saved.task("retrypath").unwrap().state, "skipped");
    assert_eq!(saved.task("fixpath").unwrap().state, "pending");
    assert!(saved.ready("fixpath").is_ok());
}

#[test]
fn join_any_releases_after_first_completed_dependency() {
    let (_dir, store, study) = setup();
    let mut joiner = spec("joiner", "as-research-synthesizer", &["design", "parallel"]);
    joiner.wait_for = "any".into();
    let input = PlanInput {
        workflow: None,
        summary: "join any baseline".into(),
        tasks: vec![
            spec("design", "as-experiment-designer", &[]),
            spec("parallel", "as-literature-strategist", &[]),
            joiner,
            spec("review", "as-independent-reviewer", &["joiner"]),
            spec("audit", "as-quality-citation-auditor", &["review"]),
        ],
    };
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "design", "s1");
    finish(&store, &study, "design");
    let saved = store.research_study(&study.id).unwrap();
    // design 已完成、parallel 还没跑：「任一完成」即可放行；默认「全部完成」不受影响。
    assert_eq!(saved.task("parallel").unwrap().state, "pending");
    assert!(saved.ready("joiner").is_ok());
    assert!(saved.ready("review").is_err());
}

#[test]
fn rework_resets_routes_and_branches_then_reroutes_on_new_verdict() {
    let (_dir, store, study) = setup();
    let mut input = route_plan();
    input.tasks[1].max_rework = 1;
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "strategy", "s0");
    finish(&store, &study, "strategy");
    bind(&store, &study, "design", "s1");
    finish_with_verdict(&store, &study, "design", "blocked", &["换方法"]);
    let saved = store.research_study(&study.id).unwrap();
    // 第一轮返工在验收时立即启动：分流节点尚未求值，全员回到待执行。
    assert_eq!(saved.task("design").unwrap().rework_count, 1);
    assert_eq!(saved.task("brancher").unwrap().state, "pending");
    assert_eq!(saved.task("brancher").unwrap().route_decision, None);
    assert_eq!(saved.task("retrypath").unwrap().state, "pending");
    // 返工重置了上游：先重跑 strategy，再带着新结论重跑 design。
    bind(&store, &study, "strategy", "s2");
    finish(&store, &study, "strategy");
    bind(&store, &study, "design", "s3");
    finish_with_verdict(&store, &study, "design", "pass", &[]);
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("brancher").unwrap().state, "completed");
    assert_eq!(
        saved
            .task("brancher")
            .unwrap()
            .route_decision
            .as_ref()
            .unwrap()
            .outcome,
        "unmatched"
    );
    assert_eq!(saved.task("retrypath").unwrap().state, "pending");
    assert_eq!(saved.task("fixpath").unwrap().state, "skipped");
    assert!(saved.ready("retrypath").is_ok());
}

#[test]
fn legacy_specs_without_route_fields_parse_and_serialize_stably() {
    let plain = spec("design", "as-experiment-designer", &[]);
    let legacy = r#"{"id":"design","role":"as-experiment-designer","brief":"produce design","dependsOn":[],"outputs":["design.md"]}"#;
    let parsed: TaskSpec = serde_json::from_str(legacy).unwrap();
    assert_eq!(parsed, plain);
    // 空值字段不进入序列化：已批准计划的 plan_scope 哈希保持不变。
    assert_eq!(serde_json::to_string(&parsed).unwrap(), legacy);
}

// —— 逐项处理 foreach 与人工任务 human（批次二，2026-11-16 方案）——

fn foreach_spec(
    id: &str,
    deps: &[&str],
    source: &str,
    item_output: &str,
    on_failure: &str,
) -> TaskSpec {
    TaskSpec {
        id: id.into(),
        role: String::new(),
        brief: format!("逐项 {id}"),
        depends_on: deps.iter().map(|d| (*d).into()).collect(),
        outputs: vec![],
        force_rerun: false,
        inputs: vec![],
        requires_approval: false,
        gate_downstream: false,
        max_rework: 0,
        kind: "foreach".into(),
        route: None,
        route_branch: String::new(),
        wait_for: String::new(),
        for_each: Some(crate::store::research::ForEachSpec {
            source: source.into(),
            item_output: item_output.into(),
            item_brief: "逐篇精读 {item}".into(),
            on_failure: on_failure.into(),
        }),
        wait_step: None,
    }
}

fn human_spec(id: &str, deps: &[&str], output: &str) -> TaskSpec {
    let mut task = spec(id, "as-research-synthesizer", deps);
    task.role = String::new();
    task.kind = "human".into();
    task.outputs = vec![output.into()];
    task.brief = "给出评价标准".into();
    task
}

fn foreach_plan(on_failure: &str) -> PlanInput {
    PlanInput {
        workflow: None,
        summary: "foreach baseline".into(),
        tasks: vec![
            spec("strategy", "as-literature-strategist", &[]),
            spec("papers", "as-literature-researcher", &["strategy"]),
            foreach_spec(
                "readings",
                &["papers"],
                "papers.md",
                "readings/{item}.md",
                on_failure,
            ),
            spec("review", "as-independent-reviewer", &["readings"]),
            spec("audit", "as-quality-citation-auditor", &["review"]),
        ],
    }
}

fn write_list(store: &Store, study: &Study) {
    let root = store.research_root(study).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("papers.md"), "# 论文清单\n- a\n- b").unwrap();
    std::fs::write(
        root.join("papers.md.items.json"),
        r#"{"items":[{"id":"paper-a","title":"论文甲"},{"id":"paper-b","title":"论文乙"}]}"#,
    )
    .unwrap();
}

#[test]
fn foreach_and_human_plans_fail_validation_on_bad_shapes() {
    let mut input = foreach_plan("pause");
    assert!(validate_plan(&input, "team").is_ok());
    // 列表来源不是直接前置任务的产物。
    input.tasks[2].for_each.as_mut().unwrap().source = "review.md".into();
    assert!(validate_plan(&input, "team").is_err());
    // 模板缺少 {item} 占位。
    let mut no_placeholder = foreach_plan("pause");
    no_placeholder.tasks[2]
        .for_each
        .as_mut()
        .unwrap()
        .item_output = "readings/all.md".into();
    assert!(validate_plan(&no_placeholder, "team").is_err());
    // 模板路径越界。
    let mut escaping = foreach_plan("pause");
    escaping.tasks[2].for_each.as_mut().unwrap().item_output = "../readings/{item}.md".into();
    assert!(validate_plan(&escaping, "team").is_err());
    // 失败策略只允许暂停或跳过继续。
    let mut bad_policy = foreach_plan("pause");
    bad_policy.tasks[2].for_each.as_mut().unwrap().on_failure = "ignore".into();
    assert!(validate_plan(&bad_policy, "team").is_err());
    // 逐项任务不产出文件、不选专家、不支持把关。
    let mut with_outputs = foreach_plan("pause");
    with_outputs.tasks[2].outputs = vec!["all.md".into()];
    assert!(validate_plan(&with_outputs, "team").is_err());
    let mut gated = foreach_plan("pause");
    gated.tasks[2].gate_downstream = true;
    assert!(validate_plan(&gated, "team").is_err());
    // 人工任务需要恰好一个产物，且不叠加确认。
    let mut human_double = foreach_plan("pause");
    human_double
        .tasks
        .insert(3, human_spec("confirm", &["readings"], "confirm.md"));
    human_double.tasks[3].outputs.push("confirm-2.md".into());
    assert!(validate_plan(&human_double, "team").is_err());
    let mut human_approval = foreach_plan("pause");
    human_approval
        .tasks
        .insert(3, human_spec("confirm", &["readings"], "confirm.md"));
    human_approval.tasks[3].requires_approval = true;
    assert!(validate_plan(&human_approval, "team").is_err());
    assert!(validate_plan(&human_double, "team").is_err());
}

#[test]
fn foreach_runs_items_serially_and_feeds_downstream() {
    let (_dir, store, study) = setup();
    store
        .research_set_plan(&study.id, foreach_plan("pause"))
        .unwrap();
    approve(&store, &study, "G1");
    // 上游派发提示词携带清单 sidecar 要求。
    let saved = store.research_study(&study.id).unwrap();
    let entry = saved.task("papers").unwrap();
    let prompt =
        crate::commands::research_dispatch::task_dispatch_prompt(&store, &saved, entry).unwrap();
    assert!(prompt.contains("papers.md.items.json"));
    bind(&store, &study, "strategy", "s0");
    finish(&store, &study, "strategy");
    bind(&store, &study, "papers", "s1");
    write_list(&store, &study);
    store
        .research_finish(&study.id, "papers", true, "清单完成".into())
        .unwrap();
    // 清单缺失时逐项任务转失败并说明缺什么。
    let (_dir2, store2, study2) = setup();
    store2
        .research_set_plan(&study2.id, foreach_plan("pause"))
        .unwrap();
    approve(&store2, &study2, "G1");
    bind(&store2, &study2, "strategy", "s0");
    finish(&store2, &study2, "strategy");
    bind(&store2, &study2, "papers", "s1");
    let root = store2.research_root(&study2).unwrap();
    std::fs::write(root.join("papers.md"), "# 清单").unwrap();
    store2
        .research_finish(&study2.id, "papers", true, "没写清单".into())
        .unwrap();
    let dispatched =
        crate::commands::research_dispatch::auto_dispatch_sync(&store2, &study2.id).unwrap();
    assert!(dispatched.is_empty());
    let saved2 = store2.research_study(&study2.id).unwrap();
    assert_eq!(saved2.task("readings").unwrap().state, "failed");
    assert!(saved2
        .task("readings")
        .unwrap()
        .summary
        .as_deref()
        .unwrap()
        .contains("逐项清单缺失"));

    // 正常路径：物化清单 → 串行逐项派发 → 全部完成后下游可派发。
    let dispatched =
        crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    assert_eq!(dispatched.len(), 1);
    assert_eq!(dispatched[0].0, "readings");
    let saved = store.research_study(&study.id).unwrap();
    let readings = saved.task("readings").unwrap();
    assert_eq!(readings.state, "running");
    assert_eq!(readings.foreach_items.as_ref().unwrap().len(), 2);
    assert_eq!(readings.foreach_items.as_ref().unwrap()[0].id, "paper-a");
    // 逐项派发提示词只交代当前项。
    let entry = saved.task("readings").unwrap();
    let prompt =
        crate::commands::research_dispatch::task_dispatch_prompt(&store, &saved, entry).unwrap();
    assert!(prompt.contains("第 1/2 项"));
    assert!(prompt.contains("论文甲"));
    assert!(prompt.contains("readings/paper-a.md"));
    let root = store.research_root(&study).unwrap();
    std::fs::create_dir_all(root.join("readings")).unwrap();
    std::fs::write(root.join("readings/paper-a.md"), "# 论文甲精读").unwrap();
    store
        .research_auto_finish(&study.id, "readings", "甲完成".into())
        .unwrap();
    let saved = store.research_study(&study.id).unwrap();
    let readings = saved.task("readings").unwrap();
    assert_eq!(readings.state, "pending");
    assert_eq!(readings.foreach_runs.len(), 1);
    assert!(readings.foreach_runs[0].ok);
    assert_eq!(readings.summary.as_deref(), Some("逐项处理进行中（1/2）。"));
    // 第二项派发与收束：完成后产物聚合全部项。
    let dispatched =
        crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    assert_eq!(dispatched.len(), 1);
    let prompt = crate::commands::research_dispatch::task_dispatch_prompt(
        &store,
        &store.research_study(&study.id).unwrap(),
        store
            .research_study(&study.id)
            .unwrap()
            .task("readings")
            .unwrap(),
    )
    .unwrap();
    assert!(prompt.contains("第 2/2 项"));
    assert!(prompt.contains("readings/paper-b.md"));
    std::fs::create_dir_all(root.join("readings")).unwrap();
    std::fs::write(root.join("readings/paper-b.md"), "# 论文乙精读").unwrap();
    store
        .research_auto_finish(&study.id, "readings", "乙完成".into())
        .unwrap();
    let saved = store.research_study(&study.id).unwrap();
    let readings = saved.task("readings").unwrap();
    assert_eq!(readings.state, "completed");
    assert_eq!(readings.artifacts.len(), 2);
    assert!(saved.ready("review").is_ok());
}

#[test]
fn foreach_failure_pauses_then_retry_reruns_that_item() {
    let (_dir, store, study) = setup();
    store
        .research_set_plan(&study.id, foreach_plan("pause"))
        .unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "strategy", "s0");
    finish(&store, &study, "strategy");
    bind(&store, &study, "papers", "s1");
    write_list(&store, &study);
    store
        .research_finish(&study.id, "papers", true, "清单完成".into())
        .unwrap();
    crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    // 第一项失败：任务整体暂停，等待主理人重试。
    store
        .research_finish(&study.id, "readings", false, "没写出产物".into())
        .unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("readings").unwrap().state, "failed");
    assert_eq!(saved.task("readings").unwrap().foreach_runs.len(), 1);
    assert!(!saved.task("readings").unwrap().foreach_runs[0].ok);
    // 重试：移除失败迭代，重新派发同一项。
    store.research_retry_task(&study.id, "readings").unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("readings").unwrap().foreach_runs.len(), 0);
    assert_eq!(saved.task("readings").unwrap().state, "pending");
    let dispatched =
        crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    assert_eq!(dispatched.len(), 1);
    let prompt = crate::commands::research_dispatch::task_dispatch_prompt(
        &store,
        &store.research_study(&study.id).unwrap(),
        store
            .research_study(&study.id)
            .unwrap()
            .task("readings")
            .unwrap(),
    )
    .unwrap();
    assert!(prompt.contains("第 1/2 项"));
}

#[test]
fn foreach_skip_policy_continues_past_failures() {
    let (_dir, store, study) = setup();
    store
        .research_set_plan(&study.id, foreach_plan("skip"))
        .unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "strategy", "s0");
    finish(&store, &study, "strategy");
    bind(&store, &study, "papers", "s1");
    write_list(&store, &study);
    store
        .research_finish(&study.id, "papers", true, "清单完成".into())
        .unwrap();
    crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    // 第一项失败：跳过继续，第二项照常派发。
    store
        .research_finish(&study.id, "readings", false, "这项做不出来".into())
        .unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("readings").unwrap().state, "pending");
    assert_eq!(saved.task("readings").unwrap().foreach_runs.len(), 1);
    let dispatched =
        crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    assert_eq!(dispatched.len(), 1);
    let root = store.research_root(&study).unwrap();
    std::fs::create_dir_all(root.join("readings")).unwrap();
    std::fs::write(root.join("readings/paper-b.md"), "# 论文乙精读").unwrap();
    store
        .research_auto_finish(&study.id, "readings", "乙完成".into())
        .unwrap();
    let saved = store.research_study(&study.id).unwrap();
    let readings = saved.task("readings").unwrap();
    assert_eq!(readings.state, "completed");
    assert_eq!(readings.foreach_runs.len(), 2);
    // 只聚合成功项的产物。
    assert_eq!(readings.artifacts.len(), 1);
    assert_eq!(readings.artifacts[0].path, "readings/paper-b.md");
}

#[test]
fn human_task_awaits_owner_submission_and_feeds_downstream() {
    let (_dir, store, study) = setup();
    let mut input = foreach_plan("pause");
    input
        .tasks
        .insert(3, human_spec("confirm", &["readings"], "criteria.md"));
    // 审稿收束逐项与人工两条线；归档依赖审稿。
    input.tasks[4].depends_on = vec!["readings".into(), "confirm".into()];
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "strategy", "s0");
    finish(&store, &study, "strategy");
    // 前置未完成：人工任务不能提前提交。
    assert!(store
        .research_submit_human(&study.id, "confirm", "先给标准".into())
        .is_err());
    bind(&store, &study, "papers", "s1");
    write_list(&store, &study);
    store
        .research_finish(&study.id, "papers", true, "清单完成".into())
        .unwrap();
    crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    let root = store.research_root(&study).unwrap();
    std::fs::create_dir_all(root.join("readings")).unwrap();
    std::fs::write(root.join("readings/paper-a.md"), "# 论文甲精读").unwrap();
    store
        .research_auto_finish(&study.id, "readings", "甲完成".into())
        .unwrap();
    crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    std::fs::create_dir_all(root.join("readings")).unwrap();
    std::fs::write(root.join("readings/paper-b.md"), "# 论文乙精读").unwrap();
    store
        .research_auto_finish(&study.id, "readings", "乙完成".into())
        .unwrap();
    // 逐项完成后：人工任务进入等待主理人产出，派发器不再触碰它。
    let dispatched =
        crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    assert!(dispatched.is_empty());
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("confirm").unwrap().state, "awaiting");
    // 提交即验收完成，产物落盘并自动推进下游。
    store
        .research_submit_human(&study.id, "confirm", "只看消融实验与显著性行。".into())
        .unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("confirm").unwrap().state, "completed");
    assert_eq!(saved.task("confirm").unwrap().artifacts.len(), 1);
    assert_eq!(
        saved.task("confirm").unwrap().artifacts[0].path,
        "criteria.md"
    );
    assert!(saved.ready("review").is_ok());
    let written = std::fs::read(root.join("criteria.md")).unwrap();
    assert_eq!(
        String::from_utf8(written).unwrap(),
        "只看消融实验与显著性行。"
    );
    // 空提交被拒绝。
    let saved = store.research_study(&study.id).unwrap();
    assert!(store
        .research_submit_human(&study.id, "confirm", "  ".into())
        .is_err());
    let _ = saved;
}

// —— 实验节点 experiment 与事件等待 wait（批次三，2026-11-16 方案）——

fn wait_spec(id: &str, deps: &[&str], source: &str, timeout_minutes: u32) -> TaskSpec {
    TaskSpec {
        id: id.into(),
        role: String::new(),
        brief: format!("等待 {source}"),
        depends_on: deps.iter().map(|d| (*d).into()).collect(),
        outputs: vec![],
        force_rerun: false,
        inputs: vec![],
        requires_approval: false,
        gate_downstream: false,
        max_rework: 0,
        kind: "wait".into(),
        route: None,
        route_branch: String::new(),
        wait_for: String::new(),
        for_each: None,
        wait_step: Some(crate::store::research::WaitStepSpec {
            source: source.into(),
            timeout_minutes,
        }),
    }
}

fn experiment_spec(id: &str, deps: &[&str]) -> TaskSpec {
    let mut task = spec(id, "as-experiment-designer", deps);
    task.role = String::new();
    task.kind = "experiment".into();
    task.outputs = vec![format!("metrics-{id}.md")];
    task.brief = "运行基线实验".into();
    task
}

#[test]
fn experiment_and_wait_plans_fail_validation_on_bad_shapes() {
    let mut input = foreach_plan("pause");
    // 审稿祖先规则要求全部非审查角色都在审稿上游：实验节点插在审稿之前。
    let mut baseline = experiment_spec("baseline", &["readings"]);
    baseline.brief = "运行基线实验".into();
    let review_index = input
        .tasks
        .iter()
        .position(|t| t.role == "as-independent-reviewer")
        .unwrap();
    input.tasks.insert(review_index, baseline);
    let review_index = input
        .tasks
        .iter()
        .position(|t| t.role == "as-independent-reviewer")
        .unwrap();
    input.tasks[review_index].depends_on = vec!["baseline".into()];
    assert!(validate_plan(&input, "team").is_ok());
    // 实验节点必须声明产物、不叠加确认。
    let exp_index = input
        .tasks
        .iter()
        .position(|t| t.kind == "experiment")
        .unwrap();
    let mut no_outputs = input.clone();
    no_outputs.tasks[exp_index].outputs = vec![];
    assert!(validate_plan(&no_outputs, "team").is_err());
    let mut approval = input.clone();
    approval.tasks[exp_index].requires_approval = true;
    assert!(validate_plan(&approval, "team").is_err());
    // 等待节点需要等待定义、路径越界要拒绝、超时不超过 24 小时。
    // 审稿祖先规则同样覆盖等待节点：审稿改挂等待之后。
    input.tasks.insert(
        review_index,
        wait_spec("notify", &["baseline"], "baseline-done.md", 30),
    );
    let review_index = input
        .tasks
        .iter()
        .position(|t| t.role == "as-independent-reviewer")
        .unwrap();
    input.tasks[review_index].depends_on = vec!["notify".into()];
    assert!(validate_plan(&input, "team").is_ok());
    let wait_index = input.tasks.iter().position(|t| t.kind == "wait").unwrap();
    let mut missing = input.clone();
    missing.tasks[wait_index].wait_step = None;
    assert!(validate_plan(&missing, "team").is_err());
    let mut escaping = input.clone();
    escaping.tasks[wait_index]
        .wait_step
        .as_mut()
        .unwrap()
        .source = "../elsewhere.md".into();
    assert!(validate_plan(&escaping, "team").is_err());
    let mut too_long = input.clone();
    too_long.tasks[wait_index]
        .wait_step
        .as_mut()
        .unwrap()
        .timeout_minutes = 25 * 60;
    assert!(validate_plan(&too_long, "team").is_err());
    let mut with_outputs = input.clone();
    with_outputs.tasks[wait_index].outputs = vec!["seen.md".into()];
    assert!(validate_plan(&with_outputs, "team").is_err());
}

#[test]
fn wait_node_completes_when_path_appears_and_fails_on_timeout() {
    let (_dir, store, study) = setup();
    let mut input = foreach_plan("pause");
    input.tasks = vec![
        spec("strategy", "as-literature-strategist", &[]),
        wait_spec("notify", &["strategy"], "handoff/ready.md", 30),
        spec("review", "as-independent-reviewer", &["notify"]),
        spec("audit", "as-quality-citation-auditor", &["review"]),
    ];
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "strategy", "s0");
    finish(&store, &study, "strategy");
    // 路径未出现：等待节点保持待推进并记录等待说明，不派发专家。
    let dispatched =
        crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    assert!(dispatched.is_empty());
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("notify").unwrap().state, "pending");
    let started_at = saved.task("notify").unwrap().wait_started_at;
    assert!(started_at.is_some());
    assert!(saved
        .task("notify")
        .unwrap()
        .summary
        .as_deref()
        .unwrap()
        .contains("handoff/ready.md"));
    // 路径出现：等待节点完成，下游放行。
    let root = store.research_root(&study).unwrap();
    std::fs::create_dir_all(root.join("handoff")).unwrap();
    std::fs::write(root.join("handoff/ready.md"), "ok").unwrap();
    crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("notify").unwrap().state, "completed");
    assert!(saved.ready("review").is_ok());
}

#[test]
fn wait_node_times_out_into_failed_for_the_owner() {
    let (_dir, store, study) = setup();
    let mut input = foreach_plan("pause");
    input.tasks = vec![
        spec("strategy", "as-literature-strategist", &[]),
        wait_spec("notify", &["strategy"], "handoff/never.md", 30),
        spec("review", "as-independent-reviewer", &["notify"]),
        spec("audit", "as-quality-citation-auditor", &["review"]),
    ];
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "strategy", "s0");
    finish(&store, &study, "strategy");
    crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    // 把等待开始时间拨回 31 分钟前：下一次求值判超时转失败。
    store
        .research_update(&study.id, |s| {
            let task = s.task_mut("notify")?;
            task.wait_started_at = Some(crate::store::now_ms() - 31 * 60_000);
            Ok(())
        })
        .unwrap();
    crate::commands::research_dispatch::auto_dispatch_sync(&store, &study.id).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("notify").unwrap().state, "failed");
    assert!(saved
        .task("notify")
        .unwrap()
        .summary
        .as_deref()
        .unwrap()
        .contains("等待超时"));
    assert!(saved.ready("review").is_err());
}

#[test]
fn experiment_node_accepts_attached_runs_and_wraps_up_on_terminal() {
    let (_dir, store, study) = setup();
    let mut input = foreach_plan("pause");
    input.tasks = vec![
        spec("strategy", "as-literature-strategist", &[]),
        experiment_spec("baseline", &["strategy"]),
        spec("review", "as-independent-reviewer", &["baseline"]),
        spec("audit", "as-quality-citation-auditor", &["review"]),
    ];
    store.research_set_plan(&study.id, input).unwrap();
    approve(&store, &study, "G1");
    bind(&store, &study, "strategy", "s0");
    finish(&store, &study, "strategy");
    // 绑定运行契约（G2/G3 请求随绑定生成）。
    store
        .create_local_experiment(&crate::local::model::LocalExperiment {
            id: "exp".into(),
            project_id: "project".into(),
            parent_experiment_id: None,
            slug: "exp".into(),
            branch_name: "main".into(),
            title: None,
            description: None,
            run_command: "python3 main.py".into(),
            agent_status: "idle".into(),
            created_at: 1,
            updated_at: 1,
            chat_session_id: Some("lead".into()),
            archived: false,
        })
        .unwrap();
    let contract = crate::store::research::RunContract {
        experiment_id: "exp".into(),
        revision: "abc".into(),
        command: "python3 main.py".into(),
        options: serde_json::json!({"backend":"local","timeout":"4h"}),
    };
    store
        .research_prepare(&study.id, "baseline", contract)
        .unwrap();
    // G2/G3 未批准前实验节点不就绪。
    let saved = store.research_study(&study.id).unwrap();
    assert!(saved.ready("baseline").is_err());
    approve(&store, &study, "G2");
    approve(&store, &study, "G3");
    let saved = store.research_study(&study.id).unwrap();
    assert!(saved.ready("baseline").is_ok());
    // 挂接引擎提交的运行。
    store
        .conn
        .execute(
            "INSERT INTO runs(id,experiment_id,project_id,status,backend_json,created_at,updated_at) VALUES('run-1','exp','project','done','{}',1,2)",
            [],
        )
        .unwrap();
    store
        .research_attach_experiment_run(&study.id, "baseline", "run-1")
        .unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("baseline").unwrap().state, "running");
    // 运行成功但产物缺失：验收转失败并说明缺什么。
    store
        .research_reconcile_experiment_tasks(&study.id)
        .unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("baseline").unwrap().state, "failed");
    assert!(saved
        .task("baseline")
        .unwrap()
        .summary
        .as_deref()
        .unwrap()
        .contains("metrics-baseline.md"));
    // 重试移除运行并回到待提交；挂接新的成功运行且产物落盘后收束。
    store.research_retry_task(&study.id, "baseline").unwrap();
    let saved = store.research_study(&study.id).unwrap();
    assert_eq!(saved.task("baseline").unwrap().state, "pending");
    assert!(saved.task("baseline").unwrap().run_ids.is_empty());
    store
        .conn
        .execute(
            "INSERT INTO runs(id,experiment_id,project_id,status,backend_json,created_at,updated_at) VALUES('run-2','exp','project','done','{}',3,4)",
            [],
        )
        .unwrap();
    let root = store.research_root(&study).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("metrics-baseline.md"), "# 指标\nacc=0.9").unwrap();
    store
        .research_attach_experiment_run(&study.id, "baseline", "run-2")
        .unwrap();
    store
        .research_reconcile_experiment_tasks(&study.id)
        .unwrap();
    let saved = store.research_study(&study.id).unwrap();
    let baseline = saved.task("baseline").unwrap();
    assert_eq!(baseline.state, "completed");
    assert_eq!(baseline.artifacts.len(), 1);
    assert!(saved.ready("review").is_ok());
}

#[test]
fn custom_agent_mcp_bindings_freeze_into_snapshots() {
    let (_dir, store, study) = setup();
    // 自定义专家挂载 MCP 服务 id（注册表校验在入口层；store 层只持久化）。
    let agent = store
        .create_workflow_agent(crate::workflow::AgentInput {
            name: "量化分析师".into(),
            description: "负责技术指标计算与解读".into(),
            prompt: "你是量化分析专家。".into(),
            mcp_servers: vec!["mcp-quant".into()],
            user_skills: Vec::new(),
        })
        .unwrap();
    // 计划引用该自定义专家：快照冻结挂载（id/名称），内置角色为空。
    let mut input = plan();
    input.tasks[0].role = agent.id.clone();
    store.research_set_plan(&study.id, input).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    let entry = saved.task("design").unwrap();
    let bindings = entry.agent.as_ref().unwrap().mcp_servers.clone();
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].id, "mcp-quant");
    // 未挂载的内置角色快照为空。
    let review = saved.task("review").unwrap();
    assert!(review.agent.is_none());
    // 会话级解析：未绑定任务的会话与缺注册表条目都不产生注入。
    assert!(
        crate::local::research::session_mcp_servers(&store, "expert-none")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn custom_agent_skill_bindings_freeze_into_snapshots() {
    let (_dir, store, study) = setup();
    // 自定义专家挂载上传技能名（入口层校验；store 层只持久化）。
    let agent = store
        .create_workflow_agent(crate::workflow::AgentInput {
            name: "文献提炼师".into(),
            description: "按上传技能操作".into(),
            prompt: "你是文献专家。".into(),
            mcp_servers: Vec::new(),
            user_skills: vec!["lab-protocol".into()],
        })
        .unwrap();
    // 计划引用该自定义专家：快照冻结技能名，内置角色为空。
    let mut input = plan();
    input.tasks[0].role = agent.id.clone();
    store.research_set_plan(&study.id, input).unwrap();
    let saved = store.research_study(&study.id).unwrap();
    let entry = saved.task("design").unwrap();
    let agent_snapshot = entry.agent.as_ref().unwrap();
    assert_eq!(agent_snapshot.mcp_servers.len(), 0);
    assert_eq!(agent_snapshot.user_skills, ["lab-protocol"]);
    let review = saved.task("review").unwrap();
    assert!(review.agent.is_none());
    // 会话→任务→快照的解析链路由 session_mcp_servers 共用（research_session_task），
    // 注入侧的集合过滤由 user_skills 自己的 write_into_session 作用域测试覆盖。
}
