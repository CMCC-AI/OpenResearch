//! Shared plumbing for the one-sentence draft generators (custom agents, whole
//! workflows): how the model child is picked, and the small helpers every
//! generator needs. Kept apart from the generators so each can be read, and
//! changed, on its own.

use super::harness::{chat_harness, detect_harness, Harness};
use crate::error::Result;
use crate::store::Store;

/// One reasoning round trip over a long output. Both generators write more
/// than a title or a handful of prompts, and reasoning models take their time:
/// on GLM-5.3 a short flow already costs ~110s, and a broad intent (survey plus
/// reproduction) routinely spent the full 300s without emitting JSON. The
/// canvas now streams the reasoning tail, so a longer ceiling is watchable
/// instead of silent; 180s cut real drafts off and 300s did too.
pub const GENERATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(420);
/// The user's one-sentence intent, as accepted from the API.
pub const INTENT_CHARS: usize = 2000;

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

/// 引擎选定之后按真实节点上报阶段：引擎就绪 → 开始撰写 → 模型已返回、开始校验。
/// 单独拆出是为了不靠真引擎也能锁住事件顺序：实测漏发过 writing，整段等待里
/// 前端一直把「启动生成引擎」显示为进行中，带计时的撰写行从未亮起。
pub(crate) async fn staged<F>(
    on_stage: &impl Fn(DraftStage),
    call: impl FnOnce() -> F,
) -> Result<String>
where
    F: std::future::Future<Output = Result<String>>,
{
    on_stage(DraftStage::Engine);
    on_stage(DraftStage::Writing);
    let raw = call().await?;
    on_stage(DraftStage::Reviewing);
    Ok(raw)
}

/// One pickable inventory entry; `key` is the reference the model must echo
/// back (an expert id, an MCP service id, a skill name).
#[derive(Debug, Clone)]
pub struct Pick {
    pub key: String,
    pub name: String,
    pub description: String,
}

/// The chat harness and model a draft is written on: the one the user last
/// picked in the composer, else the first harness that is ready. A configured
/// draft model (`provider/model`, OpenCode only) wins over the chat's model so
/// structure writing can run on something faster. OpenCode's one-shot needs an
/// explicit model and the fallback path picks none, so take the first of its
/// catalog there.
pub(crate) async fn generation_agent() -> Option<(Box<dyn Harness>, Option<String>)> {
    let agent = super::starter::resolve_agent(None).await?;
    let configured = tokio::task::spawn_blocking(|| {
        Store::open()
            .and_then(|store| store.ui_state())
            .ok()
            .and_then(|state| state.draft_model)
    })
    .await
    .ok()
    .flatten();
    let model = draft_model_override(&agent.harness, configured.as_deref()).or(
        match agent.effective_model() {
            Some(model) => Some(model.to_string()),
            None if agent.harness == "opencode" => detect_harness("opencode")
                .await
                .and_then(|info| info.models.first().map(|m| m.id.clone())),
            None => None,
        },
    );
    Some((chat_harness(&agent.harness)?, model))
}

/// The draft-model preference, honoured only where a `provider/model` string
/// means something (OpenCode). Other harnesses keep their own model resolution.
fn draft_model_override(harness: &str, configured: Option<&str>) -> Option<String> {
    (harness == "opencode")
        .then(|| {
            configured
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .map(str::to_owned)
        })
        .flatten()
}

/// Truncate to at most `chars` characters, trimming trailing whitespace.
pub(crate) fn clip(text: &str, chars: usize) -> String {
    text.chars()
        .take(chars)
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// 思考流给界面看的那一小段：压成一行，只保留最新 `chars` 个字符。
/// 生成期模型可能先想几分钟，界面只需要“它还在动”，不搬运整段思维链。
pub(crate) fn reasoning_tail(text: &str, chars: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = flat.chars().count();
    if count <= chars {
        return flat;
    }
    flat.chars().skip(count - chars).collect()
}

/// The built-in roles as picks: id plus the first two lines of the role
/// prompt (its title and one-line summary). The prompt body itself is tuned
/// by the core team and never leaves the process.
pub(crate) fn built_in_picks() -> Vec<Pick> {
    crate::local::research::ROLES
        .iter()
        .map(|(id, prompt)| {
            let (name, description) = crate::local::research::role_brief(id, prompt);
            Pick {
                key: (*id).to_string(),
                name: name.to_string(),
                description: description.to_string(),
            }
        })
        .collect()
}

/// The custom agents the user has saved, as picks.
pub(crate) fn custom_agent_picks(store: &Store) -> Result<Vec<Pick>> {
    Ok(store
        .list_workflow_agents()?
        .into_iter()
        .map(|agent| Pick {
            key: agent.id,
            name: agent.name,
            description: agent.description,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_model_preference_only_applies_to_opencode() {
        assert_eq!(
            draft_model_override("opencode", Some(" zhipu-coding/glm-5.3 ")).as_deref(),
            Some("zhipu-coding/glm-5.3")
        );
        // 空值和空白都等于「沿用聊天模型」。
        assert_eq!(draft_model_override("opencode", Some("  ")), None);
        assert_eq!(draft_model_override("opencode", None), None);
        // provider/model 是 OpenCode 的写法；别的引擎不认，交回它自己的模型选择。
        assert_eq!(
            draft_model_override("codex", Some("zhipu-coding/glm-5.3")),
            None
        );
    }

    #[test]
    fn clip_cuts_on_a_character_boundary_and_trims_the_tail() {
        assert_eq!(clip("abc", 5), "abc");
        assert_eq!(clip("abcdef", 3), "abc");
        assert_eq!(clip("ab \n", 10), "ab");
        // 按字符而不是字节截断：三个汉字不会被切成半个。
        assert_eq!(clip("文献计量", 3), "文献计");
    }

    #[test]
    fn reasoning_tail_keeps_the_newest_text_on_one_line() {
        assert_eq!(reasoning_tail(" 先想\n  再排\t流程 ", 40), "先想 再排 流程");
        assert_eq!(reasoning_tail("先把论文分成三类再排", 5), "成三类再排");
        // 空思考不产生可见行。
        assert_eq!(reasoning_tail(" \n\t ", 10), "");
    }

    #[test]
    fn built_in_picks_carry_ids_and_names_but_no_prompt_body() {
        let picks = built_in_picks();
        assert_eq!(picks.len(), crate::local::research::ROLES.len());
        assert_eq!(picks[0].key, crate::local::research::ROLES[0].0);
        assert!(picks.iter().all(|pick| !pick.name.is_empty()));
        // 提示词正文比「首行 + 次行」长得多；一旦泄漏，说明取错了范围。
        for (pick, (_, prompt)) in picks.iter().zip(crate::local::research::ROLES) {
            assert!(
                !pick.description.contains('\n') && prompt.lines().count() > 2,
                "{} 的说明不应携带多行提示词正文",
                pick.key
            );
        }
    }
}
