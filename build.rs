use std::{fs, path::PathBuf};
use utoipa::OpenApi;

#[path = "src/config.rs"]
mod config;
#[path = "src/error.rs"]
mod error;

// Stub storage module for build script
mod storage {
    pub use crate::error::AppResult;
    use async_trait::async_trait;
    use std::sync::Arc;

    #[async_trait]
    pub trait StorageBackend: Send + Sync {
        async fn list_flags(&self) -> AppResult<Vec<String>>;
        async fn read_flag(&self, name: &str) -> AppResult<serde_json::Value>;
        async fn write_flag(&self, name: &str, content: &serde_json::Value) -> AppResult<()>;
        async fn delete_flag(&self, name: &str) -> AppResult<()>;
        async fn flag_exists(&self, name: &str) -> AppResult<bool>;
    }

    pub fn create_storage_backend(_uri: &str) -> AppResult<Arc<dyn StorageBackend>> {
        panic!("Storage backend should not be used in build script")
    }
}

#[path = "src/handlers/api/flags.rs"]
pub mod flags_impl;

mod handlers {
    pub mod api {
        pub use crate::flags_impl as flags;
        pub use crate::flags_impl::ListFlagsResponse;
    }
}

#[path = "src/openapi_doc.rs"]
mod openapi_doc;

use openapi_doc::ApiDoc;

fn main() {
    println!("cargo:rerun-if-changed=src/openapi_doc.rs");
    println!("cargo:rerun-if-changed=src/handlers/api/flags.rs");

    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"));
    let output_path = manifest_dir.join("ui/openapi.json");

    let openapi_json =
        serde_json::to_string_pretty(&ApiDoc::openapi()).expect("Failed to serialize OpenAPI spec");

    fs::write(&output_path, openapi_json).unwrap_or_else(|err| {
        panic!(
            "Failed to write OpenAPI spec to {}: {}",
            output_path.display(),
            err
        )
    });
}
