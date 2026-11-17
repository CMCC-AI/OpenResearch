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
    operator_gates.tasks.insert(
        1,
        spec("execute", "as-experiment-operator", &["design"]),
    );
    operator_gates
        .tasks
        .last_mut()
        .unwrap()
        .gate_downstream = true;
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
        saved.task("audit").unwrap().verdict.as_ref().unwrap().status,
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
    approve(&store, &study, &crate::store::research::Study::task_gate_id("review"));
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
    let prompt = crate::commands::research_dispatch::task_dispatch_prompt(&store, &saved, entry)
        .unwrap();
    assert!(prompt.contains("返工意见"));
    // 审稿任务：提示词携带输入产物哈希与结论把关要求。
    let entry = saved.task("review").unwrap();
    let prompt = crate::commands::research_dispatch::task_dispatch_prompt(&store, &saved, entry)
        .unwrap();
    assert!(prompt.contains("design.md（sha256 前 12 位："));
    assert!(prompt.contains("review.md.verdict.json"));
    assert!(prompt.contains("结论把关"));
}// —— 条件分流、汇合与跳过（批次一，2026-11-16 方案）——

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
    let mut review = spec("review", "as-independent-reviewer", &["fixpath", "retrypath"]);
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
    assert!(store.research_bind_task(&study.id, "retrypath", "s9").is_err());
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
        saved.task("brancher").unwrap().route_decision.as_ref().unwrap().outcome,
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
        saved.task("brancher").unwrap().route_decision.as_ref().unwrap().outcome,
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
        saved.task("brancher").unwrap().route_decision.as_ref().unwrap().outcome,
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
