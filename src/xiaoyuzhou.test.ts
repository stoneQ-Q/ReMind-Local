import { describe, expect, it } from 'vitest';

import {
  organizationContextForXiaoyuzhou,
  XIAOYUZHOU_INSIGHT_PROMPT,
} from './xiaoyuzhou';

describe('organizationContextForXiaoyuzhou', () => {
  it('adds the default insight request after transcription completes', () => {
    expect(
      organizationContextForXiaoyuzhou({
        sourceUrl: 'https://www.xiaoyuzhoufm.com/episode/example',
        sourcePageText: '节目介绍\n\n音频转写\n[00:00:10] 示例内容',
        userContext: null,
      }),
    ).toBe(XIAOYUZHOU_INSIGHT_PROMPT);
  });

  it('preserves the user request when one was supplied', () => {
    expect(
      organizationContextForXiaoyuzhou({
        sourceUrl: 'https://www.xiaoyuzhoufm.com/episode/example',
        sourcePageText: '音频转写\n内容',
        userContext: '重点关注产品设计',
      }),
    ).toBe('重点关注产品设计');
  });

  it('upgrades the earlier short default request', () => {
    expect(
      organizationContextForXiaoyuzhou({
        sourceUrl: 'https://www.xiaoyuzhoufm.com/episode/example',
        sourcePageText: '音频转写\n内容',
        userContext:
          '请把这期播客整理成一篇便于阅读的洞察笔记：先用一两句话说明这期究竟讲了什么，再提炼内容地图、核心观点、重要案例和真正值得关注的启发；合并重复表达，不要输出逐字稿，并尽量保留可追溯的时间戳证据。',
      }),
    ).toBe(XIAOYUZHOU_INSIGHT_PROMPT);
  });

  it('does not auto-organize ordinary links', () => {
    expect(
      organizationContextForXiaoyuzhou({
        sourceUrl: 'https://example.com/article',
        sourcePageText: '音频转写\n内容',
        userContext: null,
      }),
    ).toBeNull();
  });
});
