import { describe, expect, it, vi } from 'vitest';

import { runSingleWechatSync } from './wechat-sync-guard';

describe('WeChat sync guard', () => {
  it('shares one active sync for the same database', async () => {
    const database = {};
    let finish!: (value: number) => void;
    const sync = vi.fn(
      () => new Promise<number>((resolve) => {
        finish = resolve;
      }),
    );

    const first = runSingleWechatSync(database, sync);
    const second = runSingleWechatSync(database, sync);

    expect(sync).toHaveBeenCalledTimes(1);
    finish(3);
    await expect(Promise.all([first, second])).resolves.toEqual([3, 3]);
  });

  it('allows a later sync after the active sync finishes', async () => {
    const database = {};
    const sync = vi.fn(async () => 1);

    await runSingleWechatSync(database, sync);
    await runSingleWechatSync(database, sync);

    expect(sync).toHaveBeenCalledTimes(2);
  });
});
