import type { ExpoConfig } from 'expo/config';

import app from './app.json';

const publicLocal = process.env.REMIND_APP_VARIANT === 'public-local';
const androidVersionCode = Number(process.env.REMIND_ANDROID_VERSION_CODE);
const base = app.expo as ExpoConfig;

export default {
  ...base,
  name: publicLocal ? 'ReMind Local' : base.name,
  version: publicLocal ? '1.0.3' : base.version,
  scheme: publicLocal ? 'remind-local' : base.scheme,
  ios: {
    ...base.ios,
    bundleIdentifier: publicLocal
      ? 'app.remind.notes.local'
      : app.expo.ios.bundleIdentifier,
  },
  android: {
    ...base.android,
    versionCode:
      Number.isInteger(androidVersionCode) && androidVersionCode > 0
        ? androidVersionCode
        : base.android?.versionCode,
    package: publicLocal
      ? 'app.remind.notes.local'
      : app.expo.android.package,
  },
} satisfies ExpoConfig;
