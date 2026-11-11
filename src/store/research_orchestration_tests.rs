// 输入绑定、任务确认（G5）、结论门控与有界返工的编排语义测试。

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
    // review 未启用结论门控，即使写了结论文件也不参与验收。
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
    // 审稿任务：提示词携带输入产物哈希与结论门控要求。
    let entry = saved.task("review").unwrap();
    let prompt = crate::commands::research_dispatch::task_dispatch_prompt(&store, &saved, entry)
        .unwrap();
    assert!(prompt.contains("design.md（sha256 前 12 位："));
    assert!(prompt.contains("review.md.verdict.json"));
    assert!(prompt.contains("结论门控"));
}
