const EVIDENCE_MARKER = /[（(\[]\s*E\d+(?:\s*[·,，:：/\-]\s*(?:(?:\d{1,2}:)?\d{1,2}:\d{2}|\d+))?\s*[）)\]]/gi;
const STANDALONE_EVIDENCE_MARKER = /\bE\d+(?:\s*[·,，:：/\-]\s*(?:(?:\d{1,2}:)?\d{1,2}:\d{2}|\d+))?\b/gi;
const BRACKETED_TIMESTAMP = /[（(\[]\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*[）)\]]/g;

export function withoutInternalEvidenceMarkers(markdown: string): string {
  return markdown
    .replace(EVIDENCE_MARKER, '')
    .replace(BRACKETED_TIMESTAMP, '')
    .replace(STANDALONE_EVIDENCE_MARKER, '')
    .replace(/[ \t]+([，。！？；：,.!?;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .trim();
}
