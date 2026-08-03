import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const apkPath = resolve(process.argv[2] ?? '');
if (!apkPath || !existsSync(apkPath) || extname(apkPath) !== '.apk') {
  console.error('请提供已构建的公共 APK 路径。');
  process.exit(1);
}

const extractionDirectory = mkdtempSync(join(tmpdir(), 'remind-apk-scan-'));
const findings = [];

try {
  execFileSync('unzip', ['-oq', apkPath, '-d', extractionDirectory]);
  for (const path of walk(extractionDirectory)) {
    const size = statSync(path).size;
    if (size === 0 || size > 80 * 1024 * 1024) continue;
    const content = readFileSync(path);
    const text = content.toString('latin1');
    if (
      /\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}:8787\b/.test(text) ||
      /\b192\.168\.\d{1,3}\.\d{1,3}:8787\b/.test(text) ||
      /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}:8787\b/.test(text)
    ) {
      findings.push(`${relative(path)}：包含预设局域网服务地址`);
    }
    if (/https?:\/\/[^\s"']+\.sslip\.io/i.test(text)) {
      findings.push(`${relative(path)}：包含临时云端地址`);
    }
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
      /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/.test(text) ||
      /\bsk-[A-Za-z0-9_-]{24,}\b/.test(text) ||
      /\bAKID[A-Za-z0-9]{13,}\b/.test(text)
    ) {
      findings.push(`${relative(path)}：包含疑似真实密钥`);
    }
  }
} finally {
  rmSync(extractionDirectory, { recursive: true, force: true });
}

if (findings.length > 0) {
  console.error('公共 APK 安全检查未通过：');
  for (const finding of [...new Set(findings)]) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('公共 APK 安全检查通过：未发现预设私有地址或常见真实密钥格式。');

function walk(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...walk(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

function relative(path) {
  return path.slice(extractionDirectory.length + 1);
}
