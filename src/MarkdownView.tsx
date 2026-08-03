import * as Linking from 'expo-linking';
import { Fragment, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { colors } from './theme';

type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'rule' };

export function MarkdownView({ markdown }: { markdown: string }) {
  const blocks = parseBlocks(normalizeEvidenceMarkerLabels(markdown));

  return (
    <View style={styles.container}>
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === 'heading') {
          return (
            <Text
              key={key}
              selectable
              style={[
                styles.heading,
                block.level === 1
                  ? styles.heading1
                  : block.level === 2
                    ? styles.heading2
                    : styles.heading3,
              ]}
            >
              {renderInline(block.text, key)}
            </Text>
          );
        }
        if (block.type === 'quote') {
          return (
            <View key={key} style={styles.quote}>
              <Text selectable style={styles.quoteText}>
                {renderInline(block.text, key)}
              </Text>
            </View>
          );
        }
        if (block.type === 'list') {
          return (
            <View key={key} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={`${key}-${itemIndex}`} style={styles.listRow}>
                  <Text style={styles.listMarker}>
                    {block.ordered ? `${itemIndex + 1}.` : '•'}
                  </Text>
                  <Text selectable style={styles.listText}>
                    {renderInline(item, `${key}-${itemIndex}`)}
                  </Text>
                </View>
              ))}
            </View>
          );
        }
        if (block.type === 'rule') {
          return <View key={key} style={styles.rule} />;
        }
        return (
          <Text key={key} selectable style={styles.paragraph}>
            {renderInline(block.text, key)}
          </Text>
        );
      })}
    </View>
  );
}

export function normalizeEvidenceMarkerLabels(markdown: string): string {
  return markdown.replace(/〔证据\s*([^〕]+)〕/g, (_marker, body: string) => {
    const normalized = body.replace(/\bE(\d+)\b/gi, '$1').trim();
    return `〔证据 ${normalized}〕`;
  });
}

function parseBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trimEnd();
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: Math.min(heading[1].length, 3),
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      const quoteLines = [quote[1]];
      index += 1;
      while (index < lines.length) {
        const next = lines[index].match(/^\s*>\s?(.*)$/);
        if (!next) break;
        quoteLines.push(next[1]);
        index += 1;
      }
      blocks.push({ type: 'quote', text: quoteLines.join('\n') });
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const isOrdered = Boolean(ordered);
      const items = [(ordered ?? unordered)![1].trim()];
      index += 1;
      while (index < lines.length) {
        let nextIndex = index;
        while (nextIndex < lines.length && !lines[nextIndex].trim()) {
          nextIndex += 1;
        }
        const next = isOrdered
          ? lines[nextIndex]?.match(/^\s*\d+[.)]\s+(.+)$/)
          : lines[nextIndex]?.match(/^\s*[-*+]\s+(.+)$/);
        if (!next) break;
        items.push(next[1].trim());
        index = nextIndex + 1;
      }
      blocks.push({ type: 'list', ordered: isOrdered, items });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim()) {
      const next = lines[index];
      if (
        /^(#{1,6})\s+/.test(next) ||
        /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?)/.test(next) ||
        /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(next)
      ) {
        break;
      }
      paragraph.push(next.trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}

function renderInline(value: string, keyPrefix: string): ReactNode[] {
  const pattern =
    /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value))) {
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-inline-${match.index}`;
    if (
      (token.startsWith('**') && token.endsWith('**')) ||
      (token.startsWith('__') && token.endsWith('__'))
    ) {
      nodes.push(
        <Text key={key} style={styles.strong}>
          {token.slice(2, -2)}
        </Text>,
      );
    } else if (token.startsWith('`')) {
      nodes.push(
        <Text key={key} style={styles.code}>
          {token.slice(1, -1)}
        </Text>,
      );
    } else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
      if (link) {
        nodes.push(
          <Text
            accessibilityRole="link"
            key={key}
            onPress={() => void Linking.openURL(link[2])}
            style={styles.link}
          >
            {link[1]}
          </Text>,
        );
      }
    }
    cursor = match.index + token.length;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes.map((node, index) => (
    <Fragment key={`${keyPrefix}-part-${index}`}>{node}</Fragment>
  ));
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  heading: {
    color: colors.ink,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontWeight: '700',
  },
  heading1: {
    marginTop: 6,
    fontSize: 23,
    lineHeight: 31,
  },
  heading2: {
    marginTop: 5,
    fontSize: 19,
    lineHeight: 27,
  },
  heading3: {
    marginTop: 3,
    fontSize: 17,
    lineHeight: 25,
  },
  paragraph: {
    color: colors.ink,
    fontSize: 16,
    lineHeight: 27,
  },
  strong: {
    fontWeight: '900',
  },
  code: {
    color: colors.sageText,
    backgroundColor: colors.sage,
    fontFamily: 'monospace',
  },
  link: {
    color: colors.accent,
    textDecorationLine: 'underline',
  },
  quote: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#AEB8B1',
    borderRadius: 12,
    backgroundColor: '#FBFCF8',
  },
  quoteText: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 24,
  },
  list: {
    gap: 8,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  listMarker: {
    width: 25,
    color: colors.accent,
    fontSize: 16,
    fontWeight: '900',
    lineHeight: 26,
  },
  listText: {
    flex: 1,
    color: colors.ink,
    fontSize: 16,
    lineHeight: 26,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 4,
    backgroundColor: colors.line,
  },
});
