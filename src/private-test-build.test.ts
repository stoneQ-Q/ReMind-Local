import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const PRIVATE_TEST_CLOUD_URL =
  'https://remind.43-129-237-189.sslip.io';

describe('private test build configuration', () => {
  it('keeps local mode available and adds the HTTPS cloud endpoint', async () => {
    const easConfig = JSON.parse(
      await readFile(join(process.cwd(), 'eas.json'), 'utf8'),
    ) as {
      build: {
        preview: {
          distribution: string;
          environment: string;
          env: Record<string, string>;
          android: { buildType: string };
        };
      };
    };

    const preview = easConfig.build.preview;

    expect(preview.distribution).toBe('internal');
    expect(preview.environment).toBe('preview');
    expect(preview.android.buildType).toBe('apk');
    expect(preview.env.EXPO_PUBLIC_REMIND_LOCAL_API_URL).toMatch(
      /^http:\/\/.+/,
    );
    expect(preview.env.EXPO_PUBLIC_REMIND_CLOUD_API_URL).toBe(
      PRIVATE_TEST_CLOUD_URL,
    );
  });

  it('does not pin the temporary private-test domain in production', async () => {
    const easConfigText = await readFile(
      join(process.cwd(), 'eas.json'),
      'utf8',
    );
    const easConfig = JSON.parse(easConfigText) as {
      build: {
        production: {
          env?: Record<string, string>;
        };
      };
    };

    expect(
      easConfig.build.production.env?.EXPO_PUBLIC_REMIND_CLOUD_API_URL,
    ).not.toBe(PRIVATE_TEST_CLOUD_URL);
  });
});
