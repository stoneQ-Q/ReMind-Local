import * as Haptics from 'expo-haptics';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  listMemoryAnswers,
  listMemoryInsights,
  saveMemoryAnswer,
  saveMemoryInsight,
  setMemoryInsightFeedback,
} from './database';
import {
  askMemory,
  generateInsight,
  insightEligibility,
  insightPeriodRange,
  selectInsightSources,
  selectQuestionSources,
} from './memory-ai';
import { colors } from './theme';
import type { InsightPeriod, MemoryAnswer, MemoryCitation, MemoryInsight, Note } from './types';

export function MemoryAskSheet({
  db,
  notes,
  onClose,
  onOpenNote,
  visible,
}: {
  db: SQLiteDatabase;
  notes: Note[];
  onClose: () => void;
  onOpenNote: (note: Note) => void;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<MemoryAnswer | null>(null);
  const [history, setHistory] = useState<MemoryAnswer[]>([]);
  const [loading, setLoading] = useState(false);
  const notesById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);

  useEffect(() => {
    if (visible) void listMemoryAnswers(db).then(setHistory);
  }, [db, visible]);

  const submit = async (nextQuestion = question) => {
    const normalized = nextQuestion.trim();
    if (!normalized || loading) return;
    const sources = selectQuestionSources(notes, normalized);
    if (!sources.length) {
      Alert.alert('还没有可以查找的记录', '先记下一些内容，再来问 ReMind。');
      return;
    }
    setQuestion(normalized);
    setLoading(true);
    try {
      const result = await askMemory(normalized, sources);
      await saveMemoryAnswer(db, result);
      setAnswer(result);
      setHistory(await listMemoryAnswers(db));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert('这次没有回答出来', error instanceof Error ? error.message : '请稍后重试。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible={visible}>
      <View style={sheetStyles.page}>
        <View style={[sheetStyles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable hitSlop={10} onPress={onClose}><Text style={sheetStyles.cancel}>返回</Text></Pressable>
          <Text style={sheetStyles.heading}>问 ReMind</Text>
          <View style={sheetStyles.headerSpacer} />
        </View>
        <ScrollView contentContainerStyle={[sheetStyles.body, { paddingBottom: insets.bottom + 36 }]} keyboardShouldPersistTaps="handled">
          <Text style={sheetStyles.lead}>只从你的记录里寻找答案，找不到时会如实告诉你。</Text>
          <View style={sheetStyles.askBox}>
            <TextInput
              accessibilityLabel="向自己的笔记提问"
              multiline
              onChangeText={setQuestion}
              placeholder="例如：我之前记过哪些关于 AI 产品的想法？"
              placeholderTextColor={colors.faint}
              style={sheetStyles.askInput}
              value={question}
            />
            <Pressable disabled={!question.trim() || loading} onPress={() => void submit()} style={[sheetStyles.primaryButton, (!question.trim() || loading) && sheetStyles.disabled]}>
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={sheetStyles.primaryButtonText}>从笔记里找</Text>}
            </Pressable>
          </View>

          {answer ? (
            <View style={sheetStyles.answerCard}>
              <Text style={sheetStyles.eyebrow}>{answer.insufficient ? '没有足够依据' : '来自你的记录'}</Text>
              <Text selectable style={sheetStyles.answerText}>{answer.answer}</Text>
              <CitationList citations={answer.citations} notesById={notesById} onOpen={(note) => { onClose(); onOpenNote(note); }} />
              {answer.suggestedQuestions.length ? (
                <View style={sheetStyles.suggestions}>
                  {answer.suggestedQuestions.map((item) => (
                    <Pressable key={item} onPress={() => void submit(item)} style={sheetStyles.suggestionChip}>
                      <Text style={sheetStyles.suggestionText}>{item}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          ) : history.length ? (
            <View style={sheetStyles.history}>
              <Text style={sheetStyles.sectionTitle}>最近问过</Text>
              {history.map((item) => (
                <Pressable key={item.id} onPress={() => { setQuestion(item.question); setAnswer(item); }} style={sheetStyles.historyRow}>
                  <Text numberOfLines={2} style={sheetStyles.historyText}>{item.question}</Text>
                  <Text style={sheetStyles.chevron}>›</Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <View style={sheetStyles.examples}>
              <Text style={sheetStyles.sectionTitle}>可以这样问</Text>
              {['我之前好像记过一个关于什么的东西？', '我最近反复关注的主题是什么？', '我对一个问题的看法发生过变化吗？'].map((item) => (
                <Pressable key={item} onPress={() => setQuestion(item)} style={sheetStyles.exampleRow}>
                  <Text style={sheetStyles.exampleText}>{item}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

export function MemoryInsightsSheet({
  db,
  notes,
  onClose,
  onOpenNote,
  onOpenRecords,
  visible,
}: {
  db: SQLiteDatabase;
  notes: Note[];
  onClose: () => void;
  onOpenNote: (note: Note) => void;
  onOpenRecords: () => void;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [period, setPeriod] = useState<InsightPeriod>('week');
  const [insights, setInsights] = useState<MemoryInsight[]>([]);
  const [active, setActive] = useState<MemoryInsight | null>(null);
  const [loading, setLoading] = useState(false);
  const notesById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  const range = insightPeriodRange(period);
  const sources = selectInsightSources(notes, range.start, range.end);
  const eligibility = insightEligibility(period, sources);

  useEffect(() => {
    if (!visible) return;
    void listMemoryInsights(db).then((items) => {
      setInsights(items);
      setActive(items[0] ?? null);
    });
  }, [db, visible]);

  const create = async () => {
    if (!eligibility.eligible || loading) return;
    setLoading(true);
    try {
      const result = await generateInsight(period, range.start, range.end, sources);
      await saveMemoryInsight(db, result);
      setInsights(await listMemoryInsights(db));
      setActive(result);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert('这次回望没有生成', error instanceof Error ? error.message : '请稍后重试。');
    } finally {
      setLoading(false);
    }
  };

  const feedback = async (value: 'accurate' | 'inaccurate') => {
    if (!active) return;
    await setMemoryInsightFeedback(db, active.id, value);
    const updated = { ...active, feedback: value };
    setActive(updated);
    setInsights((items) => items.map((item) => item.id === active.id ? updated : item));
    await Haptics.selectionAsync();
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible={visible}>
      <View style={sheetStyles.page}>
        <View style={[sheetStyles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable hitSlop={10} onPress={onClose}><Text style={sheetStyles.cancel}>返回</Text></Pressable>
          <Text style={sheetStyles.heading}>回望</Text>
          <Pressable hitSlop={8} onPress={() => { onClose(); onOpenRecords(); }}><Text style={sheetStyles.headerAction}>看记录</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={[sheetStyles.body, { paddingBottom: insets.bottom + 36 }]}>
          <Text style={sheetStyles.lead}>不是统计报表，而是从一段时间的记录里寻找重复、变化和未被注意的线索。</Text>
          <View style={sheetStyles.periodTabs}>
            {(['week', 'month'] as const).map((value) => (
              <Pressable key={value} onPress={() => setPeriod(value)} style={[sheetStyles.periodTab, period === value && sheetStyles.periodTabActive]}>
                <Text style={[sheetStyles.periodTabText, period === value && sheetStyles.periodTabTextActive]}>{value === 'week' ? '最近一周' : '这个月'}</Text>
              </Pressable>
            ))}
          </View>
          <View style={sheetStyles.generateCard}>
            <View style={sheetStyles.generateCopy}>
              <Text style={sheetStyles.generateTitle}>{period === 'week' ? '生成周回望' : '生成月回望'}</Text>
              <Text style={sheetStyles.generateMeta}>{sources.length} 条记录 · {new Set(sources.map((source) => source.createdAt.slice(0, 10))).size} 天</Text>
              {!eligibility.eligible ? <Text style={sheetStyles.eligibilityText}>{eligibility.message}</Text> : null}
            </View>
            <Pressable disabled={!eligibility.eligible || loading} onPress={() => void create()} style={[sheetStyles.roundButton, (!eligibility.eligible || loading) && sheetStyles.disabled]}>
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={sheetStyles.roundButtonText}>生成</Text>}
            </Pressable>
          </View>

          {active ? (
            <View style={sheetStyles.insightCard}>
              <Text style={sheetStyles.eyebrow}>{active.period === 'week' ? '周回望' : '月回望'}</Text>
              <Text style={sheetStyles.insightTitle}>{active.title}</Text>
              <Text style={sheetStyles.insightSummary}>{active.summary}</Text>
              <InsightSection title="这一段时间留下了什么" body={active.overview} />
              <InsightSection title="反复出现的线索" body={active.patterns} />
              <InsightSection title="正在发生的变化" body={active.changes} />
              <InsightSection title="也许你还没察觉" body={active.blindSpot} />
              <InsightSection title="留给自己的一个问题" body={active.question} />
              <CitationList citations={active.citations} notesById={notesById} onOpen={(note) => { onClose(); onOpenNote(note); }} />
              <View style={sheetStyles.feedbackRow}>
                <Text style={sheetStyles.feedbackLabel}>这次回望准确吗？</Text>
                <Pressable onPress={() => void feedback('accurate')} style={[sheetStyles.feedbackButton, active.feedback === 'accurate' && sheetStyles.feedbackButtonActive]}><Text style={sheetStyles.feedbackText}>说得准</Text></Pressable>
                <Pressable onPress={() => void feedback('inaccurate')} style={[sheetStyles.feedbackButton, active.feedback === 'inaccurate' && sheetStyles.feedbackButtonActive]}><Text style={sheetStyles.feedbackText}>不太准</Text></Pressable>
              </View>
            </View>
          ) : null}

          {insights.length > 1 ? (
            <View style={sheetStyles.history}>
              <Text style={sheetStyles.sectionTitle}>过去的回望</Text>
              {insights.filter((item) => item.id !== active?.id).map((item) => (
                <Pressable key={item.id} onPress={() => setActive(item)} style={sheetStyles.historyRow}>
                  <View style={sheetStyles.historyCopy}><Text style={sheetStyles.historyText}>{item.title}</Text><Text style={sheetStyles.historyMeta}>{new Date(item.createdAt).toLocaleDateString('zh-CN')}</Text></View>
                  <Text style={sheetStyles.chevron}>›</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

function InsightSection({ title, body }: { title: string; body: string }) {
  return <View style={sheetStyles.insightSection}><Text style={sheetStyles.insightSectionTitle}>{title}</Text><Text selectable style={sheetStyles.insightSectionBody}>{body}</Text></View>;
}

function CitationList({ citations, notesById, onOpen }: { citations: MemoryCitation[]; notesById: Map<string, Note>; onOpen: (note: Note) => void }) {
  if (!citations.length) return null;
  return (
    <View style={sheetStyles.citations}>
      <Text style={sheetStyles.sectionTitle}>依据这些记录</Text>
      {citations.map((citation, index) => {
        const note = notesById.get(citation.sourceId);
        if (!note) return null;
        return (
          <Pressable key={`${citation.sourceId}-${index}`} onPress={() => onOpen(note)} style={sheetStyles.citationRow}>
            <View style={sheetStyles.citationIndex}><Text style={sheetStyles.citationIndexText}>{index + 1}</Text></View>
            <View style={sheetStyles.citationCopy}><Text numberOfLines={1} style={sheetStyles.citationTitle}>{note.title}</Text><Text numberOfLines={2} style={sheetStyles.citationQuote}>{citation.quote}</Text></View>
            <Text style={sheetStyles.chevron}>›</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const sheetStyles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  header: { minHeight: 86, paddingHorizontal: 24, paddingBottom: 14, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  cancel: { color: colors.sageText, fontSize: 16, fontWeight: '700' },
  heading: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  headerSpacer: { width: 42 },
  headerAction: { color: colors.sageText, fontSize: 14, fontWeight: '700' },
  body: { padding: 20, gap: 18 },
  lead: { color: colors.muted, fontSize: 15, lineHeight: 23 },
  askBox: { padding: 16, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, gap: 14 },
  askInput: { minHeight: 104, color: colors.ink, fontSize: 17, lineHeight: 25, textAlignVertical: 'top' },
  primaryButton: { minHeight: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
  primaryButtonText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  disabled: { opacity: 0.35 },
  answerCard: { borderRadius: 24, padding: 20, backgroundColor: colors.sage, gap: 14 },
  eyebrow: { color: colors.sageText, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  answerText: { color: colors.ink, fontSize: 17, lineHeight: 28 },
  sectionTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  citations: { gap: 10, marginTop: 4 },
  citationRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 16, backgroundColor: colors.surface },
  citationIndex: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.sage },
  citationIndexText: { color: colors.sageText, fontWeight: '800' },
  citationCopy: { flex: 1, gap: 3 },
  citationTitle: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  citationQuote: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  chevron: { color: colors.muted, fontSize: 24 },
  suggestions: { gap: 8 },
  suggestionChip: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, backgroundColor: colors.surface },
  suggestionText: { color: colors.sageText, lineHeight: 20 },
  history: { gap: 10 },
  historyRow: { minHeight: 62, paddingHorizontal: 15, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', borderRadius: 17, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  historyCopy: { flex: 1, gap: 3 },
  historyText: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '700' },
  historyMeta: { color: colors.faint, fontSize: 12 },
  examples: { gap: 10 },
  exampleRow: { padding: 15, borderRadius: 17, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  exampleText: { color: colors.muted, fontSize: 15 },
  periodTabs: { flexDirection: 'row', padding: 4, borderRadius: 16, backgroundColor: colors.line },
  periodTab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 13 },
  periodTabActive: { backgroundColor: colors.surface },
  periodTabText: { color: colors.muted, fontWeight: '700' },
  periodTabTextActive: { color: colors.ink },
  generateCard: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  generateCopy: { flex: 1, gap: 4 },
  generateTitle: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  generateMeta: { color: colors.muted, fontSize: 13 },
  eligibilityText: { color: colors.faint, fontSize: 12, lineHeight: 18, marginTop: 3 },
  roundButton: { minWidth: 62, height: 44, paddingHorizontal: 14, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
  roundButtonText: { color: '#fff', fontWeight: '800' },
  insightCard: { padding: 20, borderRadius: 26, backgroundColor: colors.sage, gap: 12 },
  insightTitle: { color: colors.ink, fontSize: 25, lineHeight: 32, fontWeight: '800' },
  insightSummary: { color: colors.sageText, fontSize: 16, lineHeight: 25, fontWeight: '600' },
  insightSection: { gap: 5, paddingTop: 8 },
  insightSectionTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  insightSectionBody: { color: colors.muted, fontSize: 15, lineHeight: 24 },
  feedbackRow: { paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  feedbackLabel: { width: '100%', color: colors.muted, fontSize: 13 },
  feedbackButton: { paddingVertical: 8, paddingHorizontal: 13, borderRadius: 14, backgroundColor: colors.surface },
  feedbackButtonActive: { borderWidth: 1, borderColor: colors.accent },
  feedbackText: { color: colors.sageText, fontWeight: '700' },
});
