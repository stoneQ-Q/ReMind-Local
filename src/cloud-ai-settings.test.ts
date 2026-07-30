import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./cloud-auth', () => ({
  clearCloudSession: vi.fn(async () => undefined),
  getCloudAccessToken: vi.fn(async () => 'rms_test_access_token'),
}));

import {
  CloudAiSettingsError,
  deleteCloudAiCredential,
  getCloudAiSettings,
  saveCloudAiCredential,
  updateCloudAiMode,
} from './cloud-ai-settings';
import { clearCloudSession } from './cloud-auth';

const emptySettings = {
  mode: 'disabled',
  credentials: [],
};

beforeEach(() => {
  process.env.EXPO_PUBLIC_REMIND_CLOUD_API_URL =
    'https://api.remind.example';
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_REMIND_CLOUD_API_URL;
  vi.unstubAllGlobals();
});

describe('cloud AI settings client', () => {
  it('loads settings with the cloud session and versioned route', async () => {
    const fetchMock = mockJsonResponse(emptySettings);

    await expect(getCloudAiSettings()).resolves.toEqual(emptySettings);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.remind.example/api/v1/ai/settings',
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer rms_test_access_token');
  });

  it('sends a key only in the credential request and accepts only masked metadata', async () => {
    const settings = {
      mode: 'disabled',
      credentials: [
        {
          provider: 'deepseek',
          maskedSuffix: '8472',
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
      ],
    };
    const fetchMock = mockJsonResponse(settings);

    await expect(
      saveCloudAiCredential('deepseek', 'secret-api-key-8472'),
    ).resolves.toEqual(settings);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.body).toBe(
      JSON.stringify({ apiKey: 'secret-api-key-8472' }),
    );
    expect(JSON.stringify(settings)).not.toContain('secret-api-key-8472');
  });

  it('updates safe modes and deletes individual credentials', async () => {
    const fetchMock = mockJsonResponse(emptySettings);

    await updateCloudAiMode('disabled');
    await deleteCloudAiCredential('zhipu');

    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ mode: 'disabled' }),
      }),
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('returns a stable server error code without response secrets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'invalid_api_credential' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(
      saveCloudAiCredential('deepseek', 'short'),
    ).rejects.toMatchObject({
      code: 'invalid_api_credential',
      status: 400,
    } satisfies Partial<CloudAiSettingsError>);
  });

  it('clears an expired cloud session after an unauthorized response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(getCloudAiSettings()).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
    expect(clearCloudSession).toHaveBeenCalled();
  });
});

function mockJsonResponse(payload: unknown) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
