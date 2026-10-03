import express from 'express';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}

const app = express();
app.disable('x-powered-by');
app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))));

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`UlsaTracerStyle SDK 0.0.1: http://localhost:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
