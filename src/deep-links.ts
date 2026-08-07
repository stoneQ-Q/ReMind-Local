import * as Linking from 'expo-linking';

export type CaptureIntent = {
  sourceKey: string;
  text: string;
};

export function parseCaptureIntent(url: string): CaptureIntent | null {
  const parsed = Linking.parse(url);
  const route = [parsed.hostname, parsed.path]
    .filter(Boolean)
    .join('/')
    .split('/')
    .filter(Boolean);

  if (!route.includes('capture')) return null;

  const rawText = parsed.queryParams?.text;
  const text = Array.isArray(rawText) ? rawText[0] : rawText;
  const rawId = parsed.queryParams?.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  return {
    sourceKey: id?.trim() || stableIntentKey(url),
    text: text?.trim() ?? '',
  };
}

function stableIntentKey(url: string): string {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `link-${(hash >>> 0).toString(36)}`;
}
