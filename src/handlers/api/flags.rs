use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Serialize;
use std::{fs, path::PathBuf, sync::Arc};
use utoipa::ToSchema;

use crate::{
    config::ServerConfig,
    error::{AppError, AppResult},
    storage::{create_storage_backend, StorageBackend},
};

struct LocalSchemaRetriever {
    base_dir: PathBuf,
}

impl jsonschema::Retrieve for LocalSchemaRetriever {
    fn retrieve(
        &self,
        uri: &jsonschema::Uri<&str>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        let uri_str = uri.as_str();

        let candidate = if uri_str.starts_with("json-schema:///") {
            let rel = uri_str.trim_start_matches("json-schema:///");
            self.base_dir.join(rel)
        } else if uri.scheme().as_str() == "file" {
            PathBuf::from(uri.path().as_str())
        } else if uri.scheme().as_str() == "https"
            && uri.path().as_str().ends_with("targeting.json")
        {
            self.base_dir.join("targeting.json")
        } else {
            return Err(format!("Unsupported schema URI: {uri_str}").into());
        };

        let content = fs::read_to_string(&candidate)?;
        Ok(serde_json::from_str(&content)?)
    }
}

/// Application state containing configuration
#[derive(Clone)]
pub struct AppState {
    #[allow(dead_code)]
    pub config: Arc<ServerConfig>,
    pub schema: Arc<jsonschema::Validator>,
    pub storage: Arc<dyn StorageBackend>,
}

/// Response for listing all flag definition files
#[derive(Debug, Serialize, ToSchema)]
pub struct ListFlagsResponse {
    /// List of flag definition file names
    #[schema(example = json!(["demo", "production"]))]
    pub files: Vec<String>,
}

/// Initialize the application state with schema validation
pub async fn init_app_state(config: ServerConfig) -> AppResult<AppState> {
    let schema_dir = PathBuf::from(&config.schema_file_path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    // Load the schema from the local file
    let schema_content = fs::read_to_string(&config.schema_file_path)
        .map_err(|e| AppError::InternalServerError(format!("Failed to read schema file: {}", e)))?;

    let schema_json: serde_json::Value = serde_json::from_str(&schema_content)
        .map_err(|e| AppError::InternalServerError(format!("Failed to parse schema: {}", e)))?;

    // Compile the JSON schema into a validator
    let schema = jsonschema::options()
        .with_retriever(LocalSchemaRetriever {
            base_dir: schema_dir,
        })
        .build(&schema_json)
        .map_err(|e| AppError::InternalServerError(format!("Invalid schema: {}", e)))?;

    // Create storage backend based on URI
    let storage = create_storage_backend(&config.storage_uri)?;

    Ok(AppState {
        config: Arc::new(config),
        schema: Arc::new(schema),
        storage,
    })
}

/// Validate flag definition against the schema
fn validate_flags(
    schema: &jsonschema::Validator,
    complete_doc: &serde_json::Value,
) -> AppResult<()> {
    schema
        .validate(complete_doc)
        .map_err(|error| AppError::BadRequest(format!("Schema validation failed: {}", error)))
}

/// List all flag definition files
#[utoipa::path(
    get,
    path = "/api/flags",
    responses(
        (status = 200, description = "List of all flag definition files", body = ListFlagsResponse),
        (status = 500, description = "Internal server error")
    ),
    tag = "flags"
)]
pub async fn list_flags(State(state): State<AppState>) -> AppResult<impl IntoResponse> {
    let files = state.storage.list_flags().await?;
    Ok(Json(ListFlagsResponse { files }))
}

/// Get a specific flag definition file
#[utoipa::path(
    get,
    path = "/api/flags/{name}",
    params(
        ("name" = String, Path, description = "Name of the flag definition file")
    ),
    responses(
        (status = 200, description = "Flag definition file content", body = Object),
        (status = 404, description = "Flag definition not found"),
        (status = 400, description = "Invalid filename"),
        (status = 500, description = "Internal server error")
    ),
    tag = "flags"
)]
pub async fn get_flag(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> AppResult<impl IntoResponse> {
    let json = state.storage.read_flag(&name).await?;
    Ok(Json(json))
}

/// Create a new flag definition file
#[utoipa::path(
    post,
    path = "/api/flags/{name}",
    params(
        ("name" = String, Path, description = "Name of the flag definition file to create")
    ),
    request_body = Object,
    responses(
        (status = 201, description = "Flag definition file created successfully", body = Object),
        (status = 400, description = "Invalid request or validation failed"),
        (status = 500, description = "Internal server error")
    ),
    tag = "flags"
)]
pub async fn create_flag(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(payload): Json<serde_json::Value>,
) -> AppResult<impl IntoResponse> {
    // Check if file already exists
    if state.storage.flag_exists(&name).await? {
        return Err(AppError::BadRequest(format!(
            "Flag definition '{}' already exists",
            name
        )));
    }

    if !payload.is_object() {
        return Err(AppError::BadRequest(
            "Request body must be a JSON object".to_string(),
        ));
    }

    // Validate the full document against the schema
    validate_flags(&state.schema, &payload)?;

    // Write the file
    state.storage.write_flag(&name, &payload).await?;

    Ok((StatusCode::CREATED, Json(payload)))
}

/// Update an existing flag definition file
#[utoipa::path(
    put,
    path = "/api/flags/{name}",
    params(
        ("name" = String, Path, description = "Name of the flag definition file to update")
    ),
    request_body = Object,
    responses(
        (status = 200, description = "Flag definition file updated successfully", body = Object),
        (status = 404, description = "Flag definition not found"),
        (status = 400, description = "Invalid request or validation failed"),
        (status = 500, description = "Internal server error")
    ),
    tag = "flags"
)]
pub async fn update_flag(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(payload): Json<serde_json::Value>,
) -> AppResult<impl IntoResponse> {
    // Check if file exists
    if !state.storage.flag_exists(&name).await? {
        return Err(AppError::NotFound(format!(
            "Flag definition '{}' not found",
            name
        )));
    }

    if !payload.is_object() {
        return Err(AppError::BadRequest(
            "Request body must be a JSON object".to_string(),
        ));
    }

    // Validate the full document against the schema
    validate_flags(&state.schema, &payload)?;

    // Write the file
    state.storage.write_flag(&name, &payload).await?;

    Ok(Json(payload))
}

/// Delete a flag definition file
#[utoipa::path(
    delete,
    path = "/api/flags/{name}",
    params(
        ("name" = String, Path, description = "Name of the flag definition file to delete")
    ),
    responses(
        (status = 204, description = "Flag definition file deleted successfully"),
        (status = 404, description = "Flag definition not found"),
        (status = 400, description = "Invalid filename"),
        (status = 500, description = "Internal server error")
    ),
    tag = "flags"
)]
pub async fn delete_flag(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> AppResult<impl IntoResponse> {
    state.storage.delete_flag(&name).await?;
    Ok(StatusCode::NO_CONTENT)
}
