import { describe, expect, it } from 'vitest';

import {
  isCancelLinkIntent,
  isMeaningfulLinkContext,
  parseLinkInput,
} from '../src/link';

describe('parseLinkInput', () => {
  it('extracts a URL and the user context from one message', () => {
    expect(
      parseLinkInput(
        'https://example.com/article\n这篇文章可以用于 ReMind 的链接整理设计。',
      ),
    ).toEqual({
      url: 'https://example.com/article',
      userContext: '这篇文章可以用于 ReMind 的链接整理设计。',
      urlCount: 1,
    });
  });

  it('accepts context before the URL and trims punctuation', () => {
    expect(
      parseLinkInput('重点看个人记忆部分：https://example.com/post。'),
    ).toEqual({
      url: 'https://example.com/post',
      userContext: '重点看个人记忆部分',
      urlCount: 1,
    });
  });

  it('detects multiple URLs', () => {
    expect(
      parseLinkInput('https://one.example https://two.example'),
    )?.toMatchObject({ urlCount: 2 });
  });
});

describe('link intent helpers', () => {
  it('requires more than a vague acknowledgement', () => {
    expect(isMeaningfulLinkContext('好')).toBe(false);
    expect(isMeaningfulLinkContext('重点看产品设计')).toBe(true);
  });

  it('recognizes cancel commands', () => {
    expect(isCancelLinkIntent('取消')).toBe(true);
    expect(isCancelLinkIntent('继续')).toBe(false);
  });
});
