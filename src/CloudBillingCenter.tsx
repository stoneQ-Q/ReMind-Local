import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CloudBillingError,
  formatCnyMicros,
  formatYiliMicros,
  getCloudBillingOverview,
  simplifyConsumerLedger,
  type CloudBillingOverview,
  type CloudLedgerEntry,
} from './cloud-billing';
import { colors } from './theme';
import { isConsumerReMindApp } from './app-variant';

export function CloudBillingCenter({
  onClose,
  visible,
}: {
  onClose: () => void;
  visible: boolean;
}) {
  const consumer = isConsumerReMindApp();
  const insets = useSafeAreaInsets();
  const [overview, setOverview] = useState<CloudBillingOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      setOverview(await getCloudBillingOverview());
    } catch (reason) {
      setError(billingErrorMessage(reason));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      void load();
    } else {
      setOverview(null);
      setError(null);
      setLoading(false);
      setRefreshing(false);
    }
  }, [load, visible]);

  const account = overview?.account;
  const formatUsage = consumer ? formatYiliMicros : formatCnyMicros;
  const displayedEntries = overview
    ? consumer
      ? simplifyConsumerLedger(overview.entries)
      : overview.entries
    : [];

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
          <Text style={styles.heading}>
            {consumer ? '忆粒与用量' : '余额与费用'}
          </Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView
          contentContainerStyle={[
            styles.body,
            { paddingBottom: insets.bottom + 28 },
          ]}
          refreshControl={
            <RefreshControl
              onRefresh={() => void load(true)}
              refreshing={refreshing}
              tintColor={colors.accent}
            />
          }
        >
          <View style={styles.heroMark}>
            <Text style={styles.heroMarkText}>{consumer ? '忆' : '¥'}</Text>
          </View>
          <Text style={styles.title}>
            {consumer ? '你的忆粒' : '每一笔费用都能看清楚'}
          </Text>
          <Text style={styles.copy}>
            {consumer
              ? '忆粒用于整理记录、问 ReMind 和自动处理链接。完成后只记录实际使用量，没有用到的部分会自动归还。'
              : '余额不会出现负数。任务开始前先预占，完成后按实际用量结算，失败或未使用的部分会释放。'}
          </Text>

          {loading && !overview ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.loadingText}>正在读取费用记录…</Text>
            </View>
          ) : account ? (
            <>
              <View style={styles.balanceCard}>
                <Text style={styles.balanceLabel}>
                  {consumer ? '现在可用' : '当前可用'}
                </Text>
                <Text
                  adjustsFontSizeToFit
                  minimumFontScale={0.7}
                  numberOfLines={1}
                  style={styles.balanceValue}
                >
                  {formatUsage(account.availableMicros)}
                </Text>
                <View style={styles.balanceBreakdown}>
                  <BalanceStat
                    label={consumer ? '全部' : '账户余额'}
                    value={formatUsage(account.balanceMicros)}
                  />
                  <View style={styles.balanceDivider} />
                  <BalanceStat
                    label={consumer ? '处理中' : '任务预占'}
                    value={formatUsage(account.reservedMicros)}
                  />
                </View>
              </View>

              {consumer ? (
                <View style={styles.usageGuideCard}>
                  <Text style={styles.usageGuideTitle}>大概会用多少</Text>
                  <View style={styles.usageGuideRow}>
                    <View style={styles.usageGuideCopy}>
                      <Text style={styles.usageGuideLabel}>5 分钟视频</Text>
                      <Text style={styles.usageGuideDetail}>
                        只转写约 2.4 忆粒；自动整理后通常共 3～5 忆粒
                      </Text>
                    </View>
                  </View>
                  <View style={styles.usageGuideDivider} />
                  <View style={styles.usageGuideRow}>
                    <View style={styles.usageGuideCopy}>
                      <Text style={styles.usageGuideLabel}>1 小时小宇宙音频</Text>
                      <Text style={styles.usageGuideDetail}>
                        只转写约 28.8 忆粒；自动整理后通常共 30～35 忆粒
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.usageGuideFootnote}>
                    实际按识别出的有效语音时长结算。开始前会先留出预计用量，未使用的部分自动归还。
                  </Text>
                </View>
              ) : null}

              <View style={styles.limitCard}>
                <Text style={styles.limitTitle}>
                  {consumer ? '使用保护' : '消费安全上限'}
                </Text>
                <Text style={styles.limitCopy}>
                  {consumer
                    ? '每天和每月都有保护线，避免异常任务连续消耗。'
                    : '即使以后开启托管服务，也不能超过这些服务端限制。'}
                </Text>
                <View style={styles.limitRows}>
                  <View style={styles.limitRow}>
                    <Text style={styles.limitLabel}>每日上限</Text>
                    <Text style={styles.limitValue}>
                      {formatUsage(account.dailyLimitMicros)}
                    </Text>
                  </View>
                  <View style={styles.limitRow}>
                    <Text style={styles.limitLabel}>每月上限</Text>
                    <Text style={styles.limitValue}>
                      {formatUsage(account.monthlyLimitMicros)}
                    </Text>
                  </View>
                </View>
              </View>

              <View style={styles.topUpCard}>
                <View style={styles.topUpIcon}>
                  <Text style={styles.topUpIconText}>＋</Text>
                </View>
                <View style={styles.topUpCopy}>
                  <View style={styles.topUpTitleRow}>
                    <Text style={styles.topUpTitle}>
                      {consumer ? '内测体验规则' : '充值暂未开放'}
                    </Text>
                    <Text style={styles.lockedBadge}>
                      {consumer ? '暂不收费' : '无付款入口'}
                    </Text>
                  </View>
                  <Text style={styles.topUpDescription}>
                    {consumer
                      ? '当前忆粒由 ReMind 赠送。用完后仍可正常记录、搜索和查看已有内容。'
                      : '私密测试阶段先验证成本和稳定性，完成支付、退款、对账与合规后再开放。'}
                  </Text>
                </View>
              </View>

              <View style={styles.ledgerHeader}>
                <Text style={styles.ledgerTitle}>
                  {consumer ? '最近使用' : '费用明细'}
                </Text>
                <Text style={styles.ledgerCount}>
                  最近 {displayedEntries.length} 笔
                </Text>
              </View>
              {displayedEntries.length ? (
                displayedEntries.map((entry) => (
                  <LedgerRow entry={entry} key={entry.id} />
                ))
              ) : (
                <View style={styles.emptyLedger}>
                  <Text style={styles.emptyLedgerTitle}>
                    {consumer ? '还没有忆粒记录' : '还没有费用记录'}
                  </Text>
                  <Text style={styles.emptyLedgerCopy}>
                    {consumer
                      ? '第一次使用智能功能后，这里会显示获赠、留出和实际使用的忆粒。'
                      : '目前没有充值、赠送、预占或结算。使用自己的 API Key 不会从这里扣费。'}
                  </Text>
                </View>
              )}
            </>
          ) : null}

          {error ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable
                disabled={loading}
                onPress={() => void load()}
                style={({ pressed }) => [
                  styles.retryButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.retryButtonText}>重新加载</Text>
              </Pressable>
            </View>
          ) : null}

          <Text style={styles.footnote}>
            {consumer
              ? '这里优先展示实际使用；正在处理的任务会临时留出忆粒，完成或失败后自动结算。'
              : '金额由服务端以整数微元记录，App 不使用浮点数计算余额。账本只追加新记录，历史记录不能直接修改。'}
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

function BalanceStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.balanceStat}>
      <Text style={styles.balanceStatLabel}>{label}</Text>
      <Text style={styles.balanceStatValue}>{value}</Text>
    </View>
  );
}

function LedgerRow({ entry }: { entry: CloudLedgerEntry }) {
  const consumer = isConsumerReMindApp();
  const formatUsage = consumer ? formatYiliMicros : formatCnyMicros;
  const presentation = ledgerPresentation(entry, formatUsage, consumer);
  return (
    <View style={styles.ledgerRow}>
      <View style={[styles.ledgerIcon, presentation.iconStyle]}>
        <Text style={[styles.ledgerIconText, presentation.iconTextStyle]}>
          {presentation.icon}
        </Text>
      </View>
      <View style={styles.ledgerCopy}>
        <Text style={styles.ledgerRowTitle}>{presentation.title}</Text>
        <Text style={styles.ledgerRowMeta}>
          {formatBillingTime(entry.createdAt)}
          {entry.jobId ? ' · AI 任务' : ''}
        </Text>
        <Text style={styles.ledgerAfter}>
          {consumer ? '剩余' : '余额'} {formatUsage(entry.balanceAfterMicros)} ·{' '}
          {consumer ? '留出' : '预占'} {formatUsage(entry.reservedAfterMicros)}
        </Text>
      </View>
      <Text style={[styles.ledgerAmount, presentation.amountStyle]}>
        {presentation.amount}
      </Text>
    </View>
  );
}

function ledgerPresentation(
  entry: CloudLedgerEntry,
  formatUsage: (value: string, showPlus?: boolean) => string,
  consumer: boolean,
): {
  title: string;
  amount: string;
  icon: string;
  iconStyle: object;
  iconTextStyle: object;
  amountStyle: object;
} {
  if (entry.kind === 'reserve') {
    return {
      title: consumer ? '为任务留出忆粒' : '任务费用预占',
      amount: `${consumer ? '留出' : '预占'} ${formatUsage(entry.amountMicros)}`,
      icon: '锁',
      iconStyle: styles.ledgerIconReserved,
      iconTextStyle: styles.ledgerIconReservedText,
      amountStyle: styles.ledgerAmountReserved,
    };
  }
  if (entry.kind === 'release') {
    return {
      title: consumer ? '未使用忆粒归还' : '未使用预占退回',
      amount: `归还 ${formatUsage(entry.amountMicros)}`,
      icon: '回',
      iconStyle: styles.ledgerIconPositive,
      iconTextStyle: styles.ledgerIconPositiveText,
      amountStyle: styles.ledgerAmountPositive,
    };
  }
  if (entry.kind === 'settle') {
    return {
      title: consumer ? '智能服务使用' : '任务实际结算',
      amount: formatUsage(entry.balanceDeltaMicros, true),
      icon: '用',
      iconStyle: styles.ledgerIconSettled,
      iconTextStyle: styles.ledgerIconSettledText,
      amountStyle: styles.ledgerAmountNegative,
    };
  }

  const title =
    entry.kind === 'refund'
      ? consumer ? '忆粒退回' : '退款到账'
      : entry.kind === 'adjustment'
        ? consumer ? '忆粒调整' : '余额调整'
        : entry.source === 'gift'
          ? consumer ? '获赠体验忆粒' : '体验额度赠送'
          : entry.source === 'payment'
            ? consumer ? '忆粒到账' : '充值到账'
            : entry.source === 'operator'
              ? consumer ? '忆粒调整' : '人工额度调整'
              : consumer ? '忆粒增加' : '余额增加';
  return {
    title,
    amount: formatUsage(entry.balanceDeltaMicros, true),
    icon: entry.kind === 'refund' ? '退' : entry.source === 'gift' ? '赠' : '入',
    iconStyle: styles.ledgerIconPositive,
    iconTextStyle: styles.ledgerIconPositiveText,
    amountStyle:
      BigInt(entry.balanceDeltaMicros) >= 0n
        ? styles.ledgerAmountPositive
        : styles.ledgerAmountNegative,
  };
}

function formatBillingTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function billingErrorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.name === 'AbortError') {
    return '连接超时，请检查网络后重试。';
  }
  if (reason instanceof CloudBillingError) {
    if (
      reason.code === 'cloud_session_missing' ||
      reason.code === 'unauthorized'
    ) {
      return '云端登录已经失效，请先用恢复码重新连接账号。';
    }
    if (reason.code === 'cloud_not_configured') {
      return '这个安装包尚未配置私密测试云端。';
    }
  }
  return '暂时无法读取忆粒与使用记录，请稍后重试。';
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  header: {
    minHeight: 58,
    paddingHorizontal: 20,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  close: {
    width: 54,
    color: colors.accent,
    fontSize: 15,
    fontWeight: '700',
  },
  heading: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  headerSpacer: {
    width: 54,
  },
  body: {
    paddingHorizontal: 24,
    paddingTop: 30,
  },
  heroMark: {
    width: 66,
    height: 66,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.apricotText,
    borderRadius: 22,
    backgroundColor: colors.apricot,
    transform: [{ rotate: '2deg' }],
  },
  heroMarkText: {
    color: colors.apricotText,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 28,
    fontWeight: '800',
  },
  title: {
    marginTop: 20,
    color: colors.ink,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 23,
    fontWeight: '700',
    textAlign: 'center',
  },
  copy: {
    marginTop: 9,
    marginBottom: 20,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 21,
    textAlign: 'center',
  },
  loading: {
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    color: colors.muted,
    fontSize: 13,
  },
  balanceCard: {
    padding: 20,
    borderRadius: 20,
    backgroundColor: colors.ink,
  },
  balanceLabel: {
    color: colors.line,
    fontSize: 11,
    fontWeight: '700',
  },
  balanceValue: {
    marginTop: 8,
    color: colors.white,
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -0.6,
  },
  balanceBreakdown: {
    marginTop: 20,
    paddingTop: 15,
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.muted,
  },
  balanceStat: {
    flex: 1,
  },
  balanceStatLabel: {
    color: colors.faint,
    fontSize: 10,
  },
  balanceStatValue: {
    marginTop: 5,
    color: colors.surface,
    fontSize: 13,
    fontWeight: '800',
  },
  balanceDivider: {
    width: StyleSheet.hairlineWidth,
    marginHorizontal: 15,
    backgroundColor: colors.muted,
  },
  limitCard: {
    marginTop: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 17,
    backgroundColor: colors.surface,
  },
  usageGuideCard: {
    marginTop: 12,
    padding: 16,
    borderRadius: 17,
    backgroundColor: colors.mist,
  },
  usageGuideTitle: {
    color: colors.mistText,
    fontSize: 13,
    fontWeight: '800',
  },
  usageGuideRow: {
    marginTop: 12,
  },
  usageGuideCopy: {
    flex: 1,
  },
  usageGuideLabel: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '800',
  },
  usageGuideDetail: {
    marginTop: 4,
    color: colors.muted,
    fontSize: 10,
    lineHeight: 16,
  },
  usageGuideDivider: {
    height: StyleSheet.hairlineWidth,
    marginTop: 12,
    backgroundColor: colors.line,
  },
  usageGuideFootnote: {
    marginTop: 13,
    color: colors.mistText,
    fontSize: 10,
    lineHeight: 16,
  },
  limitTitle: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
  },
  limitCopy: {
    marginTop: 5,
    color: colors.muted,
    fontSize: 10,
    lineHeight: 16,
  },
  limitRows: {
    marginTop: 13,
    gap: 8,
  },
  limitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  limitLabel: {
    color: colors.muted,
    fontSize: 11,
  },
  limitValue: {
    color: colors.ink,
    fontSize: 11,
    fontWeight: '800',
  },
  topUpCard: {
    marginTop: 12,
    padding: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 17,
    backgroundColor: colors.surface,
  },
  topUpIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.apricot,
  },
  topUpIconText: {
    color: colors.apricotText,
    fontSize: 21,
    fontWeight: '800',
  },
  topUpCopy: {
    flex: 1,
  },
  topUpTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 7,
  },
  topUpTitle: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
  },
  lockedBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 99,
    backgroundColor: colors.mist,
    color: colors.mistText,
    fontSize: 9,
    fontWeight: '800',
  },
  topUpDescription: {
    marginTop: 4,
    color: colors.muted,
    fontSize: 10,
    lineHeight: 15,
  },
  ledgerHeader: {
    marginTop: 28,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  ledgerTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  ledgerCount: {
    color: colors.faint,
    fontSize: 10,
  },
  ledgerRow: {
    minHeight: 78,
    marginBottom: 9,
    padding: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 15,
    backgroundColor: colors.surface,
  },
  ledgerIcon: {
    width: 35,
    height: 35,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 11,
  },
  ledgerIconText: {
    fontSize: 11,
    fontWeight: '900',
  },
  ledgerIconPositive: {
    backgroundColor: colors.accentSoft,
  },
  ledgerIconPositiveText: {
    color: colors.accent,
  },
  ledgerIconReserved: {
    backgroundColor: colors.mist,
  },
  ledgerIconReservedText: {
    color: colors.mistText,
  },
  ledgerIconSettled: {
    backgroundColor: colors.apricot,
  },
  ledgerIconSettledText: {
    color: colors.apricotText,
  },
  ledgerCopy: {
    flex: 1,
  },
  ledgerRowTitle: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '800',
  },
  ledgerRowMeta: {
    marginTop: 4,
    color: colors.muted,
    fontSize: 9,
  },
  ledgerAfter: {
    marginTop: 4,
    color: colors.faint,
    fontSize: 8,
  },
  ledgerAmount: {
    maxWidth: 100,
    fontSize: 11,
    fontWeight: '800',
    textAlign: 'right',
  },
  ledgerAmountPositive: {
    color: colors.accent,
  },
  ledgerAmountNegative: {
    color: colors.danger,
  },
  ledgerAmountReserved: {
    color: colors.mistText,
  },
  emptyLedger: {
    padding: 22,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 17,
    borderStyle: 'dashed',
  },
  emptyLedgerTitle: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
  },
  emptyLedgerCopy: {
    marginTop: 7,
    color: colors.muted,
    fontSize: 11,
    lineHeight: 18,
    textAlign: 'center',
  },
  errorCard: {
    marginTop: 16,
    padding: 16,
    alignItems: 'center',
    borderRadius: 16,
    backgroundColor: colors.apricot,
  },
  errorText: {
    color: colors.danger,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 10,
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.surface,
  },
  retryButtonText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '800',
  },
  footnote: {
    marginTop: 22,
    color: colors.faint,
    fontSize: 10,
    lineHeight: 16,
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.72,
  },
});
