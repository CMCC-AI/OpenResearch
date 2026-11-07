//! Fixed point citations supplement, rather than replace, existing Run log evidence.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetricSelection {
    pub evidence_id: String,
    pub name: String,
    pub split: String,
    pub step: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetricCitation {
    pub selection: MetricSelection,
    pub snapshot_sha256: String,
    pub report_sha256: String,
    pub run_id: String,
    pub experiment_id: String,
    pub commit_sha: String,
    pub source_sha256: String,
    pub unit: String,
    pub value: f64,
    pub measured_at: i64,
    pub registered_at: i64,
    pub producer_version: String,
}

pub(super) fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch("CREATE TRIGGER IF NOT EXISTS research_metric_citation_guard BEFORE UPDATE ON research_studies
    WHEN json_extract(OLD.document,'$.metricCitationRevision') IS NOT NULL AND (
        json_type(NEW.document,'$.metricCitationRevision') IS NOT 'integer'
        OR json_extract(NEW.document,'$.metricCitationRevision') < json_extract(OLD.document,'$.metricCitationRevision')
        OR json_extract(NEW.document,'$.metricCitationRevision') IS NOT
            (SELECT count(*) FROM json_each(NEW.document,'$.claims') WHERE json_type(value,'$.metricCitation')='object'))
    BEGIN SELECT RAISE(ABORT,'指标引用已登记，请使用支持指标引用的版本'); END;")?;
    Ok(())
}

impl Store {
    pub(super) fn research_prepare_metric_claim(
        &self,
        study: &Study,
        claim: &mut EvidenceClaim,
    ) -> Result<()> {
        let Some(selection) = &claim.input.metric else {
            return Ok(());
        };
        if claim.input.support != "experiment" {
            return Err(anyhow!("指标引用必须补充实验声明及其 Run 日志证据"));
        }
        let run = self
            .get_run(
                claim
                    .input
                    .run_id
                    .as_deref()
                    .ok_or_else(|| anyhow!("指标引用需要 runId"))?,
            )?
            .ok_or_else(|| anyhow!("指标引用的 Run 不存在"))?;
        let saved = self.metric_evidence(&study.project_id, &selection.evidence_id)?;
        claim.metric_citation = Some(crate::scientific_metrics::citation(
            &saved, selection, &run,
        )?);
        self.research_validate_metric_claim(study, claim)
    }

    /// The immutable record was fully hashed/parsed during preparation outside
    /// the writer transaction. Only fixed identity columns are read on commit.
    pub(super) fn research_validate_metric_claim(
        &self,
        study: &Study,
        claim: &EvidenceClaim,
    ) -> Result<()> {
        match (&claim.input.metric, &claim.metric_citation) {
            (None, None) => Ok(()),
            (Some(selection), Some(citation)) => {
                if selection != &citation.selection
                    || claim.input.support != "experiment"
                    || claim.input.run_id.as_ref() != Some(&citation.run_id)
                    || claim.commit_sha.as_ref() != Some(&citation.commit_sha)
                    || claim.log_sha256.is_none()
                    || claim.excerpt.is_none()
                {
                    return Err(anyhow!("指标引用与实验声明不一致"));
                }
                let identity: Option<(String,String,i64,String)> = self.conn.query_row(
                    "SELECT run_id,snapshot_sha256,registered_at,producer_version FROM scientific_metric_evidence WHERE project_id=?1 AND id=?2",
                    params![study.project_id,selection.evidence_id], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
                if identity
                    != Some((
                        citation.run_id.clone(),
                        citation.snapshot_sha256.clone(),
                        citation.registered_at,
                        citation.producer_version.clone(),
                    ))
                {
                    return Err(anyhow!("指标引用与持久登记身份不一致"));
                }
                Ok(())
            }
            _ => Err(anyhow!("指标引用缺少选择或规范来源")),
        }
    }
}
