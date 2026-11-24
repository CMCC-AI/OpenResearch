//! One-shot drafts for custom agents: the researcher describes the job in one
//! sentence, a headless harness child writes the name, description, role
//! prompt, and MCP/skill picks as a single JSON object. Picks are filtered
//! against the local inventories so a hallucinated reference never reaches the
//! create API. No cache: every draft starts from what the user just typed.

use serde::Deserialize;

use super::draft_support::{
    built_in_picks, clip, custom_agent_picks, generation_agent, Pick, GENERATION_TIMEOUT,
};
use super::harness::{OneShot, OneShotQuality};
use crate::error::{anyhow, Result};
use crate::store::Store;
use crate::workflow::AgentInput;

/// Same ceilings the create API enforces (`validate_agent`).
const NAME_CHARS: usize = 120;
const DESCRIPTION_CHARS: usize = 2048;
const PROMPT_CHARS: usize = 24000;
/// Inventory entries shown to the model, descriptions clipped to keep the
/// prompt bounded.
const MAX_LISTED: usize = 50;
const PICK_DESC_CHARS: usize = 160;

const SYSTEM_PROMPT: &str = "You design custom research agents for MobileSci, an AI for Science \
research workspace. You reply with a single JSON object and nothing else.";

/// Everything the model may choose from. Only names and descriptions — a
/// built-in role's prompt never enters this struct, so it cannot leak into a
/// draft request.
#[derive(Debug, Clone, Default)]
pub struct Inventories {
    pub built_in: Vec<Pick>,
    /// Existing custom agents (name, description), for context only: the draft
    /// should complement, not duplicate, them.
    pub custom: Vec<(String, String)>,
    pub mcp_servers: Vec<Pick>,
    pub skills: Vec<Pick>,
}

/// 生成推进到的阶段。借 `/api/events` 的 SSE 广播发给前端，等待期不再只有
/// 转圈；四个阶段都是后端真实动作，不是演示用的假进度。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftStage {
    /// 本机清单就绪（内置角色、自定义专家、MCP 服务、上传技能）。
    Inventory,
    /// 生成引擎已选定，子进程即将启动。
    Engine,
    /// 模型撰写开始：整段等待的主体，前端就地显示已等待秒数。
    Writing,
    /// 模型输出已返回，正在校验引用并整理草稿。
    Reviewing,
}

impl DraftStage {
    /// 事件载荷里的阶段名，前端按它推进过程清单。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inventory => "inventory",
            Self::Engine => "engine",
            Self::Writing => "writing",
            Self::Reviewing => "reviewing",
        }
    }
}

/// 本机库存：内置角色（只带名称/说明）、现有自定义专家、已启用的 MCP 服务、
/// 上传技能。store 访问由调用侧包在 spawn_blocking 里。
pub fn inventories(store: &Store) -> Result<Inventories> {
    let built_in = built_in_picks();
    let custom = custom_agent_picks(store)?
        .into_iter()
        .map(|agent| (agent.name, agent.description))
        .collect();
    let mcp_servers = super::mcp_registry::list_servers()
        .into_iter()
        .filter(|server| server.enabled)
        .map(|server| Pick {
            key: server.id,
            name: server.name,
            description: server.description,
        })
        .collect();
    let skills = super::user_skills::list_uploaded()
        .into_iter()
        .map(|skill| Pick {
            key: skill.name.clone(),
            name: skill.name,
            description: skill.description,
        })
        .collect();
    Ok(Inventories {
        built_in,
        custom,
        mcp_servers,
        skills,
    })
}

/// 生成一份可直接进创建接口的专家草稿。引擎不可用、模型超时或答非所问时
/// 返回带可读文案的错误。`on_stage` 在推进到真实节点时回调（选定引擎、
/// 开始撰写、开始校验），调用侧借此把进度广播给前端。
pub async fn generate(
    intent: &str,
    locale: &str,
    inv: &Inventories,
    on_stage: impl Fn(DraftStage) + Send + Sync,
) -> Result<AgentInput> {
    let (harness, model) = generation_agent()
        .await
        .ok_or_else(|| anyhow!("没有可用的对话引擎；请先在对话设置里登录一个引擎"))?;
    let raw = staged(&on_stage, || async {
        harness
            .one_shot(OneShot {
                system: SYSTEM_PROMPT,
                prompt: &generation_prompt(intent, locale, inv),
                quality: OneShotQuality::Standard,
                model: model.as_deref(),
                timeout: GENERATION_TIMEOUT,
            })
            .await
            .map_err(|e| anyhow!("引擎调用失败：{e}"))
    })
    .await?;
    parse_draft(&raw, &inv.mcp_servers, &inv.skills)
        .ok_or_else(|| anyhow!("模型没有返回有效的专家草稿；请重试或换个说法"))
}

/// 引擎选定之后按真实节点上报阶段：引擎就绪 → 开始撰写 → 模型已返回、开始校验。
/// 单独拆出是为了不靠真引擎也能锁住事件顺序：实测漏发过 writing，整段等待里
/// 前端一直把「启动生成引擎」显示为进行中，带计时的撰写行从未亮起。
async fn staged<F>(on_stage: &impl Fn(DraftStage), call: impl FnOnce() -> F) -> Result<String>
where
    F: std::future::Future<Output = Result<String>>,
{
    on_stage(DraftStage::Engine);
    on_stage(DraftStage::Writing);
    let raw = call().await?;
    on_stage(DraftStage::Reviewing);
    Ok(raw)
}

fn generation_prompt(intent: &str, locale: &str, inv: &Inventories) -> String {
    let mut out = format!(
        "Design ONE custom research agent for this request:\n{intent}\n\n\
         LANGUAGE — read this first: every piece of text a person will read (\"name\", \
         \"description\", and the whole \"prompt\") MUST be written in the language with \
         IETF tag \"{locale}\" — the same language as the request above. Do not answer in \
         English just because these instructions are in English; keep only technical \
         terms (tool names, field names, CLI commands) as they are.\n\n\
         Rules:\n\
         - \"name\": at most 30 characters, specific to this job, not a rename of \
         an existing role below.\n\
         - \"description\": one or two sentences on what this agent is for and when \
         to use it.\n\
         - \"prompt\": the full role specification the agent will obey, in the language \
         with IETF tag \"{locale}\". Cover the agent's scope and \
         boundaries, its working method, how to use evidence and any mounted tools \
         or skills, the required output form, and what it must not do. End it with \
         these hard rules, verbatim:\n\
         实验必须通过受管的 orx exp run，不得用 Bash 直接启动训练或评测；\
         不得自行派生其他专家；不得自行批准 G1–G4。\n\
         - \"mcpServers\": ids picked only from the MCP list below, only what the \
         job actually needs; use [] when none fit.\n\
         - \"userSkills\": names picked only from the skill list below; use [] when \
         none fit.\n\
         - Reply with a single JSON object with keys \"name\", \"description\", \
         \"prompt\", \"mcpServers\", \"userSkills\", and nothing else.\n"
    );
    section(
        &mut out,
        "Built-in roles (do not duplicate; a custom agent complements them)",
        &inv.built_in,
    );
    if !inv.custom.is_empty() {
        out.push_str("## Existing custom agents\n");
        for (name, description) in inv.custom.iter().take(MAX_LISTED) {
            out.push_str(&format!(
                "- {} — {}\n",
                name,
                clip(description, PICK_DESC_CHARS)
            ));
        }
        out.push('\n');
    }
    section(
        &mut out,
        "MCP services the agent may mount (pick ids only from this list)",
        &inv.mcp_servers,
    );
    section(
        &mut out,
        "Skills the agent may mount (pick names only from this list)",
        &inv.skills,
    );
    out
}

fn section(out: &mut String, title: &str, picks: &[Pick]) {
    if picks.is_empty() {
        return;
    }
    out.push_str("## ");
    out.push_str(title);
    out.push('\n');
    for pick in picks.iter().take(MAX_LISTED) {
        out.push_str(&format!(
            "- {} | {} — {}\n",
            pick.key,
            pick.name,
            clip(&pick.description, PICK_DESC_CHARS)
        ));
    }
    out.push('\n');
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawDraft {
    name: String,
    description: String,
    prompt: String,
    mcp_servers: Vec<String>,
    user_skills: Vec<String>,
}

/// 模型输出 → 草稿。容忍代码围栏与前后杂文；截断到创建接口的上限；
/// 编造的引用就地丢弃。名称或提示词为空则整体失败。
fn parse_draft(raw: &str, mcp: &[Pick], skills: &[Pick]) -> Option<AgentInput> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    let draft: RawDraft = serde_json::from_str(&raw[start..=end]).ok()?;
    let name = clip(draft.name.trim(), NAME_CHARS);
    let prompt = clip(draft.prompt.trim(), PROMPT_CHARS);
    if name.is_empty() || prompt.is_empty() {
        return None;
    }
    Some(AgentInput {
        name,
        description: clip(draft.description.trim(), DESCRIPTION_CHARS),
        prompt,
        mcp_servers: keep_known(draft.mcp_servers, mcp),
        user_skills: keep_known(draft.user_skills, skills),
    })
}

/// 只保留库存里存在的引用并去重；模型编造的引用在这里丢弃，
/// 不让创建接口替我们把关。
fn keep_known(refs: Vec<String>, known: &[Pick]) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for reference in refs {
        let reference = reference.trim().to_string();
        if reference.is_empty() || kept.contains(&reference) {
            continue;
        }
        if known.iter().any(|pick| pick.key == reference) {
            kept.push(reference);
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(key: &str) -> Pick {
        Pick {
            key: key.to_string(),
            name: key.to_string(),
            description: String::new(),
        }
    }

    #[test]
    fn parse_tolerates_fences_and_prose() {
        let raw = "Sure:\n```json\n{\"name\": \" 文献计量员 \", \"description\": \" 跑计量分析。 \", \
                   \"prompt\": \" 你是文献计量专家…… \", \"mcpServers\": [], \"userSkills\": []}\n```\nDone.";
        let draft = parse_draft(raw, &[], &[]).unwrap();
        assert_eq!(draft.name, "文献计量员");
        assert_eq!(draft.description, "跑计量分析。");
        assert_eq!(draft.prompt, "你是文献计量专家……");
    }

    #[test]
    fn unknown_refs_are_dropped_and_known_kept_deduped() {
        let mcp = [pick("mcp-a"), pick("mcp-b")];
        let skills = [pick("skill-1")];
        let raw = r#"{"name":"n","prompt":"p","mcpServers":["mcp-b","mcp-zzz","mcp-b","mcp-a",""],"userSkills":["skill-1","skill-ghost"]}"#;
        let draft = parse_draft(raw, &mcp, &skills).unwrap();
        assert_eq!(draft.mcp_servers, vec!["mcp-b", "mcp-a"]);
        assert_eq!(draft.user_skills, vec!["skill-1"]);
    }

    #[test]
    fn overlong_fields_are_clipped_to_create_limits() {
        let raw = format!(
            r#"{{"name":"{}","description":"{}","prompt":"{}"}}"#,
            "名".repeat(NAME_CHARS + 10),
            "述".repeat(DESCRIPTION_CHARS + 10),
            "词".repeat(PROMPT_CHARS + 10),
        );
        let draft = parse_draft(&raw, &[], &[]).unwrap();
        assert_eq!(draft.name.chars().count(), NAME_CHARS);
        assert_eq!(draft.description.chars().count(), DESCRIPTION_CHARS);
        assert_eq!(draft.prompt.chars().count(), PROMPT_CHARS);
    }

    #[test]
    fn empty_name_or_prompt_fails() {
        assert!(parse_draft(r#"{"name":"  ","prompt":"p"}"#, &[], &[]).is_none());
        assert!(parse_draft(r#"{"name":"n","prompt":""}"#, &[], &[]).is_none());
        assert!(parse_draft("no json here", &[], &[]).is_none());
        // 两个独立的 JSON 对象拼不成一个：整体判失败，而不是取前半个。
        assert!(parse_draft(r#"{"name":"n"} tail {"a":1}"#, &[], &[]).is_none());
    }

    #[tokio::test]
    async fn staged_reports_engine_writing_then_reviewing_in_order() {
        // 回调约定是 Fn（handler 把同一个闭包反复用于 SSE 广播），所以用 RefCell 收集。
        let seen = std::cell::RefCell::new(Vec::new());
        let raw = staged(&|stage| seen.borrow_mut().push(stage.as_str()), || async {
            Ok("{}".to_string())
        })
        .await
        .unwrap();
        assert_eq!(raw, "{}");
        // 每个阶段恰好一次、顺序固定：整段等待落在 writing 上，前端据此显示计时。
        assert_eq!(*seen.borrow(), ["engine", "writing", "reviewing"]);
        // 模型调用失败时停在撰写阶段，不谎报「开始校验」。
        let failed = std::cell::RefCell::new(Vec::new());
        let error = staged(
            &|stage| failed.borrow_mut().push(stage.as_str()),
            || async { Err(anyhow!("boom")) },
        )
        .await
        .expect_err("a failed model call must not yield a draft");
        assert_eq!(error.to_string(), "boom");
        assert_eq!(*failed.borrow(), ["engine", "writing"]);
    }

    #[test]
    fn prompt_lists_inventories_and_locale_without_role_prompts() {
        let inv = Inventories {
            built_in: vec![Pick {
                key: "as-demo".to_string(),
                name: "演示专家".to_string(),
                description: "只用于测试".to_string(),
            }],
            custom: vec![("旧专家".to_string(), "已有".to_string())],
            mcp_servers: vec![pick("mcp-1")],
            skills: vec![pick("skill-1")],
        };
        let prompt = generation_prompt("帮我建文献计量专家", "zh-CN", &inv);
        assert!(prompt.contains("帮我建文献计量专家"));
        assert!(prompt.contains("zh-CN"));
        assert!(prompt.contains("as-demo | 演示专家"));
        assert!(prompt.contains("mcp-1"));
        assert!(prompt.contains("skill-1"));
        assert!(prompt.contains("旧专家"));
        // 内置角色的提示词永远不会进入素材，也就不可能出现在提示词里。
        assert!(!prompt.contains("ROLE PROMPT BODY"));
        // 统一硬规则逐字进入生成提示词。
        assert!(prompt.contains("不得自行批准 G1–G4"));
    }
}
