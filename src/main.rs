mod config;
mod error;
mod handlers;
mod middleware;
mod openapi_doc;
mod storage;

use axum::{routing::get, Router};
use tower_http::{
    compression::CompressionLayer,
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use utoipa::OpenApi;
use utoipa_swagger_ui::{Config as SwaggerConfig, SwaggerUi};

use config::ServerConfig;
use handlers::{
    create_flag, delete_flag, get_flag, health_check, init_app_state, list_flags, readiness_check,
    update_flag,
};
use openapi_doc::ApiDoc;

#[tokio::main]
async fn main() {
    // Initialize tracing for structured logging
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Load configuration
    let config = ServerConfig::from_cli();
    let addr = format!("0.0.0.0:{}", config.port);

    tracing::info!("Starting server with config: {:?}", config);

    // Initialize application state with schema validation
    let app_state = init_app_state(config.clone())
        .await
        .expect("Failed to initialize application state");

    tracing::info!(
        "Schema validation initialized from: {}",
        config.schema_file_path
    );

    // Build the application router
    let app = create_router(&config, app_state);

    // Create TCP listener
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind to address");

    tracing::info!("Server listening on {}", addr);

    // Start the server with graceful shutdown on SIGTERM/SIGINT
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("Server failed to start");

    tracing::info!("Server shut down gracefully");
}

async fn shutdown_signal() {
    use tokio::signal;

    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("Shutdown signal received, starting graceful shutdown");
}

/// Create the Axum router with all routes and middleware
fn create_router(config: &ServerConfig, app_state: handlers::api::AppState) -> Router {
    // API routes - prefix all with /api
    let api_routes = Router::new()
        // Flag management endpoints
        .route("/flags", get(list_flags))
        .route(
            "/flags/:name",
            get(get_flag)
                .post(create_flag)
                .put(update_flag)
                .delete(delete_flag),
        )
        .with_state(app_state);

    // Main application router
    Router::new()
        // Health check endpoints
        .route("/health", get(health_check))
        .route("/ready", get(readiness_check))
        // Mount API routes under /api prefix
        .nest("/api", api_routes)
        // Swagger UI for interactive API documentation
        .merge(
            SwaggerUi::new("/swagger-ui")
                .url("/api/openapi.json", ApiDoc::openapi())
                .config(SwaggerConfig::default().try_it_out_enabled(true)),
        )
        // Serve static files from the public directory
        // This will also fallback to index.html for SPA routing
        .nest_service(
            "/",
            ServeDir::new(&config.static_dir)
                .not_found_service(ServeFile::new(format!("{}/index.html", &config.static_dir))),
        )
        // Add middleware stack
        .layer(CorsLayer::permissive())
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
}
