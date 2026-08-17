export type ReMindAppVariant = 'consumer' | 'public-local';

export function getReMindAppVariant(): ReMindAppVariant {
  return process.env.EXPO_PUBLIC_REMIND_APP_VARIANT === 'public-local'
    ? 'public-local'
    : 'consumer';
}

export function isConsumerReMindApp(): boolean {
  return getReMindAppVariant() === 'consumer';
}

export function isPublicLocalReMindApp(): boolean {
  return getReMindAppVariant() === 'public-local';
}
