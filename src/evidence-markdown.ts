export type SplitEvidenceMarkdown = {
  body: string;
  evidence: string;
  evidenceCount: number;
};

export function splitOriginalEvidenceMarkdown(
  markdown: string,
): SplitEvidenceMarkdown | null {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const heading = /(?:^|\n)##\s+原始证据\s*(?:\n|$)/.exec(normalized);
  if (!heading) return null;

  const body = normalized.slice(0, heading.index).trimEnd();
  const evidence = normalized
    .slice(heading.index + heading[0].length)
    .trim();
  const evidenceCount = Array.from(
    evidence.matchAll(/^###\s+证据(?:\s+\d+)?\s*$/gm),
  ).length;

  return { body, evidence, evidenceCount };
}
