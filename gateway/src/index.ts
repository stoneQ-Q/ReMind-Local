import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';

import {
  displayedConfigPath,
  loadConfig,
  saveConfig,
  type GatewayConfig,
} from './config.js';
import { normalizeIncomingMessage } from './message.js';
import { readLinkSnapshot } from './link-reader.js';
import {
  captureMessage,
  claimCloudWechatBinding,
  listPendingLinkSnapshots,
  pairConnector,
  updateConnectorRuntimeStatus,
  updateLinkSnapshotProgress,
  uploadLinkSnapshot,
  type ConnectorCredentials,
  type PendingLinkSnapshot,
} from './remind-client.js';
import { transcribeVideoFromUrl } from './video-transcriber.js';
import {
  cloudCostLimitMicros,
  createTranscriptionProvider,
  findLocalTranscriptionProvider,
  requiresCloudCostApproval,
  type TranscriptionProvider,
} from './transcription-provider.js';
import {
  getUpdates,
  normalizedBaseUrl,
  notifyStart,
  pollLoginStatus,
  requestLoginQr,
  sendText,
} from './weixin-client.js';

const command = process.argv[2] ?? 'status';
const DEFAULT_API_URL =
  process.env.REMIND_API_URL ??
  'https://remind-wechat.chartreuse-canvas.workers.dev';

if (command === 'login') {
  await login();
} else if (command === 'pair') {
  await pair();
} else if (command === 'cloud-pair') {
  await cloudPair();
} else if (command === 'run') {
  await run();
} else if (command === 'status') {
  await status();
} else {
  throw new Error(`未知命令：${command}`);
}

async function login(): Promise<void> {
  const qr = await requestLoginQr();
  console.log('\n请使用微信扫描二维码并在手机上确认：\n');
  qrcode.generate(qr.qrcode_img_content, { small: true });
  const qrImagePath = '/tmp/remind-weixin-qr.png';
  await QRCode.toFile(qrImagePath, qr.qrcode_img_content, {
    width: 480,
    margin: 2,
  });
  console.log(`二维码图片：${qrImagePath}`);
  console.log(`\n备用链接：${qr.qrcode_img_content}\n`);

  let pollingBaseUrl: string | undefined;
  let verifyCode: string | undefined;
  let scannedNoticeShown = false;
  while (true) {
    const result = await pollLoginStatus(
      qr.qrcode,
      pollingBaseUrl,
      verifyCode,
    );
    if (result.status === 'wait') continue;
    if (result.status === 'scaned') {
      if (!scannedNoticeShown) {
        console.log('二维码已扫描，等待微信确认…');
        scannedNoticeShown = true;
      }
      verifyCode = undefined;
      continue;
    }
    if (result.status === 'scaned_but_redirect' && result.redirect_host) {
      pollingBaseUrl = normalizedBaseUrl(result.redirect_host);
      continue;
    }
    if (result.status === 'need_verifycode') {
      verifyCode = await prompt('请输入手机微信显示的数字：');
      continue;
    }
    if (result.status === 'confirmed') {
      if (
        !result.bot_token ||
        !result.ilink_bot_id ||
        !result.ilink_user_id
      ) {
        throw new Error('微信确认成功，但未返回完整账号凭据');
      }
      const config = await loadConfig();
      config.weixin = {
        botToken: result.bot_token,
        botId: result.ilink_bot_id,
        userId: result.ilink_user_id,
        baseUrl: normalizedBaseUrl(result.baseurl),
      };
      config.cursor = '';
      await saveConfig(config);
      console.log(`微信连接成功，凭据已安全保存到 ${displayedConfigPath()}`);
      return;
    }
    if (result.status === 'binded_redirect') {
      throw new Error('这个 ClawBot 已绑定过其他客户端，请先在微信中解除后重试');
    }
    if (
      result.status === 'expired' ||
      result.status === 'verify_code_blocked'
    ) {
      throw new Error('二维码或验证码已失效，请重新运行登录命令');
    }
  }
}

async function pair(): Promise<void> {
  const config = await loadConfig();
  if (!config.weixin) {
    throw new Error('请先运行 npm run login 完成微信扫码');
  }
  const bindingCode =
    process.argv[3]?.trim() || (await prompt('请输入 ReMind 的六位绑定码：'));
  if (!/^[0-9]{6}$/.test(bindingCode)) {
    throw new Error('绑定码必须是六位数字');
  }
  const apiBaseUrl = process.env.REMIND_API_URL ?? DEFAULT_API_URL;
  const credentials = await pairConnector(apiBaseUrl, bindingCode);
  config.remind = { apiBaseUrl, ...credentials };
  await saveConfig(config);
  console.log('ReMind 配对成功。');
}

async function cloudPair(): Promise<void> {
  const config = await loadConfig();
  if (!config.weixin) {
    throw new Error('请先运行 npm run login 完成微信扫码');
  }
  const bindingCode =
    process.argv[3]?.trim() || (await prompt('请输入 ReMind 的六位云端绑定码：'));
  if (!/^[0-9]{6}$/.test(bindingCode)) {
    throw new Error('绑定码必须是六位数字');
  }
  const apiBaseUrl =
    process.env.REMIND_CLOUD_API_URL ?? process.env.REMIND_API_URL;
  if (!apiBaseUrl) {
    throw new Error('请设置 REMIND_CLOUD_API_URL');
  }
  await claimCloudWechatBinding(apiBaseUrl, bindingCode, {
    botToken: config.weixin.botToken,
    botId: config.weixin.botId,
    allowedUserId: config.weixin.userId,
    baseUrl: config.weixin.baseUrl,
  });
  console.log('ReMind 云端微信配对成功，云端会继续接收消息。');
}

async function run(): Promise<void> {
  const config = await loadConfig();
  if (!config.weixin || !config.remind) {
    throw new Error('请先依次运行 npm run login 和 npm run pair');
  }

  console.log('ReMind 微信网关已启动。按 Ctrl+C 停止。');
  try {
    await notifyStart(config.weixin.baseUrl, config.weixin.botToken);
  } catch (error) {
    console.warn(`启动通知失败，将继续收件：${String(error)}`);
  }

  const cloudTranscriptionProvider = createTranscriptionProvider({
    apiBaseUrl: config.remind.apiBaseUrl,
    credentials: connectorCredentials(config),
  });
  const localTranscriptionProvider = await findLocalTranscriptionProvider();
  console.log(
    `视频转写：${
      localTranscriptionProvider
        ? `${localTranscriptionProvider.label} 优先，${cloudTranscriptionProvider.label}兜底`
        : cloudTranscriptionProvider.label
    }`,
  );
  const snapshotQueue = createSnapshotQueue(
    config,
    {
      local: localTranscriptionProvider,
      cloud: cloudTranscriptionProvider,
    },
    cloudCostLimitMicros(),
  );
  const reportRuntime = async (): Promise<void> => {
    await updateConnectorRuntimeStatus(
      config.remind!.apiBaseUrl,
      connectorCredentials(config),
      {
        localWhisperAvailable: Boolean(localTranscriptionProvider),
      },
    );
  };
  await reportRuntime().catch((error) =>
    console.warn(`网关状态上报失败，将继续收件：${String(error)}`),
  );
  const recoverPending = async (): Promise<void> => {
    try {
      await reportRuntime();
      const pending = await listPendingLinkSnapshots(
        config.remind!.apiBaseUrl,
        connectorCredentials(config),
      );
      for (const item of pending) snapshotQueue.schedule(item);
      if (pending.length > 0) {
        console.log(`发现 ${pending.length} 条待处理链接。`);
      }
    } catch (error) {
      console.warn(`未能读取待处理链接，将继续收件：${String(error)}`);
    }
  };
  await recoverPending();
  setInterval(() => void recoverPending(), 15_000);

  let timeoutMs = 40_000;
  let failures = 0;
  while (true) {
    try {
      const response = await getUpdates(
        config.weixin.baseUrl,
        config.weixin.botToken,
        config.cursor ?? '',
        timeoutMs,
      );
      if (
        (response.ret !== undefined && response.ret !== 0) ||
        (response.errcode !== undefined && response.errcode !== 0)
      ) {
        throw new Error(
          `微信收件失败 ret=${response.ret} errcode=${response.errcode}: ${
            response.errmsg ?? ''
          }`,
        );
      }
      if (response.longpolling_timeout_ms) {
        timeoutMs = response.longpolling_timeout_ms;
      }

      for (const message of response.msgs ?? []) {
        const capture = normalizeIncomingMessage(
          message,
          config.weixin.userId,
        );
        if (!capture) continue;
        const result = await captureMessage(
          config.remind.apiBaseUrl,
          connectorCredentials(config),
          capture,
        );
        if (result.replyText) {
          await sendText(
            config.weixin.baseUrl,
            config.weixin.botToken,
            message,
            result.replyText,
          );
        }
        if (result.linkSnapshot) {
          snapshotQueue.schedule({
            ...result.linkSnapshot,
            cloudCostApproved: false,
          });
        }
        console.log(`已记录：${capture.content.slice(0, 60)}`);
      }

      if (
        response.get_updates_buf !== undefined &&
        response.get_updates_buf !== config.cursor
      ) {
        config.cursor = response.get_updates_buf;
        await saveConfig(config);
      }
      failures = 0;
    } catch (error) {
      failures += 1;
      console.error(`网关错误：${String(error)}`);
      await sleep(Math.min(30_000, failures * 2_000));
    }
  }
}

function createSnapshotQueue(
  config: GatewayConfig,
  transcriptionProviders: {
    local: TranscriptionProvider | undefined;
    cloud: TranscriptionProvider;
  },
  costLimitMicros: number,
): {
  schedule: (item: PendingLinkSnapshot) => void;
} {
  const active = new Set<string>();
  let queue = Promise.resolve();

  const processSnapshot = async (item: PendingLinkSnapshot): Promise<void> => {
    try {
      const snapshot = await readLinkSnapshot(item.url);
      if (snapshot.mediaType === 'video') {
        if (!snapshot.transientVideoUrl) {
          throw new Error('小红书视频没有返回可读取的媒体地址');
        }
        console.log(
          `正在转写视频：${snapshot.title.slice(0, 60)}${
            snapshot.durationSeconds
              ? `（约 ${Math.ceil(snapshot.durationSeconds / 60)} 分钟）`
              : ''
          }`,
        );
        const cloudEstimatedCostMicros = snapshot.durationSeconds
          ? transcriptionProviders.cloud.estimateCostMicros(
              snapshot.durationSeconds,
            )
          : null;
        const waitForCloudApproval = async (): Promise<void> => {
          await updateLinkSnapshotProgress(
            config.remind!.apiBaseUrl,
            connectorCredentials(config),
            item.messageId,
            {
              stage: 'awaiting_approval',
              current: 0,
              total: 0,
              provider: transcriptionProviders.cloud.id,
              estimatedCostMicros: cloudEstimatedCostMicros,
              durationSeconds: snapshot.durationSeconds,
              costLimitMicros,
            },
          );
          console.log(
            `视频等待费用确认：${snapshot.title.slice(0, 60)}（${
              cloudEstimatedCostMicros === null
                ? '时长未知'
                : `预计 ¥${(cloudEstimatedCostMicros / 1_000_000).toFixed(2)}`
            }）`,
          );
        };
        const exceedsCloudLimit = requiresCloudCostApproval({
          estimatedCostMicros: cloudEstimatedCostMicros,
          costLimitMicros,
          approved: false,
        });
        let provider =
          item.cloudCostApproved || !transcriptionProviders.local
            ? transcriptionProviders.cloud
            : transcriptionProviders.local;
        if (
          provider.id === 'zhipu-cloud' &&
          exceedsCloudLimit &&
          !item.cloudCostApproved
        ) {
          await waitForCloudApproval();
          return;
        }

        const transcribeWithProvider = async (
          selectedProvider: TranscriptionProvider,
        ): Promise<string> => {
          const estimatedCostMicros = snapshot.durationSeconds
            ? selectedProvider.estimateCostMicros(snapshot.durationSeconds)
            : null;
          await updateLinkSnapshotProgress(
            config.remind!.apiBaseUrl,
            connectorCredentials(config),
            item.messageId,
            {
              stage: 'extracting',
              current: 0,
              total: 0,
              provider: selectedProvider.id,
              estimatedCostMicros,
              durationSeconds: snapshot.durationSeconds,
              costLimitMicros,
            },
          );
          return transcribeVideoFromUrl(
            snapshot.transientVideoUrl!,
            selectedProvider.transcribe,
            ({ completed, total }) =>
              updateLinkSnapshotProgress(
                config.remind!.apiBaseUrl,
                connectorCredentials(config),
                item.messageId,
                {
                  stage: 'transcribing',
                  current: completed,
                  total,
                  provider: selectedProvider.id,
                  estimatedCostMicros,
                  durationSeconds: snapshot.durationSeconds,
                  costLimitMicros,
                },
              ),
          );
        };

        let transcript: string;
        try {
          transcript = await transcribeWithProvider(provider);
        } catch (error) {
          if (provider.id !== 'local-whisper') throw error;
          console.warn(`本地 Whisper 失败，将检查云端兜底：${String(error)}`);
          if (exceedsCloudLimit && !item.cloudCostApproved) {
            await waitForCloudApproval();
            return;
          }
          provider = transcriptionProviders.cloud;
          transcript = await transcribeWithProvider(provider);
        }
        snapshot.text = [
          `作者文案：\n${snapshot.text}`,
          `视频转写：\n${transcript}`,
        ].join('\n\n');
      }
      await uploadLinkSnapshot(
        config.remind!.apiBaseUrl,
        connectorCredentials(config),
        item.messageId,
        snapshot,
      );
      console.log(
        `链接整理完成：${snapshot.title.slice(0, 60)}${
          snapshot.mediaType === 'video'
            ? '（视频已转写）'
            : snapshot.images.length > 0
              ? `（${snapshot.images.length} 张图片）`
              : ''
        }`,
      );
    } catch (error) {
      await uploadLinkSnapshot(
        config.remind!.apiBaseUrl,
        connectorCredentials(config),
        item.messageId,
        null,
      ).catch(() => undefined);
      console.warn(`链接正文读取失败：${String(error)}`);
    }
  };

  return {
    schedule(item) {
      if (active.has(item.messageId)) return;
      active.add(item.messageId);
      queue = queue
        .then(() => processSnapshot(item))
        .finally(() => active.delete(item.messageId));
    },
  };
}

async function status(): Promise<void> {
  const config = await loadConfig();
  console.log(`配置文件：${displayedConfigPath()}`);
  console.log(`微信：${config.weixin ? '已连接' : '未连接'}`);
  console.log(`ReMind：${config.remind ? '已配对' : '未配对'}`);
}

function connectorCredentials(config: GatewayConfig): ConnectorCredentials {
  if (!config.remind) throw new Error('ReMind 尚未配对');
  return {
    connectorId: config.remind.connectorId,
    connectorSecret: config.remind.connectorSecret,
    kind: 'weixin-ilink',
  };
}

async function prompt(question: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return (await readline.question(question)).trim();
  } finally {
    readline.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
