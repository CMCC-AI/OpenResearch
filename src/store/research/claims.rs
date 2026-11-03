//! Immutable claim bodies plus durable, compare-and-set amendment receipts.
use super::*;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum ClaimAmendmentInput {
    Withdraw {
        version: u32,
        revision: u64,
        reason: String,
    },
    Replace {
        version: u32,
        revision: u64,
        reason: String,
        replacement: Box<ClaimInput>,
    },
}
impl ClaimAmendmentInput {
    fn context(&self) -> (u32, u64, &str) {
        match self {
            Self::Withdraw {
                version,
                revision,
                reason,
            }
            | Self::Replace {
                version,
                revision,
                reason,
                ..
            } => (*version, *revision, reason),
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaimChange {
    pub claim_id: String,
    pub action: String,
    pub reason: String,
    pub actor_session_id: String,
    pub plan_version: u32,
    pub revision: u64,
    pub replacement_id: Option<String>,
    pub claim_hash: String,
    pub replacement_hash: Option<String>,
    pub request_hash: String,
    pub changed_at: i64,
}

pub(super) struct EvidenceScope<'a> {
    pub claims: Vec<&'a EvidenceClaim>,
    pub changes: Vec<ClaimChange>,
}
impl EvidenceScope<'_> {
    pub(super) fn digest(&self) -> Result<String> {
        // Preserve all legacy reviewer/approval hashes until the first amendment.
        let bytes = if self.changes.is_empty() {
            serde_json::to_vec(&self.claims)?
        } else {
            serde_json::to_vec(
                &serde_json::json!({"claims":self.claims,"claimChanges":self.changes}),
            )?
        };
        Ok(digest(&bytes))
    }
}

pub(super) fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS research_claim_changes (
        study_id TEXT NOT NULL REFERENCES research_studies(id) ON DELETE CASCADE,
        claim_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('withdrawn','replaced')),
        reason TEXT NOT NULL CHECK(length(CAST(reason AS BLOB)) BETWEEN 1 AND 4096),
        actor_session_id TEXT NOT NULL, plan_version INTEGER NOT NULL CHECK(plan_version>=0),
        revision INTEGER NOT NULL CHECK(revision>0), replacement_id TEXT,
        claim_hash TEXT NOT NULL, replacement_hash TEXT, request_hash TEXT NOT NULL, changed_at INTEGER NOT NULL,
        PRIMARY KEY(study_id,claim_id), UNIQUE(study_id,revision),
        CHECK((action='withdrawn' AND replacement_id IS NULL AND replacement_hash IS NULL)
           OR (action='replaced' AND replacement_id IS NOT NULL AND replacement_id<>claim_id AND replacement_hash IS NOT NULL))
    );
    CREATE TRIGGER IF NOT EXISTS research_claim_changes_no_update BEFORE UPDATE ON research_claim_changes
    BEGIN SELECT RAISE(ABORT,'声明修订记录不可改写'); END;
    CREATE TRIGGER IF NOT EXISTS research_claim_changes_no_delete BEFORE DELETE ON research_claim_changes
    WHEN EXISTS(SELECT 1 FROM research_studies WHERE id=OLD.study_id)
    BEGIN SELECT RAISE(ABORT,'声明修订记录不可单独删除'); END;
    CREATE TRIGGER IF NOT EXISTS research_claim_revision_guard BEFORE UPDATE ON research_studies
    WHEN EXISTS(SELECT 1 FROM research_claim_changes WHERE study_id=OLD.id)
      AND CASE WHEN json_valid(NEW.document) THEN
        json_extract(NEW.document,'$.claimRevision') IS NOT (SELECT count(*) FROM research_claim_changes WHERE study_id=OLD.id)
        ELSE 1 END
    BEGIN SELECT RAISE(ABORT,'研究声明已修订，请使用支持声明修订的版本'); END;")?;
    Ok(())
}

pub(super) fn require_review_roles<'a>(roles: impl Iterator<Item = &'a str>) -> Result<()> {
    let roles: HashSet<_> = roles.collect();
    if ["as-independent-reviewer", "as-quality-citation-auditor"]
        .iter()
        .any(|role| !roles.contains(role))
    {
        return Err(anyhow!(
            "声明已修订，计划必须包含独立审稿和引用审计并重新审查"
        ));
    }
    Ok(())
}

impl Store {
    fn research_claim_changes(&self, id: &str) -> Result<Vec<ClaimChange>> {
        let mut stmt = self.conn.prepare("SELECT claim_id,action,reason,actor_session_id,plan_version,revision,replacement_id,claim_hash,replacement_hash,request_hash,changed_at FROM research_claim_changes WHERE study_id=?1 ORDER BY revision")?;
        let changes = stmt
            .query_map([id], |row| {
                Ok(ClaimChange {
                    claim_id: row.get(0)?,
                    action: row.get(1)?,
                    reason: row.get(2)?,
                    actor_session_id: row.get(3)?,
                    plan_version: row.get(4)?,
                    revision: row.get(5)?,
                    replacement_id: row.get(6)?,
                    claim_hash: row.get(7)?,
                    replacement_hash: row.get(8)?,
                    request_hash: row.get(9)?,
                    changed_at: row.get(10)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(changes)
    }

    pub(super) fn research_evidence<'a>(&self, study: &'a Study) -> Result<EvidenceScope<'a>> {
        let changes = self.research_claim_changes(&study.id)?;
        if study.claim_revision.unwrap_or(0) != changes.len() as u64 {
            return Err(anyhow!("声明修订状态已变化或不完整，请刷新后核查"));
        }
        let claim_hash = |id: &str| -> Result<String> {
            let mut matches = study.claims.iter().filter(|claim| claim.id == id);
            let claim = matches
                .next()
                .ok_or_else(|| anyhow!("修订引用的原声明缺失: {id}"))?;
            if matches.next().is_some() {
                return Err(anyhow!("声明 ID 重复: {id}"));
            }
            Ok(digest(&serde_json::to_vec(claim)?))
        };
        let mut retired = HashSet::new();
        for (index, change) in changes.iter().enumerate() {
            if change.revision != index as u64 + 1
                || claim_hash(&change.claim_id)? != change.claim_hash
            {
                return Err(anyhow!("声明修订历史不一致，请核查原始记录"));
            }
            if let Some(id) = &change.replacement_id {
                if change.replacement_hash.as_ref() != Some(&claim_hash(id)?) {
                    return Err(anyhow!("替代声明已变化，请核查原始记录"));
                }
            }
            retired.insert(change.claim_id.as_str());
        }
        let claims = study
            .claims
            .iter()
            .filter(|claim| !retired.contains(claim.id.as_str()))
            .collect();
        Ok(EvidenceScope { claims, changes })
    }

    pub fn research_study_view(&self, study: &Study) -> Result<serde_json::Value> {
        let evidence = self.research_evidence(study)?;
        let mut value = serde_json::to_value(study)?;
        if !evidence.changes.is_empty() || study.material_citation_revision.is_some() {
            let evidence_digest = evidence.digest()?;
            let needs_review = study.plans.last().is_none_or(|plan| {
                ["as-independent-reviewer", "as-quality-citation-auditor"]
                    .iter()
                    .any(|role| {
                        (!evidence.changes.is_empty()
                            && !plan.tasks.iter().any(|task| task.spec.role == *role))
                            || plan
                                .tasks
                                .iter()
                                .filter(|task| task.spec.role == *role)
                                .any(|task| {
                                    task.state != "completed"
                                        || task.evidence_digest.as_deref() != Some(&evidence_digest)
                                })
                    })
            });
            value["activeClaimIds"] = serde_json::json!(evidence
                .claims
                .iter()
                .map(|claim| &claim.id)
                .collect::<Vec<_>>());
            value["claimChanges"] = serde_json::to_value(&evidence.changes)?;
            value["evidenceReviewRequired"] = needs_review.into();
            value["staleReviewTaskIds"] = serde_json::json!(study
                .plans
                .last()
                .map(|plan| {
                    plan.tasks
                        .iter()
                        .filter(|task| {
                            matches!(
                                task.spec.role.as_str(),
                                "as-independent-reviewer" | "as-quality-citation-auditor"
                            ) && task.evidence_digest.as_deref() != Some(&evidence_digest)
                        })
                        .map(|task| &task.spec.id)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default());
        }
        Ok(value)
    }

    pub fn research_amend_claim(
        &self,
        id: &str,
        actor: &str,
        claim: &str,
        input: ClaimAmendmentInput,
    ) -> Result<ClaimChange> {
        self.research_amend_claim_with_reader(id, actor, claim, input, |r, s, e| {
            evidence::scan_log(r, s, e)
        })
    }

    pub(super) fn research_amend_claim_with_reader(
        &self,
        id: &str,
        actor: &str,
        claim: &str,
        input: ClaimAmendmentInput,
        read_log: impl FnOnce(&mut dyn std::io::Read, usize, usize) -> Result<(String, String)>,
    ) -> Result<ClaimChange> {
        let (version, revision, reason) = input.context();
        if reason.trim().is_empty() || reason.len() > 4096 {
            return Err(anyhow!("声明修订需要非空原因，最多 4 KiB"));
        }
        let reason = reason.to_string();
        let request_hash = digest(&serde_json::to_vec(
            &serde_json::json!({"study":id,"actor":actor,"claim":claim,"request":input}),
        )?);
        let validate = |study: &Study| -> Result<Option<ClaimChange>> {
            study.ensure_active()?;
            if study.session_id != actor {
                return Err(anyhow!("声明修订仅允许研究主理人执行"));
            }
            let evidence = self.research_evidence(study)?;
            if let Some(previous) = evidence
                .changes
                .iter()
                .find(|change| change.claim_id == claim)
            {
                if previous.request_hash == request_hash {
                    return Ok(Some(previous.clone()));
                }
                return Err(anyhow!("该声明已撤回或替代，不能再次修订"));
            }
            if study.plans.last().map_or(0, |plan| plan.version) != version
                || study.claim_revision.unwrap_or(0) != revision
            {
                return Err(anyhow!("计划或声明版本已变化，请刷新后重新修订"));
            }
            if study
                .claims
                .iter()
                .filter(|current| current.id == claim)
                .count()
                != 1
            {
                return Err(anyhow!("声明不存在或 ID 不唯一"));
            }
            Ok(None)
        };
        let study = self.research_study(id)?;
        if let Some(previous) = validate(&study)? {
            return Ok(previous);
        }
        // Hash/parse replacement evidence outside BEGIN IMMEDIATE; revalidate
        // the actor, revision, run and file identity in the final transaction.
        let prepared = match input {
            ClaimAmendmentInput::Withdraw { .. } => None,
            ClaimAmendmentInput::Replace { replacement, .. } => {
                Some(self.research_prepare_claim_with_reader(id, *replacement, read_log)?)
            }
        };
        self.research_update(id, |study| {
            if let Some(previous) = validate(study)? {
                return Ok(previous);
            }
            let original = study.claims.iter().find(|current| current.id == claim).ok_or_else(|| anyhow!("声明不存在"))?;
            let claim_hash = digest(&serde_json::to_vec(original)?);
            let replacement_id = prepared.map(|prepared| self.research_apply_prepared_claim(study, prepared)).transpose()?;
            let replacement_hash = replacement_id.as_ref().map(|id| -> Result<String> {
                let replacement = study.claims.iter().find(|claim| &claim.id == id).ok_or_else(|| anyhow!("替代声明不存在"))?;
                Ok(digest(&serde_json::to_vec(replacement)?))
            }).transpose()?;
            let next = revision.checked_add(1).ok_or_else(|| anyhow!("声明版本已达上限"))?;
            let change = ClaimChange {
                claim_id: claim.into(),
                action: if replacement_id.is_some() { "replaced" } else { "withdrawn" }.into(),
                reason,
                actor_session_id: actor.into(),
                plan_version: version,
                revision: next,
                replacement_id,
                claim_hash,
                replacement_hash,
                request_hash: request_hash.clone(),
                changed_at: now_ms(),
            };
            self.conn.execute("INSERT INTO research_claim_changes(study_id,claim_id,action,reason,actor_session_id,plan_version,revision,replacement_id,claim_hash,replacement_hash,request_hash,changed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![id,change.claim_id,change.action,change.reason,change.actor_session_id,version,next,change.replacement_id,change.claim_hash,change.replacement_hash,change.request_hash,change.changed_at])?;
            study.claim_revision = Some(next);
            if !study.plans.is_empty() {
                study.supersede_gate(crate::local::research::delivery_gate(study.workflow_mode()))?;
            }
            study.delivery_error = None;
            Ok(change)
        })
    }
}
