use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryResult {
    pub summary: String,
    pub action_items: Vec<String>,
}

#[async_trait]
pub trait SummaryProvider {
    async fn generate(&self, transcript: &str) -> Result<SummaryResult, String>;
}
