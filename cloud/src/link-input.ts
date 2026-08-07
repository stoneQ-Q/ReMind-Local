export type LinkInput = {
  url: string;
  userContext: string;
  urlCount: number;
};

const URL_PATTERN =
  /https?:\/\/[^\s<>"“”，。！？；：）】}>]+/gi;
const TRAILING_PUNCTUATION = /[，。！？、,.!?:：；;）)\]】}>]+$/;

export function parseLinkInput(content: string): LinkInput | null {
  const matches = content.match(URL_PATTERN);
  if (!matches?.length) return null;
  const urls = matches.map((match) =>
    match.replace(TRAILING_PUNCTUATION, ''),
  );
  const url = urls[0];
  if (!url) return null;
  let userContext = content
    .replace(matches[0] ?? '', ' ')
    .replace(/^\s*(链接|网址|说明|描述|保存理由|保存意图)\s*[：:]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const firstMatch = matches[0] ?? '';
  const afterUrl = content.slice(content.indexOf(firstMatch) + firstMatch.length);
  if (!afterUrl.replace(/[，。！？、,.!?:：；;\s]+/g, '')) {
    userContext = userContext.replace(/[：:，,。.!！?？；;\s]+$/, '');
  }
  return {
    url,
    userContext: userContext.slice(0, 1_000),
    urlCount: urls.length,
  };
}
