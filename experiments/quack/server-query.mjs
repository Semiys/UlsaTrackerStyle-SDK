// Experimental adapter for the fixed SQL statements in AnalyticsStore.
// The attached-catalog beta cannot execute INSERT ... ON CONFLICT directly.
// remote.query() runs the complete statement in the server's DuckDB session.
export class ServerQueryConnection {
  constructor(connection) { this.connection = connection; }

  run(sql, parameters = {}) { return this.runAndReadAll(sql, parameters); }

  runAndReadAll(sql, parameters = {}) {
    const bound = sql.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (placeholder, key) => {
      if (!Object.hasOwn(parameters, key)) throw new Error('Missing SQL parameter: ' + key);
      const value = parameters[key];
      if (value === null) return 'NULL';
      if (typeof value === 'string') return "'" + value.replaceAll("'", "''") + "'";
      if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      throw new Error('Unsupported SQL parameter: ' + key);
    });
    return this.connection.runAndReadAll('FROM remote.query($sql)', { sql: bound });
  }

  closeSync() { this.connection.closeSync(); }
}
