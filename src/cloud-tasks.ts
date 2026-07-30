import {
  CloudApiRequestError,
  requestCloudJson,
} from './cloud-api';

export type CloudMediaKind = 'image' | 'audio' | 'video';
export type CloudMediaTaskStatus =
  | 'awaiting_confirmation'
  | 'pending'
  | 'processing'
  | 'settling'
  | 'releasing'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type CloudJobStatus =
  | 'queued'
  | 'reserved'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type CloudMediaRequest = {
  id: string;
  sourceFileId: string;
  mediaKind: CloudMediaKind;
  status: CloudMediaTaskStatus;
  executionMode: 'bring_your_own_key' | 'managed';
  stage: string;
  currentJobId: string | null;
  billingJobId: string | null;
  durationSeconds: number | null;
  estimatedCostMicros: string;
  actualCostMicros: string;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CloudJobQuote = {
  jobId: string;
  type: string;
  provider: string;
  status: CloudJobStatus;
  estimatedCostMicros: string;
  confirmationRequired: boolean;
  confirmedAt: string | null;
  expiresAt: string;
};

export type CloudMediaTask = {
  request: CloudMediaRequest;
  quote: CloudJobQuote | null;
  currentJob: CloudJobSnapshot | null;
};

export type CloudJobSnapshot = {
  id: string;
  type: string;
  status: CloudJobStatus;
  attemptCount: number;
  maxAttempts: number;
  timeoutSeconds: number;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function listCloudMediaTasks(): Promise<CloudMediaTask[]> {
  const payload = await requestCloudJson('media/requests');
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.items) ||
    payload.items.length > 50 ||
    !payload.items.every(isMediaTask)
  ) {
    throw new CloudApiRequestError('invalid_media_tasks_response');
  }
  return payload.items;
}

export async function confirmCloudMediaTask(
  jobId: string,
): Promise<CloudJobQuote> {
  const payload = await requestCloudJson(
    `jobs/${encodeURIComponent(jobId)}/confirm`,
    { method: 'POST' },
  );
  if (!isRecord(payload) || !isJobQuote(payload.quote)) {
    throw new CloudApiRequestError('invalid_job_confirmation_response');
  }
  return payload.quote;
}

export async function cancelCloudMediaTask(
  requestId: string,
): Promise<CloudMediaRequest> {
  const payload = await requestCloudJson(
    `media/requests/${encodeURIComponent(requestId)}/cancel`,
    { method: 'POST' },
  );
  if (!isMediaRequest(payload)) {
    throw new CloudApiRequestError('invalid_media_cancellation_response');
  }
  return payload;
}

export function isCloudMediaTaskActive(task: CloudMediaTask): boolean {
  return !(
    task.request.status === 'succeeded' ||
    task.request.status === 'failed' ||
    task.request.status === 'cancelled'
  );
}

export { CloudApiRequestError as CloudTaskError };

function isMediaTask(value: unknown): value is CloudMediaTask {
  return (
    isRecord(value) &&
    isMediaRequest(value.request) &&
    (value.quote === null || isJobQuote(value.quote)) &&
    (value.currentJob === null || isJobSnapshot(value.currentJob))
  );
}

function isMediaRequest(value: unknown): value is CloudMediaRequest {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.sourceFileId === 'string' &&
    isMediaKind(value.mediaKind) &&
    isMediaTaskStatus(value.status) &&
    (value.executionMode === 'bring_your_own_key' ||
      value.executionMode === 'managed') &&
    typeof value.stage === 'string' &&
    (typeof value.currentJobId === 'string' || value.currentJobId === null) &&
    (typeof value.billingJobId === 'string' || value.billingJobId === null) &&
    (typeof value.durationSeconds === 'number' ||
      value.durationSeconds === null) &&
    isNonnegativeInteger(value.estimatedCostMicros) &&
    isNonnegativeInteger(value.actualCostMicros) &&
    (typeof value.errorCode === 'string' || value.errorCode === null) &&
    isIsoTime(value.createdAt) &&
    isIsoTime(value.updatedAt)
  );
}

function isJobQuote(value: unknown): value is CloudJobQuote {
  return (
    isRecord(value) &&
    typeof value.jobId === 'string' &&
    typeof value.type === 'string' &&
    typeof value.provider === 'string' &&
    isJobStatus(value.status) &&
    isNonnegativeInteger(value.estimatedCostMicros) &&
    typeof value.confirmationRequired === 'boolean' &&
    (isIsoTime(value.confirmedAt) || value.confirmedAt === null) &&
    isIsoTime(value.expiresAt)
  );
}

function isJobSnapshot(value: unknown): value is CloudJobSnapshot {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    isJobStatus(value.status) &&
    Number.isInteger(value.attemptCount) &&
    Number(value.attemptCount) >= 0 &&
    Number.isInteger(value.maxAttempts) &&
    Number(value.maxAttempts) >= 1 &&
    Number.isInteger(value.timeoutSeconds) &&
    Number(value.timeoutSeconds) >= 1 &&
    (isIsoTime(value.cancelRequestedAt) ||
      value.cancelRequestedAt === null) &&
    isIsoTime(value.createdAt) &&
    isIsoTime(value.updatedAt)
  );
}

function isMediaKind(value: unknown): value is CloudMediaKind {
  return value === 'image' || value === 'audio' || value === 'video';
}

function isMediaTaskStatus(value: unknown): value is CloudMediaTaskStatus {
  return (
    value === 'awaiting_confirmation' ||
    value === 'pending' ||
    value === 'processing' ||
    value === 'settling' ||
    value === 'releasing' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}

function isJobStatus(value: unknown): value is CloudJobStatus {
  return (
    value === 'queued' ||
    value === 'reserved' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}

function isNonnegativeInteger(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value);
}

function isIsoTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
