import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CloudAiSettingsError,
  deleteCloudAiCredential,
  getCloudAiSettings,
  saveCloudAiCredential,
  testCloudAiCredential,
  updateCloudAiMode,
  type CloudAiMode,
  type CloudAiProvider,
  type CloudAiSettings as CloudAiSettingsValue,
} from './cloud-ai-settings';
import type { LinkAutomationMode } from './database';
import { colors } from './theme';

const PROVIDERS: Array<{
  provider: CloudAiProvider;
  title: string;
  description: string;
  placeholder: string;
}> = [
  {
    provider: 'deepseek',
    title: 'DeepSeek',
    description: '用于文字整理和视频内容总结',
    placeholder: '填写 DeepSeek API Key',
  },
  {
    provider: 'zhipu',
    title: '智谱 AI',
    description: '用于图片理解、语音和视频转写',
    placeholder: '填写智谱 API Key',
  },
];

export function CloudAiSettings({
  linkAutomationMode,
  onClose,
  onLinkAutomationModeChange,
  visible,
}: {
  linkAutomationMode: LinkAutomationMode;
  onClose: () => void;
  onLinkAutomationModeChange: (mode: LinkAutomationMode) => Promise<void>;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState<CloudAiSettingsValue | null>(null);
  const [inputs, setInputs] = useState<Record<CloudAiProvider, string>>({
    deepseek: '',
    zhipu: '',
  });
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<
    CloudAiProvider | 'mode' | 'automation' | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [byokSelected, setByokSelected] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setInputs({ deepseek: '', zhipu: '' });
      setSettings(null);
      setError(null);
      setActing(null);
      setByokSelected(false);
      setTestResult(null);
      return;
    }
    let current = true;
    setLoading(true);
    setError(null);
    void getCloudAiSettings()
      .then((value) => {
        if (current) {
          setSettings(value);
          setByokSelected(value.mode === 'bring_your_own_key');
        }
      })
      .catch((reason) => {
        if (current) setError(aiSettingsErrorMessage(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [visible]);

  const changeMode = async (mode: Exclude<CloudAiMode, 'managed'>) => {
    if (acting) return;
    if (mode === 'bring_your_own_key' && !settings?.credentials.length) {
      setByokSelected(true);
      setError('已选择使用自己的 Key。请在下方填写并保存，保存成功后会正式启用。');
      return;
    }
    setActing('mode');
    setError(null);
    try {
      setSettings(await updateCloudAiMode(mode));
      setByokSelected(mode === 'bring_your_own_key');
    } catch (reason) {
      setError(aiSettingsErrorMessage(reason));
    } finally {
      setActing(null);
    }
  };

  const saveCredential = async (provider: CloudAiProvider) => {
    const apiKey = inputs[provider].trim();
    if (!apiKey || acting) return;
    setActing(provider);
    setError(null);
    try {
      const saved = await saveCloudAiCredential(provider, apiKey);
      setInputs((current) => ({ ...current, [provider]: '' }));
      setSettings(
        saved.mode === 'bring_your_own_key'
          ? saved
          : await updateCloudAiMode('bring_your_own_key'),
      );
      setByokSelected(true);
    } catch (reason) {
      setError(aiSettingsErrorMessage(reason));
    } finally {
      setActing(null);
    }
  };

  const removeCredential = (provider: CloudAiProvider) => {
    const title =
      PROVIDERS.find((item) => item.provider === provider)?.title ?? provider;
    Alert.alert(
      `删除 ${title} Key？`,
      '删除后云端无法再使用这个供应商。完整 Key 无法从 ReMind 恢复。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            setActing(provider);
            setError(null);
            try {
              setSettings(await deleteCloudAiCredential(provider));
              setInputs((current) => ({ ...current, [provider]: '' }));
            } catch (reason) {
              setError(aiSettingsErrorMessage(reason));
            } finally {
              setActing(null);
            }
          },
        },
      ],
    );
  };

  const testCredential = async () => {
    if (acting) return;
    setActing('mode');
    setError(null);
    setTestResult(null);
    try {
      const result = await testCloudAiCredential();
      setTestResult(`${result.content}\n\n模型：${result.model} · 本次 ${result.promptTokens + result.completionTokens} tokens`);
    } catch (reason) {
      setError(aiSettingsErrorMessage(reason));
    } finally {
      setActing(null);
    }
  };

  const changeLinkAutomation = async (mode: LinkAutomationMode) => {
    if (acting || mode === linkAutomationMode) return;
    setActing('automation');
    setError(null);
    try {
      await onLinkAutomationModeChange(mode);
    } catch {
      setError('自动整理偏好暂时没有保存成功，请稍后重试。');
    } finally {
      setActing(null);
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={() => {
        if (!loading && !acting) onClose();
      }}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <View style={styles.sheet}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable
            disabled={loading || Boolean(acting)}
            hitSlop={10}
            onPress={onClose}
          >
            <Text style={styles.close}>关闭</Text>
          </Pressable>
          <Text style={styles.heading}>AI 与 API Key</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView
          contentContainerStyle={[
            styles.body,
            { paddingBottom: insets.bottom + 28 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.heroMark}>
            <Text style={styles.heroMarkText}>AI</Text>
          </View>
          <Text style={styles.title}>选择谁来承担模型费用</Text>
          <Text style={styles.copy}>
            关闭 AI 不会删除笔记；使用自己的 Key 时，模型费用直接由对应供应商向你结算。
          </Text>

          {loading && !settings ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.loadingText}>正在读取安全设置…</Text>
            </View>
          ) : (
            <>
              <AiModeCard
                active={settings?.mode === 'disabled' && !byokSelected}
                description="只记录、搜索和备份，不调用任何模型。"
                disabled={Boolean(acting)}
                label="不使用 AI"
                onPress={() => void changeMode('disabled')}
              />
              <AiModeCard
                active={
                  settings?.mode === 'bring_your_own_key' || byokSelected
                }
                description="Key 加密保存在云端，费用由你自己的供应商账号承担。"
                disabled={Boolean(acting)}
                label="使用自己的 API Key"
                onPress={() => void changeMode('bring_your_own_key')}
              />
              <AiModeCard
                active={settings?.mode === 'managed'}
                badge="尚未开放"
                description="由 ReMind 提供模型并按实际用量扣费；余额、价格和充值完成前保持锁定。"
                disabled
                label="使用 ReMind 托管服务"
                onPress={() => undefined}
              />

              <View style={styles.securityNotice}>
                <Text style={styles.securityNoticeTitle}>Key 如何保存</Text>
                <Text style={styles.securityNoticeCopy}>
                  输入后立即通过当前云端会话提交；App
                  不保存完整值，服务端加密存储，之后只返回末四位。
                </Text>
              </View>

              <Text style={styles.sectionTitle}>链接自动整理</Text>
              <Text style={styles.sectionCopy}>
                只处理已经取得可追溯正文或视频转写的链接。自动模式会直接使用你的
                DeepSeek Key；原始链接和证据仍会保留。
              </Text>
              <AiModeCard
                active={linkAutomationMode === 'review'}
                description="保持逐篇生成、审核和确认，不自动创建正式笔记。"
                disabled={Boolean(acting)}
                label="每次由我审核"
                onPress={() => void changeLinkAutomation('review')}
              />
              <AiModeCard
                active={linkAutomationMode === 'auto_note'}
                description="链接处理完成后自动生成正式来源笔记；主题仍由你决定。"
                disabled={Boolean(acting)}
                label="自动生成笔记"
                onPress={() => void changeLinkAutomation('auto_note')}
              />
              <AiModeCard
                active={linkAutomationMode === 'auto_note_and_theme'}
                description="自动生成笔记并接受主题建议；之后可在来源笔记中随时重新归类。"
                disabled={Boolean(acting)}
                label="自动生成并归入主题"
                onPress={() =>
                  void changeLinkAutomation('auto_note_and_theme')
                }
              />

              <Text style={styles.sectionTitle}>你的 API Key</Text>
              {PROVIDERS.map((item) => {
                const credential = settings?.credentials.find(
                  (value) => value.provider === item.provider,
                );
                const saving = acting === item.provider;
                return (
                  <View key={item.provider} style={styles.providerCard}>
                    <View style={styles.providerHeader}>
                      <View style={styles.providerCopy}>
                        <Text style={styles.providerTitle}>{item.title}</Text>
                        <Text style={styles.providerDescription}>
                          {item.description}
                        </Text>
                      </View>
                      {credential ? (
                        <View style={styles.configuredBadge}>
                          <Text style={styles.configuredBadgeText}>
                            已配置 ····{credential.maskedSuffix}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <TextInput
                      autoCapitalize="none"
                      autoCorrect={false}
                      editable={!acting}
                      onChangeText={(value) =>
                        setInputs((current) => ({
                          ...current,
                          [item.provider]: value,
                        }))
                      }
                      placeholder={
                        credential ? '填写新 Key 可替换' : item.placeholder
                      }
                      placeholderTextColor={colors.faint}
                      secureTextEntry
                      style={styles.keyInput}
                      textContentType="password"
                      value={inputs[item.provider]}
                    />
                    <View style={styles.providerActions}>
                      <Pressable
                        disabled={!inputs[item.provider].trim() || Boolean(acting)}
                        onPress={() => void saveCredential(item.provider)}
                        style={({ pressed }) => [
                          styles.saveButton,
                          (!inputs[item.provider].trim() || Boolean(acting)) &&
                            styles.buttonDisabled,
                          pressed && styles.pressed,
                        ]}
                      >
                        {saving ? (
                          <ActivityIndicator color={colors.white} size="small" />
                        ) : (
                          <Text style={styles.saveButtonText}>
                            {credential ? '替换 Key' : '保存 Key'}
                          </Text>
                        )}
                      </Pressable>
                      {credential ? (
                        <Pressable
                          disabled={Boolean(acting)}
                          onPress={() => removeCredential(item.provider)}
                          style={({ pressed }) => [
                            styles.deleteButton,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Text style={styles.deleteButtonText}>删除</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </View>
                );
              })}
              {settings?.mode === 'bring_your_own_key' &&
              settings.credentials.some(
                (credential) => credential.provider === 'deepseek',
              ) ? (
                <View style={styles.securityNotice}>
                  <Text style={styles.securityNoticeTitle}>真实调用验证</Text>
                  <Text style={styles.securityNoticeCopy}>
                    会向 DeepSeek 发起一次很短的真实生成请求，费用由你的 DeepSeek 账号承担。
                  </Text>
                  <Pressable
                    disabled={Boolean(acting)}
                    onPress={() => void testCredential()}
                    style={({ pressed }) => [
                      styles.saveButton,
                      Boolean(acting) && styles.buttonDisabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    {acting === 'mode' ? (
                      <ActivityIndicator color={colors.white} size="small" />
                    ) : (
                      <Text style={styles.saveButtonText}>生成一句测试内容</Text>
                    )}
                  </Pressable>
                  {testResult ? (
                    <Text style={styles.securityNoticeCopy}>{testResult}</Text>
                  ) : null}
                </View>
              ) : null}
            </>
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Text style={styles.footnote}>
            ReMind 不会显示或下载已经保存的完整 Key。若怀疑泄露，请在对应供应商后台撤销并生成新
            Key。
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

function AiModeCard({
  active,
  badge,
  description,
  disabled,
  label,
  onPress,
}: {
  active: boolean;
  badge?: string;
  description: string;
  disabled: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.modeCard,
        active && styles.modeCardActive,
        disabled && styles.modeCardDisabled,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.radio, active && styles.radioActive]}>
        {active ? <View style={styles.radioDot} /> : null}
      </View>
      <View style={styles.modeCopy}>
        <View style={styles.modeTitleRow}>
          <Text style={styles.modeTitle}>{label}</Text>
          {badge ? <Text style={styles.modeBadge}>{badge}</Text> : null}
        </View>
        <Text style={styles.modeDescription}>{description}</Text>
      </View>
    </Pressable>
  );
}

function aiSettingsErrorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.name === 'AbortError') {
    return '连接超时，请检查网络后重试。';
  }
  if (reason instanceof CloudAiSettingsError) {
    switch (reason.code) {
      case 'cloud_session_missing':
      case 'unauthorized':
        return '云端登录已经失效，请先用恢复码重新连接账号。';
      case 'invalid_api_credential':
        return '这个 Key 格式不正确，请检查是否完整复制。';
      case 'api_credential_required':
        return '请先保存至少一个自己的 API Key。';
      case 'user_provider_credential_required':
        return '请先保存 DeepSeek API Key。';
      case 'ai_key_rejected':
        return 'DeepSeek 拒绝了这个 Key，请检查 Key 是否有效及账号余额。';
      case 'ai_rate_limited':
        return 'DeepSeek 当前限流，请稍后再试。';
      case 'ai_provider_failed':
        return '已连接到云端，但 DeepSeek 暂时没有完成生成，请稍后再试。';
      case 'cloud_not_configured':
        return '这个安装包尚未配置私密测试云端。';
    }
  }
  return 'AI 设置暂时没有保存成功，请稍后重试。';
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
    borderColor: colors.accent,
    borderRadius: 22,
    backgroundColor: colors.accentSoft,
    transform: [{ rotate: '-2deg' }],
  },
  heroMarkText: {
    color: colors.accent,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 20,
    fontWeight: '900',
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
    minHeight: 150,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    color: colors.muted,
    fontSize: 13,
  },
  modeCard: {
    marginBottom: 10,
    padding: 15,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  modeCardActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  modeCardDisabled: {
    opacity: 0.55,
  },
  radio: {
    width: 19,
    height: 19,
    marginTop: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.faint,
    borderRadius: 10,
    backgroundColor: colors.surface,
  },
  radioActive: {
    borderColor: colors.accent,
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  modeCopy: {
    flex: 1,
  },
  modeTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 7,
  },
  modeTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  modeBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 99,
    backgroundColor: colors.apricot,
    color: colors.apricotText,
    fontSize: 9,
    fontWeight: '800',
  },
  modeDescription: {
    marginTop: 5,
    color: colors.muted,
    fontSize: 11,
    lineHeight: 17,
  },
  securityNotice: {
    marginTop: 12,
    padding: 15,
    borderRadius: 16,
    backgroundColor: colors.sage,
  },
  securityNoticeTitle: {
    color: colors.sageText,
    fontSize: 12,
    fontWeight: '800',
  },
  securityNoticeCopy: {
    marginTop: 5,
    color: colors.sageText,
    fontSize: 11,
    lineHeight: 17,
  },
  sectionTitle: {
    marginTop: 26,
    marginBottom: 10,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  sectionCopy: {
    marginTop: -4,
    marginBottom: 12,
    color: colors.muted,
    fontSize: 11,
    lineHeight: 17,
  },
  providerCard: {
    marginBottom: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 17,
    backgroundColor: colors.surface,
  },
  providerHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  providerCopy: {
    flex: 1,
  },
  providerTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  providerDescription: {
    marginTop: 4,
    color: colors.muted,
    fontSize: 11,
    lineHeight: 16,
  },
  configuredBadge: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 99,
    backgroundColor: colors.accentSoft,
  },
  configuredBadgeText: {
    color: colors.accent,
    fontSize: 9,
    fontWeight: '800',
  },
  keyInput: {
    minHeight: 50,
    marginTop: 14,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 13,
    backgroundColor: colors.paper,
    color: colors.ink,
    fontSize: 14,
  },
  providerActions: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 9,
  },
  saveButton: {
    minHeight: 43,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.accent,
  },
  saveButtonText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '800',
  },
  deleteButton: {
    minHeight: 43,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
  deleteButtonText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '800',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  error: {
    marginTop: 14,
    color: colors.danger,
    fontSize: 12,
    lineHeight: 19,
    textAlign: 'center',
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
