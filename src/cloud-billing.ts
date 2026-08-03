import {
  CloudApiRequestError,
  requestCloudJson,
} from './cloud-api';

export type CloudBillingAccount = {
  currency: 'CNY';
  balanceMicros: string;
  reservedMicros: string;
  availableMicros: string;
  dailyLimitMicros: string;
  monthlyLimitMicros: string;
  updatedAt: string;
};

export type CloudLedgerKind =
  | 'top_up'
  | 'reserve'
  | 'settle'
  | 'release'
  | 'refund'
  | 'adjustment';

export type CloudLedgerEntry = {
  id: string;
  jobId: string | null;
  kind: CloudLedgerKind;
  amountMicros: string;
  balanceDeltaMicros: string;
  reservedDeltaMicros: string;
  balanceAfterMicros: string;
  reservedAfterMicros: string;
  source: 'payment' | 'gift' | 'operator' | null;
  createdAt: string;
};

export type CloudBillingOverview = {
  account: CloudBillingAccount;
  entries: CloudLedgerEntry[];
};

export async function getCloudBillingOverview(): Promise<CloudBillingOverview> {
  const [accountPayload, ledgerPayload] = await Promise.all([
    requestCloudJson('billing/account'),
    requestCloudJson('billing/ledger'),
  ]);
  if (!isBillingAccount(accountPayload)) {
    throw new CloudApiRequestError('invalid_billing_account_response');
  }
  if (
    !isRecord(ledgerPayload) ||
    !Array.isArray(ledgerPayload.entries) ||
    ledgerPayload.entries.length > 100 ||
    !ledgerPayload.entries.every(isLedgerEntry)
  ) {
    throw new CloudApiRequestError('invalid_billing_ledger_response');
  }
  return {
    account: accountPayload,
    entries: ledgerPayload.entries,
  };
}

export function formatCnyMicros(value: string, showPlus = false): string {
  const micros = BigInt(value);
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const whole = absolute / 1_000_000n;
  let fraction = (absolute % 1_000_000n).toString().padStart(6, '0');
  while (fraction.length > 2 && fraction.endsWith('0')) {
    fraction = fraction.slice(0, -1);
  }
  const grouped = whole
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = negative ? '-' : showPlus && micros > 0n ? '+' : '';
  return `${sign}¥${grouped}.${fraction}`;
}

export { CloudApiRequestError as CloudBillingError };

function isBillingAccount(value: unknown): value is CloudBillingAccount {
  if (
    !(
    isRecord(value) &&
    value.currency === 'CNY' &&
    isNonnegativeInteger(value.balanceMicros) &&
    isNonnegativeInteger(value.reservedMicros) &&
    isNonnegativeInteger(value.availableMicros) &&
    isNonnegativeInteger(value.dailyLimitMicros) &&
    isNonnegativeInteger(value.monthlyLimitMicros) &&
    typeof value.updatedAt === 'string'
    )
  ) {
    return false;
  }
  const balance = BigInt(value.balanceMicros);
  const reserved = BigInt(value.reservedMicros);
  return (
    reserved <= balance &&
    BigInt(value.availableMicros) === balance - reserved
  );
}

function isLedgerEntry(value: unknown): value is CloudLedgerEntry {
  if (
    !(
    isRecord(value) &&
    typeof value.id === 'string' &&
    (typeof value.jobId === 'string' || value.jobId === null) &&
    isLedgerKind(value.kind) &&
    isNonnegativeInteger(value.amountMicros) &&
    isInteger(value.balanceDeltaMicros) &&
    isInteger(value.reservedDeltaMicros) &&
    isNonnegativeInteger(value.balanceAfterMicros) &&
    isNonnegativeInteger(value.reservedAfterMicros) &&
    (value.source === 'payment' ||
      value.source === 'gift' ||
      value.source === 'operator' ||
      value.source === null) &&
    typeof value.createdAt === 'string'
    )
  ) {
    return false;
  }
  return BigInt(value.reservedAfterMicros) <= BigInt(value.balanceAfterMicros);
}

function isLedgerKind(value: unknown): value is CloudLedgerKind {
  return (
    value === 'top_up' ||
    value === 'reserve' ||
    value === 'settle' ||
    value === 'release' ||
    value === 'refund' ||
    value === 'adjustment'
  );
}

function isInteger(value: unknown): value is string {
  return typeof value === 'string' && /^-?(?:0|[1-9]\d*)$/.test(value);
}

function isNonnegativeInteger(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
