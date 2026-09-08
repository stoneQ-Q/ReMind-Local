import type { Note } from './types';

export type CloudTranscriptPresentation = {
  title: string;
  detail: string;
};

export function cloudTranscriptPresentation(
  note: Pick<Note, 'recordType' | 'sourcePageSite' | 'sourcePageText'> | null,
): CloudTranscriptPresentation | null {
  if (note?.recordType !== 'capture' || !note.sourcePageText?.trim()) return null;
  if (
    note.sourcePageSite === 'xiaoyuzhoufm.com' &&
    note.sourcePageText.includes('音频转写')
  ) {
    return {
      title: '云端逐字稿已就绪',
      detail: '供 AI 整理时引用 · 原文不下载到手机 · 未保存音频',
    };
  }
  if (
    note.sourcePageSite === 'bilibili.com' &&
    note.sourcePageText.includes('视频语音转写')
  ) {
    return {
      title: 'B 站视频逐字稿已就绪',
      detail: '供 AI 整理时引用 · 已提取视频语音 · 未保存视频',
    };
  }
  return null;
}
