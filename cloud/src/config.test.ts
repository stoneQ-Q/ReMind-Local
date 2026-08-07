import { afterEach, describe, expect, it } from 'vitest';

import {
  dashscopeConfig,
  xiaoyuzhouTranscriptionEnabled,
} from './config.js';

const originalValue = process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED;
const originalDashscopeKey = process.env.REMIND_DASHSCOPE_API_KEY;
const originalDashscopeHost = process.env.REMIND_DASHSCOPE_API_HOST;

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED;
  } else {
    process.env.REMIND_XIAOYUZHOU_TRANSCRIPTION_ENABLED = originalValue;
  }
  restoreEnvironment('REMIND_DASHSCOPE_API_KEY', originalDashscopeKey);
  restoreEnvironment('REMIND_DASHSCOPE_API_HOST', originalDashscopeHost);
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
