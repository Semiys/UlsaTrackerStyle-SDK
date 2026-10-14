import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';

// Read-only diagnostic: does not create a schema or change saved events.
const uri = process.env.DATABASE_URI;
const token = process.env.DATABASE_TOKEN;
assert.ok(uri && token, 'DATABASE_URI and DATABASE_TOKEN are required');
const instance = await DuckDBInstance.create(':memory:', { threads: '2', memory_limit: '128MB' });
const connection = await instance.connect();
const literal = value => "'" + value.replaceAll("'", "''") + "'";
try {
  await connection.run('INSTALL quack; LOAD quack');
  const data = (await connection.runAndReadAll(
    'FROM quack_query($uri, $sql, token := $token, disable_ssl := true)',
    { uri, token, sql: 'SELECT count(*)::INTEGER AS events FROM events' },
  )).getRowObjects();
  console.log('Direct query after recreation: ' + JSON.stringify(data));
  assert.equal(data[0].events, 1);
  console.log('PASS: the database volume preserved the event');
  try {
    await connection.run(`ATTACH ${literal(uri)} AS remote (TYPE quack, TOKEN ${literal(token)}, DISABLE_SSL true)`);
    console.log('PASS: attaching the populated catalog succeeded');
  } catch (error) {
    console.error('FAIL: attaching the populated catalog: ' + error.message);
    process.exitCode = 1;
  }
} finally { connection.closeSync(); instance.closeSync(); }
