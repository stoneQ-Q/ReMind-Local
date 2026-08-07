export type LinkInput = {
  url: string;
  userContext: string;
  urlCount: number;
};

const URL_PATTERN = /https?:\/\/[^\s<>"“”]+/gi;
const TRAILING_PUNCTUATION = /[，。！？、,.!?:：；;）)\]】}>]+$/;

export function parseLinkInput(content: string): LinkInput | null {
  const matches = content.match(URL_PATTERN);
  if (!matches?.length) return null;
  const urls = matches.map((match) => match.replace(TRAILING_PUNCTUATION, ''));
  const url = urls[0];
  let userContext = content
    .replace(matches[0], ' ')
    .replace(/^\s*(链接|网址|说明|描述|保存理由|保存意图)\s*[：:]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const afterUrl = content.slice(content.indexOf(matches[0]) + matches[0].length);
  if (!afterUrl.replace(/[，。！？、,.!?:：；;\s]+/g, '')) {
    userContext = userContext.replace(/[：:，,。.!！?？；;\s]+$/, '');
  }
  return { url, userContext, urlCount: urls.length };
}

export function isMeaningfulLinkContext(value: string): boolean {
  return value.replace(/\s+/g, '').length >= 4;
}

export function isCancelLinkIntent(value: string): boolean {
  return /^(取消|算了|不要了|cancel)$/i.test(value.trim());
}
