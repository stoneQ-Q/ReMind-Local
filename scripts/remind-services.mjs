import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const command = process.argv[2] ?? 'status';
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const userId = process.getuid();
const domain = `gui/${userId}`;
const launchAgentsDirectory = join(homedir(), 'Library', 'LaunchAgents');
const logsDirectory = join(homedir(), '.remind', 'logs');
const nodePath = process.execPath;
const pathValue = [
  dirname(nodePath),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':');

const allServices = [
  {
    label: 'app.remind.worker',
    workingDirectory: join(projectDirectory, 'server'),
    arguments: [
      nodePath,
      join(projectDirectory, 'server', 'scripts', 'dev-local.mjs'),
    ],
    logName: 'worker',
  },
  {
    label: 'app.remind.gateway',
    workingDirectory: join(projectDirectory, 'gateway'),
    arguments: [
      nodePath,
      join(projectDirectory, 'gateway', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(projectDirectory, 'gateway', 'src', 'index.ts'),
      'run',
    ],
    logName: 'gateway',
  },
];
const gatewayConfigPath = join(homedir(), '.remind-weixin', 'config.json');
const services = allServices.filter(
  (service) =>
    service.logName === 'worker' || existsSync(gatewayConfigPath),
);

if (command === 'install') {
  install();
} else if (command === 'status') {
  await status();
} else if (command === 'restart') {
  restart();
  await status();
} else if (command === 'logs') {
  printLogs();
} else {
  fail(`未知命令：${command}`);
}

function install() {
  validateRuntime();
  mkdirSync(launchAgentsDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });
  chmodSync(logsDirectory, 0o700);

  for (const service of services) {
    const plistPath = join(launchAgentsDirectory, `${service.label}.plist`);
    writeFileSync(plistPath, createPlist(service), {
      encoding: 'utf8',
      mode: 0o644,
    });
    chmodSync(plistPath, 0o644);
    runLaunchctl(['bootout', `${domain}/${service.label}`], true);
    waitForServiceUnload(service.label);
    runLaunchctl(['bootstrap', domain, plistPath]);
    runLaunchctl(['kickstart', '-k', `${domain}/${service.label}`]);
  }

  console.log('ReMind 后台服务已安装，会在 Mac 登录后自动启动。');
  console.log(`日志目录：${logsDirectory}`);
}

function waitForServiceUnload(label) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = spawnSync(
      '/bin/launchctl',
      ['print', `${domain}/${label}`],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) {
      Atomics.wait(pause, 0, 0, 150);
      return;
    }
    Atomics.wait(pause, 0, 0, 50);
  }
  fail(`后台服务未能及时卸载：${label}`);
}

function restart() {
  for (const service of services) {
    const plistPath = join(launchAgentsDirectory, `${service.label}.plist`);
    if (!existsSync(plistPath)) {
      fail('后台服务尚未安装，请先运行 npm run services:install');
    }
    runLaunchctl(['kickstart', '-k', `${domain}/${service.label}`]);
  }
  console.log('ReMind 后台服务已重新启动。');
}

async function status() {
  for (const service of allServices) {
    const result = spawnSync(
      '/bin/launchctl',
      ['print', `${domain}/${service.label}`],
      { encoding: 'utf8' },
    );
    const state = result.stdout.match(/\bstate = (.+)/)?.[1]?.trim();
    const pid = result.stdout.match(/\bpid = (\d+)/)?.[1];
    console.log(
      `${service.logName === 'worker' ? 'Worker' : '微信网关'}：${
        result.status === 0 ? state ?? '已载入' : '未安装'
      }${pid ? `（PID ${pid}）` : ''}`,
    );
  }

  try {
    const response = await fetch('http://127.0.0.1:8787/health', {
      signal: AbortSignal.timeout(3_000),
    });
    console.log(`本地 API：${response.ok ? '可访问' : `异常 ${response.status}`}`);
  } catch {
    console.log('本地 API：暂不可访问');
  }
}

function printLogs() {
  for (const service of allServices) {
    const logPath = join(logsDirectory, `${service.logName}.log`);
    const errorPath = join(logsDirectory, `${service.logName}.error.log`);
    console.log(`\n== ${service.logName} ==`);
    for (const path of [logPath, errorPath]) {
      if (!existsSync(path)) continue;
      const lines = readFileSync(path, 'utf8').trimEnd().split('\n').slice(-40);
      console.log(lines.join('\n'));
    }
  }
}

function validateRuntime() {
  const requiredPaths = [
    join(projectDirectory, 'server', 'scripts', 'dev-local.mjs'),
    join(projectDirectory, 'server', 'node_modules', '.bin', 'wrangler'),
  ];
  if (existsSync(gatewayConfigPath)) {
    requiredPaths.push(
      join(projectDirectory, 'gateway', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    );
  }
  const missing = requiredPaths.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    fail(`后台服务缺少运行文件：\n${missing.join('\n')}`);
  }
  const check = spawnSync(
    nodePath,
    [join(projectDirectory, 'server', 'scripts', 'dev-local.mjs'), '--check'],
    {
      cwd: join(projectDirectory, 'server'),
      encoding: 'utf8',
      stdio: 'inherit',
    },
  );
  if (check.status !== 0) {
    fail('Worker 启动自检失败，未安装后台服务。');
  }
}

function createPlist(service) {
  const standardOutPath = join(logsDirectory, `${service.logName}.log`);
  const standardErrorPath = join(logsDirectory, `${service.logName}.error.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(service.label)}</string>
  <key>ProgramArguments</key>
  <array>
${service.arguments.map((argument) => `    <string>${xml(argument)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(service.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(homedir())}</string>
    <key>PATH</key>
    <string>${xml(pathValue)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(standardOutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(standardErrorPath)}</string>
</dict>
</plist>
`;
}

function runLaunchctl(arguments_, allowFailure = false) {
  const result = spawnSync('/bin/launchctl', arguments_, {
    encoding: 'utf8',
    stdio: allowFailure ? 'ignore' : 'pipe',
  });
  if (!allowFailure && result.status !== 0) {
    fail(result.stderr.trim() || `launchctl ${arguments_.join(' ')} 失败`);
  }
}

function xml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
