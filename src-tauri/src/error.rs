use serde::ser::Serializer;

/// Failures crossing the IPC boundary. Tauri requires command errors to be `Serialize`, so the
/// variant is flattened to its `Display` string and the React shell receives a plain message.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("backend process error: {0}")]
    Backend(String),
    #[error("backend did not report readiness within {0}s")]
    BackendTimeout(u64),
    #[error("folder picker failed: {0}")]
    Dialog(String),
    #[error("could not open path: {0}")]
    Opener(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
