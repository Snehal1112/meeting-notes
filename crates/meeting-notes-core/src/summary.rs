use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Topic {
    pub title: String,
    pub points: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ActionItem {
    pub text: String,
    /// The person responsible, when the transcript names one. The transcript
    /// has no speaker labels, so this is often absent and must never be
    /// guessed.
    #[serde(default)]
    pub owner: Option<String>,
}

/// The notes for one meeting. Every field defaults, because each generation
/// pass returns only the fields it is responsible for and the fragments are
/// merged afterwards.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SummaryResult {
    #[serde(default)]
    pub meeting_type: String,
    #[serde(default)]
    pub attendees: Vec<String>,
    #[serde(default)]
    pub referenced_people: Vec<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub topics: Vec<Topic>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub action_items: Vec<ActionItem>,
    #[serde(default)]
    pub open_questions: Vec<String>,
}

/// A backend that can answer a JSON-only prompt.
///
/// This is transport only, on purpose. Prompt construction lives once in the
/// summary crate so the three generation passes are not duplicated per
/// provider.
#[async_trait]
pub trait SummaryProvider {
    /// Sends `prompt` and returns the raw JSON text of the response.
    async fn complete_json(&self, prompt: &str) -> Result<String, String>;

    /// Roughly how many transcript words this provider can accept at once.
    /// Longer transcripts are chunked to fit.
    fn input_budget_words(&self) -> usize;
}
