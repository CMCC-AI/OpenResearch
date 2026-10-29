use super::checkpoint_tests::checkpoint_fixture;
use super::*;

#[tokio::test]
async fn research_settlement_source_errors_preserve_helper_and_do_not_starve_other_spawns() {
    let (dir, store, ctx) = checkpoint_fixture();
    let study = store
        .research_create("session", "team", "isolate damaged research")
        .unwrap();
    use crate::store::research::{PlanInput, TaskSpec};
    store
        .research_set_plan(
            &study.id,
            PlanInput {
                workflow: None,
                summary: "test".into(),
                tasks: [
                    ("design", "as-experiment-designer"),
                    ("review", "as-independent-reviewer"),
                    ("audit", "as-quality-citation-auditor"),
                ]
                .into_iter()
                .map(|(id, role)| TaskSpec {
                    id: id.into(),
                    role: role.into(),
                    brief: "test".into(),
                    outputs: vec![format!("{id}.md")],
                    depends_on: match id {
                        "design" => vec![],
                        "review" => vec!["design".into()],
                        _ => vec!["review".into()],
                    },
                    force_rerun: false,
                })
                .collect(),
            },
        )
        .unwrap();
    store
        .research_update(&study.id, |s| {
            let task = s.task_mut("design")?;
            task.state = "running".into();
            task.session_id = Some("bad-helper".into());
            task.run_ids.push("missing-run".into());
            Ok(())
        })
        .unwrap();
    let tx = store.begin().unwrap();
    tx.execute_batch("INSERT INTO chat_sessions(id,project_id,harness,created_at,updated_at) VALUES
        ('bad-helper','project','codex',1,1),('ordinary-parent','project','codex',1,1),('ordinary-helper','project','codex',1,1);").unwrap();
    tx.execute(
        "INSERT INTO research_sessions VALUES('bad-helper',?1,'design',1)",
        [&study.id],
    )
    .unwrap();
    tx.execute_batch("INSERT INTO chat_spawns(session_id,parent_session_id,prompt,state,wake_parent,requested_at,finished_at) VALUES
        ('bad-helper','session','work','running',1,1,1),
        ('ordinary-helper','ordinary-parent','work','running',0,2,1);").unwrap();
    tx.commit().unwrap();
    let root = dir.clone();
    process_chat_spawns(&ctx.host, Store::open_at(root).unwrap(), None)
        .await
        .unwrap();
    let tx = store.begin().unwrap();
    let state = |id: &str| {
        tx.query_row(
            "SELECT state FROM chat_spawns WHERE session_id=?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .unwrap()
    };
    assert_eq!(state("bad-helper"), "running");
    assert_eq!(state("ordinary-helper"), "done");
    let turns: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM chat_turns WHERE session_id='bad-helper'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(turns, 0);
    tx.commit().unwrap();
    assert_eq!(
        store
            .research_study(&study.id)
            .unwrap()
            .task("design")
            .unwrap()
            .attempts,
        0
    );
    drop(ctx);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
