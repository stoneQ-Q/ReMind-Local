import { describe, expect, it } from 'vitest';

import { withoutInternalEvidenceMarkers } from './insight-markdown';

describe('withoutInternalEvidenceMarkers', () => {
  it('removes evidence ids and timestamps from generated prose', () => {
    expect(
      withoutInternalEvidenceMarkers(
        '## 核心观点\n\n换圈子能改变信息环境（E37 · 37:53）。\n\n行动比等待更重要 [00:42:18]。',
      ),
    ).toBe('## 核心观点\n\n换圈子能改变信息环境。\n\n行动比等待更重要。');
  });

  it('removes compact evidence markers such as E37:53', () => {
    expect(withoutInternalEvidenceMarkers('核心判断 E37：53，接着说明原因。')).toBe(
      '核心判断，接着说明原因。',
    );
  });

  it('preserves ordinary numbers in prose', () => {
    expect(withoutInternalEvidenceMarkers('收入提升了 37%，经过 3 个阶段。')).toBe(
      '收入提升了 37%，经过 3 个阶段。',
    );
  });
});
