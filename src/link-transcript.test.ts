import { describe, expect, it } from 'vitest';

import { cloudTranscriptPresentation } from './link-transcript';

describe('cloud transcript presentation', () => {
  it('shows a visible ready state for Bilibili video transcripts', () => {
    expect(
      cloudTranscriptPresentation({
        recordType: 'capture',
        sourcePageSite: 'bilibili.com',
        sourcePageText: '视频语音转写\n[00:00] 建立系统，而非追求目标。',
      }),
    ).toEqual({
      title: 'B 站视频逐字稿已就绪',
      detail: '供 AI 整理时引用 · 已提取视频语音 · 未保存视频',
    });
  });

  it('does not claim readiness for metadata without a transcript', () => {
    expect(
      cloudTranscriptPresentation({
        recordType: 'capture',
        sourcePageSite: 'bilibili.com',
        sourcePageText: 'UP主：示例',
      }),
    ).toBeNull();
  });
});
