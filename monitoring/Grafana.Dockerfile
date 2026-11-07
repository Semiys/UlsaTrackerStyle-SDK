# Keep the signed Prometheus plugin; ClickHouse is mounted separately.
# Other bundled backend plugins are unnecessary for this deployment.
FROM grafana/grafana:13.3.0 AS bundled
FROM grafana/grafana:13.3.0-slim
COPY --from=bundled /usr/share/grafana/data/plugins-bundled/prometheus /usr/share/grafana/data/plugins-bundled/prometheus
