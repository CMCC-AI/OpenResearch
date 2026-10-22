//! Per-subscriber deltas. A fresh/reconnected stream always starts with a full
//! message; lag clears baselines. Legacy clients can request full frames.
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct MessageEncoder {
    messages: HashMap<(String, String), (Value, u64, usize)>,
    bytes: usize,
}
impl MessageEncoder {
    pub fn clear(&mut self) {
        self.messages.clear();
        self.bytes = 0;
    }
    pub fn encode(&mut self, data: Value) -> (&'static str, Value) {
        let (Some(session), Some(id)) =
            (data["sessionId"].as_str(), data["message"]["id"].as_str())
        else {
            return ("chat.message", data);
        };
        let key = (session.to_owned(), id.to_owned());
        let message = &data["message"];
        let size = message.to_string().len();
        let previous = self.messages.remove(&key);
        let revision = previous.as_ref().map_or(1, |(_, version, _)| version + 1);
        let mut encoded = None;
        if let Some((old, base, bytes)) = previous {
            self.bytes -= bytes;
            let mut changes = Vec::new();
            diff(&old, message, &mut Vec::new(), &mut changes);
            let delta = json!({"sessionId":session,"messageId":id,"baseRevision":base,"revision":revision,"changes":changes});
            if changes.len() <= 4096 && delta.to_string().len() < size {
                encoded = Some(delta);
            }
        }
        if self.messages.len() >= 128 || self.bytes + size > 8 * 1024 * 1024 {
            self.clear();
        }
        if size <= 8 * 1024 * 1024 {
            self.messages.insert(key, (message.clone(), revision, size));
            self.bytes += size;
        }
        if let Some(delta) = encoded {
            return ("chat.message.delta", delta);
        }
        let mut data = data;
        data["streamRevision"] = json!(revision);
        ("chat.message", data)
    }
}
fn diff(old: &Value, next: &Value, path: &mut Vec<Value>, changes: &mut Vec<Value>) {
    if old == next {
        return;
    }
    if path.len() >= 64 {
        changes.push(json!({"op":"set","path":path,"value":next}));
        return;
    }
    match (old, next) {
        (Value::String(old), Value::String(next)) if next.starts_with(old) => {
            changes.push(json!({"op":"append","path":path,"text":&next[old.len()..]}));
        }
        (Value::Object(old), Value::Object(next)) => {
            for key in old.keys().filter(|key| !next.contains_key(*key)) {
                path.push(json!(key));
                changes.push(json!({"op":"remove","path":path}));
                path.pop();
            }
            for (key, value) in next {
                path.push(json!(key));
                if let Some(previous) = old.get(key) {
                    diff(previous, value, path, changes);
                } else {
                    changes.push(json!({"op":"set","path":path,"value":value}));
                }
                path.pop();
            }
        }
        (Value::Array(old), Value::Array(next)) if old.len() == next.len() => {
            for (index, (old, next)) in old.iter().zip(next).enumerate() {
                path.push(json!(index));
                diff(old, next, path, changes);
                path.pop();
            }
        }
        _ => changes.push(json!({"op":"set","path":path,"value":next})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delta_matches_the_shared_client_contract_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/chat-message-stream.json"
        ))
        .unwrap();
        let mut encoder = MessageEncoder::default();
        let baseline = encoder.encode(fixture["baseline"].clone());
        assert_eq!(baseline.1, fixture["baseline"]);
        let delta = encoder.encode(fixture["next"].clone());
        assert_eq!(delta.0, "chat.message.delta");
        assert_eq!(delta.1, fixture["delta"]);
    }

    #[test]
    fn streaming_text_uses_a_small_delta_and_lag_requires_a_fresh_baseline() {
        let mut encoder = MessageEncoder::default();
        let message = |text: String| json!({"sessionId":"s","message":{"id":"m","parts":[{"id":"p","type":"text","text":text}]}});
        let first = encoder.encode(message("a".repeat(10000)));
        assert_eq!(first.0, "chat.message");
        let second = encoder.encode(message(format!("{}好", "a".repeat(10000))));
        assert_eq!(second.0, "chat.message.delta");
        assert_eq!(second.1["baseRevision"], 1);
        assert_eq!(second.1["changes"][0]["text"], "好");
        assert!(second.1.to_string().len() < 300);
        encoder.clear();
        assert_eq!(
            encoder.encode(message("after lag".into())).0,
            "chat.message"
        );
    }
}
