import { createServer } from 'node:http';

import {
  authenticateAccessToken,
  createAnonymousAccount,
  listUserDevices,
  recoverAnonymousAccount,
  refreshDeviceSession,
  revokeUserDevice,
  type DevicePlatform,
  type DeviceRegistration,
} from './auth.js';
import {
  deleteApiCredential,
  getAiSettings,
  InvalidApiCredentialError,
  isAiProvider,
  isAiUsageMode,
  saveApiCredential,
  updateAiMode,
} from './ai-settings.js';
import { runByokAiTest } from './ai-test.js';
import {
  BillingError,
  getBillingAccount,
  listLedgerEntries,
} from './billing.js';
import { apiPort, mediaProviderMode } from './config.js';
import { credentialCipherFromEnvironment } from './credential-cipher.js';
import { closeDatabase, database } from './database.js';
import {
  appendFileUploadChunk,
  cancelFileUpload,
  completeFileUpload,
  createFileUpload,
  FileUploadError,
  getUserFileUpload,
} from './file-uploads.js';
import {
  confirmAndReserveManagedJobQuote,
  getManagedJobQuote,
  JobQuoteError,
} from './job-quotes.js';
import { getUserJob, requestJobCancellation } from './jobs.js';
import { ProviderPausedError } from './provider-health.js';
import { MediaProviderHttpError } from './media-provider-clients.js';
import { MediaProviderAuthorizationError } from './media-provider-routing.js';
import {
  requestClientAddress,
  RequestRateLimiter,
} from './request-rate-limit.js';
import {
  createByokMediaProcessingRequest,
  createManagedMediaProcessingRequest,
  getUserMediaProcessingRequest,
  listUserMediaProcessingRequests,
  MediaRequestError,
  requestMediaProcessingCancellation,
} from './media-processing.js';
import {
  managedMediaPriceCatalogFromEnvironment,
  ManagedMediaPricingUnavailableError,
} from './media-pricing.js';
import { objectStoreFromEnvironment } from './object-store.js';
import {
  OrganizationError,
  organizeDaily,
  organizeLink,
  answerMemoryQuestion,
  generateMemoryInsight,
  suggestThemeMerge,
} from './organization.js';
import {
  claimWechatBindingCode,
  createWechatBindingCode,
  getCloudWechatStatus,
  listCloudWechatCaptures,
  updateCloudWechatReplyMode,
} from './wechat-bindings.js';
import type { WechatProtocolCredentials } from './wechat-protocol.js';

const port = apiPort();
const credentialCipher = credentialCipherFromEnvironment();
const objectStore = objectStoreFromEnvironment();
const configuredMediaProvider = mediaProviderMode();
const managedMediaPriceCatalog =
  configuredMediaProvider === 'remote'
    ? managedMediaPriceCatalogFromEnvironment()
    : null;
const MAX_JSON_BODY_BYTES = 96 * 1024;
const MAX_ORGANIZATION_JSON_BODY_BYTES = 384 * 1024;
const MAX_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const requestRateLimiter = new RequestRateLimiter();
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

    const rateLimit = requestRateLimiter.check(
      requestClientAddress(request),
      request.url ?? '',
    );
    if (!rateLimit.allowed) {
      response.setHeader(
        'Retry-After',
        String(rateLimit.retryAfterSeconds),
      );
      sendJson(response, 429, { error: 'rate_limited' });
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
      request.method === 'POST' &&
      request.url === '/api/v1/auth/refresh'
    ) {
      const body = await readJsonBody(request);
      const deviceId =
        isRecord(body) && typeof body.deviceId === 'string'
          ? body.deviceId
          : '';
      const deviceSecret =
        isRecord(body) && typeof body.deviceSecret === 'string'
          ? body.deviceSecret
          : '';
      if (!deviceId || !deviceSecret) {
        sendJson(response, 400, { error: 'invalid_request' });
        return;
      }
      const session = await refreshDeviceSession(
        database,
        deviceId,
        deviceSecret,
      );
      if (!session) {
        sendJson(response, 401, { error: 'invalid_device_credentials' });
        return;
      }
      sendJson(response, 201, session);
      return;
    }

    if (
      request.method === 'POST' &&
      request.url === '/api/v1/wechat/bindings/claim'
    ) {
      const body = await readJsonBody(request);
      const bindingCode =
        isRecord(body) && typeof body.bindingCode === 'string'
          ? body.bindingCode.trim()
          : '';
      const credentials = parseWechatCredentials(body);
      if (!/^[0-9]{6}$/.test(bindingCode) || !credentials) {
        sendJson(response, 400, { error: 'invalid_request' });
        return;
      }
      try {
        const claimed = await claimWechatBindingCode(
          database,
          credentialCipher,
          bindingCode,
          credentials,
        );
        if (!claimed) {
          sendJson(response, 400, {
            error: 'invalid_or_expired_binding_code',
          });
          return;
        }
        sendJson(response, 200, { bound: true });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('invalid_wechat')) {
          sendJson(response, 400, { error: error.message });
          return;
        }
        throw error;
      }
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

    if (
      request.method === 'GET' &&
      request.url === '/api/v1/wechat/status'
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      sendJson(
        response,
        200,
        await getCloudWechatStatus(database, account.userId),
      );
      return;
    }

    if (
      request.method === 'POST' &&
      request.url === '/api/v1/wechat/binding-code'
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const status = await getCloudWechatStatus(database, account.userId);
      if (status.bound) {
        sendJson(response, 409, { error: 'wechat_already_bound' });
        return;
      }
      sendJson(
        response,
        201,
        await createWechatBindingCode(database, account.userId),
      );
      return;
    }

    if (
      request.method === 'GET' &&
      request.url === '/api/v1/wechat/captures'
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
        messages: await listCloudWechatCaptures(database, account.userId),
      });
      return;
    }

    if (
      request.method === 'PUT' &&
      request.url === '/api/v1/wechat/reply-mode'
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const body = await readJsonBody(request);
      const replyMode = isRecord(body) ? body.replyMode : null;
      if (
        replyMode !== 'first' &&
        replyMode !== 'always' &&
        replyMode !== 'silent'
      ) {
        sendJson(response, 400, { error: 'invalid_request' });
        return;
      }
      if (
        !(await updateCloudWechatReplyMode(
          database,
          account.userId,
          replyMode,
        ))
      ) {
        sendJson(response, 404, { error: 'wechat_connection_not_found' });
        return;
      }
      sendJson(response, 200, { replyMode });
      return;
    }

    const deviceMatch = request.url?.match(
      /^\/api\/v1\/devices\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
    );
    if (request.method === 'DELETE' && deviceMatch) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const deviceId = deviceMatch[1] ?? '';
      const revoked = await revokeUserDevice(
        database,
        account.userId,
        deviceId,
      );
      if (!revoked) {
        sendJson(response, 404, { error: 'device_not_found' });
        return;
      }
      sendJson(response, 200, {
        id: deviceId,
        current: deviceId === account.deviceId,
      });
      return;
    }

    if (
      request.method === 'GET' &&
      request.url === '/api/v1/billing/account'
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const billingAccount = await getBillingAccount(database, account.userId);
      if (!billingAccount) {
        sendJson(response, 404, { error: 'billing_account_not_found' });
        return;
      }
      sendJson(response, 200, billingAccount);
      return;
    }

    if (
      request.method === 'GET' &&
      request.url === '/api/v1/billing/ledger'
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
        entries: await listLedgerEntries(database, account.userId),
      });
      return;
    }

    const jobQuoteMatch = request.url?.match(
      /^\/api\/v1\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/quote$/i,
    );

    if (
      request.method === 'POST' &&
      request.url === '/api/v1/files/uploads'
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const body = await readJsonBody(request);
      if (!isRecord(body)) {
        sendJson(response, 400, { error: 'invalid_request' });
        return;
      }
      const contentType =
        typeof body.contentType === 'string' ? body.contentType : '';
      const sizeBytes =
        typeof body.sizeBytes === 'number' ? body.sizeBytes : Number.NaN;
      const sha256Hex =
        typeof body.sha256Hex === 'string' ? body.sha256Hex : '';
      const idempotencyKey =
        typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
      const originalName =
        typeof body.originalName === 'string' ? body.originalName : undefined;
      if (
        !contentType ||
        !Number.isSafeInteger(sizeBytes) ||
        !sha256Hex ||
        !idempotencyKey
      ) {
        sendJson(response, 400, { error: 'invalid_request' });
        return;
      }
      sendJson(
        response,
        201,
        await createFileUpload(database, objectStore, {
          userId: account.userId,
          contentType,
          sizeBytes,
          sha256Hex,
          idempotencyKey,
          originalName,
        }),
      );
      return;
    }

    const fileUploadMatch = request.url?.match(
      /^\/api\/v1\/files\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/(chunks|complete))?$/i,
    );
    if (
      fileUploadMatch &&
      request.method === 'GET' &&
      !fileUploadMatch[2]
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const upload = await getUserFileUpload(
        database,
        account.userId,
        fileUploadMatch[1] ?? '',
      );
      if (!upload) {
        sendJson(response, 404, { error: 'upload_not_found' });
        return;
      }
      sendJson(response, 200, upload);
      return;
    }
    if (
      fileUploadMatch &&
      fileUploadMatch[2] === 'chunks' &&
      request.method === 'PUT'
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const offset = parseUploadOffset(request.headers['upload-offset']);
      if (offset === null) {
        sendJson(response, 400, { error: 'invalid_upload_chunk' });
        return;
      }
      const content = await readUploadChunk(request);
      sendJson(
        response,
        200,
        await appendFileUploadChunk(database, objectStore, {
          userId: account.userId,
          uploadId: fileUploadMatch[1] ?? '',
          offset,
          content,
        }),
      );
      return;
    }
    if (
      fileUploadMatch &&
      fileUploadMatch[2] === 'complete' &&
      request.method === 'POST'
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      sendJson(
        response,
        200,
        await completeFileUpload(
          database,
          objectStore,
          account.userId,
          fileUploadMatch[1] ?? '',
        ),
      );
      return;
    }
    if (
      fileUploadMatch &&
      !fileUploadMatch[2] &&
      request.method === 'DELETE'
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const upload = await cancelFileUpload(
        database,
        objectStore,
        account.userId,
        fileUploadMatch[1] ?? '',
      );
      if (!upload) {
        sendJson(response, 404, { error: 'upload_not_found' });
        return;
      }
      sendJson(response, 202, upload);
      return;
    }

    if (
      request.method === 'GET' &&
      request.url === '/api/v1/media/requests'
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
        items: await listUserMediaProcessingRequests(
          database,
          account.userId,
        ),
      });
      return;
    }

    if (
      request.method === 'POST' &&
      request.url === '/api/v1/media/requests'
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const body = await readJsonBody(request);
      const sourceFileId =
        isRecord(body) && typeof body.sourceFileId === 'string'
          ? body.sourceFileId
          : '';
      const idempotencyKey =
        isRecord(body) && typeof body.idempotencyKey === 'string'
          ? body.idempotencyKey
          : '';
      const durationSeconds =
        isRecord(body) && typeof body.durationSeconds === 'number'
          ? body.durationSeconds
          : undefined;
      if (!isUuid(sourceFileId) || !idempotencyKey) {
        sendJson(response, 400, { error: 'invalid_request' });
        return;
      }
      if (account.aiMode === 'bring_your_own_key') {
        if (
          configuredMediaProvider !== 'byok' &&
          configuredMediaProvider !== 'remote'
        ) {
          sendJson(response, 503, { error: 'media_processing_unavailable' });
          return;
        }
        sendJson(response, 201, await createByokMediaProcessingRequest(
          database,
          {
            userId: account.userId,
            sourceFileId,
            idempotencyKey,
          },
        ));
        return;
      }
      if (
        account.aiMode === 'managed' &&
        configuredMediaProvider === 'remote' &&
        managedMediaPriceCatalog
      ) {
        sendJson(response, 201, await createManagedMediaProcessingRequest(
          database,
          {
            userId: account.userId,
            sourceFileId,
            idempotencyKey,
            durationSeconds,
          },
          managedMediaPriceCatalog,
        ));
        return;
      }
      sendJson(response, 503, { error: 'media_processing_unavailable' });
      return;
    }

    const mediaRequestMatch = request.url?.match(
      /^\/api\/v1\/media\/requests\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/(cancel))?$/i,
    );
    if (mediaRequestMatch && request.method === 'GET' && !mediaRequestMatch[2]) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const mediaRequest = await getUserMediaProcessingRequest(
        database,
        account.userId,
        mediaRequestMatch[1] ?? '',
      );
      if (!mediaRequest) {
        sendJson(response, 404, { error: 'media_request_not_found' });
        return;
      }
      sendJson(response, 200, mediaRequest);
      return;
    }
    if (
      mediaRequestMatch &&
      mediaRequestMatch[2] === 'cancel' &&
      request.method === 'POST'
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const mediaRequest = await requestMediaProcessingCancellation(
        database,
        account.userId,
        mediaRequestMatch[1] ?? '',
      );
      if (!mediaRequest) {
        sendJson(response, 404, { error: 'media_request_not_found' });
        return;
      }
      sendJson(response, 202, mediaRequest);
      return;
    }
    if (jobQuoteMatch && request.method === 'GET') {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const quote = await getManagedJobQuote(
        database,
        account.userId,
        jobQuoteMatch[1] ?? '',
      );
      if (!quote) {
        sendJson(response, 404, { error: 'quote_not_found' });
        return;
      }
      sendJson(response, 200, quote);
      return;
    }

    const jobConfirmationMatch = request.url?.match(
      /^\/api\/v1\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/confirm$/i,
    );
    if (jobConfirmationMatch && request.method === 'POST') {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      if (account.aiMode !== 'managed') {
        sendJson(response, 409, { error: 'managed_mode_required' });
        return;
      }
      sendJson(
        response,
        200,
        await confirmAndReserveManagedJobQuote(
          database,
          account.userId,
          jobConfirmationMatch[1] ?? '',
        ),
      );
      return;
    }

    const jobStatusMatch = request.url?.match(
      /^\/api\/v1\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
    );
    if (jobStatusMatch && request.method === 'GET') {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const job = await getUserJob(
        database,
        account.userId,
        jobStatusMatch[1] ?? '',
      );
      if (!job) {
        sendJson(response, 404, { error: 'job_not_found' });
        return;
      }
      sendJson(response, 200, job);
      return;
    }

    const jobCancellationMatch = request.url?.match(
      /^\/api\/v1\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/cancel$/i,
    );
    if (jobCancellationMatch && request.method === 'POST') {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const job = await requestJobCancellation(
        database,
        account.userId,
        jobCancellationMatch[1] ?? '',
      );
      if (!job) {
        sendJson(response, 404, { error: 'job_not_found' });
        return;
      }
      sendJson(response, 202, job);
      return;
    }

    if (
      request.method === 'GET' &&
      request.url === '/api/v1/ai/settings'
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      sendJson(response, 200, await getAiSettings(database, account.userId));
      return;
    }

    if (
      request.method === 'POST' &&
      request.url === '/api/v1/ai/test'
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        sendJson(
          response,
          200,
          await runByokAiTest(
            database,
            credentialCipher,
            account.userId,
            controller.signal,
          ),
        );
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    const organizationMatch = request.url?.match(
      /^\/api\/v1\/organize\/(organize|link-organize|theme-merge|memory-question|memory-insight)$/,
    );
    if (request.method === 'POST' && organizationMatch) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const body = await readJsonBody(
        request,
        MAX_ORGANIZATION_JSON_BODY_BYTES,
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        const action = organizationMatch[1];
        const result =
          action === 'organize'
            ? await organizeDaily(
                database,
                credentialCipher,
                account.userId,
                body,
                controller.signal,
              )
            : action === 'link-organize'
              ? await organizeLink(
                  database,
                  credentialCipher,
                  account.userId,
                  body,
                  controller.signal,
                )
              : action === 'theme-merge'
                ? await suggestThemeMerge(
                  database,
                  credentialCipher,
                  account.userId,
                  body,
                  controller.signal,
                  )
                : action === 'memory-question'
                  ? await answerMemoryQuestion(
                      database,
                      credentialCipher,
                      account.userId,
                      body,
                      controller.signal,
                    )
                  : await generateMemoryInsight(
                      database,
                      credentialCipher,
                      account.userId,
                      body,
                      controller.signal,
                    );
        sendJson(response, 200, result);
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    if (
      request.method === 'PUT' &&
      request.url === '/api/v1/ai/settings'
    ) {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const body = await readJsonBody(request);
      const mode = isRecord(body) ? body.mode : undefined;
      if (!isAiUsageMode(mode)) {
        sendJson(response, 400, { error: 'invalid_ai_mode' });
        return;
      }
      const settings = await updateAiMode(database, account.userId, mode);
      if (!settings) {
        sendJson(response, 409, { error: 'api_credential_required' });
        return;
      }
      sendJson(response, 200, settings);
      return;
    }

    const credentialMatch = request.url?.match(
      /^\/api\/v1\/ai\/credentials\/([^/?]+)$/,
    );
    if (credentialMatch && request.method === 'PUT') {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const provider = decodeURIComponent(credentialMatch[1] ?? '');
      if (!isAiProvider(provider)) {
        sendJson(response, 400, { error: 'unsupported_ai_provider' });
        return;
      }
      const body = await readJsonBody(request);
      const apiKey =
        isRecord(body) && typeof body.apiKey === 'string' ? body.apiKey : '';
      try {
        const settings = await saveApiCredential(
          database,
          credentialCipher,
          account.userId,
          provider,
          apiKey,
        );
        sendJson(response, 200, settings);
      } catch (error) {
        if (error instanceof InvalidApiCredentialError) {
          sendJson(response, 400, { error: 'invalid_api_credential' });
          return;
        }
        throw error;
      }
      return;
    }

    if (credentialMatch && request.method === 'DELETE') {
      const account = await authenticateAccessToken(
        database,
        request.headers.authorization,
      );
      if (!account) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const provider = decodeURIComponent(credentialMatch[1] ?? '');
      if (!isAiProvider(provider)) {
        sendJson(response, 400, { error: 'unsupported_ai_provider' });
        return;
      }
      sendJson(
        response,
        200,
        await deleteApiCredential(database, account.userId, provider),
      );
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      sendJson(response, error.status, { error: error.code });
      return;
    }
    if (error instanceof ProviderPausedError) {
      sendJson(response, 503, { error: error.code });
      return;
    }
    if (error instanceof MediaProviderAuthorizationError) {
      sendJson(response, 409, { error: error.code });
      return;
    }
    if (error instanceof OrganizationError) {
      sendJson(response, error.status, { error: error.code });
      return;
    }
    if (error instanceof MediaProviderHttpError) {
      sendJson(response, error.status === 401 || error.status === 403 ? 400 : 502, {
        error:
          error.status === 401 || error.status === 403
            ? 'ai_key_rejected'
            : error.status === 429
              ? 'ai_rate_limited'
              : 'ai_provider_failed',
      });
      return;
    }
    if (error instanceof JobQuoteError) {
      sendJson(response, error.code === 'quote_not_found' ? 404 : 409, {
        error: error.code,
      });
      return;
    }
    if (error instanceof BillingError) {
      sendJson(response, error.code === 'invalid_amount' ? 400 : 409, {
        error: error.code,
      });
      return;
    }
    if (error instanceof MediaRequestError) {
      sendJson(
        response,
        error.code === 'media_source_not_found'
          ? 404
          : error.code === 'invalid_media_duration'
            ? 400
            : 409,
        { error: error.code },
      );
      return;
    }
    if (error instanceof FileUploadError) {
      sendJson(
        response,
        error.code === 'upload_not_found'
          ? 404
          : error.code === 'upload_offset_mismatch' ||
              error.code === 'upload_idempotency_conflict' ||
              error.code === 'upload_not_writable' ||
              error.code === 'upload_not_completable' ||
              error.code === 'upload_already_completed'
            ? 409
            : error.code === 'upload_strategy_unavailable'
              ? 503
              : error.code === 'upload_expired'
                ? 410
              : 400,
        { error: error.code },
      );
      return;
    }
    if (error instanceof ManagedMediaPricingUnavailableError) {
      sendJson(response, 503, { error: error.message });
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
  maximumBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new RequestBodyError(415, 'content_type_required');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximumBytes) {
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

async function readUploadChunk(
  request: import('node:http').IncomingMessage,
): Promise<Buffer> {
  if (request.headers['content-type'] !== 'application/octet-stream') {
    throw new RequestBodyError(415, 'content_type_required');
  }
  const declared = Number(request.headers['content-length']);
  if (
    !Number.isSafeInteger(declared) ||
    declared < 1 ||
    declared > MAX_UPLOAD_CHUNK_BYTES
  ) {
    throw new RequestBodyError(413, 'invalid_upload_chunk');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_UPLOAD_CHUNK_BYTES || size > declared) {
      throw new RequestBodyError(413, 'invalid_upload_chunk');
    }
    chunks.push(buffer);
  }
  if (size !== declared) {
    throw new RequestBodyError(400, 'invalid_upload_chunk');
  }
  return Buffer.concat(chunks, size);
}

function parseUploadOffset(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,9})$/.test(value)) {
    return null;
  }
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : null;
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

function parseWechatCredentials(
  body: unknown,
): WechatProtocolCredentials | null {
  if (!isRecord(body) || !isRecord(body.credentials)) return null;
  const credentials = body.credentials;
  if (
    typeof credentials.botToken !== 'string' ||
    typeof credentials.botId !== 'string' ||
    typeof credentials.allowedUserId !== 'string' ||
    typeof credentials.baseUrl !== 'string'
  ) {
    return null;
  }
  return {
    botToken: credentials.botToken,
    botId: credentials.botId,
    allowedUserId: credentials.allowedUserId,
    baseUrl: credentials.baseUrl,
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
