export const XIAOYUZHOU_INSIGHT_PROMPT =
  '请把这期播客整理成一篇详细、可复用的洞察笔记，而不是简短摘要。结构包括：一两句话总结、内容地图、核心观点、案例与具体做法、值得关注的启发。每个案例必须尽量交代背景和目标、当事人具体做了什么、先后步骤、使用的方法或工具、重要数字和限制条件、得到的结果，以及这个案例为什么值得注意；不要只写一句抽象结论。核心观点要解释论据、因果和适用边界。合并重复表达，不要输出逐字稿；只使用原文明确提供的信息，原文没说的细节要标为未说明，不能自行补全。关键结论和案例尽量附带可追溯的时间戳证据。';

export const SYSTEM_XIAOYUZHOU_INSIGHT_PROMPTS = new Set([
  XIAOYUZHOU_INSIGHT_PROMPT,
  '请把这期播客整理成一篇便于阅读的洞察笔记：先概括核心观点，再提炼整体洞察和值得关注的内容；合并重复表达，不要输出逐字稿。',
  '请把这期播客整理成一篇便于阅读的洞察笔记：先用一两句话说明这期究竟讲了什么，再提炼内容地图、核心观点、重要案例和真正值得关注的启发；合并重复表达，不要输出逐字稿，并尽量保留可追溯的时间戳证据。',
]);

export function xiaoyuzhouUserIntent(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  if (!normalized || SYSTEM_XIAOYUZHOU_INSIGHT_PROMPTS.has(normalized)) {
    return null;
  }
  return normalized;
}

export function isXiaoyuzhouEpisodeUrl(value: string | null | undefined): boolean {
  return Boolean(value?.includes('xiaoyuzhoufm.com'));
}

export function organizationContextForXiaoyuzhou(input: {
  sourceUrl: string | null | undefined;
  sourcePageText: string | null | undefined;
  userContext: string | null | undefined;
}): string | null {
  const isCompletedEpisode =
    isXiaoyuzhouEpisodeUrl(input.sourceUrl) &&
    input.sourcePageText?.includes('音频转写');
  const existing = xiaoyuzhouUserIntent(input.userContext);
  if (existing) return existing;
  if (isCompletedEpisode) return XIAOYUZHOU_INSIGHT_PROMPT;
  return null;
}
