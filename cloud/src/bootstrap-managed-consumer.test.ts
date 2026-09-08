import { describe, expect, it } from 'vitest';

import { upsertEnvironmentLines } from './bootstrap-managed-consumer.js';

describe('managed consumer operator environment update', () => {
  it('replaces known values, preserves unrelated lines, and appends missing values', () => {
    expect(
      upsertEnvironmentLines(
        'REMIND_MEDIA_PROVIDER=byok\nREMIND_CONSUMER_MANAGED_AI_ENABLED=false\n',
        {
          REMIND_CONSUMER_MANAGED_AI_ENABLED: 'true',
          REMIND_MANAGED_DEEPSEEK_API_KEY: 'sk-private_1234567890',
        },
      ),
    ).toBe(
      'REMIND_MEDIA_PROVIDER=byok\nREMIND_CONSUMER_MANAGED_AI_ENABLED=true\nREMIND_MANAGED_DEEPSEEK_API_KEY=sk-private_1234567890\n',
    );
  });

  it('rejects values that could change the environment file structure', () => {
    expect(() =>
      upsertEnvironmentLines('', {
        REMIND_MANAGED_DEEPSEEK_API_KEY: 'sk-safe\nREMIND_MEDIA_PROVIDER=remote',
      }),
    ).toThrow('unsupported environment characters');
  });

  it('rejects duplicate managed settings instead of leaving a stale value', () => {
    expect(() =>
      upsertEnvironmentLines(
        'REMIND_CONSUMER_MANAGED_AI_ENABLED=false\nREMIND_CONSUMER_MANAGED_AI_ENABLED=false\n',
        { REMIND_CONSUMER_MANAGED_AI_ENABLED: 'true' },
      ),
    ).toThrow('Duplicate managed environment setting');
  });
});
