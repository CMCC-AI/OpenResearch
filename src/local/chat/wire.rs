use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireToolState {
    pub status: String, // running | completed | error
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// One option in an AskUserQuestion prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireQuestionOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextAnnotation {
    pub text: String,
}

/// An interactive request the user must act on before the harness continues.
/// The three kinds (`plan` / `permission` / `question`) originated with Claude
/// Code's ExitPlanMode / permission_denials / AskUserQuestion, but `permission`
/// and `question` are now shared: OpenCode emits them from its serve
/// `permission.asked` / `question.asked` events (see `harness/opencode.rs`),
/// and Codex emits `question` from `item/tool/requestUserInput`. `plan` is
/// Claude + Codex, each via its own mechanism (ExitPlanMode vs the end-turn
/// card synthesized from a collaboration-mode `plan` item — see
/// `harness/codex.rs`).
///
/// How the answer flows back is per-harness (see [`crate::local::harness::ResumeAction`]):
/// Claude ends its turn and resumes with a new message; OpenCode is paused
/// mid-turn and the answer is replied inline over the live serve session — which
/// is what `native_id` is for. The UI renders a card either way.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WirePrompt {
    /// `plan` | `permission` | `question`.
    pub kind: String,
    /// Whether this prompt has been answered (resolved permission cards
    /// vanish; resolved plan/question cards collapse to a one-line row).
    #[serde(default)]
    pub resolved: bool,
    /// plan: the proposed plan markdown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// plan: true when the harness synthesized this card from the turn's final
    /// text because the model never called ExitPlanMode. The approval flow is
    /// identical; the UI just softens the framing ("ready to proceed?" instead
    /// of "proposed plan").
    #[serde(default)]
    pub synthesized: bool,
    /// permission: the tool the harness was blocked from using, + its input.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<Value>,
    /// question: the prompt text + selectable options.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub options: Vec<WireQuestionOption>,
    #[serde(default)]
    pub multi_select: bool,
    /// Native skip semantics: one question (V1) or the entire form (V2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_scope: Option<String>,
    /// OpenCode question emitted by its native `plan_exit` tool. The adapter
    /// uses the tool call id to distinguish this from ordinary Yes/No prompts.
    #[serde(default)]
    pub plan_exit: bool,
    /// The harness-native id used to reply over a live protocol (opencode's
    /// permission/question request id, the Claude bridge's held request id).
    /// The backend resume path routes on it; the UI reads only its *presence*
    /// (a held mid-turn card — the turn is blocked on this answer) and echoes
    /// the `WirePart` id when answering. `None` for end-turn cards, which
    /// resume by message, not by reply id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    /// Answer echo, stamped when the user resolves the card so the collapsed
    /// rendering can show the outcome (and it survives a reload):
    /// questions record the chosen labels, plan/permission whether it was
    /// approved, and any freeform note rides along. Absent on cards resolved
    /// without an answer (stale-card cleanup, cancelled bridge requests).
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub answers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub annotations: Vec<TextAnnotation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessagePhase {
    Commentary,
    FinalAnswer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WirePart {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String, // text | reasoning | tool | prompt | steer
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<MessagePhase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<WireToolState>,
    /// Present only on `prompt` parts — the interactive request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<WirePrompt>,
    /// Nested parts belonging to a sub-agent this part spawned (Codex
    /// collaboration). A spawn part streams the sub-agent's own transcript here;
    /// arbitrary depth for sub-agents that spawn their own. `default` +
    /// `skip_serializing_if` keeps old `parts_json` rows and childless parts
    /// byte-identical on the wire — no migration.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<WirePart>,
}

impl WirePart {
    pub fn text(id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            kind: "text".into(),
            text: Some(text.into()),
            tool: None,
            state: None,
            prompt: None,
            phase: None,
            children: Vec::new(),
        }
    }

    pub fn reasoning(id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            kind: "reasoning".into(),
            ..Self::text(id, text)
        }
    }

    /// `text` holds the attachment file name (served via /api/chat/attachments).
    pub fn image(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            kind: "image".into(),
            ..Self::text(id, name)
        }
    }

    pub fn annotation(id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            kind: "annotation".into(),
            ..Self::text(id, text)
        }
    }

    /// A message the user sent into this turn while it was running. It rides
    /// the assistant message so it renders where the agent actually received
    /// it — a separate user row would sort after the whole turn.
    pub fn steer(id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            kind: "steer".into(),
            ..Self::text(id, text)
        }
    }

    /// A synthetic tool part — a status row (`error`, `interrupted`, …) that
    /// isn't a real tool call. The UI renders errors like harness tools and
    /// keeps interruption markers for history consumers only.
    pub fn tool(
        id: impl Into<String>,
        tool: impl Into<String>,
        status: impl Into<String>,
        error: Option<String>,
    ) -> Self {
        Self {
            id: id.into(),
            kind: "tool".into(),
            text: None,
            tool: Some(tool.into()),
            state: Some(WireToolState {
                status: status.into(),
                input: None,
                output: None,
                error,
                title: None,
            }),
            prompt: None,
            phase: None,
            children: Vec::new(),
        }
    }

    /// An interactive prompt part (plan / permission / question).
    pub fn prompt(id: impl Into<String>, prompt: WirePrompt) -> Self {
        Self {
            id: id.into(),
            kind: "prompt".into(),
            text: None,
            tool: None,
            state: None,
            prompt: Some(prompt),
            phase: None,
            children: Vec::new(),
        }
    }
}
