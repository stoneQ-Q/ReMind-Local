import { afterEach, describe, expect, it } from 'vitest';

import {
  consumerManagedAiEnabled,
  consumerStarterCreditMicros,
  dashscopeConfig,
  releaseIdentifier,
  serverWhisperUserIds,
  xiaoyuzhouTranscriptionEnabled,
} from './config.js';

const originalValue = process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED;
const originalDashscopeKey = process.env.REMIND_DASHSCOPE_API_KEY;
const originalDashscopeHost = process.env.REMIND_DASHSCOPE_API_HOST;
const originalRelease = process.env.REMIND_RELEASE;
const originalManagedConsumer = process.env.REMIND_CONSUMER_MANAGED_AI_ENABLED;
const originalStarterCredit =
  process.env.REMIND_CONSUMER_STARTER_CREDIT_MICROS;
const originalServerWhisperUsers =
  process.env.REMIND_SERVER_WHISPER_USER_IDS;

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED;
  } else {
    process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED = originalValue;
  }
  restoreEnvironment('REMIND_DASHSCOPE_API_KEY', originalDashscopeKey);
  restoreEnvironment('REMIND_DASHSCOPE_API_HOST', originalDashscopeHost);
  restoreEnvironment('REMIND_RELEASE', originalRelease);
  restoreEnvironment(
    'REMIND_CONSUMER_MANAGED_AI_ENABLED',
    originalManagedConsumer,
  );
  restoreEnvironment(
    'REMIND_CONSUMER_STARTER_CREDIT_MICROS',
    originalStarterCredit,
  );
  restoreEnvironment(
    'REMIND_SERVER_WHISPER_USER_IDS',
    originalServerWhisperUsers,
  );
});

describe('serverWhisperUserIds', () => {
  it('is empty by default and accepts an explicit UUID allowlist', () => {
    delete process.env.REMIND_SERVER_WHISPER_USER_IDS;
    expect([...serverWhisperUserIds()]).toEqual([]);

    process.env.REMIND_SERVER_WHISPER_USER_IDS =
      '11111111-1111-4111-8111-111111111111';
    expect([...serverWhisperUserIds()]).toEqual([
      '11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('rejects a malformed allowlist instead of widening access', () => {
    process.env.REMIND_SERVER_WHISPER_USER_IDS = 'everyone';
    expect(() => serverWhisperUserIds()).toThrow(
      'REMIND_SERVER_WHISPER_USER_IDS must contain UUIDs',
    );
  });
});

describe('consumer managed AI', () => {
  it('stays disabled with no accidental starter spend by default', () => {
    delete process.env.REMIND_CONSUMER_MANAGED_AI_ENABLED;
    delete process.env.REMIND_CONSUMER_STARTER_CREDIT_MICROS;

    expect(consumerManagedAiEnabled()).toBe(false);
    expect(consumerStarterCreditMicros()).toBe(0n);
  });

  it('requires explicit enablement and an integer starter credit', () => {
    process.env.REMIND_CONSUMER_MANAGED_AI_ENABLED = 'true';
    process.env.REMIND_CONSUMER_STARTER_CREDIT_MICROS = '2000000';

    expect(consumerManagedAiEnabled()).toBe(true);
    expect(consumerStarterCreditMicros()).toBe(2_000_000n);
  });

  it('rejects ambiguous public launch configuration', () => {
    process.env.REMIND_CONSUMER_MANAGED_AI_ENABLED = 'yes';
    process.env.REMIND_CONSUMER_STARTER_CREDIT_MICROS = '-1';

    expect(() => consumerManagedAiEnabled()).toThrow('must be true or false');
    expect(() => consumerStarterCreditMicros()).toThrow(
      'must be a nonnegative integer',
    );
  });
});

describe('releaseIdentifier', () => {
  it('returns only a safe public identifier', () => {
    process.env.REMIND_RELEASE = 'e73180f';
    expect(releaseIdentifier()).toBe('e73180f');
    process.env.REMIND_RELEASE = 'unsafe value with spaces';
    expect(releaseIdentifier()).toBe('unknown');
  });
});

describe('dashscopeConfig', () => {
  it('is absent when no credentials are configured', () => {
    delete process.env.REMIND_DASHSCOPE_API_KEY;
    delete process.env.REMIND_DASHSCOPE_API_HOST;

    expect(dashscopeConfig()).toBeNull();
  });

  it('loads the key and API host together', () => {
    process.env.REMIND_DASHSCOPE_API_KEY = 'sk-example-secret-value';
    process.env.REMIND_DASHSCOPE_API_HOST =
      'workspace.cn-beijing.maas.aliyuncs.com';

    expect(dashscopeConfig()).toEqual({
      apiKey: 'sk-example-secret-value',
      apiHost: 'workspace.cn-beijing.maas.aliyuncs.com',
    });
  });

  it('rejects partial DashScope configuration', () => {
    process.env.REMIND_DASHSCOPE_API_KEY = 'sk-example-secret-value';
    delete process.env.REMIND_DASHSCOPE_API_HOST;

    expect(() => dashscopeConfig()).toThrow(
      'REMIND_DASHSCOPE_API_KEY and REMIND_DASHSCOPE_API_HOST must be configured together',
    );
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('xiaoyuzhouTranscriptionEnabled', () => {
  it('is paused by default', () => {
    delete process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED;

    expect(xiaoyuzhouTranscriptionEnabled()).toBe(false);
  });

  it('can be explicitly enabled', () => {
    process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED = 'true';

    expect(xiaoyuzhouTranscriptionEnabled()).toBe(true);
  });

  it('rejects ambiguous values', () => {
    process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED = 'yes';

    expect(() => xiaoyuzhouTranscriptionEnabled()).toThrow(
      'REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED must be true or false',
    );
  });
});
