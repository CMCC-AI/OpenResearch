//! Shared plumbing for the one-sentence draft generators (custom agents, whole
//! workflows): how the model child is picked, and the small helpers every
//! generator needs. Kept apart from the generators so each can be read, and
//! changed, on its own.

use super::harness::{chat_harness, detect_harness, Harness};
use crate::error::Result;
use crate::store::Store;

/// A cold CLI start plus one reasoning round trip over a long output. Both
/// generators write more than a title or a handful of prompts, so they take
/// the compaction summary's budget rather than starter prompts' 90s.
pub const GENERATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
/// The user's one-sentence intent, as accepted from the API.
pub const INTENT_CHARS: usize = 2000;

/// One pickable inventory entry; `key` is the reference the model must echo
/// back (an expert id, an MCP service id, a skill name).
#[derive(Debug, Clone)]
pub struct Pick {
    pub key: String,
    pub name: String,
    pub description: String,
}

/// The chat harness and model a draft is written on: the one the user last
/// picked in the composer, else the first harness that is ready. OpenCode's
/// one-shot needs an explicit model and the fallback path picks none, so take
/// the first of its catalog there.
pub(crate) async fn generation_agent() -> Option<(Box<dyn Harness>, Option<String>)> {
    let agent = super::starter::resolve_agent(None).await?;
    let model = match agent.effective_model() {
        Some(model) => Some(model.to_string()),
        None if agent.harness == "opencode" => detect_harness("opencode")
            .await
            .and_then(|info| info.models.first().map(|m| m.id.clone())),
        None => None,
    };
    Some((chat_harness(&agent.harness)?, model))
}

/// Truncate to at most `chars` characters, trimming trailing whitespace.
pub(crate) fn clip(text: &str, chars: usize) -> String {
    text.chars()
        .take(chars)
        .collect::<String>()
        .trim_end()
        .to_string()
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
    fn clip_cuts_on_a_character_boundary_and_trims_the_tail() {
        assert_eq!(clip("abc", 5), "abc");
        assert_eq!(clip("abcdef", 3), "abc");
        assert_eq!(clip("ab \n", 10), "ab");
        // 按字符而不是字节截断：三个汉字不会被切成半个。
        assert_eq!(clip("文献计量", 3), "文献计");
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
