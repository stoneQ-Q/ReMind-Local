import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  acceptOrganizationDraft,
  acceptThemeMergeDraft,
  createImportedNote,
  createNote,
  deleteNote,
  dismissOrganizationDraft,
  dismissThemeMergeDraft,
  getOriginalCaptureForNote,
  getThemeOverview,
  getRecallSuggestion,
  getSourceThemeAssignment,
  listLinksReadyForOrganization,
  listNotesForOrganization,
  listPendingOrganizationDrafts,
  listNotes,
  listPendingThemeMergeDrafts,
  listRecentlyDeletedThemes,
  listRelatedMemories,
  listThemeSourceContributions,
  listThemeOverviewMap,
  listThemeSourceSummaries,
  listThemeNotes,
  reclassifySourceTheme,
  recordRecallAction,
  restoreNote,
  saveOrganizationResponse,
  saveThemeMergeDraft,
  updateNote,
  updateNoteStatus,
  updateThemeOverview,
  type SourceThemeAssignment,
  type RelatedMemory,
  type RecallSuggestion,
  type ThemeSourceContribution,
  type ThemeSourceSummary,
} from './database';
import {
  requestDailyOrganization,
  requestLinkOrganization,
  requestThemeMerge,
} from './ai-organize';
import { parseCaptureIntent } from './deep-links';
import {
  MarkdownView,
  normalizeEvidenceMarkerLabels,
} from './MarkdownView';
import { formatNoteTime, notePreview } from './note-utils';
import {
  chooseObsidianVault,
  cleanupRawObsidianExports,
  exportPendingNotes,
  getObsidianSyncStatus,
  isNoteSelectedForObsidian,
  requestObsidianExport,
  type ObsidianSyncStatus,
} from './obsidian-sync';
import { colors } from './theme';
import type { Note, OrganizeDraft, ThemeMergeDraft } from './types';
import {
  approveWechatProcessingCost,
  getWechatConnection,
  getWechatProcessingLinks,
  isWechatApiConfigured,
  retryWechatProcessingLink,
  syncWechatInbox,
  updateWechatReplyMode,
  type WechatConnection,
  type WechatProcessingLink,
  type WechatReplyMode,
} from './wechat-sync';
import {
  exportReMindBackup,
  importReMindBackup,
} from './data-backup';

type Screen = 'inbox' | 'search';
type NoteCategory =
  | 'inbox'
  | 'all'
  | 'remind'
  | 'wechat'
  | 'synthesis'
  | 'theme'
  | 'link';

const NOTE_CATEGORIES: { value: NoteCategory; label: string }[] = [
  { value: 'inbox', label: '收件箱' },
  { value: 'all', label: '全部' },
  { value: 'remind', label: '随手记' },
  { value: 'wechat', label: '微信' },
  { value: 'synthesis', label: '整理笔记' },
  { value: 'theme', label: '主题' },
  { value: 'link', label: '链接' },
];

export function ReMindApp() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const captureRef = useRef<TextInput>(null);
  const noteListRef = useRef<SectionList<Note>>(null);
  const linkAutoProcessing = useRef(false);
  const initialLinkScanCompleted = useRef(false);
  const lastHandledUrl = useRef<string | null>(null);
  const incomingUrl = Linking.useLinkingURL();
  const [screen, setScreen] = useState<Screen>('inbox');
  const [noteCategory, setNoteCategory] = useState<NoteCategory>('inbox');
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [captureIntent, setCaptureIntent] = useState<{
    sourceKey: string;
    text: string;
  } | null>(null);
  const [wechatVisible, setWechatVisible] = useState(false);
  const [wechatLoading, setWechatLoading] = useState(false);
  const [wechatError, setWechatError] = useState<string | null>(null);
  const [wechatConnection, setWechatConnection] =
    useState<WechatConnection | null>(null);
  const [wechatProcessingLinks, setWechatProcessingLinks] = useState<
    WechatProcessingLink[]
  >([]);
  const [obsidianVisible, setObsidianVisible] = useState(false);
  const [obsidianLoading, setObsidianLoading] = useState(false);
  const [obsidianError, setObsidianError] = useState<string | null>(null);
  const [obsidianStatus, setObsidianStatus] = useState<ObsidianSyncStatus>({
    configured: false,
    directoryName: null,
    exported: 0,
    pending: 0,
    failed: 0,
    rawExports: 0,
  });
  const [selectedNoteInObsidian, setSelectedNoteInObsidian] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [organizeVisible, setOrganizeVisible] = useState(false);
  const [organizeError, setOrganizeError] = useState<string | null>(null);
  const [organizeDrafts, setOrganizeDrafts] = useState<OrganizeDraft[]>([]);
  const [themeMergeDrafts, setThemeMergeDrafts] = useState<ThemeMergeDraft[]>(
    [],
  );
  const [themeMergeVisible, setThemeMergeVisible] = useState(false);
  const [themeMergeLoading, setThemeMergeLoading] = useState(false);
  const [themeMergeError, setThemeMergeError] = useState<string | null>(null);
  const [themeNotes, setThemeNotes] = useState<Note[]>([]);
  const [themeSourceContributions, setThemeSourceContributions] = useState<
    ThemeSourceContribution[]
  >([]);
  const [selectedThemeOverview, setSelectedThemeOverview] = useState('');
  const [themeSourcesLoading, setThemeSourcesLoading] = useState(false);
  const [themeSourceSummaries, setThemeSourceSummaries] = useState<
    Record<string, ThemeSourceSummary>
  >({});
  const [selectedSourceTheme, setSelectedSourceTheme] =
    useState<SourceThemeAssignment | null>(null);
  const [selectedSourceThemeLoading, setSelectedSourceThemeLoading] =
    useState(false);
  const [selectedOriginalCapture, setSelectedOriginalCapture] =
    useState<Note | null>(null);
  const [selectedOriginalCaptureLoading, setSelectedOriginalCaptureLoading] =
    useState(false);
  const [relatedMemories, setRelatedMemories] = useState<RelatedMemory[]>([]);
  const [relatedMemoriesLoading, setRelatedMemoriesLoading] = useState(false);
  const relatedMemoryRequest = useRef(0);
  const [reclassifySource, setReclassifySource] = useState<Note | null>(null);
  const [deletedThemes, setDeletedThemes] = useState<Note[]>([]);
  const [recallSuggestion, setRecallSuggestion] =
    useState<RecallSuggestion | null>(null);
  const [recallLoading, setRecallLoading] = useState(true);

  const loadNotes = useCallback(
    async (search = query) => {
      try {
        const [nextNotes, nextThemeSummaries] = await Promise.all([
          listNotes(db, search),
          listThemeSourceSummaries(db),
        ]);
        setNotes(nextNotes);
        setThemeSourceSummaries(nextThemeSummaries);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [db, query],
  );

  const syncObsidian = useCallback(async () => {
    const status = await exportPendingNotes(db);
    setObsidianStatus(status);
    return status;
  }, [db]);

  const processReadyLinks = useCallback(async () => {
    if (linkAutoProcessing.current) return;
    linkAutoProcessing.current = true;
    let generated = false;
    try {
      const links = await listLinksReadyForOrganization(db);
      for (const note of links) {
        if (!note.userContext) continue;
        await updateNoteStatus(db, note.id, 'processing');
        try {
          const response = await requestLinkOrganization(
            note,
            note.userContext,
          );
          await saveOrganizationResponse(db, response);
          await updateNoteStatus(db, note.id, 'ready');
          generated = true;
        } catch {
          await updateNoteStatus(db, note.id, 'failed');
        }
      }
      if (generated) {
        const drafts = await listPendingOrganizationDrafts(db);
        setOrganizeDrafts(drafts);
        setOrganizeVisible(true);
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        );
      }
      await loadNotes('');
    } finally {
      linkAutoProcessing.current = false;
    }
  }, [db, loadNotes]);

  const startDailyOrganization = useCallback(async () => {
    if (organizing) return;
    setOrganizing(true);
    setOrganizeError(null);
    try {
      const existing = await listPendingOrganizationDrafts(db);
      if (existing.length > 0) {
        setOrganizeDrafts(existing);
        setOrganizeVisible(true);
        return;
      }
      const sources = await listNotesForOrganization(db, startOfTodayIso());
      if (sources.length === 0) {
        Alert.alert('今天已经整理好了', '暂时没有新的原始记录需要整理。');
        return;
      }
      const response = await requestDailyOrganization(
        sources.map((note) => ({
          id: note.id,
          content: note.content,
          createdAt: note.createdAt,
        })),
      );
      const drafts = await saveOrganizationResponse(db, response);
      if (drafts.length === 0) {
        Alert.alert('没有生成正式笔记', '今天的内容更像临时碎片，已保留原文。');
        return;
      }
      setOrganizeDrafts(drafts);
      setOrganizeVisible(true);
    } catch (error) {
      const message =
        error instanceof Error && error.message.includes('尚未配置')
          ? '整理服务尚未配置。'
          : '整理暂时没有完成，原始记录没有受到影响。';
      setOrganizeError(message);
      Alert.alert('整理失败', message);
    } finally {
      setOrganizing(false);
    }
  }, [db, organizing]);

  const suggestThemeMerge = useCallback(
    async (source: Note) => {
      if (themeMergeLoading) return;
      setThemeMergeLoading(true);
      setThemeMergeError(null);
      try {
        const [themes, overviews] = await Promise.all([
          listThemeNotes(db),
          listThemeOverviewMap(db),
        ]);
        setThemeNotes(themes);
        const response = await requestThemeMerge(source, themes, overviews);
        const drafts = await saveThemeMergeDraft(db, source.id, response);
        setThemeMergeDrafts(drafts);
        setThemeMergeVisible(true);
      } catch {
        setThemeMergeError(
          '来源笔记已经保存，但主题建议暂时没有生成，可以稍后重试。',
        );
        throw new Error('Theme merge suggestion failed');
      } finally {
        setThemeMergeLoading(false);
      }
    },
    [db, themeMergeLoading],
  );

  useEffect(() => {
    void loadNotes('');
    void listPendingOrganizationDrafts(db).then(setOrganizeDrafts);
    void listPendingThemeMergeDrafts(db).then(setThemeMergeDrafts);
    void listThemeNotes(db).then(setThemeNotes);
    void listRecentlyDeletedThemes(db).then(setDeletedThemes);
  }, [db]);

  useEffect(() => {
    if (screen !== 'inbox') return;
    let current = true;
    setRecallLoading(true);
    void getRecallSuggestion(db)
      .then((suggestion) => {
        if (current) setRecallSuggestion(suggestion);
      })
      .finally(() => {
        if (current) setRecallLoading(false);
      });
    return () => {
      current = false;
    };
  }, [db, notes.length, notes[0]?.updatedAt, screen]);

  useEffect(() => {
    if (initialLinkScanCompleted.current) return;
    initialLinkScanCompleted.current = true;
    void processReadyLinks();
  }, [processReadyLinks]);

  useEffect(() => {
    void getObsidianSyncStatus(db).then((status) => {
      setObsidianStatus(status);
      if (status.configured) void syncObsidian();
    });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncObsidian();
    });
    return () => subscription.remove();
  }, [db, syncObsidian]);

  useEffect(() => {
    if (!isWechatApiConfigured()) return;
    void getWechatConnection(false)
      .then(setWechatConnection)
      .catch(() => setWechatError('暂时无法连接微信服务'));
  }, []);

  useEffect(() => {
    if (!wechatConnection?.bound) return;

    const sync = async () => {
      try {
        const [imported, processingLinks] = await Promise.all([
          syncWechatInbox(db),
          getWechatProcessingLinks(),
        ]);
        setWechatProcessingLinks(processingLinks);
        if (imported > 0) {
          await loadNotes('');
          void syncObsidian();
          void processReadyLinks();
        }
      } catch {
        setWechatError('微信同步暂时中断');
      }
    };

    void sync();
    const timer = setInterval(() => void sync(), 15_000);
    return () => clearInterval(timer);
  }, [
    db,
    loadNotes,
    processReadyLinks,
    syncObsidian,
    wechatConnection?.bound,
  ]);

  useEffect(() => {
    if (!incomingUrl || lastHandledUrl.current === incomingUrl) return;
    lastHandledUrl.current = incomingUrl;
    const intent = parseCaptureIntent(incomingUrl);
    if (!intent) return;
    setCaptureIntent(intent);
  }, [incomingUrl]);

  useEffect(() => {
    if (screen !== 'search') return;
    const timer = setTimeout(() => {
      void loadNotes(query);
    }, 180);
    return () => clearTimeout(timer);
  }, [loadNotes, query, screen]);

  const saveDraft = async () => {
    const content = draft.trim();
    if (!content || saving) return;

    setSaving(true);
    try {
      await createNote(db, content);
      setDraft('');
      Keyboard.dismiss();
      await Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      );
      await loadNotes('');
      void syncObsidian();
      void processReadyLinks();
    } catch {
      Alert.alert('保存失败', '内容还在输入框里，请稍后重试。');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSaving(false);
    }
  };

  const switchScreen = async (next: Screen) => {
    setScreen(next);
    if (next === 'inbox') {
      setQuery('');
      await loadNotes('');
    }
    await Haptics.selectionAsync();
  };

  const returnToCapture = () => {
    noteListRef.current?.getScrollResponder()?.scrollTo({
      y: 0,
      animated: true,
    });
    setTimeout(() => captureRef.current?.focus(), 280);
    void Haptics.selectionAsync();
  };

  const openNote = (note: Note) => {
    const requestId = relatedMemoryRequest.current + 1;
    relatedMemoryRequest.current = requestId;
    setSelectedNote(note);
    setSelectedSourceTheme(null);
    setSelectedOriginalCapture(null);
    setThemeSourceContributions([]);
    setSelectedThemeOverview('');
    if (note.recordType === 'theme') {
      setRelatedMemories([]);
      setRelatedMemoriesLoading(false);
      setThemeSourcesLoading(true);
      void Promise.all([
        listThemeSourceContributions(db, note.id),
        getThemeOverview(db, note.id),
      ])
        .then(([contributions, overview]) => {
          setThemeSourceContributions(contributions);
          setSelectedThemeOverview(overview);
        })
        .finally(() => setThemeSourcesLoading(false));
    } else {
      setThemeSourcesLoading(false);
      setRelatedMemories([]);
      setRelatedMemoriesLoading(true);
      void listRelatedMemories(db, note.id)
        .then((memories) => {
          if (relatedMemoryRequest.current === requestId) {
            setRelatedMemories(memories);
          }
        })
        .finally(() => {
          if (relatedMemoryRequest.current === requestId) {
            setRelatedMemoriesLoading(false);
          }
        });
    }
    if (note.recordType === 'source' || Boolean(note.sourceUrl)) {
      setSelectedSourceThemeLoading(true);
      void getSourceThemeAssignment(db, note.id)
        .then(setSelectedSourceTheme)
        .finally(() => setSelectedSourceThemeLoading(false));
    } else {
      setSelectedSourceThemeLoading(false);
    }
    if (note.recordType === 'source' || note.recordType === 'synthesis') {
      setSelectedOriginalCaptureLoading(true);
      void getOriginalCaptureForNote(db, note.id)
        .then((original) => {
          if (relatedMemoryRequest.current === requestId) {
            setSelectedOriginalCapture(original);
          }
        })
        .finally(() => {
          if (relatedMemoryRequest.current === requestId) {
            setSelectedOriginalCaptureLoading(false);
          }
        });
    } else {
      setSelectedOriginalCaptureLoading(false);
    }
    setSelectedNoteInObsidian(false);
    void isNoteSelectedForObsidian(db, note.id).then(
      setSelectedNoteInObsidian,
    );
    void Haptics.selectionAsync();
  };

  const removeNote = (note: Note) => {
    const isTheme = note.recordType === 'theme';
    const sourceCount = themeSourceSummaries[note.id]?.count ?? 0;
    Alert.alert(
      isTheme ? '把这个主题移到最近删除？' : '删除这条笔记？',
      isTheme
        ? `主题主页会被隐藏，但下面的 ${sourceCount} 篇来源笔记不会删除。之后可以在“主题”分类中恢复。`
        : '笔记会从当前列表中移除。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: isTheme ? '移到最近删除' : '删除',
          style: 'destructive',
          onPress: async () => {
            await deleteNote(db, note.id);
            setSelectedNote(null);
            await loadNotes(screen === 'search' ? query : '');
            if (isTheme) {
              setDeletedThemes(await listRecentlyDeletedThemes(db));
            }
            void syncObsidian();
          },
        },
      ],
    );
  };

  const emptyCopy = useMemo(() => {
    if (screen === 'search' && query.trim()) {
      return {
        title: '没有找到',
        body: '换一个词试试，ReMind 会同时搜索标题和正文。',
      };
    }
    if (screen === 'inbox' && noteCategory !== 'all') {
      const category = NOTE_CATEGORIES.find(
        (item) => item.value === noteCategory,
      );
      return {
        title: `还没有${category?.label ?? '这类'}内容`,
        body:
          noteCategory === 'link'
            ? '以后从微信或分享入口贴进来的链接，会集中显示在这里。'
            : '切换到“全部”可以查看其他记录。',
      };
    }
    return {
      title: '先记下第一件事',
      body: '灵感、待办、看到的一句话，都可以从这里开始。',
    };
  }, [noteCategory, query, screen]);

  const displayedNotes = useMemo(
    () =>
      screen === 'search'
        ? notes
        : notes.filter((note) => noteMatchesCategory(note, noteCategory)),
    [noteCategory, notes, screen],
  );
  const noteSections = useMemo(
    () => groupNotesByRecency(displayedNotes, screen === 'search'),
    [displayedNotes, screen],
  );

  const categoryCounts = useMemo(
    () =>
      Object.fromEntries(
        NOTE_CATEGORIES.map(({ value }) => [
          value,
          notes.filter((note) => noteMatchesCategory(note, value)).length,
        ]),
      ) as Record<NoteCategory, number>,
    [notes],
  );

  const listHeader = (
    <View style={styles.scrollHeader}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View>
          <Text maxFontSizeMultiplier={1.1} style={styles.brand}>
            ReMind
          </Text>
          <Text maxFontSizeMultiplier={1.15} style={styles.brandSub}>
            remember what matters
          </Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityLabel="设置 Obsidian 同步"
            onPress={() => {
              setObsidianVisible(true);
              setObsidianError(null);
              void getObsidianSyncStatus(db).then(setObsidianStatus);
            }}
            style={({ pressed }) => [
              styles.obsidianBadge,
              obsidianStatus.configured && styles.obsidianBadgeConfigured,
              pressed && styles.pressed,
            ]}
          >
            <Text maxFontSizeMultiplier={1} style={styles.obsidianBadgeMark}>
              库
            </Text>
            <View
              style={[
                styles.headerStatusDot,
                obsidianStatus.configured && styles.headerStatusDotActive,
              ]}
            />
          </Pressable>
          <Pressable
            accessibilityLabel="连接微信 ClawBot"
            onPress={() => {
              setWechatVisible(true);
              setWechatLoading(true);
              setWechatError(null);
              void getWechatConnection(true)
                .then(setWechatConnection)
                .catch(() => setWechatError('暂时无法连接微信服务'))
                .finally(() => setWechatLoading(false));
            }}
            style={({ pressed }) => [
              styles.wechatBadge,
              wechatConnection?.bound && styles.wechatBadgeBound,
              pressed && styles.pressed,
            ]}
          >
            <Text maxFontSizeMultiplier={1} style={styles.wechatBadgeMark}>
              微
            </Text>
            <View
              style={[
                styles.headerStatusDot,
                wechatConnection?.bound && styles.headerStatusDotActive,
              ]}
            />
          </Pressable>
        </View>
      </View>

      {screen === 'inbox' ? (
        <View style={styles.captureShell}>
          <View pointerEvents="none" style={styles.captureOffsetOutline} />
          <View style={styles.capture}>
            <View pointerEvents="none" style={styles.capturePin}>
              <View style={styles.capturePinDot} />
            </View>
            <Text maxFontSizeMultiplier={1.1} style={styles.captureLabel}>
              QUICK NOTE
            </Text>
            <TextInput
              ref={captureRef}
              accessibilityLabel="记录一条新笔记"
              multiline
              maxFontSizeMultiplier={1.15}
              onChangeText={setDraft}
              placeholder="此刻在想什么？"
              placeholderTextColor={colors.faint}
              style={styles.captureInput}
              textAlignVertical="top"
              value={draft}
            />
            <View style={styles.captureFooter}>
              <Text maxFontSizeMultiplier={1.1} style={styles.captureHint}>
                {draft.trim() ? `${draft.trim().length} 字` : '不用先整理'}
              </Text>
              <Pressable
                accessibilityLabel="保存笔记"
                disabled={!draft.trim() || saving}
                onPress={() => void saveDraft()}
                style={({ pressed }) => [
                  styles.saveButton,
                  (!draft.trim() || saving) && styles.saveButtonDisabled,
                  pressed && styles.pressed,
                ]}
              >
                {saving ? (
                  <ActivityIndicator color={colors.white} size="small" />
                ) : (
                  <Text
                    maxFontSizeMultiplier={1.1}
                    style={styles.saveButtonText}
                  >
                    收下
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.searchWrap}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput
            accessibilityLabel="搜索笔记"
            autoFocus
            onChangeText={setQuery}
            placeholder="搜索你记过的内容"
            placeholderTextColor={colors.faint}
            returnKeyType="search"
            style={styles.searchInput}
            value={query}
          />
          {query ? (
            <Pressable
              accessibilityLabel="清除搜索"
              onPress={() => setQuery('')}
              hitSlop={10}
            >
              <Text style={styles.clearSearch}>×</Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {screen === 'inbox' && wechatProcessingLinks.length > 0 ? (
        <ProcessingLinksPanel
          links={wechatProcessingLinks}
          onApprove={async (messageId) => {
            setWechatProcessingLinks((current) =>
              current.map((item) =>
                item.messageId === messageId
                  ? {
                      ...item,
                      cloudCostApproved: true,
                      stage: 'queued',
                      current: 0,
                      total: 0,
                    }
                  : item,
              ),
            );
            try {
              await approveWechatProcessingCost(messageId);
            } catch {
              setWechatError('费用确认暂时没有提交成功');
              setWechatProcessingLinks(await getWechatProcessingLinks());
            }
          }}
          onRetry={async (messageId) => {
            setWechatProcessingLinks((current) =>
              current.map((item) =>
                item.messageId === messageId
                  ? {
                      ...item,
                      status: 'pending',
                      stage: 'queued',
                      current: 0,
                      total: 0,
                      errorCode: null,
                    }
                  : item,
              ),
            );
            try {
              await retryWechatProcessingLink(messageId);
            } catch {
              setWechatError('视频重试暂时没有提交成功');
              setWechatProcessingLinks(await getWechatProcessingLinks());
            }
          }}
        />
      ) : null}

      <View style={styles.sectionHeader}>
        <Text maxFontSizeMultiplier={1.15} style={styles.sectionTitle}>
          {screen === 'search' ? '搜索结果' : '最近记下'}
        </Text>
        <Text maxFontSizeMultiplier={1} style={styles.sectionCount}>
          {displayedNotes.length}
        </Text>
        {screen === 'inbox' ? (
          <Pressable
            disabled={organizing || themeMergeLoading}
            onPress={() => {
              if (themeMergeDrafts.length > 0) {
                setThemeMergeVisible(true);
              } else {
                void startDailyOrganization();
              }
            }}
            style={({ pressed }) => [
              styles.organizeButton,
              organizing && styles.organizeButtonDisabled,
              pressed && styles.pressed,
            ]}
          >
            {organizing ? (
              <ActivityIndicator color={colors.accent} size="small" />
            ) : (
              <Text
                maxFontSizeMultiplier={1.1}
                style={styles.organizeButtonText}
              >
                {themeMergeDrafts.length > 0
                  ? `归入主题 ${themeMergeDrafts.length}`
                  : organizeDrafts.length > 0
                    ? `审核 ${organizeDrafts.length}`
                    : '整理今天'}
              </Text>
            )}
          </Pressable>
        ) : null}
      </View>

      {screen === 'inbox' ? (
        <>
          <ScrollView
            contentContainerStyle={styles.categoryBarContent}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.categoryBar}
          >
            {NOTE_CATEGORIES.map((category) => {
              const active = noteCategory === category.value;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  key={category.value}
                  onPress={() => {
                    setNoteCategory(category.value);
                    void Haptics.selectionAsync();
                  }}
                  style={({ pressed }) => [
                    styles.categoryChip,
                    active && styles.categoryChipActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text
                    maxFontSizeMultiplier={1.1}
                    style={[
                      styles.categoryChipText,
                      active && styles.categoryChipTextActive,
                    ]}
                  >
                    {category.label}
                  </Text>
                  <Text
                    maxFontSizeMultiplier={1}
                    style={[
                      styles.categoryChipCount,
                      active && styles.categoryChipCountActive,
                    ]}
                  >
                    {categoryCounts[category.value]}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          {noteCategory === 'theme' && deletedThemes.length > 0 ? (
            <View style={styles.deletedThemeRow}>
              <View style={styles.deletedThemeCopy}>
                <Text style={styles.deletedThemeEyebrow}>最近删除</Text>
                <Text numberOfLines={1} style={styles.deletedThemeTitle}>
                  {deletedThemes[0].title}
                </Text>
              </View>
              <Pressable
                hitSlop={8}
                onPress={async () => {
                  await restoreNote(db, deletedThemes[0].id);
                  setDeletedThemes(await listRecentlyDeletedThemes(db));
                  await loadNotes('');
                  await Haptics.notificationAsync(
                    Haptics.NotificationFeedbackType.Success,
                  );
                }}
                style={({ pressed }) => [
                  styles.deletedThemeRestore,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.deletedThemeRestoreText}>恢复</Text>
              </Pressable>
            </View>
          ) : null}
          {noteCategory === 'inbox' &&
          (recallLoading || recallSuggestion) ? (
            <RecallSpotlight
              loading={recallLoading}
              onOpen={async (suggestion) => {
                await recordRecallAction(
                  db,
                  suggestion.memory.id,
                  'opened',
                );
                setRecallSuggestion(null);
                openNote(suggestion.memory);
              }}
              onSnooze={async (suggestion) => {
                await recordRecallAction(
                  db,
                  suggestion.memory.id,
                  'snoozed',
                );
                setRecallSuggestion(null);
                await Haptics.selectionAsync();
              }}
              suggestion={recallSuggestion}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );

  return (
    <View style={styles.app}>
      <SectionList
        ref={noteListRef}
        contentContainerStyle={[
          styles.listContent,
          !loading &&
            displayedNotes.length === 0 &&
            styles.emptyListContent,
        ]}
        sections={loading ? [] : noteSections}
        keyExtractor={(item) => item.id}
        keyboardDismissMode="on-drag"
        ListHeaderComponent={listHeader}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.accent}
            onRefresh={() => {
              setRefreshing(true);
              void loadNotes(screen === 'search' ? query : '');
            }}
          />
        }
        renderItem={({ item }) => (
          <View style={styles.noteItemWrap}>
            <NoteCard
              note={item}
              onPress={() => openNote(item)}
              themeSourceSummary={themeSourceSummaries[item.id]}
            />
          </View>
        )}
        renderSectionHeader={({ section }) =>
          section.title ? (
            <Text style={styles.noteSectionTitle}>{section.title}</Text>
          ) : null
        }
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          loading ? (
            <View style={styles.listLoadingState}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : (
            <View style={styles.emptyState}>
              <View style={styles.emptyMark}>
                <Text style={styles.emptyMarkText}>记</Text>
              </View>
              <Text style={styles.emptyTitle}>{emptyCopy.title}</Text>
              <Text style={styles.emptyBody}>{emptyCopy.body}</Text>
              {screen === 'inbox' ? (
                <Pressable
                  onPress={returnToCapture}
                  style={styles.emptyAction}
                >
                  <Text style={styles.emptyActionText}>开始记录</Text>
                </Pressable>
              ) : null}
            </View>
          )
        }
      />

      <View
        style={[
          styles.tabBar,
          { paddingBottom: Math.max(insets.bottom, 12) },
        ]}
      >
        <TabButton
          active={screen === 'inbox'}
          icon="＋"
          label="记录"
          onPress={() =>
            screen === 'inbox'
              ? returnToCapture()
              : void switchScreen('inbox').then(returnToCapture)
          }
        />
        <TabButton
          active={screen === 'search'}
          icon="⌕"
          label="找回"
          onPress={() => void switchScreen('search')}
        />
      </View>

      <NoteEditor
        currentTheme={selectedSourceTheme}
        note={selectedNote}
        originalCapture={selectedOriginalCapture}
        originalCaptureLoading={selectedOriginalCaptureLoading}
        obsidianConfigured={obsidianStatus.configured}
        obsidianSelected={selectedNoteInObsidian}
        themeLoading={themeMergeLoading || selectedSourceThemeLoading}
        themeOverview={selectedThemeOverview}
        onClose={() => {
          relatedMemoryRequest.current += 1;
          setSelectedNote(null);
        }}
        onDelete={removeNote}
        onExport={async (noteId) => {
          if (!obsidianStatus.configured) {
            setSelectedNote(null);
            setObsidianVisible(true);
            return;
          }
          const status = await requestObsidianExport(db, noteId);
          setObsidianStatus(status);
          setSelectedNoteInObsidian(true);
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
        }}
        onOrganizeLink={async (note, title, content, userContext) => {
          await updateNote(db, note.id, title, content, userContext);
          await updateNoteStatus(db, note.id, 'processing');
          try {
            const response = await requestLinkOrganization(
              { ...note, title, content, userContext },
              userContext,
            );
            const drafts = await saveOrganizationResponse(db, response);
            await updateNoteStatus(db, note.id, 'ready');
            setOrganizeDrafts(drafts);
            setSelectedNote(null);
            setOrganizeVisible(true);
            await loadNotes(screen === 'search' ? query : '');
          } catch (error) {
            await updateNoteStatus(db, note.id, 'failed');
            throw error;
          }
        }}
        onSuggestTheme={async (note) => {
          setSelectedNote(null);
          try {
            await suggestThemeMerge(note);
          } catch {
            Alert.alert(
              '主题建议暂时失败',
              '来源笔记已经保留，可以稍后再次点击“整理到主题”。',
            );
          }
        }}
        onReclassify={(note) => {
          setSelectedNote(null);
          void getSourceThemeAssignment(db, note.id).then((assignment) => {
            if (!assignment) {
              Alert.alert('暂时无法重新归类', '没有找到这篇来源的主题归属。');
              return;
            }
            setSelectedSourceTheme(assignment);
            setReclassifySource(note);
          });
        }}
        onOpenRelated={openNote}
        onSave={async (id, title, content, userContext) => {
          await updateNote(db, id, title, content, userContext);
          if (selectedNote?.recordType === 'theme') {
            setThemeNotes(await listThemeNotes(db));
          }
          setSelectedNote(null);
          await loadNotes(screen === 'search' ? query : '');
          void syncObsidian();
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
        }}
        onSaveThemeOverview={async (themeNoteId, overview) => {
          await updateThemeOverview(db, themeNoteId, overview);
          setSelectedThemeOverview(overview.trim());
          void syncObsidian();
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
        }}
        themeSourceContributions={themeSourceContributions}
        themeSourcesLoading={themeSourcesLoading}
        relatedMemories={relatedMemories}
        relatedMemoriesLoading={relatedMemoriesLoading}
      />

      <SourceThemePicker
        currentTheme={selectedSourceTheme}
        onClose={() => setReclassifySource(null)}
        onConfirm={async (targetThemeId, newThemeTitle) => {
          if (!reclassifySource) return;
          const result = await reclassifySourceTheme(
            db,
            selectedSourceTheme?.sourceNoteId ?? reclassifySource.id,
            targetThemeId,
            newThemeTitle,
          );
          setReclassifySource(null);
          setSelectedSourceTheme({
            sourceNoteId:
              selectedSourceTheme?.sourceNoteId ?? reclassifySource.id,
            themeId: result.targetTheme.id,
            themeTitle: result.targetTheme.title,
            contributionAvailable: true,
          });
          setThemeNotes(await listThemeNotes(db));
          await loadNotes(screen === 'search' ? query : '');
          if (obsidianStatus.configured) {
            await requestObsidianExport(db, result.targetTheme.id);
            const status = await exportPendingNotes(db);
            setObsidianStatus(status);
          }
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
          if (!result.removedFromPrevious) {
            Alert.alert(
              '已重新归类',
              `来源已归入“${result.targetTheme.title}”，但旧主题正文曾被手动修改，无法安全自动删掉原段落，请检查“${result.previousTheme.title}”。`,
            );
          }
        }}
        source={reclassifySource}
        themes={themeNotes}
      />

      <QuickCapture
        intent={captureIntent}
        onClose={() => setCaptureIntent(null)}
        onSave={async (text, sourceKey) => {
          const created = await createImportedNote(db, text, sourceKey);
          setCaptureIntent(null);
          await loadNotes('');
          if (created) void syncObsidian();
          if (created) void processReadyLinks();
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
          if (!created) {
            Alert.alert('已经收下了', '这条分享内容之前保存过，没有重复创建。');
          }
        }}
      />

      <OrganizationReview
        drafts={organizeDrafts}
        error={organizeError}
        onAccept={async (draftId, title, content) => {
          const note = await acceptOrganizationDraft(
            db,
            draftId,
            title,
            content,
          );
          if (obsidianStatus.configured) {
            const status = await requestObsidianExport(db, note.id);
            setObsidianStatus(status);
          }
          const remaining = await listPendingOrganizationDrafts(db);
          setOrganizeDrafts(remaining);
          setOrganizeVisible(false);
          await loadNotes('');
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
          if (note.recordType === 'source') {
            try {
              await suggestThemeMerge(note);
            } catch {
              Alert.alert(
                '来源笔记已保存',
                '主题建议暂时没有生成，可以稍后从来源笔记中重试。',
              );
              if (remaining.length > 0) setOrganizeVisible(true);
            }
          } else if (remaining.length > 0) {
            setOrganizeVisible(true);
          }
        }}
        onClose={() => setOrganizeVisible(false)}
        onDismiss={async (draftId) => {
          await dismissOrganizationDraft(db, draftId);
          const remaining = await listPendingOrganizationDrafts(db);
          setOrganizeDrafts(remaining);
          if (remaining.length === 0) setOrganizeVisible(false);
        }}
        visible={organizeVisible}
      />

      <ThemeMergeReview
        drafts={themeMergeDrafts}
        error={themeMergeError}
        loading={themeMergeLoading}
        onAccept={async (
          draftId,
          patch,
          overview,
          selectedThemeId,
          selectedThemeTitle,
        ) => {
          const theme = await acceptThemeMergeDraft(
            db,
            draftId,
            patch,
            overview,
            selectedThemeId,
            selectedThemeTitle,
          );
          if (obsidianStatus.configured) {
            const status = await requestObsidianExport(db, theme.id);
            setObsidianStatus(status);
          }
          const remaining = await listPendingThemeMergeDrafts(db);
          setThemeMergeDrafts(remaining);
          setThemeNotes(await listThemeNotes(db));
          setThemeMergeVisible(remaining.length > 0);
          await loadNotes('');
          if (remaining.length === 0 && organizeDrafts.length > 0) {
            setOrganizeVisible(true);
          }
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
        }}
        onClose={() => setThemeMergeVisible(false)}
        onDismiss={async (draftId) => {
          await dismissThemeMergeDraft(db, draftId);
          const remaining = await listPendingThemeMergeDrafts(db);
          setThemeMergeDrafts(remaining);
          setThemeMergeVisible(remaining.length > 0);
          if (remaining.length === 0 && organizeDrafts.length > 0) {
            setOrganizeVisible(true);
          }
        }}
        themes={themeNotes}
        visible={themeMergeVisible}
      />

      <WechatBinding
        connection={wechatConnection}
        error={wechatError}
        loading={wechatLoading}
        onClose={() => setWechatVisible(false)}
        onRefresh={async () => {
          setWechatLoading(true);
          setWechatError(null);
          try {
            const connection = await getWechatConnection(true);
            setWechatConnection(connection);
            if (connection.bound) {
              const [imported, processingLinks] = await Promise.all([
                syncWechatInbox(db),
                getWechatProcessingLinks(),
              ]);
              setWechatProcessingLinks(processingLinks);
              if (imported > 0) {
                await loadNotes('');
                void syncObsidian();
                void processReadyLinks();
              }
            }
          } catch {
            setWechatError('暂时无法连接微信服务');
          } finally {
            setWechatLoading(false);
          }
        }}
        onReplyModeChange={async (replyMode) => {
          setWechatError(null);
          try {
            await updateWechatReplyMode(replyMode);
            setWechatConnection((current) =>
              current ? { ...current, replyMode } : current,
            );
            await Haptics.selectionAsync();
          } catch {
            setWechatError('确认回复设置保存失败，请稍后重试');
          }
        }}
        visible={wechatVisible}
      />

      <ObsidianSettings
        error={obsidianError}
        loading={obsidianLoading}
        onExportData={async () => {
          setObsidianLoading(true);
          setObsidianError(null);
          try {
            const summary = await exportReMindBackup(db);
            Alert.alert(
              '备份已生成',
              `已整理 ${summary.notes} 条笔记及其主题、引用和审核记录。请把 JSON 文件保存到手机的“下载”或“文件”中。`,
            );
          } catch (error) {
            setObsidianError(
              error instanceof Error ? error.message : '数据备份失败，请重试。',
            );
          } finally {
            setObsidianLoading(false);
          }
        }}
        onImportData={async () => {
          setObsidianLoading(true);
          setObsidianError(null);
          try {
            const summary = await importReMindBackup(db);
            if (!summary) return;
            await loadNotes('');
            setThemeNotes(await listThemeNotes(db));
            setThemeSourceSummaries(await listThemeSourceSummaries(db));
            setRecallSuggestion(await getRecallSuggestion(db));
            Alert.alert(
              '迁移完成',
              summary.notesAdded > 0
                ? `已加入 ${summary.notesAdded} 条笔记，并恢复相关主题、引用和审核记录。已有内容没有被覆盖。`
                : '备份中的笔记已经存在，没有产生重复内容。',
            );
          } catch (error) {
            setObsidianError(
              error instanceof Error ? error.message : '数据导入失败，请重试。',
            );
          } finally {
            setObsidianLoading(false);
          }
        }}
        onChoose={async () => {
          setObsidianLoading(true);
          setObsidianError(null);
          try {
            const status = await chooseObsidianVault(db);
            setObsidianStatus(status);
            await Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Success,
            );
          } catch {
            setObsidianError(
              '没有完成文件夹授权。请选择 Obsidian Vault 的根目录后重试。',
            );
          } finally {
            setObsidianLoading(false);
          }
        }}
        onClose={() => setObsidianVisible(false)}
        onCleanup={() => {
          Alert.alert(
            '清理本次原始导出？',
            '只会删除 ReMind 刚才批量创建、且尚未手动选择保存的 Markdown，不会触碰 Vault 中的其他文件。',
            [
              { text: '取消', style: 'cancel' },
              {
                text: '清理',
                style: 'destructive',
                onPress: async () => {
                  setObsidianLoading(true);
                  setObsidianError(null);
                  try {
                    const status = await cleanupRawObsidianExports(db);
                    setObsidianStatus(status);
                  } catch {
                    setObsidianError('部分文件未能清理，请稍后重试。');
                  } finally {
                    setObsidianLoading(false);
                  }
                },
              },
            ],
          );
        }}
        onSync={async () => {
          setObsidianLoading(true);
          setObsidianError(null);
          try {
            await syncObsidian();
            await Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Success,
            );
          } catch {
            setObsidianError('同步失败，请检查 Vault 文件夹授权。');
          } finally {
            setObsidianLoading(false);
          }
        }}
        status={obsidianStatus}
        visible={obsidianVisible}
      />
    </View>
  );
}

function RecallSpotlight({
  loading,
  onOpen,
  onSnooze,
  suggestion,
}: {
  loading: boolean;
  onOpen: (suggestion: RecallSuggestion) => Promise<void>;
  onSnooze: (suggestion: RecallSuggestion) => Promise<void>;
  suggestion: RecallSuggestion | null;
}) {
  const [acting, setActing] = useState(false);

  if (loading && !suggestion) {
    return (
      <View style={styles.recallSpotlightLoading}>
        <ActivityIndicator color={colors.accent} size="small" />
        <Text style={styles.recallSpotlightLoadingText}>
          正在从旧笔记中找一条值得再看的内容…
        </Text>
      </View>
    );
  }
  if (!suggestion) return null;

  return (
    <View style={styles.recallSpotlight}>
      <View style={styles.recallSpotlightHeader}>
        <View>
          <Text style={styles.recallSpotlightEyebrow}>最近值得再看</Text>
          <Text style={styles.recallSpotlightHeading}>这让我想起</Text>
        </View>
        <Text style={styles.recallSpotlightMark}>回</Text>
      </View>
      <Text numberOfLines={2} style={styles.recallSpotlightTitle}>
        {suggestion.memory.title}
      </Text>
      <Text style={styles.recallSpotlightReason}>{suggestion.reason}</Text>
      <View style={styles.recallSpotlightMeta}>
        <Text style={styles.recallSpotlightMetaText}>
          {formatNoteTime(suggestion.memory.createdAt)}
          {suggestion.memory.sourcePageSite
            ? ` · ${suggestion.memory.sourcePageSite}`
            : ' · 整理笔记'}
        </Text>
      </View>
      <View style={styles.recallSpotlightActions}>
        <Pressable
          disabled={acting}
          onPress={async () => {
            setActing(true);
            try {
              await onSnooze(suggestion);
            } finally {
              setActing(false);
            }
          }}
          style={({ pressed }) => [
            styles.recallSpotlightSnooze,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.recallSpotlightSnoozeText}>暂时不看</Text>
        </Pressable>
        <Pressable
          disabled={acting}
          onPress={async () => {
            setActing(true);
            try {
              await onOpen(suggestion);
            } finally {
              setActing(false);
            }
          }}
          style={({ pressed }) => [
            styles.recallSpotlightOpen,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.recallSpotlightOpenText}>
            {acting ? '正在打开…' : '打开看看'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function ProcessingLinksPanel({
  links,
  onApprove,
  onRetry,
}: {
  links: WechatProcessingLink[];
  onApprove: (messageId: string) => Promise<void>;
  onRetry: (messageId: string) => Promise<void>;
}) {
  return (
    <View style={styles.processingPanel}>
      <View style={styles.processingPanelHeading}>
        <Text style={styles.processingPanelTitle}>正在整理</Text>
        <Text style={styles.processingPanelCount}>{links.length}</Text>
      </View>
      {links.map((item) => {
        const failed = item.status === 'failed';
        const awaitingApproval = item.stage === 'awaiting_approval';
        const progress =
          item.total > 0
            ? Math.min(1, Math.max(0, item.current / item.total))
            : item.stage === 'extracting'
              ? 0.12
              : 0.04;
        const statusText = failed
          ? '整理没有完成'
          : awaitingApproval
            ? '本地转写不可用，需要云端继续'
            : item.stage === 'transcribing' && item.total > 0
              ? `正在转写 ${item.current}/${item.total}`
              : item.stage === 'extracting'
                ? '正在读取视频'
                : '等待开始';
        const costText =
          item.estimatedCostMicros !== null
            ? `预计约 ¥${(item.estimatedCostMicros / 1_000_000).toFixed(2)}`
            : null;
        const limitText =
          awaitingApproval && item.costLimitMicros !== null
            ? item.estimatedCostMicros === null
              ? '时长未知，费用需先确认'
              : `已超过 ¥${(item.costLimitMicros / 1_000_000).toFixed(2)} 上限`
            : null;
        return (
          <View key={item.messageId} style={styles.processingCard}>
            <View style={styles.processingCardTop}>
              <View style={styles.processingCardCopy}>
                <Text numberOfLines={1} style={styles.processingCardTitle}>
                  {item.title}
                </Text>
                <Text style={styles.processingCardStatus}>
                  {[statusText, costText, limitText]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              {failed ? (
                <Pressable
                  hitSlop={8}
                  onPress={() => void onRetry(item.messageId)}
                  style={({ pressed }) => [
                    styles.processingRetry,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.processingRetryText}>重试</Text>
                </Pressable>
              ) : awaitingApproval ? (
                <Pressable
                  hitSlop={8}
                  onPress={() => void onApprove(item.messageId)}
                  style={({ pressed }) => [
                    styles.processingApprove,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.processingApproveText}>继续整理</Text>
                </Pressable>
              ) : (
                <ActivityIndicator color={colors.accent} size="small" />
              )}
            </View>
            {!failed && !awaitingApproval ? (
              <View style={styles.processingTrack}>
                <View
                  style={[
                    styles.processingFill,
                    { width: `${Math.max(4, progress * 100)}%` },
                  ]}
                />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function NoteCard({
  note,
  onPress,
  themeSourceSummary,
}: {
  note: Note;
  onPress: () => void;
  themeSourceSummary?: ThemeSourceSummary;
}) {
  const categoryLabel =
    note.recordType === 'theme'
      ? '主题笔记'
      : note.recordType === 'source'
      ? '来源笔记'
      : note.recordType === 'synthesis'
        ? '整理笔记'
      : note.source === 'wechat'
        ? '微信记录'
        : note.source === 'share'
          ? '分享记录'
          : '随手记';
  const containsLink =
    note.contentKind === 'link' || note.contentKind === 'mixed';
  const linkIntentLabel =
    note.recordType === 'capture' && containsLink
      ? note.status === 'processing'
        ? '生成中'
        : note.status === 'failed'
          ? '生成失败'
          : note.status === 'ready'
            ? '已生成'
            : note.userContext &&
                note.userContext.replace(/\s+/g, '').length >= 4
              ? '待生成'
              : '待补描述'
      : null;

  const cardTone =
    note.recordType === 'theme'
      ? styles.noteCardTheme
      : note.recordType === 'source'
        ? styles.noteCardSource
        : note.recordType === 'synthesis'
          ? styles.noteCardSynthesis
          : styles.noteCardCapture;

  return (
    <View style={styles.noteCardStack}>
      <View pointerEvents="none" style={styles.noteCardBack} />
      <Pressable
        accessibilityLabel={`打开笔记：${note.title}`}
        onPress={onPress}
        style={({ pressed }) => [
          styles.noteCard,
          cardTone,
          pressed && styles.noteCardPressed,
        ]}
      >
      <View
        pointerEvents="none"
        style={[
          styles.noteCardTab,
          note.recordType === 'theme'
            ? styles.noteCardTabTheme
            : note.recordType === 'source'
              ? styles.noteCardTabSource
              : note.recordType === 'synthesis'
                ? styles.noteCardTabSynthesis
                : styles.noteCardTabCapture,
        ]}
      />
      <View style={styles.noteTopline}>
        <Text
          maxFontSizeMultiplier={1.15}
          numberOfLines={1}
          style={styles.noteTitle}
        >
          {note.title}
        </Text>
        <Text maxFontSizeMultiplier={1} style={styles.noteTime}>
          {formatNoteTime(note.updatedAt)}
        </Text>
      </View>
      <Text
        maxFontSizeMultiplier={1.15}
        numberOfLines={2}
        style={styles.notePreview}
      >
        {note.recordType === 'theme' && themeSourceSummary
          ? `${themeSourceSummary.count} 篇来源 · 最近补充于 ${formatNoteTime(
              themeSourceSummary.lastAddedAt,
            )}`
          : notePreview(note.summary?.trim() || note.content)}
      </Text>
      <View style={styles.noteMeta}>
        <View style={styles.noteCategories}>
          <View
            style={[
              styles.pendingPill,
              note.recordType !== 'capture' && styles.readyPill,
            ]}
          >
            <View
              style={[
                styles.pendingDot,
                note.recordType !== 'capture' && styles.readyDot,
              ]}
            />
            <Text
              maxFontSizeMultiplier={1}
              style={[
                styles.pendingText,
                note.recordType !== 'capture' && styles.readyText,
              ]}
            >
              {categoryLabel}
            </Text>
          </View>
          {containsLink ? (
            <View style={styles.kindPill}>
            <Text maxFontSizeMultiplier={1} style={styles.kindPillText}>
              链接
            </Text>
            </View>
          ) : null}
          {linkIntentLabel ? (
            <View
              style={[
                styles.linkStatePill,
                (linkIntentLabel === '待生成' ||
                  linkIntentLabel === '生成中' ||
                  linkIntentLabel === '已生成') &&
                  styles.linkStatePillReady,
              ]}
            >
              <Text
                maxFontSizeMultiplier={1}
                style={[
                  styles.linkStatePillText,
                  (linkIntentLabel === '待生成' ||
                    linkIntentLabel === '生成中' ||
                    linkIntentLabel === '已生成') &&
                    styles.linkStatePillTextReady,
                ]}
              >
                {linkIntentLabel}
              </Text>
            </View>
          ) : null}
        </View>
        <Text maxFontSizeMultiplier={1} style={styles.noteArrow}>↗</Text>
      </View>
      </Pressable>
    </View>
  );
}

function noteMatchesCategory(note: Note, category: NoteCategory): boolean {
  switch (category) {
    case 'inbox':
      return (
        note.recordType !== 'theme' &&
        !(
          note.recordType === 'capture' &&
          note.sourceUrl &&
          note.status === 'ready'
        )
      );
    case 'remind':
      return note.recordType === 'capture' && note.source !== 'wechat';
    case 'wechat':
      return note.source === 'wechat';
    case 'synthesis':
      return note.recordType === 'source' || note.recordType === 'synthesis';
    case 'theme':
      return note.recordType === 'theme';
    case 'link':
      return note.contentKind === 'link' || note.contentKind === 'mixed';
    default:
      return true;
  }
}

function groupNotesByRecency(notes: Note[], singleSection: boolean) {
  if (singleSection) return [{ title: '', data: notes }];
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const groups = [
    { title: '今天', data: [] as Note[] },
    { title: '昨天', data: [] as Note[] },
    { title: '更早', data: [] as Note[] },
  ];
  for (const note of notes) {
    const time = new Date(note.updatedAt).getTime();
    if (time >= startOfToday) groups[0].data.push(note);
    else if (time >= startOfYesterday) groups[1].data.push(note);
    else groups[2].data.push(note);
  }
  return groups.filter((group) => group.data.length > 0);
}

function TabButton({
  active,
  icon,
  label,
  onPress,
}: {
  active: boolean;
  icon: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={styles.tabButton}
    >
      <Text style={[styles.tabIcon, active && styles.tabIconActive]}>
        {icon}
      </Text>
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

function NoteEditor({
  currentTheme,
  note,
  originalCapture,
  originalCaptureLoading,
  obsidianConfigured,
  obsidianSelected,
  onClose,
  onDelete,
  onExport,
  onOrganizeLink,
  onOpenRelated,
  onReclassify,
  onSave,
  onSaveThemeOverview,
  onSuggestTheme,
  themeSourceContributions,
  themeSourcesLoading,
  themeOverview,
  themeLoading,
  relatedMemories,
  relatedMemoriesLoading,
}: {
  currentTheme: SourceThemeAssignment | null;
  note: Note | null;
  originalCapture: Note | null;
  originalCaptureLoading: boolean;
  obsidianConfigured: boolean;
  obsidianSelected: boolean;
  onClose: () => void;
  onDelete: (note: Note) => void;
  onExport: (noteId: string) => Promise<void>;
  onOrganizeLink: (
    note: Note,
    title: string,
    content: string,
    userContext: string,
  ) => Promise<void>;
  onOpenRelated: (note: Note) => void;
  onReclassify: (note: Note) => void;
  onSaveThemeOverview: (
    themeNoteId: string,
    overview: string,
  ) => Promise<void>;
  onSuggestTheme: (note: Note) => Promise<void>;
  themeSourceContributions: ThemeSourceContribution[];
  themeSourcesLoading: boolean;
  themeOverview: string;
  themeLoading: boolean;
  relatedMemories: RelatedMemory[];
  relatedMemoriesLoading: boolean;
  onSave: (
    id: string,
    title: string,
    content: string,
    userContext: string | null,
  ) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [userContext, setUserContext] = useState('');
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [linkOrganizing, setLinkOrganizing] = useState(false);
  const [editingMarkdown, setEditingMarkdown] = useState(false);
  const [originalCaptureExpanded, setOriginalCaptureExpanded] = useState(false);

  useEffect(() => {
    if (!note) return;
    setTitle(note.title);
    setContent(note.content);
    setUserContext(note.userContext ?? '');
    setEditingMarkdown(note.recordType === 'capture');
    setOriginalCaptureExpanded(false);
  }, [note]);

  const save = async () => {
    if (!note || !content.trim() || saving) return;
    setSaving(true);
    try {
      await onSave(note.id, title, content, userContext.trim() || null);
    } catch {
      Alert.alert('保存失败', '修改还在页面中，请重试。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={Boolean(note)}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.editor}
      >
        <View style={[styles.editorHeader, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={styles.editorCancel}>取消</Text>
          </Pressable>
          <Text style={styles.editorHeading}>笔记</Text>
          <Pressable
            disabled={editingMarkdown && (!content.trim() || saving)}
            onPress={() =>
              editingMarkdown ? void save() : setEditingMarkdown(true)
            }
            hitSlop={10}
          >
            <Text
              style={[
                styles.editorSave,
                editingMarkdown &&
                  (!content.trim() || saving) &&
                  styles.editorSaveDisabled,
              ]}
            >
              {editingMarkdown ? (saving ? '保存中' : '完成') : '编辑'}
            </Text>
          </Pressable>
        </View>
        <ScrollView
          contentContainerStyle={styles.editorBody}
          keyboardShouldPersistTaps="handled"
        >
          {editingMarkdown ? (
            <>
              <TextInput
                accessibilityLabel="笔记标题"
                onChangeText={setTitle}
                placeholder="标题"
                placeholderTextColor={colors.faint}
                style={styles.editorTitle}
                value={title}
              />
              <TextInput
                accessibilityLabel="笔记正文"
                multiline
                onChangeText={setContent}
                placeholder="继续写下去…"
                placeholderTextColor={colors.faint}
                style={styles.editorContent}
                textAlignVertical="top"
                value={content}
              />
            </>
          ) : note?.recordType === 'theme' ? (
            <ThemeHomepage
              contributions={themeSourceContributions}
              loading={themeSourcesLoading}
              note={note}
              onReclassify={onReclassify}
              onSaveOverview={onSaveThemeOverview}
              overview={themeOverview}
            />
          ) : (
            <View style={styles.editorMarkdownPreview}>
              <Text selectable style={styles.editorTitle}>
                {title}
              </Text>
              <View style={styles.editorMarkdownBody}>
                <MarkdownView markdown={content} />
              </View>
            </View>
          )}
          {note?.recordType === 'capture' && note.sourceUrl ? (
            <View style={styles.linkIntentCard}>
              <View style={styles.linkIntentHeading}>
                <Text style={styles.linkIntentMark}>↗</Text>
                <View style={styles.linkIntentHeadingCopy}>
                  <Text style={styles.linkIntentTitle}>为什么保存？</Text>
                  <Text style={styles.linkIntentDescription}>
                    说说它与你有什么关系，或希望 ReMind 重点整理什么。
                  </Text>
                </View>
              </View>
              <TextInput
                accessibilityLabel="链接保存意图"
                multiline
                onChangeText={setUserContext}
                placeholder="例如：重点看它如何帮助回忆，想留作产品设计参考。"
                placeholderTextColor={colors.faint}
                style={styles.linkIntentInput}
                textAlignVertical="top"
                value={userContext}
              />
              {note.status === 'failed' ? (
                <View style={styles.linkRetryNotice}>
                  <Text style={styles.linkRetryNoticeTitle}>
                    上次只在生成笔记时失败
                  </Text>
                  <Text style={styles.linkRetryNoticeBody}>
                    原始链接、保存意图和已有视频转写都已保留，重新生成不会再次转写。
                  </Text>
                </View>
              ) : null}
              <Pressable
                disabled={
                  userContext.replace(/\s+/g, '').length < 4 ||
                  linkOrganizing
                }
                onPress={async () => {
                  if (!note || linkOrganizing) return;
                  setLinkOrganizing(true);
                  try {
                    await onOrganizeLink(
                      note,
                      title,
                      content,
                      userContext.trim(),
                    );
                  } catch (error) {
                    Alert.alert(
                      '链接整理失败',
                      error instanceof Error
                        ? error.message
                        : '暂时没有完成整理，链接和描述都已保留。',
                    );
                  } finally {
                    setLinkOrganizing(false);
                  }
                }}
                style={({ pressed }) => [
                  styles.linkOrganizeButton,
                  (userContext.replace(/\s+/g, '').length < 4 ||
                    linkOrganizing) &&
                    styles.linkOrganizeButtonDisabled,
                  pressed && styles.pressed,
                ]}
              >
                {linkOrganizing ? (
                  <ActivityIndicator color={colors.white} size="small" />
                ) : (
                  <Text style={styles.linkOrganizeButtonText}>
                    {note.status === 'failed'
                      ? '重新生成可审核笔记'
                      : '生成可审核笔记'}
                  </Text>
                )}
              </Pressable>
            </View>
          ) : null}
          <View style={styles.editorAiNote}>
            <Text style={styles.editorAiMark}>记</Text>
            <View style={styles.editorAiCopy}>
              <Text style={styles.editorAiTitle}>
                {note?.recordType === 'source'
                  ? '可追溯的来源笔记'
                  : note?.recordType === 'synthesis'
                    ? '整理后的笔记'
                    : note?.recordType === 'theme'
                      ? '持续生长的主题笔记'
                    : '等待每日整理'}
              </Text>
              <Text style={styles.editorAiBody}>
                {note?.recordType === 'source'
                  ? '观点保留逐字证据和原始链接，原始捕获仍然保留。'
                  : note?.recordType === 'synthesis'
                    ? '正式笔记已生成，原始碎片仍然保留。'
                    : note?.recordType === 'theme'
                      ? '主题名称和正文都可以点击右上角“编辑”修改，保存后会同步更新。'
                    : '原文已经安全保存在这台手机上。'}
              </Text>
            </View>
          </View>
          {note?.recordType === 'source' &&
          (originalCaptureLoading || originalCapture) ? (
            <View style={styles.originalCaptureArchive}>
              <Pressable
                disabled={originalCaptureLoading}
                onPress={() =>
                  setOriginalCaptureExpanded((current) => !current)
                }
                style={({ pressed }) => [
                  styles.originalCaptureHeader,
                  pressed && styles.pressed,
                ]}
              >
                <View style={styles.originalCaptureHeaderCopy}>
                  <Text style={styles.originalCaptureEyebrow}>
                    原始记录 · 已归档
                  </Text>
                  <Text style={styles.originalCaptureHeading}>
                    {originalCaptureLoading
                      ? '正在读取最初保存的内容…'
                      : '查看最初发送的链接和描述'}
                  </Text>
                </View>
                {originalCaptureLoading ? (
                  <ActivityIndicator color={colors.accent} size="small" />
                ) : (
                  <Text style={styles.originalCaptureChevron}>
                    {originalCaptureExpanded ? '⌃' : '⌄'}
                  </Text>
                )}
              </Pressable>
              {originalCaptureExpanded && originalCapture ? (
                <View style={styles.originalCaptureBody}>
                  <Text style={styles.originalCaptureMeta}>
                    {originalCapture.source === 'wechat'
                      ? '来自微信'
                      : originalCapture.source === 'share'
                        ? '来自系统分享'
                        : '来自 ReMind'}
                    {' · '}
                    {formatNoteTime(originalCapture.createdAt)}
                  </Text>
                  <Text selectable style={styles.originalCaptureText}>
                    {originalCapture.content}
                  </Text>
                  {originalCapture.userContext &&
                  !originalCapture.content.includes(
                    originalCapture.userContext,
                  ) ? (
                    <View style={styles.originalCaptureIntent}>
                      <Text style={styles.originalCaptureIntentLabel}>
                        当时的保存意图
                      </Text>
                      <Text selectable style={styles.originalCaptureIntentText}>
                        {originalCapture.userContext}
                      </Text>
                    </View>
                  ) : null}
                  {originalCapture.sourceUrl ? (
                    <Pressable
                      hitSlop={8}
                      onPress={() =>
                        void Linking.openURL(originalCapture.sourceUrl!)
                      }
                      style={styles.originalCaptureOpen}
                    >
                      <Text style={styles.originalCaptureOpenText}>
                        打开原始链接 ↗
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : null}
          {note &&
          (note.recordType === 'source' ||
            (note.recordType === 'capture' && currentTheme)) ? (
            <Pressable
              disabled={themeLoading}
              onPress={() =>
                currentTheme
                  ? onReclassify(note)
                  : void onSuggestTheme(note)
              }
              style={({ pressed }) => [
                styles.themeSuggestButton,
                pressed && styles.pressed,
              ]}
            >
              {themeLoading ? (
                <ActivityIndicator color={colors.accent} size="small" />
              ) : (
                <>
                  <Text style={styles.themeSuggestMark}>↗</Text>
                  <View style={styles.themeSuggestCopy}>
                    <Text style={styles.themeSuggestTitle}>
                      {currentTheme
                        ? `当前主题 · ${currentTheme.themeTitle}`
                        : '整理到主题'}
                    </Text>
                    <Text style={styles.themeSuggestBody}>
                      {currentTheme
                        ? '点这里重新归类到已有主题，或新建一个主题'
                        : '建议新建或补充一篇持续生长的主题笔记'}
                    </Text>
                  </View>
                </>
              )}
            </Pressable>
          ) : null}
          {note && note.recordType !== 'theme' ? (
            <RelatedMemories
              loading={relatedMemoriesLoading}
              memories={relatedMemories}
              onOpen={onOpenRelated}
            />
          ) : null}
          {note ? (
            <Pressable
              disabled={exporting || obsidianSelected}
              onPress={async () => {
                setExporting(true);
                try {
                  await onExport(note.id);
                } catch {
                  Alert.alert('导出失败', '请检查 Obsidian 文件夹授权后重试。');
                } finally {
                  setExporting(false);
                }
              }}
              style={({ pressed }) => [
                styles.editorObsidianButton,
                obsidianSelected && styles.editorObsidianButtonDone,
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.editorObsidianButtonText,
                  obsidianSelected && styles.editorObsidianButtonTextDone,
                ]}
              >
                {exporting
                  ? '正在保存…'
                  : obsidianSelected
                    ? '✓ 已保存到 Obsidian'
                    : obsidianConfigured
                      ? '保存到 Obsidian'
                      : '设置 Obsidian 后保存'}
              </Text>
            </Pressable>
          ) : null}
          {note ? (
            <Pressable
              onPress={() => onDelete(note)}
              style={styles.deleteButton}
            >
              <Text style={styles.deleteButtonText}>删除这条笔记</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function RelatedMemories({
  loading,
  memories,
  onOpen,
}: {
  loading: boolean;
  memories: RelatedMemory[];
  onOpen: (note: Note) => void;
}) {
  if (!loading && memories.length === 0) return null;

  return (
    <View style={styles.relatedMemories}>
      <View style={styles.relatedMemoriesHeading}>
        <View>
          <Text style={styles.relatedMemoriesEyebrow}>相关记忆</Text>
          <Text style={styles.relatedMemoriesTitle}>你以前还记过这些</Text>
        </View>
        {loading ? (
          <ActivityIndicator color={colors.accent} size="small" />
        ) : (
          <Text style={styles.relatedMemoriesCount}>{memories.length} 条</Text>
        )}
      </View>
      {memories.map((memory) => (
        <Pressable
          accessibilityHint={memory.reason}
          accessibilityRole="button"
          key={memory.note.id}
          onPress={() => onOpen(memory.note)}
          style={({ pressed }) => [
            styles.relatedMemoryCard,
            pressed && styles.pressed,
          ]}
        >
          <View style={styles.relatedMemoryCopy}>
            <Text numberOfLines={2} style={styles.relatedMemoryTitle}>
              {memory.note.title}
            </Text>
            <Text style={styles.relatedMemoryReason}>{memory.reason}</Text>
            <Text style={styles.relatedMemoryMeta}>
              {formatNoteTime(memory.note.createdAt)}
              {memory.note.sourcePageSite
                ? ` · ${memory.note.sourcePageSite}`
                : ' · 整理笔记'}
            </Text>
          </View>
          <Text style={styles.relatedMemoryArrow}>↗</Text>
        </Pressable>
      ))}
    </View>
  );
}

function ThemeHomepage({
  contributions,
  loading,
  note,
  onReclassify,
  onSaveOverview,
  overview,
}: {
  contributions: ThemeSourceContribution[];
  loading: boolean;
  note: Note;
  onReclassify: (note: Note) => void;
  onSaveOverview: (themeNoteId: string, overview: string) => Promise<void>;
  overview: string;
}) {
  const [expandedSourceIds, setExpandedSourceIds] = useState<string[]>([]);
  const [viewingSource, setViewingSource] = useState<Note | null>(null);
  const [editingOverview, setEditingOverview] = useState(false);
  const [overviewDraft, setOverviewDraft] = useState('');
  const [savingOverview, setSavingOverview] = useState(false);

  useEffect(() => {
    setExpandedSourceIds([]);
    setViewingSource(null);
    setEditingOverview(false);
    setOverviewDraft(overview);
  }, [note.id]);

  useEffect(() => {
    if (!editingOverview) setOverviewDraft(overview);
  }, [editingOverview, overview]);

  const toggleSource = (sourceId: string) => {
    setExpandedSourceIds((current) =>
      current.includes(sourceId)
        ? current.filter((id) => id !== sourceId)
        : [...current, sourceId],
    );
  };

  return (
    <View style={styles.themeHomepage}>
      <Text selectable style={styles.editorTitle}>
        {note.title}
      </Text>
      <View style={styles.themeOverviewCard}>
        <View style={styles.themeOverviewHeader}>
          <View>
            <Text style={styles.themeOverviewEyebrow}>当前理解</Text>
            <Text style={styles.themeOverviewCount}>
              {loading
                ? '正在读取…'
                : `${contributions.length} 篇来源共同补充`}
            </Text>
          </View>
          {!loading && overview && !editingOverview ? (
            <Pressable
              hitSlop={8}
              onPress={() => setEditingOverview(true)}
            >
              <Text style={styles.themeOverviewEdit}>编辑</Text>
            </Pressable>
          ) : (
            <Text style={styles.themeOverviewMark}>册</Text>
          )}
        </View>
        {!loading ? (
          editingOverview ? (
            <View style={styles.themeOverviewEditor}>
              <TextInput
                accessibilityLabel="主题当前理解"
                multiline
                onChangeText={setOverviewDraft}
                placeholder="写下这个主题目前最重要的理解…"
                placeholderTextColor={colors.faint}
                style={styles.themeOverviewInput}
                textAlignVertical="top"
                value={overviewDraft}
              />
              <View style={styles.themeOverviewEditorActions}>
                <Pressable
                  disabled={savingOverview}
                  onPress={() => {
                    setOverviewDraft(overview);
                    setEditingOverview(false);
                  }}
                  style={styles.themeOverviewCancel}
                >
                  <Text style={styles.themeOverviewCancelText}>取消</Text>
                </Pressable>
                <Pressable
                  disabled={savingOverview || !overviewDraft.trim()}
                  onPress={async () => {
                    setSavingOverview(true);
                    try {
                      await onSaveOverview(note.id, overviewDraft);
                      setEditingOverview(false);
                    } catch {
                      Alert.alert('保存失败', '当前理解没有改变，请重试。');
                    } finally {
                      setSavingOverview(false);
                    }
                  }}
                  style={[
                    styles.themeOverviewSave,
                    (savingOverview || !overviewDraft.trim()) &&
                      styles.saveButtonDisabled,
                  ]}
                >
                  <Text style={styles.themeOverviewSaveText}>
                    {savingOverview ? '保存中' : '保存'}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : overview ? (
            <View style={styles.themeOverviewMarkdown}>
              <MarkdownView markdown={overview} />
            </View>
          ) : (
            <Text style={styles.themeOverviewEmpty}>
              下一篇相关来源加入时，会在审核后生成第一版当前理解。
            </Text>
          )
        ) : null}
      </View>

      {loading ? (
        <View style={styles.themeSourcesLoading}>
          <ActivityIndicator color={colors.accent} size="small" />
        </View>
      ) : contributions.length > 0 ? (
        <>
          <View style={styles.themeSourcesHeading}>
            <Text style={styles.themeSourcesTitle}>来源内容</Text>
            <Text style={styles.themeSourcesHint}>点击展开阅读</Text>
          </View>
          <View style={styles.themeSourceCards}>
            {contributions.map((item) => {
              const expanded = expandedSourceIds.includes(item.source.id);
              const sourceSite =
                item.source.sourcePageSite?.trim() || '来源笔记';
              return (
                <View key={item.source.id} style={styles.themeContributionCard}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    onPress={() => toggleSource(item.source.id)}
                    style={({ pressed }) => [
                      styles.themeContributionHeader,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View style={styles.themeContributionHeadingCopy}>
                      <Text
                        numberOfLines={expanded ? undefined : 2}
                        style={styles.themeContributionTitle}
                      >
                        {item.source.title}
                      </Text>
                      <Text style={styles.themeContributionMeta}>
                        {sourceSite} · {formatNoteTime(item.addedAt)}
                      </Text>
                    </View>
                    <Text style={styles.themeContributionChevron}>
                      {expanded ? '⌃' : '⌄'}
                    </Text>
                  </Pressable>
                  {expanded ? (
                    <>
                      <View style={styles.themeContributionMarkdown}>
                        <MarkdownView markdown={item.contribution} />
                      </View>
                      <View style={styles.themeContributionActions}>
                        <Pressable
                          hitSlop={8}
                          onPress={() => setViewingSource(item.source)}
                          style={styles.themeContributionAction}
                        >
                          <Text style={styles.themeContributionActionText}>
                            查看整理笔记
                          </Text>
                        </Pressable>
                        {item.source.sourceUrl ? (
                          <Pressable
                            hitSlop={8}
                            onPress={() =>
                              void Linking.openURL(item.source.sourceUrl!)
                            }
                            style={styles.themeContributionAction}
                          >
                            <Text style={styles.themeContributionActionText}>
                              打开原文
                            </Text>
                          </Pressable>
                        ) : null}
                        <Pressable
                          hitSlop={8}
                          onPress={() => onReclassify(item.source)}
                          style={styles.themeContributionAction}
                        >
                          <Text style={styles.themeContributionActionText}>
                            重新归类
                          </Text>
                        </Pressable>
                      </View>
                    </>
                  ) : (
                    <Text numberOfLines={3} style={styles.themeContributionPreview}>
                      {notePreview(item.contribution)}
                    </Text>
                  )}
                </View>
              );
            })}
          </View>
        </>
      ) : (
        <View style={styles.editorMarkdownBody}>
          <MarkdownView markdown={note.content} />
        </View>
      )}
      <RelatedSourceNote
        note={viewingSource}
        onClose={() => setViewingSource(null)}
      />
    </View>
  );
}

function RelatedSourceNote({
  note,
  onClose,
}: {
  note: Note | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={Boolean(note)}
    >
      <View style={styles.editor}>
        <View style={[styles.editorHeader, { paddingTop: insets.top + 8 }]}>
          <Pressable hitSlop={10} onPress={onClose}>
            <Text style={styles.editorCancel}>返回主题</Text>
          </Pressable>
          <Text style={styles.editorHeading}>整理笔记</Text>
          <View style={styles.headerSpacer} />
        </View>
        <ScrollView
          contentContainerStyle={[
            styles.editorBody,
            { paddingBottom: insets.bottom + 28 },
          ]}
        >
          <Text selectable style={styles.editorTitle}>
            {note?.title}
          </Text>
          {note?.sourcePageSite ? (
            <Text style={styles.relatedSourceMeta}>
              来源 · {note.sourcePageSite}
            </Text>
          ) : null}
          <View style={styles.editorMarkdownBody}>
            <MarkdownView markdown={note?.content ?? ''} />
          </View>
          {note?.sourceUrl ? (
            <Pressable
              onPress={() => void Linking.openURL(note.sourceUrl!)}
              style={({ pressed }) => [
                styles.relatedSourceOpen,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.relatedSourceOpenText}>打开原文</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

function QuickCapture({
  intent,
  onClose,
  onSave,
}: {
  intent: { sourceKey: string; text: string } | null;
  onClose: () => void;
  onSave: (text: string, sourceKey: string) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (intent) setText(intent.text);
  }, [intent]);

  const save = async () => {
    if (!intent || !text.trim() || saving) return;
    setSaving(true);
    try {
      await onSave(text.trim(), intent.sourceKey);
    } catch {
      Alert.alert('保存失败', '内容还在这里，请稍后重试。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={Boolean(intent)}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.quickCapture}
      >
        <View style={[styles.quickHeader, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={styles.editorCancel}>取消</Text>
          </Pressable>
          <View style={styles.quickTitleWrap}>
            <Text style={styles.quickEyebrow}>REMIND</Text>
            <Text style={styles.quickTitle}>快速收下</Text>
          </View>
          <Pressable
            disabled={!text.trim() || saving}
            onPress={() => void save()}
            hitSlop={10}
          >
            <Text
              style={[
                styles.editorSave,
                (!text.trim() || saving) && styles.editorSaveDisabled,
              ]}
            >
              {saving ? '保存中' : '保存'}
            </Text>
          </Pressable>
        </View>
        <View style={styles.quickBody}>
          <View style={styles.quickSource}>
            <Text style={styles.quickSourceMark}>↙</Text>
            <Text style={styles.quickSourceText}>来自手机快捷入口</Text>
          </View>
          <TextInput
            accessibilityLabel="快速记录内容"
            autoFocus
            multiline
            onChangeText={setText}
            placeholder="把此刻的内容留在这里…"
            placeholderTextColor={colors.faint}
            style={styles.quickInput}
            textAlignVertical="top"
            value={text}
          />
          <Text style={styles.quickHint}>内容会先离线保存在这台手机上</Text>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function OrganizationReview({
  drafts,
  error,
  onAccept,
  onClose,
  onDismiss,
  visible,
}: {
  drafts: OrganizeDraft[];
  error: string | null;
  onAccept: (
    draftId: string,
    title: string,
    content: string,
  ) => Promise<void>;
  onClose: () => void;
  onDismiss: (draftId: string) => Promise<void>;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  const draft = drafts[0] ?? null;
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingMarkdown, setEditingMarkdown] = useState(false);

  useEffect(() => {
    setTitle(draft?.title ?? '');
    setContent(normalizeEvidenceMarkerLabels(draft?.content ?? ''));
    setEditingMarkdown(false);
  }, [draft?.id]);

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.organizeSheet}
      >
        <View style={[styles.editorHeader, { paddingTop: insets.top + 8 }]}>
          <Pressable hitSlop={10} onPress={onClose}>
            <Text style={styles.editorCancel}>稍后</Text>
          </Pressable>
          <Text style={styles.editorHeading}>
            整理审核 {draft ? `1/${drafts.length}` : ''}
          </Text>
          <View style={styles.headerSpacer} />
        </View>

        {draft ? (
          <ScrollView
            contentContainerStyle={[
              styles.organizeReviewBody,
              { paddingBottom: insets.bottom + 28 },
            ]}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.organizeReviewEyebrow}>
              <Text style={styles.organizeReviewMark}>稿</Text>
              <Text style={styles.organizeReviewModel}>
                {draft.contentKind === 'link'
                  ? '链接整理稿'
                  : '今日整理稿'}
              </Text>
            </View>
            {editingMarkdown ? (
              <TextInput
                accessibilityLabel="整理稿标题"
                onChangeText={setTitle}
                placeholder="整理稿标题"
                placeholderTextColor={colors.faint}
                style={styles.organizeReviewTitle}
                value={title}
              />
            ) : (
              <Text selectable style={styles.organizeReviewTitle}>
                {title}
              </Text>
            )}
            {draft.summary ? (
              <Text style={styles.organizeReviewSummary}>{draft.summary}</Text>
            ) : null}
            <View style={styles.organizeTagRow}>
              {draft.tags.map((tag) => (
                <View key={tag} style={styles.organizeTag}>
                  <Text style={styles.organizeTagText}>#{tag}</Text>
                </View>
              ))}
              <Text style={styles.organizeSourceCount}>
                引用 {draft.sourceIds.length} 条原始记录
              </Text>
            </View>
            {draft.contentKind === 'link' ? (
              <View style={styles.sourceContextCard}>
                <Text style={styles.sourceSectionLabel}>我的保存意图</Text>
                <Text selectable style={styles.sourceContextText}>
                  {draft.userContext || '未填写'}
                </Text>
                <View style={styles.sourceMetaRow}>
                  <Text numberOfLines={1} style={styles.sourceMetaText}>
                    {[draft.sourceTitle, draft.sourceSite]
                      .filter(Boolean)
                      .join(' · ') || '原始网页'}
                  </Text>
                  {draft.sourceUrl ? (
                    <Pressable
                      hitSlop={8}
                      onPress={() => void Linking.openURL(draft.sourceUrl!)}
                    >
                      <Text style={styles.sourceOpenAction}>打开原文</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            ) : null}
            <View style={styles.markdownModeRow}>
              <Text style={styles.markdownModeLabel}>
                {editingMarkdown ? 'Markdown 原文' : '格式预览'}
              </Text>
              <Pressable
                hitSlop={8}
                onPress={() => setEditingMarkdown((current) => !current)}
              >
                <Text style={styles.markdownModeAction}>
                  {editingMarkdown ? '预览格式' : '编辑内容'}
                </Text>
              </Pressable>
            </View>
            {editingMarkdown ? (
              <TextInput
                accessibilityLabel="整理稿正文"
                multiline
                onChangeText={setContent}
                placeholder="整理稿正文"
                placeholderTextColor={colors.faint}
                style={styles.organizeReviewContent}
                textAlignVertical="top"
                value={content}
              />
            ) : (
              <View style={styles.organizeMarkdownPreview}>
                <MarkdownView markdown={content} />
              </View>
            )}
            {draft.citations.length > 0 ? (
              <View style={styles.evidenceSection}>
                <View style={styles.evidenceHeadingRow}>
                  <Text style={styles.sourceSectionLabel}>原始证据</Text>
                  <Text style={styles.evidenceCount}>
                    {draft.citations.length} 条逐字引用
                  </Text>
                </View>
                {draft.citations.map((citation, index) => (
                  <View key={citation.id} style={styles.evidenceCard}>
                    <Text style={styles.evidenceIndex}>证据 {index + 1}</Text>
                    <Text selectable style={styles.evidenceQuote}>
                      {citation.quote}
                    </Text>
                  </View>
                ))}
                <Text style={styles.evidenceHint}>
                  这些片段已由服务端核对，均可在抓取到的网页正文中找到。
                </Text>
              </View>
            ) : null}
            {error ? <Text style={styles.obsidianError}>{error}</Text> : null}
            <Pressable
              disabled={saving || !title.trim() || !content.trim()}
              onPress={async () => {
                setSaving(true);
                try {
                  await onAccept(
                    draft.id,
                    title,
                    normalizeEvidenceMarkerLabels(content),
                  );
                } catch {
                  Alert.alert('保存失败', '整理稿仍然保留，请稍后重试。');
                } finally {
                  setSaving(false);
                }
              }}
              style={({ pressed }) => [
                styles.organizeAccept,
                (saving || !title.trim() || !content.trim()) &&
                  styles.saveButtonDisabled,
                pressed && styles.pressed,
              ]}
            >
              {saving ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Text style={styles.organizeAcceptText}>
                  确认生成正式笔记
                </Text>
              )}
            </Pressable>
            <Pressable
              disabled={saving}
              onPress={() => void onDismiss(draft.id)}
              style={styles.organizeDismiss}
            >
              <Text style={styles.organizeDismissText}>不保留这篇整理稿</Text>
            </Pressable>
            <Text style={styles.organizeReviewFootnote}>
              {draft.contentKind === 'link'
                ? '你的保存意图和原始链接都会保留。'
                : '无论选择哪种方式，原始碎片都不会被删除。'}
            </Text>
          </ScrollView>
        ) : (
          <View style={styles.centerState}>
            <Text style={styles.emptyTitle}>今天整理完成</Text>
          </View>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SourceThemePicker({
  currentTheme,
  onClose,
  onConfirm,
  source,
  themes,
}: {
  currentTheme: SourceThemeAssignment | null;
  onClose: () => void;
  onConfirm: (
    targetThemeId: string | null,
    newThemeTitle: string,
  ) => Promise<void>;
  source: Note | null;
  themes: Note[];
}) {
  const insets = useSafeAreaInsets();
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [newThemeTitle, setNewThemeTitle] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!source) return;
    setSelectedThemeId(null);
    setNewThemeTitle('');
    setSaving(false);
  }, [source?.id]);

  const availableThemes = themes.filter(
    (theme) => theme.id !== currentTheme?.themeId,
  );

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={Boolean(source)}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.organizeSheet}
      >
        <View style={[styles.editorHeader, { paddingTop: insets.top + 8 }]}>
          <Pressable hitSlop={10} onPress={onClose}>
            <Text style={styles.editorCancel}>取消</Text>
          </Pressable>
          <Text style={styles.editorHeading}>重新归类</Text>
          <View style={styles.headerSpacer} />
        </View>
        <ScrollView
          contentContainerStyle={[
            styles.organizeReviewBody,
            { paddingBottom: insets.bottom + 28 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.sourceSectionLabel}>来源笔记</Text>
          <Text style={styles.organizeReviewTitle}>{source?.title}</Text>
          {currentTheme ? (
            <Text style={styles.reclassifyCurrent}>
              当前归在「{currentTheme.themeTitle}」
            </Text>
          ) : null}
          <Text style={styles.themeTargetHint}>
            选择后会移动这篇来源贡献的内容，并保留原始来源和引用。
          </Text>

          <View style={styles.themeTargetOptions}>
            <Pressable
              onPress={() => setSelectedThemeId(null)}
              style={[
                styles.themeTargetOption,
                selectedThemeId === null &&
                  styles.themeTargetOptionSelected,
              ]}
            >
              <Text
                style={[
                  styles.themeTargetOptionLabel,
                  selectedThemeId === null &&
                    styles.themeTargetOptionLabelSelected,
                ]}
              >
                ＋ 新建主题
              </Text>
            </Pressable>
            {selectedThemeId === null ? (
              <TextInput
                accessibilityLabel="自定义新主题名称"
                autoFocus
                onChangeText={setNewThemeTitle}
                placeholder="例如：拉美文学阅读"
                placeholderTextColor={colors.faint}
                style={styles.themeNameInput}
                value={newThemeTitle}
              />
            ) : null}
            {availableThemes.map((theme) => (
              <Pressable
                key={theme.id}
                onPress={() => setSelectedThemeId(theme.id)}
                style={[
                  styles.themeTargetOption,
                  selectedThemeId === theme.id &&
                    styles.themeTargetOptionSelected,
                ]}
              >
                <Text
                  numberOfLines={2}
                  style={[
                    styles.themeTargetOptionLabel,
                    selectedThemeId === theme.id &&
                      styles.themeTargetOptionLabelSelected,
                  ]}
                >
                  已有 · {theme.title}
                </Text>
              </Pressable>
            ))}
          </View>

          <Pressable
            disabled={
              saving ||
              (selectedThemeId === null && !newThemeTitle.trim())
            }
            onPress={async () => {
              setSaving(true);
              try {
                await onConfirm(selectedThemeId, newThemeTitle);
              } catch {
                Alert.alert(
                  '重新归类失败',
                  '现有主题内容没有改变，请稍后重试。',
                );
              } finally {
                setSaving(false);
              }
            }}
            style={({ pressed }) => [
              styles.organizeAccept,
              (saving ||
                (selectedThemeId === null && !newThemeTitle.trim())) &&
                styles.saveButtonDisabled,
              pressed && styles.pressed,
            ]}
          >
            {saving ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.organizeAcceptText}>确认重新归类</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ThemeMergeReview({
  drafts,
  error,
  loading,
  onAccept,
  onClose,
  onDismiss,
  themes,
  visible,
}: {
  drafts: ThemeMergeDraft[];
  error: string | null;
  loading: boolean;
  onAccept: (
    draftId: string,
    patch: string,
    overview: string,
    selectedThemeId: string | null,
    selectedThemeTitle: string,
  ) => Promise<void>;
  onClose: () => void;
  onDismiss: (draftId: string) => Promise<void>;
  themes: Note[];
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  const draft = drafts[0] ?? null;
  const [patch, setPatch] = useState('');
  const [overview, setOverview] = useState('');
  const [editing, setEditing] = useState(false);
  const [editingOverview, setEditingOverview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [newThemeTitle, setNewThemeTitle] = useState('');

  useEffect(() => {
    setPatch(draft?.patch ?? '');
    setOverview(draft?.overview ?? '');
    setEditing(false);
    setEditingOverview(false);
    setSelectedThemeId(draft?.themeNoteId ?? null);
    setNewThemeTitle(draft?.themeTitle ?? '');
  }, [draft?.id]);
  const selectedTheme = themes.find((theme) => theme.id === selectedThemeId);
  const overviewApplicable = selectedThemeId === draft?.themeNoteId;

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.organizeSheet}
      >
        <View style={[styles.editorHeader, { paddingTop: insets.top + 8 }]}>
          <Pressable hitSlop={10} onPress={onClose}>
            <Text style={styles.editorCancel}>稍后</Text>
          </Pressable>
          <Text style={styles.editorHeading}>归入长期主题</Text>
          <View style={styles.headerSpacer} />
        </View>
        {loading && !draft ? (
          <View style={styles.centerState}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.themeLoadingText}>正在寻找合适的主题…</Text>
          </View>
        ) : draft ? (
          <ScrollView
            contentContainerStyle={[
              styles.organizeReviewBody,
              { paddingBottom: insets.bottom + 28 },
            ]}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.themeDecisionPill}>
              <Text style={styles.themeDecisionText}>
                {selectedThemeId ? '找到了已有主题' : '建议新建主题'}
              </Text>
            </View>
            <View style={styles.themePurposeNotice}>
              <Text style={styles.themePurposeNoticeTitle}>
                来源笔记已经保存
              </Text>
              <Text style={styles.themePurposeNoticeBody}>
                这一步只会新建或更新一个长期主题主页，不会再生成一篇相同的来源笔记。
              </Text>
            </View>
            <Text selectable style={styles.organizeReviewTitle}>
              {(selectedTheme?.title ?? newThemeTitle) || draft.themeTitle}
            </Text>
            <Text style={styles.organizeReviewSummary}>{draft.rationale}</Text>

            <View style={styles.themeTargetSection}>
              <Text style={styles.sourceSectionLabel}>选择合并目标</Text>
              <Text style={styles.themeTargetHint}>
                已找到一个建议主题，你可以在确认前改选。
              </Text>
              <View style={styles.themeTargetOptions}>
                <Pressable
                  onPress={() => setSelectedThemeId(null)}
                  style={[
                    styles.themeTargetOption,
                    selectedThemeId === null &&
                      styles.themeTargetOptionSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.themeTargetOptionLabel,
                      selectedThemeId === null &&
                        styles.themeTargetOptionLabelSelected,
                    ]}
                  >
                    新建 · {draft.themeTitle}
                  </Text>
                </Pressable>
                {selectedThemeId === null ? (
                  <TextInput
                    accessibilityLabel="新主题名称"
                    autoCapitalize="sentences"
                    onChangeText={setNewThemeTitle}
                    placeholder="输入新主题名称"
                    placeholderTextColor={colors.faint}
                    style={styles.themeNameInput}
                    value={newThemeTitle}
                  />
                ) : null}
                {themes.slice(0, 8).map((theme) => (
                  <Pressable
                    key={theme.id}
                    onPress={() => setSelectedThemeId(theme.id)}
                    style={[
                      styles.themeTargetOption,
                      selectedThemeId === theme.id &&
                        styles.themeTargetOptionSelected,
                    ]}
                  >
                    <Text
                      numberOfLines={2}
                      style={[
                        styles.themeTargetOptionLabel,
                        selectedThemeId === theme.id &&
                          styles.themeTargetOptionLabelSelected,
                      ]}
                    >
                      已有 · {theme.title}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={styles.themeSourceCard}>
              <Text style={styles.sourceSectionLabel}>本次来源</Text>
              <View style={styles.sourceMetaRow}>
                <Text numberOfLines={2} style={styles.themeSourceTitle}>
                  {draft.sourceTitle}
                </Text>
                {draft.sourceUrl ? (
                  <Pressable
                    hitSlop={8}
                    onPress={() => void Linking.openURL(draft.sourceUrl!)}
                  >
                    <Text style={styles.sourceOpenAction}>打开原文</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>

            {draft.conflicts.length > 0 ? (
              <View style={styles.themeConflictCard}>
                <Text style={styles.themeConflictTitle}>需要留意的冲突</Text>
                {draft.conflicts.map((conflict) => (
                  <Text key={conflict} style={styles.themeConflictText}>
                    · {conflict}
                  </Text>
                ))}
              </View>
            ) : null}

            <View style={styles.markdownModeRow}>
              <Text style={styles.markdownModeLabel}>将加入主题的内容</Text>
              <Pressable hitSlop={8} onPress={() => setEditing(!editing)}>
                <Text style={styles.markdownModeAction}>
                  {editing ? '预览格式' : '编辑 patch'}
                </Text>
              </Pressable>
            </View>
            {editing ? (
              <TextInput
                accessibilityLabel="主题笔记修改内容"
                multiline
                onChangeText={setPatch}
                placeholder="要加入主题笔记的内容"
                placeholderTextColor={colors.faint}
                style={styles.organizeReviewContent}
                textAlignVertical="top"
                value={patch}
              />
            ) : (
              <View style={styles.organizeMarkdownPreview}>
                <MarkdownView markdown={patch} />
              </View>
            )}
            <View style={styles.markdownModeRow}>
              <Text style={styles.markdownModeLabel}>
                更新后的当前理解
              </Text>
              {overviewApplicable && overview ? (
                <Pressable
                  hitSlop={8}
                  onPress={() => setEditingOverview(!editingOverview)}
                >
                  <Text style={styles.markdownModeAction}>
                    {editingOverview ? '预览格式' : '编辑概览'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {!overviewApplicable ? (
              <View style={styles.themeOverviewSkipped}>
                <Text style={styles.themeOverviewSkippedText}>
                  你改选了其他主题。本次仍会加入来源内容，但不会套用针对原建议主题生成的概览。
                </Text>
              </View>
            ) : editingOverview ? (
              <TextInput
                accessibilityLabel="更新后的主题概览"
                multiline
                onChangeText={setOverview}
                placeholder="主题当前理解"
                placeholderTextColor={colors.faint}
                style={styles.organizeReviewContent}
                textAlignVertical="top"
                value={overview}
              />
            ) : overview ? (
              <View style={styles.themeOverviewReview}>
                <MarkdownView markdown={overview} />
              </View>
            ) : (
              <View style={styles.themeOverviewSkipped}>
                <Text style={styles.themeOverviewSkippedText}>
                  这份旧建议稿没有概览，确认后只更新来源内容。
                </Text>
              </View>
            )}
            {error ? <Text style={styles.obsidianError}>{error}</Text> : null}
            <Pressable
              disabled={
                saving ||
                !patch.trim() ||
                (selectedThemeId === null && !newThemeTitle.trim())
              }
              onPress={async () => {
                setSaving(true);
                try {
                  await onAccept(
                    draft.id,
                    patch,
                    overviewApplicable ? overview : '',
                    selectedThemeId,
                    selectedTheme?.title ?? newThemeTitle,
                  );
                } catch {
                  Alert.alert('合并失败', '主题笔记没有改变，建议稿仍然保留。');
                } finally {
                  setSaving(false);
                }
              }}
              style={({ pressed }) => [
                styles.organizeAccept,
                (saving ||
                  !patch.trim() ||
                  (selectedThemeId === null && !newThemeTitle.trim())) &&
                  styles.saveButtonDisabled,
                pressed && styles.pressed,
              ]}
            >
              {saving ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Text style={styles.organizeAcceptText}>
                  {selectedThemeId ? '确认补充主题' : '确认创建主题'}
                </Text>
              )}
            </Pressable>
            <Pressable
              disabled={saving}
              onPress={() => void onDismiss(draft.id)}
              style={styles.organizeDismiss}
            >
              <Text style={styles.organizeDismissText}>暂不加入主题</Text>
            </Pressable>
            <Text style={styles.organizeReviewFootnote}>
              只有确认后才会修改主题笔记，来源笔记始终独立保留。
            </Text>
          </ScrollView>
        ) : (
          <View style={styles.centerState}>
            <Text style={styles.emptyTitle}>没有待审核的主题建议</Text>
          </View>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ObsidianSettings({
  error,
  loading,
  onChoose,
  onCleanup,
  onClose,
  onExportData,
  onImportData,
  onSync,
  status,
  visible,
}: {
  error: string | null;
  loading: boolean;
  onChoose: () => Promise<void>;
  onCleanup: () => void;
  onClose: () => void;
  onExportData: () => Promise<void>;
  onImportData: () => Promise<void>;
  onSync: () => Promise<void>;
  status: ObsidianSyncStatus;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <View style={styles.obsidianSheet}>
        <View style={[styles.editorHeader, { paddingTop: insets.top + 8 }]}>
          <Pressable hitSlop={10} onPress={onClose}>
            <Text style={styles.editorCancel}>关闭</Text>
          </Pressable>
          <Text style={styles.editorHeading}>Obsidian 备份</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView
          contentContainerStyle={[
            styles.obsidianBody,
            { paddingBottom: insets.bottom + 28 },
          ]}
        >
          <View style={styles.obsidianHeroMark}>
            <Text style={styles.obsidianHeroMarkText}>库</Text>
          </View>
          <Text style={styles.obsidianTitle}>
            {status.configured ? '只把值得留下的放进 Vault' : '把记录留在自己手里'}
          </Text>
          <Text style={styles.obsidianBodyCopy}>
            随手记先留在 ReMind。只有你手动选择，或整理完成的笔记，才会进入 Obsidian。
          </Text>

          {status.configured ? (
            <View style={styles.obsidianStatusCard}>
              <Text style={styles.obsidianFolderLabel}>当前目录</Text>
              <Text selectable style={styles.obsidianFolderName}>
                {status.directoryName ?? 'ReMind/Inbox'}
              </Text>
              <View style={styles.obsidianStats}>
                <ObsidianStat label="已同步" value={status.exported} />
                <ObsidianStat label="待同步" value={status.pending} />
                <ObsidianStat label="失败" value={status.failed} />
              </View>
            </View>
          ) : (
            <View style={styles.obsidianGuide}>
              <Text style={styles.obsidianGuideTitle}>首次设置</Text>
              <Text style={styles.obsidianGuideLine}>
                1. 在系统窗口中选择 Obsidian Vault 根目录
              </Text>
              <Text style={styles.obsidianGuideLine}>
                2. ReMind 自动创建 ReMind/Inbox
              </Text>
              <Text style={styles.obsidianGuideLine}>
                3. 在笔记详情中选择“保存到 Obsidian”
              </Text>
            </View>
          )}

          {error ? <Text style={styles.obsidianError}>{error}</Text> : null}

          <Pressable
            disabled={loading}
            onPress={() => void onChoose()}
            style={({ pressed }) => [
              styles.obsidianPrimary,
              loading && styles.wechatRefreshDisabled,
              pressed && styles.pressed,
            ]}
          >
            {loading ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.obsidianPrimaryText}>
                {status.configured ? '重新选择 Vault' : '选择 Obsidian Vault'}
              </Text>
            )}
          </Pressable>

          {status.configured ? (
            <Pressable
              disabled={loading}
              onPress={() => void onSync()}
              style={({ pressed }) => [
                styles.obsidianSecondary,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.obsidianSecondaryText}>立即同步</Text>
            </Pressable>
          ) : null}

          {status.rawExports > 0 ? (
            <Pressable
              disabled={loading}
              onPress={onCleanup}
              style={({ pressed }) => [
                styles.obsidianCleanup,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.obsidianCleanupText}>
                清理刚才导出的 {status.rawExports} 条原始记录
              </Text>
            </Pressable>
          ) : null}

          <View style={styles.dataTransferCard}>
            <Text style={styles.dataTransferEyebrow}>数据迁移</Text>
            <Text style={styles.dataTransferTitle}>把旧记录带到独立版</Text>
            <Text style={styles.dataTransferCopy}>
              先在 Expo Go 里导出 JSON，再在独立版选择同一个文件导入。导入只补充缺少的数据，不会覆盖或重复已有笔记。
            </Text>
            <View style={styles.dataTransferActions}>
              <Pressable
                disabled={loading}
                onPress={() => void onExportData()}
                style={({ pressed }) => [
                  styles.dataTransferButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.dataTransferButtonText}>导出数据</Text>
              </Pressable>
              <Pressable
                disabled={loading}
                onPress={() => void onImportData()}
                style={({ pressed }) => [
                  styles.dataTransferButton,
                  styles.dataTransferImportButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={[
                    styles.dataTransferButtonText,
                    styles.dataTransferImportText,
                  ]}
                >
                  导入备份
                </Text>
              </Pressable>
            </View>
          </View>

          <Text style={styles.obsidianFootnote}>
            手动保存过的笔记会持续更新；删除时只标记 archived。
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

function startOfTodayIso(): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function ObsidianStat({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <View style={styles.obsidianStat}>
      <Text style={styles.obsidianStatValue}>{value}</Text>
      <Text style={styles.obsidianStatLabel}>{label}</Text>
    </View>
  );
}

function WechatBinding({
  connection,
  error,
  loading,
  onClose,
  onRefresh,
  onReplyModeChange,
  visible,
}: {
  connection: WechatConnection | null;
  error: string | null;
  loading: boolean;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onReplyModeChange: (replyMode: WechatReplyMode) => Promise<void>;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <View style={styles.wechatSheet}>
        <View style={[styles.editorHeader, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={styles.editorCancel}>关闭</Text>
          </Pressable>
          <Text style={styles.editorHeading}>连接微信</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView
          contentContainerStyle={[
            styles.wechatBodyContent,
            { paddingBottom: insets.bottom + 24 },
          ]}
          style={styles.wechatBody}
        >
          <View style={styles.wechatHero}>
            <View style={styles.wechatHeroMark}>
              <Text style={styles.wechatHeroMarkText}>微</Text>
            </View>
            <Text style={styles.wechatHeroTitle}>
              {connection?.bound ? '微信已经连接' : '把微信变成记录入口'}
            </Text>
            <Text style={styles.wechatHeroBody}>
              {connection?.bound
                ? '现在向 ReMind 微信助手发送文字，内容会自动出现在 App。'
                : '把下面的六位码交给电脑端微信网关，只需配对一次。'}
            </Text>
          </View>

          {loading ? (
            <View style={styles.wechatLoading}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.wechatLoadingText}>正在连接服务…</Text>
            </View>
          ) : error ? (
            <View style={styles.wechatError}>
              <Text style={styles.wechatErrorTitle}>{error}</Text>
              <Text style={styles.wechatErrorBody}>
                微信接收服务尚未发布完成，请稍后重试。
              </Text>
            </View>
          ) : connection?.bound ? (
            <View>
              <View style={styles.wechatSuccess}>
                <View style={styles.wechatSuccessDot} />
                <Text style={styles.wechatSuccessText}>同步已开启</Text>
              </View>
              <View style={styles.serviceStatusCard}>
                <Text style={styles.serviceStatusTitle}>运行状态</Text>
                <ServiceStatusRow
                  available={connection.gatewayOnline}
                  label="微信网关"
                  unavailableLabel="未运行"
                />
                <ServiceStatusRow
                  available={connection.aiAvailable}
                  label="笔记整理"
                  unavailableLabel="需要检查配置"
                />
                <ServiceStatusRow
                  available={connection.localWhisperAvailable}
                  label="本地 Whisper"
                  unavailableLabel={
                    connection.gatewayOnline ? '将使用云端兜底' : '等待网关'
                  }
                />
                <ServiceStatusRow
                  available={connection.visionAvailable}
                  label="图片理解"
                  unavailableLabel="未配置"
                />
              </View>
              <View style={styles.replyModeCard}>
                <Text style={styles.replyModeTitle}>记录后的微信回复</Text>
                <Text style={styles.replyModeDescription}>
                  内容无论选择哪种方式都会正常保存
                </Text>
                {(
                  [
                    ['first', '首次确认', '第一次回复，之后静默'],
                    ['always', '每次确认', '每条记录都回复已记下'],
                    ['silent', '静默记录', '只保存，不发送回复'],
                  ] as const
                ).map(([value, title, description]) => {
                  const selected = connection.replyMode === value;
                  return (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      key={value}
                      onPress={() => void onReplyModeChange(value)}
                      style={({ pressed }) => [
                        styles.replyModeOption,
                        selected && styles.replyModeOptionSelected,
                        pressed && styles.pressed,
                      ]}
                    >
                      <View
                        style={[
                          styles.replyModeRadio,
                          selected && styles.replyModeRadioSelected,
                        ]}
                      >
                        {selected ? (
                          <View style={styles.replyModeRadioDot} />
                        ) : null}
                      </View>
                      <View style={styles.replyModeCopy}>
                        <Text style={styles.replyModeOptionTitle}>{title}</Text>
                        <Text style={styles.replyModeOptionDescription}>
                          {description}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : connection?.bindingCode ? (
            <View style={styles.bindingCard}>
              <Text style={styles.bindingLabel}>网关配对码</Text>
              <Text
                adjustsFontSizeToFit
                maxFontSizeMultiplier={1.15}
                minimumFontScale={0.72}
                numberOfLines={1}
                selectable
                style={styles.bindingCommand}
              >
                {connection.bindingCode}
              </Text>
              <Text style={styles.bindingExpiry}>绑定码 30 分钟内有效</Text>
            </View>
          ) : (
            <View style={styles.wechatError}>
              <Text style={styles.wechatErrorTitle}>服务还未配置</Text>
              <Text style={styles.wechatErrorBody}>
                完成微信接收服务部署后，这里会自动生成绑定码。
              </Text>
            </View>
          )}

          <Pressable
            disabled={loading}
            onPress={() => void onRefresh()}
            style={({ pressed }) => [
              styles.wechatRefresh,
              loading && styles.wechatRefreshDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.wechatRefreshText}>
              {connection?.bound ? '立即同步' : '我已配对，检查状态'}
            </Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

function ServiceStatusRow({
  available,
  label,
  unavailableLabel,
}: {
  available: boolean;
  label: string;
  unavailableLabel: string;
}) {
  return (
    <View style={styles.serviceStatusRow}>
      <View
        style={[
          styles.serviceStatusDot,
          !available && styles.serviceStatusDotUnavailable,
        ]}
      />
      <Text style={styles.serviceStatusLabel}>{label}</Text>
      <Text
        style={[
          styles.serviceStatusValue,
          !available && styles.serviceStatusValueUnavailable,
        ]}
      >
        {available ? '可用' : unavailableLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  app: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  scrollHeader: {
    paddingBottom: 4,
  },
  header: {
    paddingHorizontal: 22,
    paddingBottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: {
    color: colors.ink,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  brandSub: {
    marginTop: 3,
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.5,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  obsidianBadge: {
    position: 'relative',
    width: 40,
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
  obsidianBadgeConfigured: {
    borderColor: colors.sage,
    backgroundColor: colors.sage,
  },
  obsidianBadgeMark: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '800',
  },
  wechatBadge: {
    position: 'relative',
    width: 40,
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
  wechatBadgeBound: {
    backgroundColor: colors.sage,
  },
  wechatBadgeMark: {
    color: colors.sageText,
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
  },
  headerStatusDot: {
    position: 'absolute',
    right: 5,
    bottom: 5,
    width: 6,
    height: 6,
    borderWidth: 1,
    borderColor: colors.surface,
    borderRadius: 3,
    backgroundColor: colors.faint,
  },
  headerStatusDotActive: {
    backgroundColor: colors.accent,
  },
  captureShell: {
    height: 184,
    marginHorizontal: 18,
    position: 'relative',
  },
  captureOffsetOutline: {
    position: 'absolute',
    top: 2,
    right: 0,
    bottom: -2,
    left: 2,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 23,
    borderStyle: 'dashed',
    opacity: 0.5,
    transform: [{ rotate: '-0.3deg' }],
  },
  capture: {
    height: 178,
    padding: 18,
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderRadius: 22,
    backgroundColor: colors.surface,
    transform: [{ rotate: '0.18deg' }],
  },
  capturePin: {
    position: 'absolute',
    top: -11,
    left: '50%',
    zIndex: 4,
    width: 26,
    height: 21,
    marginLeft: -13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 11,
    backgroundColor: colors.apricot,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 2,
    elevation: 4,
  },
  capturePinDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  captureLabel: {
    alignSelf: 'flex-start',
    marginBottom: 8,
    paddingHorizontal: 9,
    paddingVertical: 4,
    overflow: 'hidden',
    borderRadius: 8,
    color: colors.sageText,
    backgroundColor: colors.sage,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  captureInput: {
    height: 76,
    minHeight: 76,
    maxHeight: 76,
    color: colors.ink,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 20,
    fontWeight: '400',
    lineHeight: 30,
  },
  captureFooter: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  captureHint: {
    color: colors.faint,
    fontSize: 12,
    fontWeight: '600',
  },
  saveButton: {
    minWidth: 72,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.accent,
  },
  saveButtonDisabled: {
    backgroundColor: colors.line,
  },
  pressed: {
    transform: [{ scale: 0.97 }],
    opacity: 0.88,
  },
  saveButtonText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '800',
  },
  searchWrap: {
    height: 54,
    marginHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  searchIcon: {
    color: colors.muted,
    fontSize: 24,
  },
  searchInput: {
    flex: 1,
    color: colors.ink,
    fontSize: 16,
  },
  clearSearch: {
    color: colors.muted,
    fontSize: 24,
    lineHeight: 28,
  },
  processingPanel: {
    marginTop: 14,
    marginHorizontal: 18,
    padding: 14,
    gap: 9,
    borderWidth: 1,
    borderColor: '#CDD7CF',
    borderRadius: 16,
    backgroundColor: '#F4F7F2',
  },
  processingPanelHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  processingPanelTitle: {
    color: colors.sageText,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  processingPanelCount: {
    minWidth: 19,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
    borderRadius: 7,
    color: colors.muted,
    backgroundColor: colors.surface,
    fontSize: 10,
    fontWeight: '800',
    textAlign: 'center',
  },
  processingCard: {
    paddingTop: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#D8DED7',
  },
  processingCardTop: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  processingCardCopy: {
    flex: 1,
  },
  processingCardTitle: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
  },
  processingCardStatus: {
    marginTop: 4,
    color: colors.muted,
    fontSize: 11,
  },
  processingRetry: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 9,
    backgroundColor: colors.surface,
  },
  processingRetryText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '900',
  },
  processingApprove: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 9,
    backgroundColor: colors.accent,
  },
  processingApproveText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '900',
  },
  processingTrack: {
    height: 4,
    marginTop: 8,
    overflow: 'hidden',
    borderRadius: 2,
    backgroundColor: '#DEE5DD',
  },
  processingFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  sectionHeader: {
    marginTop: 24,
    marginBottom: 12,
    paddingHorizontal: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionTitle: {
    color: colors.ink,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 17,
    fontWeight: '700',
  },
  sectionCount: {
    minWidth: 22,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
    borderRadius: 8,
    color: colors.muted,
    backgroundColor: colors.line,
    fontSize: 11,
    fontWeight: '800',
    textAlign: 'center',
  },
  organizeButton: {
    minWidth: 94,
    height: 34,
    marginLeft: 'auto',
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 12,
    backgroundColor: colors.accentSoft,
  },
  organizeButtonDisabled: {
    opacity: 0.55,
  },
  organizeButtonMark: {
    color: colors.accent,
    fontSize: 13,
  },
  organizeButtonText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '800',
  },
  categoryBar: {
    flexGrow: 0,
    flexShrink: 0,
    height: 46,
    marginBottom: 12,
  },
  categoryBarContent: {
    paddingHorizontal: 18,
    paddingVertical: 6,
    gap: 8,
  },
  deletedThemeRow: {
    marginHorizontal: 18,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: '#DED9CD',
    borderRadius: 13,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  deletedThemeCopy: {
    flex: 1,
  },
  deletedThemeEyebrow: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  deletedThemeTitle: {
    marginTop: 3,
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
  },
  deletedThemeRestore: {
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.sage,
  },
  deletedThemeRestoreText: {
    color: colors.sageText,
    fontSize: 12,
    fontWeight: '800',
  },
  recallSpotlightLoading: {
    minHeight: 68,
    marginHorizontal: 18,
    marginBottom: 14,
    paddingHorizontal: 15,
    borderWidth: 1,
    borderColor: '#D9DDD5',
    borderRadius: 15,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  recallSpotlightLoadingText: {
    flex: 1,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  recallSpotlight: {
    marginHorizontal: 18,
    marginBottom: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#C9D5C7',
    borderRadius: 18,
    backgroundColor: colors.sage,
  },
  recallSpotlightHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  recallSpotlightEyebrow: {
    color: colors.sageText,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  recallSpotlightHeading: {
    marginTop: 3,
    color: colors.sageText,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 18,
    fontWeight: '700',
  },
  recallSpotlightMark: {
    width: 31,
    height: 31,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#B9C8B6',
    borderRadius: 16,
    color: colors.sageText,
    backgroundColor: colors.surface,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 29,
    textAlign: 'center',
  },
  recallSpotlightTitle: {
    marginTop: 15,
    color: colors.ink,
    fontSize: 16,
    fontWeight: '900',
    lineHeight: 23,
  },
  recallSpotlightReason: {
    marginTop: 7,
    color: colors.sageText,
    fontSize: 12,
    lineHeight: 18,
  },
  recallSpotlightMeta: {
    marginTop: 8,
  },
  recallSpotlightMetaText: {
    color: colors.muted,
    fontSize: 11,
  },
  recallSpotlightActions: {
    marginTop: 14,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 9,
  },
  recallSpotlightSnooze: {
    minHeight: 38,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#BCC8BA',
    borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  recallSpotlightSnoozeText: {
    color: colors.sageText,
    fontSize: 12,
    fontWeight: '800',
  },
  recallSpotlightOpen: {
    minHeight: 38,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 11,
    backgroundColor: colors.accent,
  },
  recallSpotlightOpenText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '900',
  },
  categoryChip: {
    minHeight: 34,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 11,
    backgroundColor: colors.surface,
  },
  categoryChipActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  categoryChipText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  categoryChipTextActive: {
    color: colors.accent,
  },
  categoryChipCount: {
    color: colors.faint,
    fontSize: 10,
    fontWeight: '800',
  },
  categoryChipCountActive: {
    color: colors.sageText,
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listContent: {
    paddingBottom: 128,
  },
  noteItemWrap: {
    paddingHorizontal: 18,
  },
  listLoadingState: {
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteSectionTitle: {
    marginTop: 8,
    marginBottom: 9,
    paddingHorizontal: 21,
    color: colors.faint,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  emptyListContent: {
    flexGrow: 1,
  },
  noteCardStack: {
    position: 'relative',
    marginBottom: 16,
    paddingBottom: 5,
  },
  noteCardBack: {
    position: 'absolute',
    top: 5,
    right: -2,
    bottom: 0,
    left: 5,
    borderWidth: 1,
    borderColor: '#C4CCC5',
    borderRadius: 18,
    backgroundColor: '#E9ECE6',
    opacity: 0.88,
    transform: [{ rotate: '-0.35deg' }],
  },
  noteCard: {
    position: 'relative',
    padding: 17,
    paddingTop: 19,
    borderWidth: 1.2,
    borderColor: '#C3CAC4',
    borderRadius: 18,
    backgroundColor: colors.surface,
    shadowColor: '#47534E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.035,
    shadowRadius: 10,
    elevation: 1,
  },
  noteCardCapture: {
    backgroundColor: colors.surface,
  },
  noteCardSource: {
    backgroundColor: '#F8FBF9',
  },
  noteCardSynthesis: {
    backgroundColor: '#FAF8FC',
  },
  noteCardTheme: {
    backgroundColor: '#F8FAF5',
  },
  noteCardTab: {
    position: 'absolute',
    top: -1,
    left: 18,
    width: 42,
    height: 5,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 4,
  },
  noteCardTabCapture: {
    backgroundColor: colors.apricot,
  },
  noteCardTabSource: {
    backgroundColor: colors.mist,
  },
  noteCardTabSynthesis: {
    backgroundColor: colors.lavender,
  },
  noteCardTabTheme: {
    backgroundColor: colors.sage,
  },
  noteCardPressed: {
    transform: [{ scale: 0.988 }],
    backgroundColor: '#FAF5EB',
  },
  noteTopline: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 12,
  },
  noteTitle: {
    flex: 1,
    color: colors.ink,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0,
  },
  noteTime: {
    color: colors.faint,
    fontSize: 11,
    fontWeight: '600',
  },
  notePreview: {
    marginTop: 8,
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21,
  },
  noteMeta: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  noteCategories: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 7,
  },
  pendingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 9,
    backgroundColor: colors.accentSoft,
  },
  pendingDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  pendingText: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '800',
  },
  readyPill: {
    backgroundColor: colors.sage,
  },
  readyDot: {
    backgroundColor: colors.sageText,
  },
  readyText: {
    color: colors.sageText,
  },
  kindPill: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 9,
    backgroundColor: colors.line,
  },
  kindPillText: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '800',
  },
  linkStatePill: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 9,
    backgroundColor: colors.accentSoft,
  },
  linkStatePillReady: {
    backgroundColor: colors.sage,
  },
  linkStatePillText: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '800',
  },
  linkStatePillTextReady: {
    color: colors.sageText,
  },
  noteArrow: {
    color: colors.faint,
    fontSize: 18,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 42,
    paddingBottom: 56,
  },
  emptyMark: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 18,
    backgroundColor: colors.accentSoft,
  },
  emptyMarkText: {
    color: colors.accent,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 22,
  },
  emptyTitle: {
    marginTop: 18,
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
  },
  emptyBody: {
    marginTop: 7,
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  emptyAction: {
    marginTop: 18,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 13,
    backgroundColor: colors.accent,
  },
  emptyActionText: {
    color: colors.paper,
    fontSize: 13,
    fontWeight: '800',
  },
  tabBar: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    paddingTop: 10,
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: 'rgba(246, 244, 237, 0.97)',
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  tabIcon: {
    color: colors.faint,
    fontSize: 25,
    fontWeight: '500',
    lineHeight: 28,
  },
  tabIconActive: {
    color: colors.accent,
  },
  tabLabel: {
    color: colors.faint,
    fontSize: 11,
    fontWeight: '700',
  },
  tabLabelActive: {
    color: colors.ink,
  },
  editor: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  editorHeader: {
    paddingHorizontal: 20,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  editorCancel: {
    minWidth: 54,
    color: colors.muted,
    fontSize: 15,
    fontWeight: '600',
  },
  editorHeading: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  editorSave: {
    minWidth: 54,
    color: colors.accent,
    fontSize: 15,
    fontWeight: '800',
    textAlign: 'right',
  },
  editorSaveDisabled: {
    color: colors.faint,
  },
  editorBody: {
    flexGrow: 1,
    padding: 22,
  },
  editorTitle: {
    color: colors.ink,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  editorContent: {
    minHeight: 220,
    marginTop: 18,
    color: colors.ink,
    fontSize: 17,
    lineHeight: 28,
  },
  editorMarkdownPreview: {
    paddingBottom: 8,
  },
  editorMarkdownBody: {
    marginTop: 22,
  },
  originalCaptureArchive: {
    marginTop: 14,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#C8CEC3',
    borderRadius: 15,
    backgroundColor: '#F7F6F0',
    overflow: 'hidden',
  },
  originalCaptureHeader: {
    minHeight: 68,
    paddingHorizontal: 15,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  originalCaptureHeaderCopy: {
    flex: 1,
  },
  originalCaptureEyebrow: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  originalCaptureHeading: {
    marginTop: 4,
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
  },
  originalCaptureChevron: {
    color: colors.muted,
    fontSize: 16,
    fontWeight: '800',
  },
  originalCaptureBody: {
    paddingHorizontal: 15,
    paddingTop: 13,
    paddingBottom: 15,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#D8D8D0',
  },
  originalCaptureMeta: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
  },
  originalCaptureText: {
    marginTop: 10,
    color: colors.ink,
    fontSize: 13,
    lineHeight: 20,
  },
  originalCaptureIntent: {
    marginTop: 12,
    padding: 11,
    borderRadius: 11,
    backgroundColor: colors.sage,
  },
  originalCaptureIntentLabel: {
    color: colors.sageText,
    fontSize: 10,
    fontWeight: '900',
  },
  originalCaptureIntentText: {
    marginTop: 4,
    color: colors.sageText,
    fontSize: 12,
    lineHeight: 18,
  },
  originalCaptureOpen: {
    alignSelf: 'flex-start',
    marginTop: 13,
    paddingVertical: 4,
  },
  originalCaptureOpenText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '900',
  },
  relatedMemories: {
    marginTop: 20,
    paddingTop: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    gap: 10,
  },
  relatedMemoriesHeading: {
    marginBottom: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  relatedMemoriesEyebrow: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  relatedMemoriesTitle: {
    marginTop: 4,
    color: colors.ink,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 19,
    fontWeight: '700',
  },
  relatedMemoriesCount: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  relatedMemoryCard: {
    minHeight: 94,
    paddingHorizontal: 15,
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: '#D7D8CF',
    borderRadius: 15,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  relatedMemoryCopy: {
    flex: 1,
  },
  relatedMemoryTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
    lineHeight: 21,
  },
  relatedMemoryReason: {
    marginTop: 6,
    color: colors.sageText,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 17,
  },
  relatedMemoryMeta: {
    marginTop: 4,
    color: colors.muted,
    fontSize: 11,
  },
  relatedMemoryArrow: {
    color: colors.accent,
    fontSize: 20,
    fontWeight: '600',
  },
  themeHomepage: {
    paddingBottom: 8,
  },
  themeOverviewCard: {
    marginTop: 18,
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderWidth: 1,
    borderColor: '#CDD8CA',
    borderRadius: 16,
    backgroundColor: colors.sage,
  },
  themeOverviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  themeOverviewEyebrow: {
    color: colors.sageText,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  themeOverviewCount: {
    marginTop: 4,
    color: colors.sageText,
    fontSize: 14,
    fontWeight: '800',
  },
  themeOverviewMark: {
    color: colors.sageText,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 18,
  },
  themeOverviewEdit: {
    color: colors.sageText,
    fontSize: 12,
    fontWeight: '800',
    textDecorationLine: 'underline',
  },
  themeOverviewMarkdown: {
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#C8D3C5',
  },
  themeOverviewEmpty: {
    marginTop: 14,
    color: colors.sageText,
    fontSize: 13,
    lineHeight: 20,
    opacity: 0.78,
  },
  themeOverviewEditor: {
    marginTop: 14,
  },
  themeOverviewInput: {
    minHeight: 180,
    padding: 13,
    borderWidth: 1,
    borderColor: '#BAC8B7',
    borderRadius: 12,
    color: colors.ink,
    backgroundColor: colors.surface,
    fontSize: 14,
    lineHeight: 22,
  },
  themeOverviewEditorActions: {
    marginTop: 10,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  themeOverviewCancel: {
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  themeOverviewCancelText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  themeOverviewSave: {
    minWidth: 66,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: colors.accent,
  },
  themeOverviewSaveText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '800',
  },
  themeSourcesLoading: {
    minHeight: 130,
    alignItems: 'center',
    justifyContent: 'center',
  },
  themeSourcesHeading: {
    marginTop: 25,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  themeSourcesTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '900',
  },
  themeSourcesHint: {
    color: colors.faint,
    fontSize: 11,
    fontWeight: '600',
  },
  themeSourceCards: {
    gap: 10,
  },
  themeContributionCard: {
    overflow: 'hidden',
    borderWidth: 1.2,
    borderColor: '#AEB8B1',
    borderRadius: 15,
    backgroundColor: colors.surface,
  },
  themeContributionHeader: {
    paddingHorizontal: 15,
    paddingTop: 15,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  themeContributionHeadingCopy: {
    flex: 1,
  },
  themeContributionTitle: {
    color: colors.ink,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 21,
  },
  themeContributionMeta: {
    marginTop: 5,
    color: colors.faint,
    fontSize: 11,
    fontWeight: '600',
  },
  themeContributionChevron: {
    color: colors.accent,
    fontSize: 18,
    fontWeight: '800',
    lineHeight: 21,
  },
  themeContributionPreview: {
    paddingHorizontal: 15,
    paddingTop: 10,
    paddingBottom: 15,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 20,
  },
  themeContributionMarkdown: {
    paddingHorizontal: 15,
    paddingTop: 14,
    paddingBottom: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  themeContributionActions: {
    paddingHorizontal: 15,
    paddingVertical: 13,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  themeContributionAction: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.accentSoft,
  },
  themeContributionActionText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '800',
  },
  relatedSourceMeta: {
    marginTop: 8,
    color: colors.faint,
    fontSize: 12,
    fontWeight: '700',
  },
  relatedSourceOpen: {
    height: 48,
    marginTop: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    backgroundColor: colors.accent,
  },
  relatedSourceOpenText: {
    color: colors.paper,
    fontSize: 13,
    fontWeight: '800',
  },
  linkIntentCard: {
    marginTop: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 18,
    backgroundColor: colors.surface,
  },
  linkIntentHeading: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  linkIntentMark: {
    width: 28,
    height: 28,
    overflow: 'hidden',
    borderRadius: 9,
    color: colors.accent,
    backgroundColor: colors.accentSoft,
    fontSize: 15,
    fontWeight: '900',
    lineHeight: 28,
    textAlign: 'center',
  },
  linkIntentHeadingCopy: {
    flex: 1,
  },
  linkIntentTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '900',
  },
  linkIntentDescription: {
    marginTop: 3,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  linkIntentInput: {
    minHeight: 88,
    marginTop: 14,
    padding: 13,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    color: colors.ink,
    backgroundColor: colors.paper,
    fontSize: 14,
    lineHeight: 21,
  },
  linkRetryNotice: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#F4F1E8',
  },
  linkRetryNoticeTitle: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  linkRetryNoticeBody: {
    marginTop: 4,
    color: colors.muted,
    fontSize: 11,
    lineHeight: 17,
  },
  linkOrganizeButton: {
    height: 46,
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: colors.accent,
  },
  linkOrganizeButtonDisabled: {
    backgroundColor: colors.line,
  },
  linkOrganizeButtonText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '900',
  },
  editorAiNote: {
    marginTop: 16,
    padding: 15,
    flexDirection: 'row',
    gap: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#AEB8B1',
    borderRadius: 14,
    backgroundColor: '#FBFCF8',
  },
  editorAiMark: {
    color: colors.sageText,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 16,
  },
  editorAiCopy: {
    flex: 1,
  },
  editorAiTitle: {
    color: colors.sageText,
    fontSize: 13,
    fontWeight: '800',
  },
  editorAiBody: {
    marginTop: 3,
    color: colors.sageText,
    fontSize: 12,
    lineHeight: 18,
    opacity: 0.82,
  },
  editorObsidianButton: {
    height: 48,
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 15,
    backgroundColor: colors.surface,
  },
  editorObsidianButtonDone: {
    borderColor: colors.sage,
    backgroundColor: colors.sage,
  },
  editorObsidianButtonText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '800',
  },
  editorObsidianButtonTextDone: {
    color: colors.sageText,
  },
  deleteButton: {
    alignSelf: 'flex-start',
    marginTop: 24,
    paddingVertical: 10,
  },
  deleteButtonText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '700',
  },
  quickCapture: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  quickHeader: {
    paddingHorizontal: 20,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  quickTitleWrap: {
    alignItems: 'center',
  },
  quickEyebrow: {
    color: colors.accent,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.8,
  },
  quickTitle: {
    marginTop: 2,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '900',
  },
  quickBody: {
    flex: 1,
    padding: 22,
  },
  quickSource: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.sage,
  },
  quickSourceMark: {
    color: colors.sageText,
    fontSize: 13,
    fontWeight: '900',
  },
  quickSourceText: {
    color: colors.sageText,
    fontSize: 11,
    fontWeight: '800',
  },
  quickInput: {
    minHeight: 220,
    marginTop: 22,
    color: colors.ink,
    fontSize: 21,
    fontWeight: '500',
    lineHeight: 31,
  },
  quickHint: {
    marginTop: 18,
    color: colors.faint,
    fontSize: 12,
    fontWeight: '600',
  },
  organizeSheet: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  organizeReviewBody: {
    paddingHorizontal: 22,
    paddingTop: 26,
  },
  organizeReviewEyebrow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  organizeReviewMark: {
    color: colors.accent,
    fontSize: 16,
  },
  organizeReviewModel: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  organizeReviewTitle: {
    marginTop: 15,
    color: colors.ink,
    fontSize: 25,
    fontWeight: '900',
    letterSpacing: -0.7,
  },
  organizeReviewSummary: {
    marginTop: 9,
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21,
  },
  organizeTagRow: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 7,
  },
  organizeTag: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: colors.sage,
  },
  organizeTagText: {
    color: colors.sageText,
    fontSize: 10,
    fontWeight: '700',
  },
  organizeSourceCount: {
    color: colors.faint,
    fontSize: 10,
    fontWeight: '600',
  },
  sourceContextCard: {
    marginTop: 18,
    padding: 15,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  sourceSectionLabel: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  sourceContextText: {
    marginTop: 8,
    color: colors.ink,
    fontSize: 14,
    lineHeight: 21,
  },
  sourceMetaRow: {
    marginTop: 12,
    paddingTop: 11,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  sourceMetaText: {
    flex: 1,
    color: colors.faint,
    fontSize: 11,
    fontWeight: '600',
  },
  sourceOpenAction: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '800',
  },
  markdownModeRow: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  markdownModeLabel: {
    color: colors.faint,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  markdownModeAction: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '800',
  },
  organizeReviewContent: {
    minHeight: 250,
    marginTop: 10,
    padding: 17,
    color: colors.ink,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 18,
    backgroundColor: colors.surface,
    fontSize: 16,
    lineHeight: 26,
  },
  organizeMarkdownPreview: {
    marginTop: 10,
    padding: 17,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 18,
    backgroundColor: colors.surface,
  },
  evidenceSection: {
    marginTop: 18,
  },
  evidenceHeadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  evidenceCount: {
    color: colors.faint,
    fontSize: 10,
    fontWeight: '700',
  },
  evidenceCard: {
    marginTop: 9,
    padding: 14,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
  evidenceIndex: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '900',
  },
  evidenceQuote: {
    marginTop: 6,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 20,
  },
  evidenceHint: {
    marginTop: 9,
    color: colors.faint,
    fontSize: 10,
    lineHeight: 15,
  },
  organizeAccept: {
    height: 52,
    marginTop: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: colors.accent,
  },
  organizeAcceptText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '800',
  },
  organizeDismiss: {
    alignItems: 'center',
    marginTop: 8,
    paddingVertical: 12,
  },
  organizeDismissText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  organizeReviewFootnote: {
    marginTop: 6,
    color: colors.faint,
    fontSize: 10,
    textAlign: 'center',
  },
  themeSuggestButton: {
    minHeight: 64,
    marginTop: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: colors.accentSoft,
    borderRadius: 16,
    backgroundColor: colors.accentSoft,
  },
  themeSuggestMark: {
    color: colors.accent,
    fontSize: 19,
    fontWeight: '900',
  },
  themeSuggestCopy: {
    flex: 1,
  },
  themeSuggestTitle: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '900',
  },
  themeSuggestBody: {
    marginTop: 3,
    color: colors.muted,
    fontSize: 11,
    lineHeight: 16,
  },
  themeLoadingText: {
    marginTop: 12,
    color: colors.muted,
    fontSize: 12,
  },
  themeDecisionPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.sage,
  },
  themeDecisionText: {
    color: colors.sageText,
    fontSize: 10,
    fontWeight: '900',
  },
  themePurposeNotice: {
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#CDD8CA',
    borderRadius: 13,
    backgroundColor: colors.sage,
  },
  themePurposeNoticeTitle: {
    color: colors.sageText,
    fontSize: 13,
    fontWeight: '900',
  },
  themePurposeNoticeBody: {
    marginTop: 4,
    color: colors.sageText,
    fontSize: 12,
    lineHeight: 18,
  },
  themeSourceCard: {
    marginTop: 18,
    padding: 15,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  themeTargetSection: {
    marginTop: 18,
  },
  themeTargetHint: {
    marginTop: 5,
    color: colors.faint,
    fontSize: 11,
    lineHeight: 16,
  },
  reclassifyCurrent: {
    marginTop: 8,
    color: colors.accent,
    fontSize: 13,
    fontWeight: '800',
  },
  themeNameInput: {
    minHeight: 48,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 13,
    color: colors.ink,
    backgroundColor: colors.surface,
    fontSize: 14,
    fontWeight: '700',
  },
  themeTargetOptions: {
    marginTop: 10,
    gap: 8,
  },
  themeTargetOption: {
    minHeight: 44,
    paddingHorizontal: 13,
    paddingVertical: 11,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 13,
    backgroundColor: colors.surface,
  },
  themeTargetOptionSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  themeTargetOptionLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
  },
  themeTargetOptionLabelSelected: {
    color: colors.accent,
  },
  themeSourceTitle: {
    flex: 1,
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 19,
  },
  themeConflictCard: {
    marginTop: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E7C9A8',
    borderRadius: 14,
    backgroundColor: '#FFF3E5',
  },
  themeConflictTitle: {
    color: '#8B5428',
    fontSize: 11,
    fontWeight: '900',
  },
  themeConflictText: {
    marginTop: 6,
    color: '#805B3D',
    fontSize: 12,
    lineHeight: 18,
  },
  themeOverviewReview: {
    padding: 15,
    borderWidth: 1,
    borderColor: '#C8D3C5',
    borderRadius: 14,
    backgroundColor: '#F8FAF5',
  },
  themeOverviewSkipped: {
    padding: 14,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.line,
    borderRadius: 13,
    backgroundColor: colors.surface,
  },
  themeOverviewSkippedText: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 19,
  },
  obsidianSheet: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  obsidianBody: {
    paddingHorizontal: 24,
    paddingTop: 34,
    alignItems: 'center',
  },
  obsidianHeroMark: {
    width: 66,
    height: 66,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    backgroundColor: colors.accent,
  },
  obsidianHeroMarkText: {
    color: colors.white,
    fontSize: 25,
    fontWeight: '900',
  },
  obsidianTitle: {
    marginTop: 20,
    color: colors.ink,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: -0.6,
    textAlign: 'center',
  },
  obsidianBodyCopy: {
    maxWidth: 320,
    marginTop: 9,
    color: colors.muted,
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
  },
  obsidianStatusCard: {
    width: '100%',
    marginTop: 28,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 20,
    backgroundColor: colors.surface,
  },
  obsidianFolderLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
  },
  obsidianFolderName: {
    marginTop: 5,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  obsidianStats: {
    marginTop: 18,
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    paddingTop: 16,
  },
  obsidianStat: {
    flex: 1,
    alignItems: 'center',
  },
  obsidianStatValue: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '900',
  },
  obsidianStatLabel: {
    marginTop: 3,
    color: colors.muted,
    fontSize: 11,
    fontWeight: '600',
  },
  obsidianGuide: {
    width: '100%',
    marginTop: 28,
    padding: 18,
    gap: 8,
    borderRadius: 20,
    backgroundColor: colors.accentSoft,
  },
  obsidianGuideTitle: {
    marginBottom: 3,
    color: colors.accent,
    fontSize: 13,
    fontWeight: '900',
  },
  obsidianGuideLine: {
    color: colors.ink,
    fontSize: 13,
    lineHeight: 20,
  },
  obsidianError: {
    width: '100%',
    marginTop: 14,
    color: colors.danger,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  obsidianPrimary: {
    width: '100%',
    height: 52,
    marginTop: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: colors.accent,
  },
  obsidianPrimaryText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '800',
  },
  obsidianSecondary: {
    width: '100%',
    height: 48,
    marginTop: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  obsidianSecondaryText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  obsidianCleanup: {
    marginTop: 14,
    paddingVertical: 10,
  },
  obsidianCleanupText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  dataTransferCard: {
    width: '100%',
    marginTop: 28,
    padding: 17,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 18,
    backgroundColor: colors.surface,
  },
  dataTransferEyebrow: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  dataTransferTitle: {
    marginTop: 5,
    color: colors.ink,
    fontSize: 16,
    fontWeight: '900',
  },
  dataTransferCopy: {
    marginTop: 7,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 19,
  },
  dataTransferActions: {
    marginTop: 15,
    flexDirection: 'row',
    gap: 9,
  },
  dataTransferButton: {
    flex: 1,
    height: 43,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: colors.sage,
  },
  dataTransferImportButton: {
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.surface,
  },
  dataTransferButtonText: {
    color: colors.sageText,
    fontSize: 13,
    fontWeight: '800',
  },
  dataTransferImportText: {
    color: colors.accent,
  },
  obsidianFootnote: {
    marginTop: 18,
    color: colors.faint,
    fontSize: 11,
    lineHeight: 17,
    textAlign: 'center',
  },
  wechatSheet: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  headerSpacer: {
    width: 54,
  },
  wechatBody: {
    flex: 1,
  },
  wechatBodyContent: {
    paddingHorizontal: 24,
    paddingTop: 34,
  },
  wechatHero: {
    alignItems: 'center',
  },
  wechatHeroMark: {
    width: 66,
    height: 66,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.sageText,
    borderRadius: 22,
    backgroundColor: colors.sage,
    transform: [{ rotate: '-2deg' }],
  },
  wechatHeroMarkText: {
    color: colors.sageText,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 25,
    fontWeight: '900',
  },
  wechatHeroTitle: {
    marginTop: 20,
    color: colors.ink,
    fontSize: 23,
    fontWeight: '900',
    letterSpacing: -0.7,
  },
  wechatHeroBody: {
    maxWidth: 310,
    marginTop: 9,
    color: colors.muted,
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
  },
  wechatLoading: {
    marginTop: 36,
    alignItems: 'center',
    gap: 12,
  },
  wechatLoadingText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  wechatError: {
    marginTop: 32,
    padding: 18,
    borderRadius: 18,
    backgroundColor: colors.accentSoft,
  },
  wechatErrorTitle: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: '800',
    textAlign: 'center',
  },
  wechatErrorBody: {
    marginTop: 5,
    color: colors.danger,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  wechatSuccess: {
    alignSelf: 'center',
    marginTop: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.sage,
  },
  wechatSuccessDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.sageText,
  },
  wechatSuccessText: {
    color: colors.sageText,
    fontSize: 13,
    fontWeight: '800',
  },
  serviceStatusCard: {
    marginTop: 20,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 18,
    backgroundColor: colors.surface,
  },
  serviceStatusTitle: {
    marginBottom: 7,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '900',
  },
  serviceStatusRow: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  serviceStatusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  serviceStatusDotUnavailable: {
    backgroundColor: colors.faint,
  },
  serviceStatusLabel: {
    flex: 1,
    color: colors.ink,
    fontSize: 12,
    fontWeight: '700',
  },
  serviceStatusValue: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '800',
  },
  serviceStatusValueUnavailable: {
    color: colors.muted,
  },
  replyModeCard: {
    marginTop: 24,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 21,
    backgroundColor: colors.surface,
  },
  replyModeTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '900',
  },
  replyModeDescription: {
    marginTop: 4,
    marginBottom: 9,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  replyModeOption: {
    minHeight: 58,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
  },
  replyModeOptionSelected: {
    backgroundColor: colors.accentSoft,
  },
  replyModeRadio: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.line,
    borderRadius: 10,
  },
  replyModeRadioSelected: {
    borderColor: colors.accent,
  },
  replyModeRadioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
  replyModeCopy: {
    marginLeft: 12,
    flex: 1,
  },
  replyModeOptionTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  replyModeOptionDescription: {
    marginTop: 2,
    color: colors.muted,
    fontSize: 12,
  },
  bindingCard: {
    marginTop: 30,
    padding: 22,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 21,
    backgroundColor: colors.surface,
  },
  bindingLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  bindingCommand: {
    width: '100%',
    marginTop: 10,
    color: colors.ink,
    fontSize: 30,
    fontWeight: '900',
    includeFontPadding: false,
    letterSpacing: 1.4,
    lineHeight: 38,
    textAlign: 'center',
  },
  bindingExpiry: {
    marginTop: 10,
    color: colors.faint,
    fontSize: 11,
    fontWeight: '600',
  },
  wechatRefresh: {
    height: 52,
    marginTop: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: colors.accent,
  },
  wechatRefreshDisabled: {
    opacity: 0.5,
  },
  wechatRefreshText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '800',
  },
});
