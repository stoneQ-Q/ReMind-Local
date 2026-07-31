import {
  Component,
  useCallback,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatCnyMicros } from './cloud-billing';
import {
  cancelCloudMediaTask,
  confirmCloudMediaTask,
  isCloudMediaTaskActive,
  listCloudMediaTasks,
  type CloudMediaTask,
  type CloudMediaTaskStatus,
} from './cloud-tasks';
import { colors } from './theme';

export function CloudTaskCenter({
  onClose,
  visible,
}: {
  onClose: () => void;
  visible: boolean;
}) {
  return (
    <CloudTaskCenterBoundary
      key={visible ? 'task-center-visible' : 'task-center-hidden'}
      onClose={onClose}
      visible={visible}
    >
      <CloudTaskCenterScreen onClose={onClose} visible={visible} />
    </CloudTaskCenterBoundary>
  );
}

function CloudTaskCenterScreen({
  onClose,
  visible,
}: {
  onClose: () => void;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [tasks, setTasks] = useState<CloudMediaTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (mode: 'initial' | 'refresh' | 'silent') => {
    if (mode === 'initial') setLoading(true);
    if (mode === 'refresh') setRefreshing(true);
    if (mode !== 'silent') setError(null);
    try {
      setTasks(await listCloudMediaTasks());
      setError(null);
    } catch (reason) {
      if (mode !== 'silent') setError(taskErrorMessage(reason));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      void load('initial');
    } else {
      setTasks([]);
      setError(null);
      setActingId(null);
      setLoading(false);
      setRefreshing(false);
    }
  }, [load, visible]);

  useEffect(() => {
    if (!visible || !tasks.some(isCloudMediaTaskActive)) return;
    const timer = setInterval(() => {
      void load('silent');
    }, 4_000);
    return () => clearInterval(timer);
  }, [load, tasks, visible]);

  const confirmTask = useCallback(
    (task: CloudMediaTask) => {
      const quote = task.quote;
      if (!quote) return;
      const amount = formatCnyMicros(quote.estimatedCostMicros);
      Alert.alert(
        quote.confirmationRequired ? '确认这笔预计费用？' : '开始这个任务？',
        `服务端预计最多预占 ${amount}。完成后按实际用量结算，未使用部分会退回可用余额。`,
        [
          { text: '暂不开始', style: 'cancel' },
          {
            text: `确认并预占 ${amount}`,
            onPress: async () => {
              setActingId(task.request.id);
              setError(null);
              try {
                await confirmCloudMediaTask(quote.jobId);
                await load('silent');
              } catch (reason) {
                setError(taskErrorMessage(reason));
              } finally {
                setActingId(null);
              }
            },
          },
        ],
      );
    },
    [load],
  );

  const cancelTask = useCallback(
    (task: CloudMediaTask) => {
      Alert.alert(
        '取消这个任务？',
        '未使用的预占金额会释放；已经实际产生的第三方费用仍会按实际用量结算。',
        [
          { text: '继续任务', style: 'cancel' },
          {
            text: '确认取消',
            style: 'destructive',
            onPress: async () => {
              setActingId(task.request.id);
              setError(null);
              try {
                await cancelCloudMediaTask(task.request.id);
                await load('silent');
              } catch (reason) {
                setError(taskErrorMessage(reason));
              } finally {
                setActingId(null);
              }
            },
          },
        ],
      );
    },
    [load],
  );

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <View style={styles.sheet}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable hitSlop={10} onPress={onClose}>
            <Text style={styles.close}>关闭</Text>
          </Pressable>
          <Text style={styles.heading}>任务与确认</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView
          contentContainerStyle={[
            styles.body,
            { paddingBottom: insets.bottom + 28 },
          ]}
          refreshControl={
            <RefreshControl
              onRefresh={() => void load('refresh')}
              refreshing={refreshing}
              tintColor={colors.accent}
            />
          }
        >
          <View style={styles.heroMark}>
            <Text style={styles.heroMarkText}>任</Text>
          </View>
          <Text style={styles.title}>费用确认后，任务才会开始</Text>
          <Text style={styles.copy}>
            图片、语音和视频会在云端排队处理。高费用任务不会自动确认；离开这个页面后，进行中的任务仍会继续。
          </Text>

          {loading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.loadingText}>正在读取任务状态…</Text>
            </View>
          ) : tasks.length ? (
            tasks.map((task) => (
              <TaskCard
                acting={actingId === task.request.id}
                key={task.request.id}
                onCancel={() => cancelTask(task)}
                onConfirm={() => confirmTask(task)}
                task={task}
              />
            ))
          ) : !error ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>还没有云端任务</Text>
              <Text style={styles.emptyCopy}>
                以后从 App 提交图片、语音或视频后，报价、排队进度和处理结果会统一显示在这里。
              </Text>
            </View>
          ) : null}

          {error ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable
                disabled={loading}
                onPress={() => void load('initial')}
                style={({ pressed }) => [
                  styles.retryButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.retryText}>重新加载</Text>
              </Pressable>
            </View>
          ) : null}

          <Text style={styles.footnote}>
            页面只显示当前账号最近 50 个任务，每 4 秒刷新进行中状态。价格、余额预占和最终结算都由服务端决定。
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

class CloudTaskCenterBoundary extends Component<
  {
    children: ReactNode;
    onClose: () => void;
    visible: boolean;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('CloudTaskCenter render failed', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <Modal
        animationType="fade"
        onRequestClose={this.props.onClose}
        visible={this.props.visible}
      >
        <View style={styles.fallback}>
          <Text style={styles.fallbackTitle}>任务页面暂时无法显示</Text>
          <Text style={styles.fallbackCopy}>
            云端账号和手机里的笔记不受影响，也不会产生费用。
          </Text>
          <Pressable
            onPress={this.props.onClose}
            style={({ pressed }) => [
              styles.fallbackButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.fallbackButtonText}>安全返回</Text>
          </Pressable>
        </View>
      </Modal>
    );
  }
}

function TaskCard({
  acting,
  onCancel,
  onConfirm,
  task,
}: {
  acting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  task: CloudMediaTask;
}) {
  const presentation = taskPresentation(task.request.status);
  const statusLabel =
    task.request.status === 'processing' &&
    task.currentJob &&
    task.currentJob.attemptCount > 1
      ? `重试中 ${task.currentJob.attemptCount}/${task.currentJob.maxAttempts}`
      : presentation.label;
  const quote = task.quote;
  const expired = quote ? Date.parse(quote.expiresAt) <= Date.now() : false;
  const canConfirm =
    task.request.status === 'awaiting_confirmation' &&
    quote?.status === 'queued' &&
    !quote.confirmedAt &&
    !expired;
  const canStartWithoutSecondConfirmation =
    task.request.status === 'awaiting_confirmation' &&
    quote?.status === 'queued' &&
    Boolean(quote.confirmedAt) &&
    !expired;
  const active = isCloudMediaTaskActive(task);
  const canCancel =
    task.request.status === 'awaiting_confirmation' ||
    task.request.status === 'pending' ||
    task.request.status === 'processing';
  const terminal =
    task.request.status === 'succeeded' ||
    task.request.status === 'failed' ||
    task.request.status === 'cancelled';
  const displayedCost =
    terminal ? task.request.actualCostMicros : task.request.estimatedCostMicros;

  return (
    <View style={styles.taskCard}>
      <View style={styles.taskHeader}>
        <View style={styles.taskIdentity}>
          <View style={styles.kindMark}>
            <Text style={styles.kindMarkText}>
              {mediaKindLabel(task.request.mediaKind).slice(0, 1)}
            </Text>
          </View>
          <View>
            <Text style={styles.taskTitle}>
              {mediaKindLabel(task.request.mediaKind)}分析
            </Text>
            <Text style={styles.taskTime}>
              {formatTaskTime(task.request.createdAt)}
            </Text>
          </View>
        </View>
        <View style={[styles.statusBadge, presentation.badgeStyle]}>
          {presentation.spinning ? (
            <ActivityIndicator color={presentation.color} size="small" />
          ) : null}
          <Text style={[styles.statusText, { color: presentation.color }]}>
            {statusLabel}
          </Text>
        </View>
      </View>

      <View style={styles.costRow}>
        <Text style={styles.costLabel}>
          {terminal ? '实际费用' : '预计费用'}
        </Text>
        <Text style={styles.costValue}>{formatCnyMicros(displayedCost)}</Text>
      </View>

      {task.request.status === 'awaiting_confirmation' && quote ? (
        <View style={styles.quoteBox}>
          <Text style={styles.quoteTitle}>
            {expired
              ? '报价已过期'
              : quote.confirmationRequired
                ? '等待你的费用确认'
                : '等待开始'}
          </Text>
          <Text style={styles.quoteCopy}>
            {expired
              ? '这笔报价不会再扣款。请取消后重新提交，获取新的服务端报价。'
              : `报价有效至 ${formatTaskTime(quote.expiresAt)}；确认时会先预占 ${formatCnyMicros(quote.estimatedCostMicros)}。`}
          </Text>
          {!expired && quote.status === 'queued' ? (
            <Pressable
              disabled={acting}
              onPress={onConfirm}
              style={({ pressed }) => [
                styles.confirmButton,
                pressed && styles.pressed,
              ]}
            >
              {acting ? (
                <ActivityIndicator color={colors.white} size="small" />
              ) : (
                <Text style={styles.confirmText}>
                  {canConfirm || quote.confirmationRequired
                    ? `确认并预占 ${formatCnyMicros(quote.estimatedCostMicros)}`
                    : canStartWithoutSecondConfirmation
                      ? '开始任务'
                      : '确认并开始'}
                </Text>
              )}
            </Pressable>
          ) : !expired ? (
            <Text style={styles.quoteProgress}>已确认，正在进入任务队列…</Text>
          ) : null}
        </View>
      ) : null}

      {task.request.errorCode ? (
        <Text style={styles.taskError}>
          失败原因：{friendlyTaskCode(task.request.errorCode)}
        </Text>
      ) : null}

      {active && canCancel ? (
        <Pressable disabled={acting} onPress={onCancel} style={styles.cancel}>
          <Text style={styles.cancelText}>
            {acting ? '正在处理…' : '取消任务'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function taskPresentation(status: CloudMediaTaskStatus): {
  label: string;
  color: string;
  badgeStyle: object;
  spinning: boolean;
} {
  switch (status) {
    case 'awaiting_confirmation':
      return {
        label: '待确认',
        color: colors.apricotText,
        badgeStyle: styles.statusWaiting,
        spinning: false,
      };
    case 'pending':
      return {
        label: '排队中',
        color: colors.mistText,
        badgeStyle: styles.statusPending,
        spinning: true,
      };
    case 'processing':
    case 'settling':
    case 'releasing':
      return {
        label:
          status === 'processing'
            ? '处理中'
            : status === 'settling'
              ? '结算中'
              : '取消中',
        color: colors.accent,
        badgeStyle: styles.statusActive,
        spinning: true,
      };
    case 'succeeded':
      return {
        label: '已完成',
        color: colors.sageText,
        badgeStyle: styles.statusDone,
        spinning: false,
      };
    case 'failed':
      return {
        label: '失败',
        color: colors.danger,
        badgeStyle: styles.statusFailed,
        spinning: false,
      };
    case 'cancelled':
      return {
        label: '已取消',
        color: colors.muted,
        badgeStyle: styles.statusCancelled,
        spinning: false,
      };
  }
}

function mediaKindLabel(kind: CloudMediaTask['request']['mediaKind']): string {
  if (kind === 'image') return '图片';
  if (kind === 'audio') return '语音';
  return '视频';
}

function formatTaskTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function friendlyTaskCode(code: string): string {
  if (code === 'job_cancelled') return '任务已取消';
  if (code === 'job_timed_out') return '处理超时，可稍后重试';
  if (code === 'provider_unavailable') return '服务商暂时不可用';
  return '处理未完成，请稍后重试';
}

function taskErrorMessage(reason: unknown): string {
  const code =
    reason instanceof Error && 'code' in reason
      ? String((reason as Error & { code: unknown }).code)
      : reason instanceof Error
        ? reason.message
        : String(reason);
  if (code === 'quote_expired') return '报价已过期，请取消任务后重新提交。';
  if (code === 'insufficient_balance') return '可用余额不足，任务没有开始。';
  if (code === 'daily_limit_exceeded') return '已达到今日消费上限，任务没有开始。';
  if (code === 'monthly_limit_exceeded') return '已达到本月消费上限，任务没有开始。';
  if (code === 'provider_paused') return '第三方服务已自动暂停，任务没有开始。';
  if (code === 'cloud_session_missing' || code === 'unauthorized') {
    return '云端登录已失效，请返回“连接方式”重新连接。';
  }
  return '暂时无法读取或更新任务，请检查网络后重试。';
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.paper },
  fallback: {
    flex: 1,
    paddingHorizontal: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.paper,
  },
  fallbackTitle: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '800',
    textAlign: 'center',
  },
  fallbackCopy: {
    marginTop: 10,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 21,
    textAlign: 'center',
  },
  fallbackButton: {
    minWidth: 150,
    minHeight: 46,
    marginTop: 24,
    paddingHorizontal: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: colors.accent,
  },
  fallbackButtonText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '800',
  },
  header: {
    minHeight: 58,
    paddingHorizontal: 18,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface,
  },
  close: { width: 52, color: colors.accent, fontSize: 15, fontWeight: '700' },
  heading: {
    flex: 1,
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
  },
  headerSpacer: { width: 52 },
  body: { paddingHorizontal: 20, paddingTop: 28 },
  heroMark: {
    width: 58,
    height: 58,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    backgroundColor: colors.mist,
  },
  heroMarkText: { color: colors.mistText, fontSize: 23, fontWeight: '900' },
  title: {
    marginTop: 16,
    color: colors.ink,
    fontSize: 23,
    fontWeight: '800',
    textAlign: 'center',
  },
  copy: {
    marginTop: 10,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 21,
    textAlign: 'center',
  },
  loading: { marginTop: 36, alignItems: 'center', gap: 12 },
  loadingText: { color: colors.muted, fontSize: 13 },
  empty: {
    marginTop: 28,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 18,
    backgroundColor: colors.surface,
  },
  emptyTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
    textAlign: 'center',
  },
  emptyCopy: {
    marginTop: 8,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 19,
    textAlign: 'center',
  },
  taskCard: {
    marginTop: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 18,
    backgroundColor: colors.surface,
  },
  taskHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  taskIdentity: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  kindMark: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.lavender,
  },
  kindMarkText: {
    color: colors.lavenderText,
    fontSize: 14,
    fontWeight: '900',
  },
  taskTitle: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  taskTime: { marginTop: 3, color: colors.faint, fontSize: 10 },
  statusBadge: {
    minHeight: 28,
    paddingHorizontal: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 99,
  },
  statusText: { fontSize: 10, fontWeight: '800' },
  statusWaiting: { backgroundColor: colors.apricot },
  statusPending: { backgroundColor: colors.mist },
  statusActive: { backgroundColor: colors.accentSoft },
  statusDone: { backgroundColor: colors.sage },
  statusFailed: { backgroundColor: '#F7E7E4' },
  statusCancelled: { backgroundColor: '#EEEDE9' },
  costRow: {
    marginTop: 16,
    paddingTop: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  costLabel: { color: colors.muted, fontSize: 12 },
  costValue: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  quoteBox: {
    marginTop: 14,
    padding: 14,
    borderRadius: 14,
    backgroundColor: colors.apricot,
  },
  quoteTitle: { color: colors.apricotText, fontSize: 13, fontWeight: '800' },
  quoteCopy: {
    marginTop: 6,
    color: colors.apricotText,
    fontSize: 11,
    lineHeight: 17,
  },
  quoteProgress: {
    marginTop: 10,
    color: colors.apricotText,
    fontSize: 11,
    fontWeight: '700',
  },
  confirmButton: {
    minHeight: 44,
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.accent,
  },
  confirmText: { color: colors.white, fontSize: 12, fontWeight: '800' },
  taskError: {
    marginTop: 12,
    color: colors.danger,
    fontSize: 11,
    lineHeight: 17,
  },
  cancel: { alignSelf: 'center', marginTop: 14, padding: 6 },
  cancelText: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  errorCard: {
    marginTop: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E7C3BD',
    borderRadius: 16,
    backgroundColor: '#F8EDEA',
  },
  errorText: {
    color: colors.danger,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  retryButton: { alignSelf: 'center', marginTop: 10, padding: 8 },
  retryText: { color: colors.danger, fontSize: 12, fontWeight: '800' },
  footnote: {
    marginTop: 24,
    color: colors.faint,
    fontSize: 10,
    lineHeight: 16,
    textAlign: 'center',
  },
  pressed: { opacity: 0.72 },
});
