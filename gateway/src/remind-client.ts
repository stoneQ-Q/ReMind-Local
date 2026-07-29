export type ConnectorCredentials = {
  connectorId: string;
  connectorSecret: string;
  kind: 'weixin-ilink';
};

type Capture = {
  externalId: string;
  type: 'text' | 'voice' | 'link';
  content: string;
  createdAt: string;
};

export type LinkSnapshot = {
  title: string;
  site: string;
  text: string;
  images: string[];
  platform: 'web' | 'xiaohongshu';
  mediaType: 'web' | 'image' | 'video';
  durationSeconds: number | null;
  transientVideoUrl?: string;
};

export type PendingLinkSnapshot = {
  messageId: string;
  url: string;
  userContext: string;
  cloudCostApproved: boolean;
};

type CaptureResult = {
  inserted: boolean;
  replyMode: 'first' | 'always' | 'silent';
  shouldReply: boolean;
  replyText: string | null;
  linkSnapshot?: {
    messageId: string;
    url: string;
    userContext: string;
  };
};

async function apiRequest(
  url: string,
  init: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function pairConnector(
  apiBaseUrl: string,
  bindingCode: string,
): Promise<ConnectorCredentials> {
  const response = await apiRequest(`${trimUrl(apiBaseUrl)}/api/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bindingCode, kind: 'weixin-ilink' }),
  });
  if (!response.ok) {
    throw new Error(`ReMind 配对失败：${await response.text()}`);
  }
  return (await response.json()) as ConnectorCredentials;
}

export async function captureMessage(
  apiBaseUrl: string,
  credentials: ConnectorCredentials,
  capture: Capture,
): Promise<CaptureResult> {
  const response = await apiRequest(
    `${trimUrl(apiBaseUrl)}/api/connectors/${encodeURIComponent(
      credentials.connectorId,
    )}/captures`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.connectorSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(capture),
    },
  );
  if (!response.ok) {
    throw new Error(`ReMind 写入失败：${await response.text()}`);
  }
  return (await response.json()) as CaptureResult;
}

export async function uploadLinkSnapshot(
  apiBaseUrl: string,
  credentials: ConnectorCredentials,
  messageId: string,
  snapshot: LinkSnapshot | null,
): Promise<void> {
  const persistentSnapshot = snapshot
    ? {
        status: 'ready',
        title: snapshot.title,
        site: snapshot.site,
        text: snapshot.text,
        images: snapshot.images,
        platform: snapshot.platform,
        mediaType: snapshot.mediaType,
        durationSeconds: snapshot.durationSeconds,
      }
    : { status: 'failed' };
  const response = await apiRequest(
    `${trimUrl(apiBaseUrl)}/api/connectors/${encodeURIComponent(
      credentials.connectorId,
    )}/captures/${encodeURIComponent(messageId)}/snapshot`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${credentials.connectorSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(persistentSnapshot),
    },
    60_000,
  );
  if (!response.ok) {
    throw new Error(`链接正文上传失败：${await response.text()}`);
  }
}

export async function updateLinkSnapshotProgress(
  apiBaseUrl: string,
  credentials: ConnectorCredentials,
  messageId: string,
  progress: {
    stage: 'queued' | 'extracting' | 'transcribing' | 'awaiting_approval';
    current: number;
    total: number;
    provider: string;
    estimatedCostMicros: number | null;
    durationSeconds: number | null;
    costLimitMicros: number | null;
  },
): Promise<void> {
  const response = await apiRequest(
    `${trimUrl(apiBaseUrl)}/api/connectors/${encodeURIComponent(
      credentials.connectorId,
    )}/captures/${encodeURIComponent(messageId)}/snapshot-progress`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${credentials.connectorSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(progress),
    },
  );
  if (!response.ok) {
    throw new Error(`视频进度上传失败：${await response.text()}`);
  }
}

export async function updateConnectorRuntimeStatus(
  apiBaseUrl: string,
  credentials: ConnectorCredentials,
  status: {
    localWhisperAvailable: boolean;
  },
): Promise<void> {
  const response = await apiRequest(
    `${trimUrl(apiBaseUrl)}/api/connectors/${encodeURIComponent(
      credentials.connectorId,
    )}/runtime-status`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${credentials.connectorSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(status),
    },
  );
  if (!response.ok) {
    throw new Error(`网关状态上报失败：${await response.text()}`);
  }
}

export async function transcribeAudioChunk(
  apiBaseUrl: string,
  credentials: ConnectorCredentials,
  audio: Uint8Array,
): Promise<string> {
  const response = await apiRequest(
    `${trimUrl(apiBaseUrl)}/api/connectors/${encodeURIComponent(
      credentials.connectorId,
    )}/audio-transcriptions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.connectorSecret}`,
        'Content-Type': 'audio/mpeg',
      },
      body: new Blob([Uint8Array.from(audio).buffer], { type: 'audio/mpeg' }),
    },
    75_000,
  );
  if (!response.ok) {
    throw new Error(`音频转写失败：${await response.text()}`);
  }
  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload.text !== 'string' || !payload.text.trim()) {
    throw new Error('音频转写没有返回文字');
  }
  return payload.text.trim();
}

export async function listPendingLinkSnapshots(
  apiBaseUrl: string,
  credentials: ConnectorCredentials,
): Promise<PendingLinkSnapshot[]> {
  const response = await apiRequest(
    `${trimUrl(apiBaseUrl)}/api/connectors/${encodeURIComponent(
      credentials.connectorId,
    )}/pending-link-snapshots`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credentials.connectorSecret}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`待处理链接读取失败：${await response.text()}`);
  }
  const payload = (await response.json()) as {
    snapshots?: PendingLinkSnapshot[];
  };
  return Array.isArray(payload.snapshots) ? payload.snapshots : [];
}

function trimUrl(value: string): string {
  return value.replace(/\/+$/, '');
}
