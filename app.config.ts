import type { ExpoConfig } from 'expo/config';

import app from './app.json';

const publicLocal = process.env.REMIND_APP_VARIANT === 'public-local';
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
    package: publicLocal
      ? 'app.remind.notes.local'
      : app.expo.android.package,
  },
} satisfies ExpoConfig;
