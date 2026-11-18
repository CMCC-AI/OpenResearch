//! 技能生效范围:绑定关系与历史上传（legacy 全局）集合。
//!
//! 上传技能默认不进任何会话；绑定到项目（`scope_kind = "project"`）或自定义
//! 专家（`scope_kind = "agent"`）后才随那些会话携带。`skill_legacy_global`
//! 记录按需绑定上线时已存在的存量技能，它们保留升级前的全局生效行为。

use rusqlite::params;

use super::Store;
use crate::error::{anyhow, Result};

pub(crate) const SCOPE_PROJECT: &str = "project";
pub(crate) const SCOPE_AGENT: &str = "agent";

pub(super) fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS skill_bindings (
            scope_kind TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            skill_name TEXT NOT NULL,
            PRIMARY KEY (scope_kind, scope_id, skill_name)
        );
        CREATE TABLE IF NOT EXISTS skill_legacy_global (
            skill_name TEXT PRIMARY KEY
        );",
    )?;
    migrate_skill_legacy_global(conn)
}

/// 一次性快照：首次打开时把当时已存在的上传技能记入 legacy 集合。之后上传的
/// 技能不再入集（marker 挡住重扫），否则“存量保留全局”会随时间越滚越大。
fn migrate_skill_legacy_global(conn: &rusqlite::Connection) -> Result<()> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS product_migrations (name TEXT PRIMARY KEY)")?;
    let migrated: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM product_migrations WHERE name = 'skill-legacy-global-v1')",
        [],
        |row| row.get(0),
    )?;
    if migrated {
        tx.commit()?;
        return Ok(());
    }
    // 存量目录在 data_dir 下，store 打开时两者同根；从连接路径反推，测试里
    // `open_at` 指向的临时目录因此天然隔离。拿不到路径时不落 marker，下次
    // 打开重试，避免把存量永久漏在集合外。
    let Some(db_path) = conn.path() else {
        return Ok(());
    };
    let Some(dir) = std::path::Path::new(db_path).parent() else {
        return Ok(());
    };
    let root = dir.join("user-skills");
    // 先跑 retired 项目作用域的提升，保证旧布局里的技能也进快照。
    crate::local::user_skills::migrate_project_scoped(&root);
    for name in crate::local::user_skills::uploaded_names_in(&root) {
        tx.execute(
            "INSERT OR IGNORE INTO skill_legacy_global(skill_name) VALUES(?1)",
            [&name],
        )?;
    }
    tx.execute(
        "INSERT INTO product_migrations (name) VALUES ('skill-legacy-global-v1')",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

fn validate_scope(scope_kind: &str) -> Result<()> {
    if !matches!(scope_kind, SCOPE_PROJECT | SCOPE_AGENT) {
        return Err(anyhow!("未知的技能生效范围: {scope_kind}"));
    }
    Ok(())
}

/// 项目或专家删除时清掉技能绑定——在写事务内调用，与删除保持原子。
/// `delete_local_project` 与 `delete_workflow_agent` 的级联都走这里。
pub(crate) fn purge_scope_bindings_tx(
    tx: &rusqlite::Transaction<'_>,
    scope_kind: &str,
    scope_id: &str,
) -> Result<()> {
    validate_scope(scope_kind)?;
    tx.execute(
        "DELETE FROM skill_bindings WHERE scope_kind=?1 AND scope_id=?2",
        params![scope_kind, scope_id],
    )?;
    Ok(())
}

/// 重写一个自定义专家的技能挂载（在写事务内调用，agent 行与关联表保持原子）。
/// 与 MCP 挂载一致：存在性校验在 API/CLI 入口做，这里只负责持久化，重复项
/// 静默去重；技能删除后的残留引用由会话注入阶段自然跳过。
pub(crate) fn set_agent_skills(
    tx: &rusqlite::Transaction<'_>,
    agent_id: &str,
    skill_names: &[String],
) -> Result<()> {
    tx.execute(
        "DELETE FROM skill_bindings WHERE scope_kind=?1 AND scope_id=?2",
        params![SCOPE_AGENT, agent_id],
    )?;
    for name in skill_names {
        tx.execute(
            "INSERT OR IGNORE INTO skill_bindings(scope_kind,scope_id,skill_name) VALUES(?1,?2,?3)",
            params![SCOPE_AGENT, agent_id, name],
        )?;
    }
    Ok(())
}

impl Store {
    /// 把技能挂到一个生效范围；重复绑定幂等。
    pub fn bind_skill(&self, scope_kind: &str, scope_id: &str, skill_name: &str) -> Result<()> {
        validate_scope(scope_kind)?;
        self.conn.execute(
            "INSERT OR IGNORE INTO skill_bindings(scope_kind,scope_id,skill_name) VALUES(?1,?2,?3)",
            params![scope_kind, scope_id, skill_name],
        )?;
        Ok(())
    }

    pub fn unbind_skill(&self, scope_kind: &str, scope_id: &str, skill_name: &str) -> Result<bool> {
        validate_scope(scope_kind)?;
        Ok(self.conn.execute(
            "DELETE FROM skill_bindings WHERE scope_kind=?1 AND scope_id=?2 AND skill_name=?3",
            params![scope_kind, scope_id, skill_name],
        )? > 0)
    }

    /// 一个范围挂的技能名，按挂载顺序（rowid）。
    pub fn skill_bindings_for_scope(
        &self,
        scope_kind: &str,
        scope_id: &str,
    ) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare(
            "SELECT skill_name FROM skill_bindings WHERE scope_kind=?1 AND scope_id=?2 ORDER BY rowid",
        )?;
        let rows = statement.query_map(params![scope_kind, scope_id], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>, _>>()?)
    }

    /// 全部绑定关系 (scope_kind, scope_id, skill_name)，技能库总览一次取齐。
    pub fn list_skill_bindings(&self) -> Result<Vec<(String, String, String)>> {
        let mut statement = self
            .conn
            .prepare("SELECT scope_kind,scope_id,skill_name FROM skill_bindings ORDER BY rowid")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>, _>>()?)
    }

    /// 技能删除时清掉它的一切绑定。
    pub fn purge_skill_bindings(&self, skill_name: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM skill_bindings WHERE skill_name=?1",
            [skill_name],
        )?;
        Ok(())
    }

    /// 保留全局生效的存量技能名，名字序。
    pub fn legacy_global_skills(&self) -> Result<Vec<String>> {
        let mut statement = self
            .conn
            .prepare("SELECT skill_name FROM skill_legacy_global ORDER BY skill_name")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>, _>>()?)
    }

    /// 存量技能改为按需绑定：移出 legacy 集合，之后只随绑定生效。
    pub fn demote_legacy_global_skill(&self, skill_name: &str) -> Result<bool> {
        Ok(self.conn.execute(
            "DELETE FROM skill_legacy_global WHERE skill_name=?1",
            [skill_name],
        )? > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("orx-skills-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_skill(dir: &Path, name: &str) {
        let skill = dir.join("user-skills/global").join(name);
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: 测试技能\n---\n正文\n"),
        )
        .unwrap();
    }

    #[test]
    fn legacy_seeding_snapshots_uploads_once() {
        let dir = TestDir::new();
        write_skill(dir.path(), "alpha");
        let store = Store::open_at(dir.path().to_path_buf()).unwrap();
        assert_eq!(store.legacy_global_skills().unwrap(), ["alpha"]);

        // 上传新技能后重开：marker 挡住重扫，新技能不得混入 legacy 集合。
        write_skill(dir.path(), "bravo");
        drop(store);
        let reopened = Store::open_at(dir.path().to_path_buf()).unwrap();
        assert_eq!(reopened.legacy_global_skills().unwrap(), ["alpha"]);
    }

    #[test]
    fn fresh_install_without_skills_seeds_empty_legacy_set() {
        let dir = TestDir::new();
        let store = Store::open_at(dir.path().to_path_buf()).unwrap();
        assert!(store.legacy_global_skills().unwrap().is_empty());
        // 空目录也要落 marker：全新安装不存在“后补存量”。
        drop(store);
        let reopened = Store::open_at(dir.path().to_path_buf()).unwrap();
        assert!(reopened.legacy_global_skills().unwrap().is_empty());
    }

    #[test]
    fn bindings_crud_and_cascades() {
        let dir = TestDir::new();
        let store = Store::open_at(dir.path().to_path_buf()).unwrap();
        store.bind_skill(SCOPE_PROJECT, "proj-1", "alpha").unwrap();
        store.bind_skill(SCOPE_PROJECT, "proj-1", "bravo").unwrap();
        store.bind_skill(SCOPE_AGENT, "agent-1", "alpha").unwrap();
        // 幂等
        store.bind_skill(SCOPE_PROJECT, "proj-1", "alpha").unwrap();

        assert_eq!(
            store
                .skill_bindings_for_scope(SCOPE_PROJECT, "proj-1")
                .unwrap(),
            ["alpha", "bravo"]
        );
        assert_eq!(
            store
                .skill_bindings_for_scope(SCOPE_AGENT, "agent-1")
                .unwrap(),
            ["alpha"]
        );
        assert_eq!(store.list_skill_bindings().unwrap().len(), 3);

        assert!(store
            .unbind_skill(SCOPE_PROJECT, "proj-1", "alpha")
            .unwrap());
        assert!(!store
            .unbind_skill(SCOPE_PROJECT, "proj-1", "alpha")
            .unwrap());
        assert_eq!(
            store
                .skill_bindings_for_scope(SCOPE_PROJECT, "proj-1")
                .unwrap(),
            ["bravo"]
        );

        {
            let tx = rusqlite::Transaction::new_unchecked(
                &store.conn,
                rusqlite::TransactionBehavior::Immediate,
            )
            .unwrap();
            purge_scope_bindings_tx(&tx, SCOPE_PROJECT, "proj-1").unwrap();
            tx.commit().unwrap();
        }
        assert!(store
            .skill_bindings_for_scope(SCOPE_PROJECT, "proj-1")
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .skill_bindings_for_scope(SCOPE_AGENT, "agent-1")
                .unwrap(),
            ["alpha"]
        );

        store.purge_skill_bindings("alpha").unwrap();
        assert!(store
            .skill_bindings_for_scope(SCOPE_AGENT, "agent-1")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn unknown_scope_kind_is_rejected() {
        let dir = TestDir::new();
        let store = Store::open_at(dir.path().to_path_buf()).unwrap();
        assert!(store.bind_skill("conversation", "s1", "alpha").is_err());
        assert!(store.unbind_skill("conversation", "s1", "alpha").is_err());
        {
            let tx = rusqlite::Transaction::new_unchecked(
                &store.conn,
                rusqlite::TransactionBehavior::Immediate,
            )
            .unwrap();
            assert!(purge_scope_bindings_tx(&tx, "conversation", "s1").is_err());
        }
    }

    #[test]
    fn demote_moves_skill_out_of_legacy_set() {
        let dir = TestDir::new();
        write_skill(dir.path(), "alpha");
        let store = Store::open_at(dir.path().to_path_buf()).unwrap();
        assert!(store.demote_legacy_global_skill("alpha").unwrap());
        assert!(store.legacy_global_skills().unwrap().is_empty());
        // 再降级一次：已不在集合内。
        assert!(!store.demote_legacy_global_skill("alpha").unwrap());
    }
}
