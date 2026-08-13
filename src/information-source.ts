import type { Note } from './types';

export function informationSourceLabel(note: Note): string {
  const hostname = normalizedHostname(note.sourceUrl);
  if (hostname.endsWith('xiaoyuzhoufm.com')) return '小宇宙';
  if (
    hostname.endsWith('xiaohongshu.com') ||
    hostname.endsWith('xhslink.com')
  ) {
    return '小红书';
  }
  if (hostname === 'mp.weixin.qq.com') return '微信公众号';
  if (hostname.endsWith('bilibili.com') || hostname === 'b23.tv') {
    return '哔哩哔哩';
  }
  if (hostname.endsWith('youtube.com') || hostname === 'youtu.be') {
    return 'YouTube';
  }

  const pageSite = note.sourcePageSite?.trim();
  if (pageSite && pageSite.length <= 12) return pageSite;
  if (note.recordType === 'theme') return '主题汇总';
  if (note.recordType === 'synthesis') return '多条记录';
  if (note.source === 'wechat') return note.sourceUrl ? '微信链接' : '微信';
  if (note.source === 'share') return note.sourceUrl ? '系统分享' : '系统分享';
  if (note.source === 'ai') return 'ReMind 整理';
  return note.sourceUrl ? '网页链接' : '自己写的';
}

function normalizedHostname(value: string | null): string {
  if (!value) return '';
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}
