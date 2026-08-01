/**
 * Stable on-device storage identities.
 *
 * These values are part of ReMind's upgrade contract. Changing one creates a
 * new storage location and can make an in-place update appear to lose data.
 */
export const REMIND_DATABASE_NAME = 'remind.db';
export const REMIND_DATABASE_SCHEMA_VERSION = 16;
export const REMIND_APPLICATION_ID = 'app.remind.notes';

export const OBSIDIAN_DIRECTORY_URI_SETTING = 'obsidian.directory_uri';
export const OBSIDIAN_DIRECTORY_NAME_SETTING = 'obsidian.directory_name';
export const LINK_AUTOMATION_MODE_SETTING = 'links.automation_mode';
export const REMIND_SERVICE_MODE_STORAGE_KEY = 'remind.service.mode.v1';

const WECHAT_DEVICE_ID_STORAGE_KEY = 'remind.wechat.device-id';
const WECHAT_DEVICE_SECRET_STORAGE_KEY = 'remind.wechat.device-secret';
const CLOUD_SESSION_STORAGE_KEY = 'remind.cloud.session';

export function wechatDeviceIdStorageKey(scope: string): string {
  return scopedStorageKey(WECHAT_DEVICE_ID_STORAGE_KEY, scope);
}

export function wechatDeviceSecretStorageKey(scope: string): string {
  return scopedStorageKey(WECHAT_DEVICE_SECRET_STORAGE_KEY, scope);
}

export function cloudSessionStorageKey(scope: string): string {
  return scopedStorageKey(CLOUD_SESSION_STORAGE_KEY, scope);
}

function scopedStorageKey(key: string, scope: string): string {
  let hash = 5381;
  for (let index = 0; index < scope.length; index += 1) {
    hash = (hash * 33) ^ scope.charCodeAt(index);
  }
  return `${key}.${(hash >>> 0).toString(16)}`;
}
