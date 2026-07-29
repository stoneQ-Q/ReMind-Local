import { spawn, execFileSync } from 'node:child_process';
import { accessSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const account = 'remind-local';
const secretNames = [
  'WECHAT_TOKEN',
  'DEEPSEEK_API_KEY',
  'ZHIPU_API_KEY',
];
const keychainServices = Object.fromEntries(
  secretNames.map((name) => [
    name,
    `app.remind.${name.toLowerCase()}`,
  ]),
);

function readKeychainSecret(name) {
  try {
    return execFileSync(
      'security',
      [
        'find-generic-password',
        '-a',
        account,
        '-s',
        keychainServices[name],
        '-w',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return '';
  }
}

function readDevVars() {
  try {
    const text = readFileSync(join(serverDirectory, '.dev.vars'), 'utf8');
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
        .filter(Boolean)
        .map((match) => [match[1], match[2].trim()]),
    );
  } catch {
    return {};
  }
}

function isUsableSecret(value) {
  return (
    typeof value === 'string' &&
    value.length >= 16 &&
    !/replace-with|your-api-key|placeholder/i.test(value)
  );
}

const devVars = readDevVars();
const secrets = Object.fromEntries(
  secretNames.map((name) => [
    name,
    readKeychainSecret(name) || devVars[name] || '',
  ]),
);
const missing = secretNames.filter((name) => !isUsableSecret(secrets[name]));
if (missing.length > 0) {
  console.error(`本地服务缺少有效配置：${missing.join('、')}`);
  console.error('请先把密钥保存到 macOS 钥匙串，再重新启动。');
  process.exit(1);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 8_000);
let deepSeekAvailable = false;
try {
  const response = await fetch('https://api.deepseek.com/models', {
    headers: { Authorization: `Bearer ${secrets.DEEPSEEK_API_KEY}` },
    signal: controller.signal,
  });
  deepSeekAvailable = response.ok;
} catch {
  deepSeekAvailable = false;
} finally {
  clearTimeout(timer);
}

const whisperExecutable =
  process.env.REMIND_MLX_WHISPER_PATH ??
  join(homedir(), '.remind-weixin', 'whisper-venv', 'bin', 'mlx_whisper');
const whisperModel =
  process.env.REMIND_WHISPER_MODEL_PATH ??
  join(
    homedir(),
    '.remind-weixin',
    'models',
    'whisper-small-mlx-4bit',
    'config.json',
  );
let localWhisperAvailable = true;
try {
  accessSync(whisperExecutable);
  accessSync(whisperModel);
} catch {
  localWhisperAvailable = false;
}

console.log(`启动检查 · 微信配置：可用`);
console.log(
  `启动检查 · DeepSeek：${deepSeekAvailable ? '可用' : '认证失败或网络不可用'}`,
);
console.log(`启动检查 · 智谱兜底：已配置`);
console.log(
  `启动检查 · 本地 Whisper：${localWhisperAvailable ? '可用' : '不可用，将使用云端兜底'}`,
);

if (!deepSeekAvailable) {
  console.error('DeepSeek 自检没有通过，Worker 未启动，避免任务进入必然失败状态。');
  process.exit(1);
}
if (checkOnly) process.exit(0);

const tempDirectory = mkdtempSync(join(tmpdir(), 'remind-worker-env-'));
const envPath = join(tempDirectory, '.env');
writeFileSync(
  envPath,
  secretNames.map((name) => `${name}=${secrets[name]}`).join('\n'),
  { mode: 0o600 },
);

const child = spawn(
  join(serverDirectory, 'node_modules', '.bin', 'wrangler'),
  ['dev', '--ip', '0.0.0.0', '--env-file', envPath],
  {
    cwd: serverDirectory,
    stdio: 'inherit',
  },
);
const cleanup = () => rmSync(tempDirectory, { recursive: true, force: true });
child.once('exit', (code) => {
  cleanup();
  process.exit(code ?? 0);
});
child.once('error', (error) => {
  cleanup();
  throw error;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}
