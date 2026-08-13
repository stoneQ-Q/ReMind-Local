import { describe, expect, it, vi } from 'vitest';

import {
  createLinkOrganizationJob,
  getLinkOrganizationJob,
  LINK_ORGANIZATION_JOB_TYPE,
} from './organization-jobs.js';

describe('link organization jobs', () => {
  it('creates an idempotent background job with a bounded timeout', async () => {
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes('INSERT INTO jobs')) {
        expect(sql).toContain('max_attempts, timeout_seconds');
        expect(sql).toContain('2, 180');
        expect(values[0]).toBe('user-1');
        expect(values[1]).toBe(LINK_ORGANIZATION_JOB_TYPE);
        expect(values[2]).toBe('organization.link:request-123');
        return { rows: [{ id: 'job-1' }] };
      }
      expect(sql).toContain('WHERE user_id = $1 AND id = $2 AND type = $3');
      return {
        rows: [
          {
            id: 'job-1',
            status: 'queued',
            result_json: null,
            error_code: null,
            attempt_count: 0,
            max_attempts: 2,
            created_at: new Date('2026-08-13T10:00:00.000Z'),
            updated_at: new Date('2026-08-13T10:00:00.000Z'),
          },
        ],
      };
    });

    await expect(
      createLinkOrganizationJob(
        { query } as never,
        'user-1',
        'request-123',
        { sourceId: 'note-1', url: 'https://example.com', userContext: '以后参考' },
      ),
    ).resolves.toMatchObject({ id: 'job-1', status: 'queued' });
  });

  it('reads a result only inside the authenticated user boundary', async () => {
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      expect(sql).toContain('WHERE user_id = $1 AND id = $2 AND type = $3');
      expect(values).toEqual(['user-2', 'job-2', LINK_ORGANIZATION_JOB_TYPE]);
      return { rows: [] };
    });
    await expect(
      getLinkOrganizationJob({ query } as never, 'user-2', 'job-2'),
    ).resolves.toBeNull();
  });
});
