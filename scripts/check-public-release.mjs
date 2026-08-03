import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const eas = JSON.parse(readFileSync(resolve(root, 'eas.json'), 'utf8'));
const profile = eas.build?.['public-local'];
const failures = [];

if (!profile) failures.push('缺少 eas.json public-local 构建配置');
if (profile?.android?.buildType !== 'apk') {
  failures.push('public-local 必须生成 APK');
}
if (profile?.env?.REMIND_APP_VARIANT !== 'public-local') {
  failures.push('public-local 缺少独立 App 变体');
}
for (const name of [
  'EXPO_PUBLIC_REMIND_LOCAL_API_URL',
  'EXPO_PUBLIC_REMIND_CLOUD_API_URL',
]) {
  if (Object.hasOwn(profile?.env ?? {}, name)) {
    failures.push(`${name} 不能出现在公共构建配置中`);
  }
}
for (const name of Object.keys(profile?.env ?? {})) {
  if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)) {
    failures.push(`公共构建不能声明敏感变量：${name}`);
  }
}

const tracked = execFileSync('git', ['ls-files'], {
  cwd: root,
  encoding: 'utf8',
}).trim().split('\n');
for (const forbidden of [
  '.env',
  'server/.dev.vars',
  'gateway/.env',
  'cloud/.env',
]) {
  if (tracked.includes(forbidden)) failures.push(`私密文件被 Git 跟踪：${forbidden}`);
}

const historicalFindings = scanGitHistory();
for (const finding of historicalFindings) {
  failures.push(`Git 历史中存在疑似密钥：${finding}`);
}
for (const path of tracked) {
  if (!path || /(^|\/)(package-lock\.json|.*\.test\.[jt]sx?|docs\/)/.test(path)) {
    continue;
  }
  let content = '';
  try {
    content = readFileSync(resolve(root, path), 'utf8');
  } catch {
    continue;
  }
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
    /\bsk-[A-Za-z0-9_-]{24,}\b/,
    /\bAKID[A-Za-z0-9]{13,}\b/,
  ];
  if (patterns.some((pattern) => pattern.test(content))) {
    failures.push(`疑似密钥出现在受跟踪文件：${path}`);
  }
}

if (failures.length) {
  console.error('公共发布安全检查未通过：');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('公共发布基础检查通过：');
console.log('- 公共 APK 不预设私人局域网或云端地址');
console.log('- 构建配置未声明 Key、Token、Secret 或密码');
console.log('- 常见私密环境文件未被 Git 跟踪');
console.log('- 当前受跟踪源文件未命中常见密钥格式');
console.log('- 完整 Git 历史未命中常见密钥格式或有效密钥赋值');
console.log('注意：正式公开前仍需使用独立工具复核历史并扫描最终 APK。');

function scanGitHistory() {
  const objects = execFileSync('git', ['rev-list', '--objects', '--all'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const findings = [];
  const seen = new Set();
  for (const line of objects.split('\n')) {
    const separator = line.indexOf(' ');
    if (separator < 0) continue;
    const hash = line.slice(0, separator);
    const path = line.slice(separator + 1);
    if (!isTextCandidate(path) || seen.has(hash)) continue;
    seen.add(hash);
    let size = 0;
    try {
      size = Number(
        execFileSync('git', ['cat-file', '-s', hash], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
      );
    } catch {
      continue;
    }
    if (!Number.isFinite(size) || size > 1_000_000) continue;
    let content = '';
    try {
      content = execFileSync('git', ['cat-file', '-p', hash], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    if (containsLikelySecret(content, path)) {
      findings.push(`${hash.slice(0, 10)} ${path}`);
      if (findings.length >= 20) break;
    }
  }
  return findings;
}

function isTextCandidate(path) {
  return (
    /(^|\/)(\.env|\.dev\.vars|[^/]+\.(?:ts|tsx|js|mjs|cjs|json|md|ya?ml|toml|ini|conf|vars|xml|plist|sh|command))$/i.test(
      path,
    ) && !/(^|\/)package-lock\.json$/.test(path)
  );
}

function containsLikelySecret(content, path) {
  const directPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
    /\bsk-[A-Za-z0-9_-]{24,}\b/,
    /\bAKID[A-Za-z0-9]{13,}\b/,
  ];
  if (directPatterns.some((pattern) => pattern.test(content))) return true;
  if (
    !/(^|\/)(?:\.env(?:\..*)?|\.dev\.vars|[^/]*(?:secret|credential|config)[^/]*\.json)$/i.test(
      path,
    ) ||
    /(?:example|sample|test|fixture)/i.test(path)
  ) {
    return false;
  }
  const assignment =
    /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)["']?\s*[:=]\s*["']?([^"'\s,}]{16,})/gi;
  for (const match of content.matchAll(assignment)) {
    const value = match[1];
    if (
      !/replace|placeholder|example|optional|your-|fake|test|existing|undefined|null|process\.env|\$\{/i.test(
        value,
      )
    ) {
      return true;
    }
  }
  return false;
}
