import { describe, expect, it } from 'vitest';

import { splitOriginalEvidenceMarkdown } from './evidence-markdown';

describe('splitOriginalEvidenceMarkdown', () => {
  it('separates accepted link evidence from the main note', () => {
    expect(
      splitOriginalEvidenceMarkdown(
        '# 结论\n\n正文\n\n## 原始证据\n\n### 证据 1\n\n> 第一段\n\n### 证据 2\n\n> 第二段',
      ),
    ).toEqual({
      body: '# 结论\n\n正文',
      evidence: '### 证据 1\n\n> 第一段\n\n### 证据 2\n\n> 第二段',
      evidenceCount: 2,
    });
  });

  it('does not fold daily source records or ordinary headings', () => {
    expect(
      splitOriginalEvidenceMarkdown('正文\n\n## 来源记录\n\n记录一'),
    ).toBeNull();
    expect(splitOriginalEvidenceMarkdown('正文')).toBeNull();
  });

  it('supports a heading at the beginning and Windows line endings', () => {
    expect(
      splitOriginalEvidenceMarkdown(
        '## 原始证据\r\n\r\n### 证据 1\r\n\r\n> 引用',
      ),
    ).toEqual({
      body: '',
      evidence: '### 证据 1\n\n> 引用',
      evidenceCount: 1,
    });
  });
});
