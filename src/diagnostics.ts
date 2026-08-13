import * as Application from 'expo-application';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import type { SQLiteDatabase } from 'expo-sqlite';

import { requestCloudPublicStatus } from './cloud-api';
import { getWechatSyncDiagnostic } from './database';
import type { ReMindModeStatus } from './service-mode';
import type { WechatConnection } from './wechat-sync';

export type AppDiagnostics = {
  appName: string;
  appVersion: string;
  buildVersion: string;
  applicationId: string;
  environment: string;
  activeMode: string;
  cloudRelease: string;
  cloudReady: boolean;
  wechatState: string;
  lastWechatSyncAt: string | null;
  lastWechatError: string | null;
  checkedAt: string;
};

export async function loadAppDiagnostics(
  db: SQLiteDatabase,
  serviceMode: ReMindModeStatus,
  wechat: WechatConnection | null,
): Promise<AppDiagnostics> {
  const [sync, cloud] = await Promise.all([
    getWechatSyncDiagnostic(db),
    serviceMode.active === 'cloud'
      ? requestCloudPublicStatus().catch(() => null)
      : Promise.resolve(null),
  ]);
  const expoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
  return {
    appName: Application.applicationName ?? Constants.expoConfig?.name ?? 'ReMind',
    appVersion:
      (expoGo ? Constants.expoConfig?.version : Application.nativeApplicationVersion) ??
      Constants.expoConfig?.version ??
      '未知',
    buildVersion: expoGo ? 'Expo Go' : Application.nativeBuildVersion ?? '未知',
    applicationId: expoGo
      ? Constants.expoConfig?.android?.package ?? Constants.expoConfig?.ios?.bundleIdentifier ?? 'Expo Go'
      : Application.applicationId ?? '未知',
    environment: environmentLabel(),
    activeMode: serviceMode.active === 'cloud' ? '云端模式' : '本地模式',
    cloudRelease: cloud?.release ?? (cloud ? '未标记' : '无法读取'),
    cloudReady: cloud?.ok === true,
    wechatState: !wechat
      ? '尚未读取'
      : wechat.bound
        ? wechat.gatewayOnline
          ? '已连接，网关在线'
          : '已连接，等待网关'
        : '未连接',
    lastWechatSyncAt: sync.lastSuccessAt,
    lastWechatError: sync.lastError,
    checkedAt: new Date().toISOString(),
  };
}

function environmentLabel(): string {
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    return 'Expo Go 开发环境';
  }
  return __DEV__ ? '开发测试包' : '已安装 App';
}
