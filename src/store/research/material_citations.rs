//! Canonical material references are additive; legacy claims keep identical bytes.
use super::files::FileSource;
use super::*;
use crate::store::material_reads::MaterialCitation;

pub(super) fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch("CREATE TRIGGER IF NOT EXISTS research_material_citation_guard BEFORE UPDATE ON research_studies
        WHEN json_extract(OLD.document,'$.materialCitationRevision') IS NOT NULL AND (
            json_type(NEW.document,'$.materialCitationRevision') IS NOT 'integer'
            OR json_extract(NEW.document,'$.materialCitationRevision') < json_extract(OLD.document,'$.materialCitationRevision')
            OR json_extract(NEW.document,'$.materialCitationRevision') IS NOT
                (SELECT count(*) FROM json_each(NEW.document,'$.claims') WHERE json_type(value,'$.materialCitation')='object'))
        BEGIN SELECT RAISE(ABORT,'材料引用已登记，请使用支持材料引用的版本'); END;")?;
    Ok(())
}

impl Store {
    pub(super) fn research_validate_material_claim(
        &self,
        study: &Study,
        claim: &EvidenceClaim,
    ) -> Result<()> {
        match (&claim.input.material_read_id, &claim.material_citation) {
            (None, None) => Ok(()),
            (Some(event), Some(citation)) => {
                if &self.material_citation(&study.project_id, event)? != citation {
                    return Err(anyhow!("材料引用与原始读取回执不一致"));
                }
                if !study
                    .plan()?
                    .material_ids
                    .as_ref()
                    .is_some_and(|ids| ids.contains(&citation.package_id))
                {
                    return Err(anyhow!(
                        "材料引用必须属于当前计划固定的材料集合，请先修订计划"
                    ));
                }
                Ok(())
            }
            _ => Err(anyhow!("材料引用缺少输入标识或规范来源")),
        }
    }

    pub(super) fn research_prepare_material_claim(
        &self,
        study: &Study,
        claim: &mut EvidenceClaim,
        root: &Path,
    ) -> Result<Option<FileSource>> {
        let Some(event) = &claim.input.material_read_id else {
            return Ok(None);
        };
        let citation: MaterialCitation = self.material_citation(&study.project_id, event)?;
        claim.material_citation = Some(citation.clone());
        self.research_validate_material_claim(study, claim)?;
        let package: crate::local::materials::Package = serde_json::from_slice(&std::fs::read(
            root.join(&citation.package_id).join("manifest.json"),
        )?)?;
        if !package.ready
            || package.id != citation.package_id
            || package.project_id != study.project_id
        {
            return Err(anyhow!("材料引用包尚未封存或归属已变化"));
        }
        let entry = package
            .files
            .iter()
            .find(|entry| entry.id == citation.source)
            .ok_or_else(|| anyhow!("引用来源不存在"))?;
        if entry.sha256 != citation.sha256
            || entry.path != citation.path
            || entry.format != citation.format
            || entry.size > crate::local::materials::MAX_FILE as u64
        {
            return Err(anyhow!("材料登记信息与读取回执不一致"));
        }
        let base = crate::paths::canonicalize(root.join(&citation.package_id).join("originals"))?;
        let path = crate::paths::canonicalize(base.join(&citation.path))?;
        if !path.starts_with(&base) {
            return Err(anyhow!("材料引用路径超出原件范围"));
        }
        let mut file = FileSource::open(&path, "材料原件")?;
        if file.bytes() != entry.size || file.hash()? != citation.sha256 {
            return Err(anyhow!("材料原件已变化，请重新导入"));
        }
        Ok(Some(file))
    }
}
