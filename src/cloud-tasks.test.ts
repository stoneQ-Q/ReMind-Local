import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./cloud-api', () => ({
  CloudApiRequestError: class CloudApiRequestError extends Error {
    constructor(
      readonly code: string,
      readonly status?: number,
    ) {
      super(code);
    }
  },
  requestCloudJson: vi.fn(),
}));

import { requestCloudJson } from './cloud-api';
import {
  cancelCloudMediaTask,
  confirmCloudMediaTask,
  isCloudMediaTaskActive,
  listCloudMediaTasks,
  type CloudMediaTask,
} from './cloud-tasks';

const request = {
  id: 'request-1',
  sourceFileId: 'file-1',
  mediaKind: 'video',
  status: 'awaiting_confirmation',
  executionMode: 'managed',
  stage: 'video_prepare',
  currentJobId: null,
  billingJobId: 'job-1',
  durationSeconds: 60,
  estimatedCostMicros: '3200000',
  actualCostMicros: '0',
  errorCode: null,
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
} as const;

const quote = {
  jobId: 'job-1',
  type: 'media.pipeline',
  provider: 'zhipu',
  status: 'queued',
  estimatedCostMicros: '3200000',
  confirmationRequired: true,
  confirmedAt: null,
  expiresAt: '2026-07-30T00:15:00.000Z',
} as const;

afterEach(() => {
  vi.clearAllMocks();
});

describe('cloud media task client', () => {
  it('loads a bounded task list with its server quote', async () => {
    vi.mocked(requestCloudJson).mockResolvedValue({
      items: [{ request, quote, currentJob: null }],
    });

    await expect(listCloudMediaTasks()).resolves.toEqual([
      { request, quote, currentJob: null },
    ]);
    expect(requestCloudJson).toHaveBeenCalledWith('media/requests');
  });

  it('confirms only through the explicit job confirmation endpoint', async () => {
    vi.mocked(requestCloudJson).mockResolvedValue({
      quote: { ...quote, status: 'reserved', confirmedAt: '2026-07-30T00:01:00.000Z' },
      account: {},
    });

    await expect(confirmCloudMediaTask('job-1')).resolves.toMatchObject({
      jobId: 'job-1',
      status: 'reserved',
    });
    expect(requestCloudJson).toHaveBeenCalledWith('jobs/job-1/confirm', {
      method: 'POST',
    });
  });

  it('cancels the media request rather than only hiding it in the app', async () => {
    vi.mocked(requestCloudJson).mockResolvedValue({
      ...request,
      status: 'releasing',
    });

    await expect(cancelCloudMediaTask('request-1')).resolves.toMatchObject({
      id: 'request-1',
      status: 'releasing',
    });
    expect(requestCloudJson).toHaveBeenCalledWith(
      'media/requests/request-1/cancel',
      { method: 'POST' },
    );
  });

  it('rejects malformed cost values and recognizes terminal tasks', async () => {
    vi.mocked(requestCloudJson).mockResolvedValue({
      items: [
        {
          request: { ...request, estimatedCostMicros: '3.2' },
          quote,
          currentJob: null,
        },
      ],
    });
    await expect(listCloudMediaTasks()).rejects.toThrow(
      'invalid_media_tasks_response',
    );

    expect(
      isCloudMediaTaskActive({
        request: { ...request, status: 'succeeded' },
        quote,
        currentJob: null,
      } as CloudMediaTask),
    ).toBe(false);
  });

  it('accepts bounded retry progress from the current worker job', async () => {
    const currentJob = {
      id: 'job-stage-1',
      type: 'ai.transcription',
      status: 'running',
      attemptCount: 2,
      maxAttempts: 3,
      timeoutSeconds: 180,
      cancelRequestedAt: null,
      createdAt: '2026-07-30T00:02:00.000Z',
      updatedAt: '2026-07-30T00:03:00.000Z',
    } as const;
    vi.mocked(requestCloudJson).mockResolvedValue({
      items: [
        {
          request: {
            ...request,
            status: 'processing',
            currentJobId: currentJob.id,
          },
          quote: { ...quote, status: 'reserved' },
          currentJob,
        },
      ],
    });

    await expect(listCloudMediaTasks()).resolves.toMatchObject([
      { currentJob: { attemptCount: 2, maxAttempts: 3 } },
    ]);
  });
});
