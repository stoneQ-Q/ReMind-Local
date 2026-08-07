import {
  acknowledgeInbox,
  approveDeviceLinkCloudCost,
  authenticateConnector,
  authenticateDevice,
  bindWechatOpenId,
  captureConnectorMessage,
  createConnector,
  createDevice,
  deviceStatus,
  findDeviceLinkSnapshot,
  isWechatBound,
  listPendingConnectorLinkSnapshots,
  listDeviceProcessingLinks,
  listInbox,
  refreshBindingCode,
  retryDeviceProcessingLink,
  saveConnectorLinkSnapshot,
  updateConnectorLinkProgress,
  updateConnectorRuntimeStatus,
  updateDeviceReplyMode,
} from './devices';
import type { ReplyMode } from './devices';
import type { Env } from './types';
import { ensureSchema } from './schema';
import {
  messageContent,
  parseBindingCode,
  parseWechatMessage,
  textReplyXml,
  verifyWechatSignature,
} from './wechat';
import {
  DeepSeekHttpError,
  answerMemoryQuestionWithDeepSeek,
  generateMemoryInsightWithDeepSeek,
  organizeLinkWithDeepSeek,
  organizeWithDeepSeek,
  suggestThemeMergeWithDeepSeek,
  type MemorySource,
  type OrganizeSource,
} from './deepseek';
import { fetchLinkPage, validatePublicLinkUrl } from './link-page';
import { isMeaningfulLinkContext } from './link';
import { analyzeImagesWithZhipu } from './zhipu-vision';
import { transcribeAudioWithZhipu } from './zhipu-asr';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    await ensureSchema(env.DB);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'remind-wechat' });
    }

    if (url.pathname === '/wechat/callback') {
      return handleWechatCallback(request, env, url);
    }

    if (request.method === 'POST' && url.pathname === '/api/devices') {
      return json(await createDevice(env.DB), 201);
    }

    if (request.method === 'POST' && url.pathname === '/api/connectors') {
      const body = await request.json<{
        bindingCode?: unknown;
        kind?: unknown;
      }>();
      const bindingCode =
        typeof body.bindingCode === 'string' ? body.bindingCode.trim() : '';
      const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
      if (!/^[0-9]{6}$/.test(bindingCode) || kind !== 'weixin-ilink') {
        return json({ error: 'invalid_request' }, 400);
      }
      const connector = await createConnector(env.DB, bindingCode, kind);
      return connector
        ? json(connector, 201)
        : json({ error: 'invalid_or_expired_binding_code' }, 400);
    }

    const connectorMatch = url.pathname.match(
      /^\/api\/connectors\/([^/]+)\/captures$/,
    );

    const connectorRuntimeMatch = url.pathname.match(
      /^\/api\/connectors\/([^/]+)\/runtime-status$/,
    );
    if (request.method === 'PUT' && connectorRuntimeMatch) {
      const connectorId = connectorRuntimeMatch[1];
      const authenticated = await authenticateConnector(
        env.DB,
        connectorId,
        request.headers.get('Authorization'),
      );
      if (!authenticated) return json({ error: 'unauthorized' }, 401);
      const body = await request.json<{
        localWhisperAvailable?: unknown;
      }>();
      if (typeof body.localWhisperAvailable !== 'boolean') {
        return json({ error: 'invalid_request' }, 400);
      }
      const updated = await updateConnectorRuntimeStatus(
        env.DB,
        connectorId,
        { localWhisperAvailable: body.localWhisperAvailable },
      );
      return updated ? json({ ok: true }) : json({ error: 'not_found' }, 404);
    }
    if (request.method === 'POST' && connectorMatch) {
      const connectorId = connectorMatch[1];
      const authenticated = await authenticateConnector(
        env.DB,
        connectorId,
        request.headers.get('Authorization'),
      );
      if (!authenticated) return json({ error: 'unauthorized' }, 401);
      const body = await request.json<{
        externalId?: unknown;
        type?: unknown;
        content?: unknown;
        createdAt?: unknown;
      }>();
      const externalId =
        typeof body.externalId === 'string' ? body.externalId.trim() : '';
      const type = typeof body.type === 'string' ? body.type.trim() : 'text';
      const content =
        typeof body.content === 'string' ? body.content.trim() : '';
      const createdAt =
        typeof body.createdAt === 'string'
          ? body.createdAt
          : new Date().toISOString();
      if (
        !externalId ||
        externalId.length > 256 ||
        !content ||
        content.length > 50_000 ||
        !['text', 'voice', 'link'].includes(type)
      ) {
        return json({ error: 'invalid_request' }, 400);
      }
      const capture = await captureConnectorMessage(
        env.DB,
        connectorId,
        externalId,
        type,
        content,
        createdAt,
      );
      return json({ ok: true, ...capture });
    }

    const connectorAudioMatch = url.pathname.match(
      /^\/api\/connectors\/([^/]+)\/audio-transcriptions$/,
    );
    if (request.method === 'POST' && connectorAudioMatch) {
      const connectorId = connectorAudioMatch[1];
      const authenticated = await authenticateConnector(
        env.DB,
        connectorId,
        request.headers.get('Authorization'),
      );
      if (!authenticated) return json({ error: 'unauthorized' }, 401);
      if (!env.ZHIPU_API_KEY) {
        return json({ error: 'asr_not_configured' }, 503);
      }
      const declaredLength = Number(request.headers.get('Content-Length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
        return json({ error: 'audio_too_large' }, 413);
      }
      const audio = new Uint8Array(await request.arrayBuffer());
      if (audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_BYTES) {
        return json({ error: 'invalid_audio' }, 400);
      }
      try {
        const result = await transcribeAudioWithZhipu(
          env.ZHIPU_API_KEY,
          audio,
        );
        return json(result);
      } catch (error) {
        console.error('Zhipu ASR failed', error);
        return json({ error: 'asr_unavailable' }, 502);
      }
    }

    const connectorPendingMatch = url.pathname.match(
      /^\/api\/connectors\/([^/]+)\/pending-link-snapshots$/,
    );
    if (request.method === 'GET' && connectorPendingMatch) {
      const connectorId = connectorPendingMatch[1];
      const authenticated = await authenticateConnector(
        env.DB,
        connectorId,
        request.headers.get('Authorization'),
      );
      if (!authenticated) return json({ error: 'unauthorized' }, 401);
      return json({
        snapshots: await listPendingConnectorLinkSnapshots(
          env.DB,
          connectorId,
        ),
      });
    }

    const connectorSnapshotMatch = url.pathname.match(
      /^\/api\/connectors\/([^/]+)\/captures\/([^/]+)\/snapshot$/,
    );
    if (request.method === 'PUT' && connectorSnapshotMatch) {
      const connectorId = connectorSnapshotMatch[1];
      const authenticated = await authenticateConnector(
        env.DB,
        connectorId,
        request.headers.get('Authorization'),
      );
      if (!authenticated) return json({ error: 'unauthorized' }, 401);
      const messageId = decodeURIComponent(connectorSnapshotMatch[2]);
      const body = await request.json<{
        status?: unknown;
        title?: unknown;
        site?: unknown;
        text?: unknown;
        images?: unknown;
        platform?: unknown;
        mediaType?: unknown;
        durationSeconds?: unknown;
      }>();
      if (body.status === 'failed') {
        const updated = await saveConnectorLinkSnapshot(
          env.DB,
          connectorId,
          messageId,
          { status: 'failed' },
        );
        return updated ? json({ ok: true }) : json({ error: 'not_found' }, 404);
      }
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const site = typeof body.site === 'string' ? body.site.trim() : '';
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const platform =
        body.platform === 'xiaohongshu' ? 'xiaohongshu' : 'web';
      const mediaType =
        body.mediaType === 'video'
          ? 'video'
          : body.mediaType === 'image'
            ? 'image'
            : 'web';
      const durationSeconds =
        typeof body.durationSeconds === 'number' &&
        Number.isFinite(body.durationSeconds) &&
        body.durationSeconds >= 1 &&
        body.durationSeconds <= 6 * 60 * 60
          ? Math.round(body.durationSeconds)
          : null;
      const images =
        mediaType === 'video'
          ? []
          : parseSnapshotImages(body.images, platform);
      if (
        body.status !== 'ready' ||
        !title ||
        title.length > 300 ||
        !site ||
        site.length > 200 ||
        text.length < 80 ||
        text.length > 24_000 ||
        (mediaType === 'video' && durationSeconds === null)
      ) {
        return json({ error: 'invalid_request' }, 400);
      }
      let visualText: string | null = null;
      let visualModel: string | null = null;
      if (env.ZHIPU_API_KEY && images.length > 0) {
        try {
          const visual = await analyzeImagesWithZhipu(env.ZHIPU_API_KEY, {
            title,
            caption: text,
            images,
          });
          visualText = visual.text;
          visualModel = visual.model;
        } catch (error) {
          console.error('Zhipu visual analysis failed', error);
        }
      }
      const updated = await saveConnectorLinkSnapshot(
        env.DB,
        connectorId,
        messageId,
        {
          status: 'ready',
          title,
          site,
          text,
          images,
          visualText,
          visualModel,
          mediaType,
          durationSeconds,
        },
      );
      return updated ? json({ ok: true }) : json({ error: 'not_found' }, 404);
    }

    const connectorProgressMatch = url.pathname.match(
      /^\/api\/connectors\/([^/]+)\/captures\/([^/]+)\/snapshot-progress$/,
    );
    if (request.method === 'PUT' && connectorProgressMatch) {
      const connectorId = connectorProgressMatch[1];
      const authenticated = await authenticateConnector(
        env.DB,
        connectorId,
        request.headers.get('Authorization'),
      );
      if (!authenticated) return json({ error: 'unauthorized' }, 401);
      const messageId = decodeURIComponent(connectorProgressMatch[2]);
      const body = await request.json<{
        stage?: unknown;
        current?: unknown;
        total?: unknown;
        provider?: unknown;
        estimatedCostMicros?: unknown;
        durationSeconds?: unknown;
        costLimitMicros?: unknown;
      }>();
      const stage = body.stage;
      const current =
        typeof body.current === 'number' ? Math.floor(body.current) : -1;
      const total =
        typeof body.total === 'number' ? Math.floor(body.total) : -1;
      const provider =
        typeof body.provider === 'string'
          ? body.provider.trim().slice(0, 100)
          : null;
      const estimatedCostMicros =
        typeof body.estimatedCostMicros === 'number' &&
        Number.isFinite(body.estimatedCostMicros)
          ? Math.round(body.estimatedCostMicros)
          : null;
      const durationSeconds =
        typeof body.durationSeconds === 'number' &&
        Number.isFinite(body.durationSeconds)
          ? Math.round(body.durationSeconds)
          : null;
      const costLimitMicros =
        typeof body.costLimitMicros === 'number' &&
        Number.isFinite(body.costLimitMicros)
          ? Math.round(body.costLimitMicros)
          : null;
      if (
        ![
          'queued',
          'extracting',
          'transcribing',
          'awaiting_approval',
        ].includes(String(stage)) ||
        current < 0 ||
        total < 0 ||
        current > total ||
        total > 10_000 ||
        (estimatedCostMicros !== null &&
          (estimatedCostMicros < 0 || estimatedCostMicros > 100_000_000)) ||
        (costLimitMicros !== null &&
          (costLimitMicros < 0 || costLimitMicros > 100_000_000)) ||
        (durationSeconds !== null &&
          (durationSeconds < 1 || durationSeconds > 6 * 60 * 60))
      ) {
        return json({ error: 'invalid_request' }, 400);
      }
      const updated = await updateConnectorLinkProgress(
        env.DB,
        connectorId,
        messageId,
        {
          stage: stage as
            | 'queued'
            | 'extracting'
            | 'transcribing'
            | 'awaiting_approval',
          current,
          total,
          provider,
          estimatedCostMicros,
          durationSeconds,
          costLimitMicros,
        },
      );
      return updated ? json({ ok: true }) : json({ error: 'not_found' }, 404);
    }

    const deviceMatch = url.pathname.match(
      /^\/api\/devices\/([^/]+)\/(status|inbox|ack|binding-code|reply-mode|processing-links|link-retry|link-approve-cost|organize|link-organize|theme-merge|memory-question|memory-insight)$/,
    );
    if (deviceMatch) {
      const [, deviceId, action] = deviceMatch;
      const authenticated = await authenticateDevice(
        env.DB,
        deviceId,
        request.headers.get('Authorization'),
      );
      if (!authenticated) return json({ error: 'unauthorized' }, 401);

      if (request.method === 'GET' && action === 'status') {
        const status = await deviceStatus(env.DB, deviceId);
        return status
          ? json({
              ...status,
              aiAvailable: Boolean(env.DEEPSEEK_API_KEY),
              visionAvailable: Boolean(env.ZHIPU_API_KEY),
            })
          : json({ error: 'not_found' }, 404);
      }
      if (request.method === 'GET' && action === 'inbox') {
        return json({ messages: await listInbox(env.DB, deviceId) });
      }
      if (request.method === 'GET' && action === 'processing-links') {
        return json({
          links: await listDeviceProcessingLinks(env.DB, deviceId),
        });
      }
      if (request.method === 'POST' && action === 'link-retry') {
        const body = await request.json<{ messageId?: unknown }>();
        const messageId =
          typeof body.messageId === 'string' ? body.messageId.trim() : '';
        if (!messageId || messageId.length > 512) {
          return json({ error: 'invalid_request' }, 400);
        }
        const updated = await retryDeviceProcessingLink(
          env.DB,
          deviceId,
          messageId,
        );
        return updated ? json({ ok: true }) : json({ error: 'not_found' }, 404);
      }
      if (request.method === 'POST' && action === 'link-approve-cost') {
        const body = await request.json<{ messageId?: unknown }>();
        const messageId =
          typeof body.messageId === 'string' ? body.messageId.trim() : '';
        if (!messageId || messageId.length > 512) {
          return json({ error: 'invalid_request' }, 400);
        }
        const updated = await approveDeviceLinkCloudCost(
          env.DB,
          deviceId,
          messageId,
        );
        return updated ? json({ ok: true }) : json({ error: 'not_found' }, 404);
      }
      if (request.method === 'POST' && action === 'ack') {
        const body = await request.json<{ messageIds?: unknown }>();
        const messageIds = Array.isArray(body.messageIds)
          ? body.messageIds.filter(
              (value): value is string => typeof value === 'string',
            )
          : [];
        await acknowledgeInbox(env.DB, deviceId, messageIds);
        return json({ ok: true });
      }
      if (request.method === 'POST' && action === 'binding-code') {
        const binding = await refreshBindingCode(env.DB, deviceId);
        return binding ? json(binding) : json({ error: 'not_found' }, 404);
      }
      if (request.method === 'PUT' && action === 'reply-mode') {
        const body = await request.json<{ replyMode?: unknown }>();
        const replyMode = body.replyMode;
        if (
          replyMode !== 'first' &&
          replyMode !== 'always' &&
          replyMode !== 'silent'
        ) {
          return json({ error: 'invalid_request' }, 400);
        }
        const updated = await updateDeviceReplyMode(
          env.DB,
          deviceId,
          replyMode as ReplyMode,
        );
        return updated
          ? json({ ok: true, replyMode })
          : json({ error: 'connector_not_found' }, 404);
      }
      if (request.method === 'POST' && action === 'organize') {
        if (!env.DEEPSEEK_API_KEY) {
          return json({ error: 'ai_not_configured' }, 503);
        }
        const body = await request.json<{ sources?: unknown }>();
        const sources = parseOrganizeSources(body.sources);
        if (!sources) return json({ error: 'invalid_request' }, 400);
        try {
          return json(await organizeWithDeepSeek(env.DEEPSEEK_API_KEY, sources));
        } catch (error) {
          console.error('DeepSeek organize failed', error);
          return aiErrorResponse(error);
        }
      }
      if (request.method === 'POST' && action === 'link-organize') {
        if (!env.DEEPSEEK_API_KEY) {
          return json({ error: 'ai_not_configured' }, 503);
        }
        const body = await request.json<{
          sourceId?: unknown;
          url?: unknown;
          userContext?: unknown;
          page?: unknown;
        }>();
        const sourceId =
          typeof body.sourceId === 'string' ? body.sourceId.trim() : '';
        const linkUrl = typeof body.url === 'string' ? body.url.trim() : '';
        const userContext =
          typeof body.userContext === 'string' ? body.userContext.trim() : '';
        if (
          !sourceId ||
          sourceId.length > 128 ||
          !linkUrl ||
          linkUrl.length > 2_048 ||
          !isMeaningfulLinkContext(userContext) ||
          userContext.length > 1_000
        ) {
          return json({ error: 'invalid_request' }, 400);
        }
        try {
          const safeUrl = validatePublicLinkUrl(linkUrl);
          const suppliedPage = parseSuppliedLinkPage(body.page);
          const storedPage = await findDeviceLinkSnapshot(
            env.DB,
            deviceId,
            safeUrl.toString(),
          );
          const page = suppliedPage || storedPage
            ? {
                url: safeUrl,
                title: (suppliedPage ?? storedPage)!.title,
                description: '',
                site: (suppliedPage ?? storedPage)!.site,
                text: (suppliedPage ?? storedPage)!.text,
                images: storedPage?.images ?? [],
                visualText: storedPage?.visualText ?? null,
                visualModel: storedPage?.visualModel ?? null,
                mediaType: storedPage?.mediaType ?? 'web',
                durationSeconds: storedPage?.durationSeconds ?? null,
              }
            : {
                ...(await fetchLinkPage(safeUrl)),
                images: [],
                visualText: null,
                visualModel: null,
                mediaType: 'web' as const,
                durationSeconds: null,
              };
          const result = await organizeLinkWithDeepSeek(env.DEEPSEEK_API_KEY, {
            sourceId,
            url: page.url,
            userContext,
            page: {
              title: page.title,
              description: page.description,
              site: page.site,
              text: page.text,
              images: page.images,
              visualText: page.visualText,
              visualModel: page.visualModel,
              mediaType: page.mediaType,
              durationSeconds: page.durationSeconds,
            },
          });
          return json({
            ...result,
            source: {
              url: page.url,
              title: page.title,
              site: page.site,
            },
          });
        } catch (error) {
          console.error('Link organize failed', error);
          if (isAiError(error)) return aiErrorResponse(error);
          return json({ error: 'link_unavailable' }, 502);
        }
      }
      if (request.method === 'POST' && action === 'theme-merge') {
        if (!env.DEEPSEEK_API_KEY) {
          return json({ error: 'ai_not_configured' }, 503);
        }
        const body = await request.json<{
          source?: unknown;
          themes?: unknown;
        }>();
        const source = parseThemeSource(body.source);
        const themes = parseThemeCandidates(body.themes);
        if (!source || !themes) {
          return json({ error: 'invalid_request' }, 400);
        }
        try {
          return json(
            await suggestThemeMergeWithDeepSeek(env.DEEPSEEK_API_KEY, {
              source,
              themes,
            }),
          );
        } catch (error) {
          console.error('Theme merge failed', error);
          return aiErrorResponse(error);
        }
      }
      if (request.method === 'POST' && action === 'memory-question') {
        if (!env.DEEPSEEK_API_KEY) return json({ error: 'ai_not_configured' }, 503);
        const body = await request.json<{ question?: unknown; sources?: unknown }>();
        const question = typeof body.question === 'string' ? body.question.trim().slice(0, 500) : '';
        const sources = parseMemorySources(body.sources);
        if (!question || !sources) return json({ error: 'invalid_request' }, 400);
        try {
          return json(await answerMemoryQuestionWithDeepSeek(env.DEEPSEEK_API_KEY, question, sources));
        } catch (error) {
          console.error('Memory question failed', error);
          return aiErrorResponse(error);
        }
      }
      if (request.method === 'POST' && action === 'memory-insight') {
        if (!env.DEEPSEEK_API_KEY) return json({ error: 'ai_not_configured' }, 503);
        const body = await request.json<{ period?: unknown; periodStart?: unknown; periodEnd?: unknown; sources?: unknown }>();
        const period = body.period === 'week' || body.period === 'month' ? body.period : null;
        const periodStart = typeof body.periodStart === 'string' ? body.periodStart.slice(0, 64) : '';
        const periodEnd = typeof body.periodEnd === 'string' ? body.periodEnd.slice(0, 64) : '';
        const sources = parseMemorySources(body.sources);
        if (!period || !periodStart || !periodEnd || !sources) return json({ error: 'invalid_request' }, 400);
        try {
          return json(await generateMemoryInsightWithDeepSeek(env.DEEPSEEK_API_KEY, { period, periodStart, periodEnd, sources }));
        } catch (error) {
          console.error('Memory insight failed', error);
          return aiErrorResponse(error);
        }
      }
    }

    return json({ error: 'not_found' }, 404);
  },
};

function isAiError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    error instanceof DeepSeekHttpError ||
    (error instanceof Error &&
      (error.name === 'AbortError' ||
        error.message.startsWith('DeepSeek ') ||
        error.message.includes('DeepSeek output') ||
        error.message.includes('DeepSeek returned') ||
        error.message.includes('Citation ') ||
        error.message.includes('Draft ')))
  );
}

function aiErrorResponse(error: unknown): Response {
  if (error instanceof DeepSeekHttpError) {
    if (error.status === 401 || error.status === 403) {
      return json({ error: 'ai_auth_failed' }, 503);
    }
    if (error.status === 429) {
      return json({ error: 'ai_rate_limited' }, 429);
    }
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return json({ error: 'ai_timeout' }, 504);
  }
  return json({ error: 'ai_invalid_response' }, 502);
}

function parseThemeSource(value: unknown) {
  if (!isRecord(value)) return null;
  const id = cleanInputString(value.id, 128);
  const title = cleanInputString(value.title, 120);
  const summary = cleanInputString(value.summary, 500, true);
  const content = cleanInputString(value.content, 12_000);
  const sourceUrl =
    typeof value.sourceUrl === 'string'
      ? cleanInputString(value.sourceUrl, 2_048, true)
      : null;
  if (!id || !title || !content) return null;
  return { id, title, summary, content, sourceUrl: sourceUrl || null };
}

function parseThemeCandidates(value: unknown) {
  if (!Array.isArray(value) || value.length > 12) return null;
  const themes = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const id = cleanInputString(item.id, 128);
    const title = cleanInputString(item.title, 120);
    const summary = cleanInputString(item.summary, 500, true);
    const content = cleanInputString(item.content, 6_000);
    const overview = cleanInputString(item.overview, 5_000, true);
    if (!id || !title || !content) return null;
    themes.push({ id, title, summary, content, overview });
  }
  return themes;
}

function cleanInputString(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned || (allowEmpty ? '' : '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function handleWechatCallback(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const signature = url.searchParams.get('signature') ?? '';
  const timestamp = url.searchParams.get('timestamp') ?? '';
  const nonce = url.searchParams.get('nonce') ?? '';
  const valid = await verifyWechatSignature(
    env.WECHAT_TOKEN,
    timestamp,
    nonce,
    signature,
  );
  await recordCallback(env.DB, request.method, valid, null, 'received');
  if (!valid) return new Response('invalid signature', { status: 401 });

  if (request.method === 'GET') {
    return new Response(url.searchParams.get('echostr') ?? '', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const contentLength = Number(request.headers.get('Content-Length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return new Response('payload too large', { status: 413 });
  }

  const xml = await request.text();
  if (new TextEncoder().encode(xml).byteLength > MAX_BODY_BYTES) {
    return new Response('payload too large', { status: 413 });
  }

  const message = parseWechatMessage(xml);
  await recordCallback(
    env.DB,
    request.method,
    true,
    message.msgType || null,
    'parsed',
  );
  if (!message.fromUserName || !message.toUserName || !message.msgType) {
    return new Response('invalid message', { status: 400 });
  }

  const bindingCode =
    message.msgType === 'text' ? parseBindingCode(message.content) : null;
  if (bindingCode) {
    const bound = await bindWechatOpenId(
      env.DB,
      message.fromUserName,
      bindingCode,
    );
    return wechatReply(
      message,
      bound
        ? 'ReMind 绑定成功。以后把文字或链接发到这里，就会自动记下来。'
        : '绑定码无效或已过期，请在 ReMind 中重新获取。',
    );
  }

  const content = messageContent(message);
  if (!content) {
    return wechatReply(message, '目前先支持文字和链接，图片与语音稍后开放。');
  }

  const inserted = await env.DB
    .prepare(
      `INSERT INTO wechat_messages
        (msg_id, open_id, msg_type, content, source_created_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(msg_id) DO NOTHING`,
    )
    .bind(
      message.msgId,
      message.fromUserName,
      message.msgType,
      content,
      message.createTime,
      new Date().toISOString(),
    )
    .run();

  if (!(await isWechatBound(env.DB, message.fromUserName))) {
    return wechatReply(
      message,
      'ReMind 收到了，但还没有绑定手机。请在 App 中获取 6 位绑定码，再发送“绑定 123456”。',
    );
  }

  return wechatReply(
    message,
    inserted.meta.changes === 0 ? '这条内容之前已经记过了。' : 'ReMind 已记下。',
  );
}

function parseSuppliedLinkPage(value: unknown): {
  title: string;
  site: string;
  text: string;
} | null {
  if (typeof value !== 'object' || value === null) return null;
  const page = value as Record<string, unknown>;
  const title = typeof page.title === 'string' ? page.title.trim() : '';
  const site = typeof page.site === 'string' ? page.site.trim() : '';
  const text = typeof page.text === 'string' ? page.text.trim() : '';
  if (
    !title ||
    title.length > 300 ||
    !site ||
    site.length > 200 ||
    text.length < 80 ||
    text.length > 24_000
  ) {
    return null;
  }
  return { title, site, text };
}

function parseSnapshotImages(
  value: unknown,
  platform: 'web' | 'xiaohongshu',
): string[] {
  if (platform !== 'xiaohongshu' || !Array.isArray(value)) return [];
  const images: string[] = [];
  for (const item of value.slice(0, 12)) {
    if (typeof item !== 'string') continue;
    try {
      const url = new URL(item);
      const hostname = url.hostname.toLowerCase();
      if (
        url.protocol === 'https:' &&
        (hostname === 'xhscdn.com' || hostname.endsWith('.xhscdn.com'))
      ) {
        images.push(url.toString());
      }
    } catch {
      // Ignore malformed media URLs while preserving the text snapshot.
    }
  }
  return [...new Set(images)];
}

async function recordCallback(
  db: D1Database,
  method: string,
  signatureValid: boolean,
  msgType: string | null,
  stage: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO callback_diagnostics
        (id, method, signature_valid, msg_type, stage, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      method,
      signatureValid ? 1 : 0,
      msgType,
      stage,
      new Date().toISOString(),
    )
    .run();
}

function wechatReply(
  message: ReturnType<typeof parseWechatMessage>,
  content: string,
): Response {
  return new Response(textReplyXml(message, content), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function parseOrganizeSources(value: unknown): OrganizeSource[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 80) {
    return null;
  }
  const sources: OrganizeSource[] = [];
  let totalLength = 0;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const source = item as Record<string, unknown>;
    const id = typeof source.id === 'string' ? source.id.trim() : '';
    const content =
      typeof source.content === 'string' ? source.content.trim() : '';
    const createdAt =
      typeof source.createdAt === 'string' ? source.createdAt : '';
    if (
      !id ||
      id.length > 128 ||
      !content ||
      content.length > 10_000 ||
      !Number.isFinite(Date.parse(createdAt))
    ) {
      return null;
    }
    totalLength += content.length;
    if (totalLength > 60_000) return null;
    sources.push({ id, content, createdAt });
  }
  return sources;
}

function parseMemorySources(value: unknown): MemorySource[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) return null;
  const sources: MemorySource[] = [];
  let totalLength = 0;
  for (const item of value) {
    if (!isRecord(item)) return null;
    const id = cleanInputString(item.id, 128);
    const title = cleanInputString(item.title, 160, true);
    const content = cleanInputString(item.content, 3_000);
    const createdAt = cleanInputString(item.createdAt, 64);
    if (!id || !content || !Number.isFinite(Date.parse(createdAt))) return null;
    totalLength += content.length;
    if (totalLength > 75_000) return null;
    sources.push({ id, title, content, createdAt });
  }
  return sources;
}
