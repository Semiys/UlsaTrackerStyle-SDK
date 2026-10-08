export async function openStore(config) {
  if (config.storageBackend === 'json') {
    const { JsonAnalyticsStore } = await import('./json-store.js');
    return JsonAnalyticsStore.open(config.jsonPath);
  }
  // DuckDB is preserved for later work; JSON startup never loads its native package.
  const { AnalyticsStore } = await import('./store.js');
  return AnalyticsStore.open(config.databasePath);
}
