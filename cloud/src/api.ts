import { createServer } from 'node:http';

import {
  authenticateAccessToken,
  createAnonymousAccount,
  listUserDevices,
  recoverAnonymousAccount,
  type DevicePlatform,
  type DeviceRegistration,
} from './auth.js';
import { apiPort } from './config.js';
import { closeDatabase, database } from './database.js';

const port = apiPort();
const MAX_JSON_BODY_BYTES = 16 * 1024;
const allowedPlatforms = new Set<DevicePlatform>([
  'android',
  'ios',
  'unknown',
]);

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { ok: true, service: 'remind-cloud-api' });
      return;
    }

    if (request.method === 'GET' && request.url === '/ready') {
      try {
        await database.query('SELECT 1');
        sendJson(response, 200, {
          ok: true,
          database: 'ready',
          apiVersion: 'v1',
        });
      } catch {
        sendJson(response, 503, { ok: false, database: 'unavailable' });
      }
      return;
    }

    if (
      request.method === 'POST' &&
      request.url === '/api/v1/auth/register'
    ) {
      const body = await readJsonBody(request);
      const registration = parseDeviceRegistration(body);
      if (!registration) {
        sendJson(response, 400, { error: 'invalid_request' });
        return;
      }
      const account = await createAnonymousAccount(database, registration);
      sendJson(response, 201, account);
      return;
    }

    if (
      request.method === 'POST' &&
      request.url === '/api/v1/auth/recover'
    ) {
      const body = await readJsonBody(request);
      const registration = parseDeviceRegistration(body);
      const recoveryCode =
        isRecord(body) && typeof body.recoveryCode === 'string'
          ? body.recoveryCode
          : '';
      if (!registration || !recoveryCode) {
        sendJson(response, 400, { error: 'invalid_request' });
        return;
      }
      const session = await recoverAnonymousAccount(
        database,
        recoveryCode,
        registration,
      );
      if (!session) {
        sendJson(response, 401, { error: 'invalid_recovery_code' });
        return;
      }
      sendJson(response, 201, session);
      return;
    }

    if (
      request.method === 'GET' &&
      request.url === '/api/v1/users/me'
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      sendJson(response, 200, {
        id: account.userId,
        aiMode: account.aiMode,
        createdAt: account.createdAt,
      });
      return;
    }

    if (request.method === 'GET' && request.url === '/api/v1/devices') {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const devices = await listUserDevices(
        database,
        account.userId,
        account.deviceId,
      );
      sendJson(response, 200, { devices });
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      sendJson(response, error.status, { error: error.code });
      return;
    }
    console.error(
      'Cloud API request failed',
      error instanceof Error ? error.message : 'unknown error',
    );
    sendJson(response, 500, { error: 'internal_error' });
  }
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

function sendJson(
  response: import('node:http').ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status);
  response.end(JSON.stringify(payload));
}

async function readJsonBody(
  request: import('node:http').IncomingMessage,
): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new RequestBodyError(415, 'content_type_required');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_JSON_BODY_BYTES) {
      throw new RequestBodyError(413, 'body_too_large');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestBodyError(400, 'invalid_json');
  }
}

function parseDeviceRegistration(body: unknown): DeviceRegistration | null {
  if (!isRecord(body)) return null;
  const platform = body.platform;
  if (
    typeof platform !== 'string' ||
    !allowedPlatforms.has(platform as DevicePlatform)
  ) {
    return null;
  }
  const displayName = optionalShortText(body.displayName, 80);
  const appVersion = optionalShortText(body.appVersion, 32);
  if (displayName === undefined || appVersion === undefined) return null;
  return {
    platform: platform as DevicePlatform,
    displayName,
    appVersion,
  };
}

function optionalShortText(
  value: unknown,
  maximumLength: number,
): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= maximumLength ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
