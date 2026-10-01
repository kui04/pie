//! Model catalog, thinking levels, and token usage.
//!
//! Mirrors `Model`, `Usage`, `ThinkingLevel` and the cost/limit types from
//! `packages/ai/src/types.ts`. Field names are camelCase exactly as pi writes
//! them.

use serde::{Deserialize, Deserializer, Serialize};

/// Pi thinking level (`ThinkingLevel` in `packages/ai/src/types.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ThinkingLevel {
    /// Minimal reasoning.
    Minimal,
    /// Low reasoning.
    Low,
    /// Medium reasoning.
    Medium,
    /// High reasoning.
    High,
    /// Extra-high reasoning.
    Xhigh,
    /// Maximum reasoning.
    Max,
}

/// Pi thinking level including `off` (`ModelThinkingLevel` in
/// `packages/ai/src/types.ts`).
///
/// This is the value space sessions actually use: `get_available_thinking_levels`
/// answers `["off","low","high","max"]` on a real `pi --mode rpc` (see
/// `tests/fixtures`), which is wider than the `ThinkingLevel` annotation on some
/// responses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ModelThinkingLevel {
    /// Reasoning disabled.
    Off,
    /// Minimal reasoning.
    Minimal,
    /// Low reasoning.
    Low,
    /// Medium reasoning.
    Medium,
    /// High reasoning.
    High,
    /// Extra-high reasoning.
    Xhigh,
    /// Maximum reasoning.
    Max,
}

/// Maps pi thinking levels to provider-specific values
/// (`ThinkingLevelMap` in `packages/ai/src/types.ts`).
///
/// The three states are distinct and preserved: an absent key means "use the
/// provider default", `null` means "this level is unsupported", and a string is
/// the provider's own value for the level.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThinkingLevelMap {
    /// Provider value for `off`.
    #[serde(
        default,
        deserialize_with = "optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub off: Option<Option<String>>,
    /// Provider value for `minimal`.
    #[serde(
        default,
        deserialize_with = "optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub minimal: Option<Option<String>>,
    /// Provider value for `low`.
    #[serde(
        default,
        deserialize_with = "optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub low: Option<Option<String>>,
    /// Provider value for `medium`.
    #[serde(
        default,
        deserialize_with = "optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub medium: Option<Option<String>>,
    /// Provider value for `high`.
    #[serde(
        default,
        deserialize_with = "optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub high: Option<Option<String>>,
    /// Provider value for `xhigh`.
    #[serde(
        default,
        deserialize_with = "optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub xhigh: Option<Option<String>>,
    /// Provider value for `max`.
    #[serde(
        default,
        deserialize_with = "optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub max: Option<Option<String>>,
}

/// Deserializes one mapping entry, keeping `null` distinct from an absent key.
///
/// The outer `Option` says the key is present, the inner one says it is `null`.
/// A plain `Option<Option<String>>` collapses both to `None`, because serde maps
/// JSON `null` onto the outer option.
fn optional_value<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

/// Input modality a model accepts (`input` in `BaseModel`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum InputModality {
    /// Text input.
    Text,
    /// Image input.
    Image,
}

/// Model category (`type` in `Model`).
///
/// Pi declares `type?: "chat"` on its chat model and models image and classifier
/// models as separate TS types, so only `chat` can appear here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ModelType {
    /// Chat model.
    Chat,
}

/// Per-million-token prices (`ModelCostRates` in `packages/ai/src/types.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ModelCostRates {
    /// Input price.
    pub input: f64,
    /// Output price.
    pub output: f64,
    /// Cache read price.
    #[serde(rename = "cacheRead")]
    pub cache_read: f64,
    /// Cache write price.
    #[serde(rename = "cacheWrite")]
    pub cache_write: f64,
}

/// Prices for requests whose input exceeds a threshold (`ModelCostTier`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCostTier {
    /// Input price.
    pub input: f64,
    /// Output price.
    pub output: f64,
    /// Cache read price.
    pub cache_read: f64,
    /// Cache write price.
    pub cache_write: f64,
    /// Requests above this many input tokens use this tier.
    pub input_tokens_above: u64,
}

/// Model pricing (`ModelCost` in `packages/ai/src/types.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    /// Input price.
    pub input: f64,
    /// Output price.
    pub output: f64,
    /// Cache read price.
    pub cache_read: f64,
    /// Cache write price.
    pub cache_write: f64,
    /// Request-wide pricing tiers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tiers: Option<Vec<ModelCostTier>>,
}

/// Cache-safe image resize profile (`ModelImageResizeOptions`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelImageResizeOptions {
    /// Maximum width.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_width: Option<u64>,
    /// Maximum height.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_height: Option<u64>,
    /// Maximum base64 payload size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    /// JPEG quality for the resize.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jpeg_quality: Option<u64>,
}

/// Image limits of a model (`ModelImageInputLimits`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelImageInputLimits {
    /// Resize profile applied before an image enters history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resize: Option<ModelImageResizeOptions>,
    /// Maximum images per provider message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_per_message: Option<u64>,
    /// Maximum images per provider request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_per_request: Option<u64>,
}

/// Input limits of a model (`ModelInputLimits`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInputLimits {
    /// Maximum serialized provider request size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_request_bytes: Option<u64>,
    /// Image limits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<ModelImageInputLimits>,
}

/// Best-effort prompt cache lifetime in seconds per retention tier
/// (`ModelPromptCache`, a `Partial<Record<"short"|"long", number>>`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct ModelPromptCache {
    /// Lifetime of a short-retention cache entry, in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short: Option<u64>,
    /// Lifetime of a long-retention cache entry, in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub long: Option<u64>,
}

/// A chat model as pi reports it (`Model` in `packages/ai/src/types.ts`).
///
/// `api`, `provider` and `compat` are open in pi (`KnownApi | (string & {})`,
/// `ProviderId`, and a per-API compat union). `compat` is kept as raw JSON so no
/// provider shape is invented here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    /// Model id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// API implementation, e.g. `openai-completions`.
    pub api: String,
    /// Provider id, e.g. `anthropic`.
    pub provider: String,
    /// Base URL of the endpoint.
    pub base_url: String,
    /// Categories of content the model accepts.
    pub input: Vec<InputModality>,
    /// Provider input limits and preprocessing metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_limits: Option<ModelInputLimits>,
    /// Prices.
    pub cost: ModelCost,
    /// Extra request headers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::BTreeMap<String, String>>,
    /// Model category; `chat` is the only value pi declares for this type.
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub model_type: Option<ModelType>,
    /// Whether the model supports reasoning.
    pub reasoning: bool,
    /// Pi thinking level to provider value mapping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level_map: Option<ThinkingLevelMap>,
    /// Prompt cache lifetimes per retention tier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cache: Option<ModelPromptCache>,
    /// Context window in tokens.
    pub context_window: u64,
    /// Maximum output tokens.
    pub max_tokens: u64,
    /// Default sampling parameters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampling_params: Option<serde_json::Value>,
    /// Compatibility overrides, shaped per API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<serde_json::Value>,
}

/// Cost breakdown of one usage record (`Usage["cost"]`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCost {
    /// Input cost.
    pub input: f64,
    /// Output cost.
    pub output: f64,
    /// Cache read cost.
    pub cache_read: f64,
    /// Cache write cost.
    pub cache_write: f64,
    /// Total cost.
    pub total: f64,
}

/// Token usage of one LLM response (`Usage` in `packages/ai/src/types.ts`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Input tokens.
    pub input: u64,
    /// Output tokens.
    pub output: u64,
    /// Cached input tokens read.
    pub cache_read: u64,
    /// Input tokens written to cache.
    pub cache_write: u64,
    /// Cache writes with one hour retention, when the provider reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write1h: Option<u64>,
    /// Reasoning tokens, a subset of `output`, when the provider reports them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<u64>,
    /// Total tokens.
    pub total_tokens: u64,
    /// Cost breakdown.
    pub cost: UsageCost,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `null` and an absent key mean different things to pi - "this level is
    /// unsupported" versus "use the provider default" - and a plain
    /// `Option<Option<String>>` collapses both onto the outer `None`.
    #[test]
    fn thinking_level_map_keeps_absent_and_null_apart() {
        let map: ThinkingLevelMap =
            serde_json::from_value(serde_json::json!({ "low": "low", "medium": null })).unwrap();

        assert_eq!(map.low, Some(Some("low".to_string())));
        assert_eq!(map.medium, Some(None), "an explicit null marks a level unsupported");
        assert_eq!(map.off, None, "an absent key means the provider default");
    }

    #[test]
    fn thinking_level_map_round_trips_all_three_states() {
        let map = ThinkingLevelMap {
            low: Some(Some("low".to_string())),
            medium: Some(None),
            ..ThinkingLevelMap::default()
        };

        let wire = serde_json::to_value(&map).unwrap();

        assert_eq!(wire, serde_json::json!({ "low": "low", "medium": null }));
        assert_eq!(serde_json::from_value::<ThinkingLevelMap>(wire).unwrap(), map);
    }
}
