use super::summary::*;
use async_trait::async_trait;

struct MockProvider;

#[async_trait]
impl SummaryProvider for MockProvider {
    async fn generate(&self, _transcript: &str) -> Result<SummaryResult, String> {
        Ok(SummaryResult {
            summary: "Team discussed Q3 roadmap.".into(),
            action_items: vec!["Send roadmap doc".into()],
        })
    }
}

#[tokio::test]
async fn mock_provider_returns_summary_result() {
    let provider = MockProvider;
    let result = provider.generate("some transcript text").await.unwrap();
    assert_eq!(result.summary, "Team discussed Q3 roadmap.");
    assert_eq!(result.action_items.len(), 1);
}
