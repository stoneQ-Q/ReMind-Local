import { createServer } from 'node:http';

import { apiPort } from './config.js';
import { closeDatabase, database } from './database.js';

const port = apiPort();

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200);
    response.end(JSON.stringify({ ok: true, service: 'remind-cloud-api' }));
    return;
  }

  if (request.method === 'GET' && request.url === '/ready') {
    try {
      await database.query('SELECT 1');
      response.writeHead(200);
      response.end(
        JSON.stringify({ ok: true, database: 'ready', apiVersion: 'v1' }),
      );
    } catch {
      response.writeHead(503);
      response.end(JSON.stringify({ ok: false, database: 'unavailable' }));
    }
    return;
  }

  response.writeHead(404);
  response.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`ReMind cloud API listening on port ${port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down cloud API`);
  server.close();
  await closeDatabase();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
