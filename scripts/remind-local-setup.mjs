import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { networkInterfaces, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secretsDirectory = join(homedir(), '.remind');
const secretsPath = join(secretsDirectory, 'secrets.env');
const setupToken = randomBytes(24).toString('base64url');
const host = '127.0.0.1';
const port = 43110;
let configured = false;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);
  if (url.searchParams.get('token') !== setupToken) {
    respond(response, 404, 'text/plain; charset=utf-8', 'Not found');
    return;
  }
  if (request.method === 'GET') {
    respond(response, 200, 'text/html; charset=utf-8', setupPage());
    return;
  }
  if (request.method !== 'POST') {
    respond(response, 405, 'application/json', JSON.stringify({ ok: false }));
    return;
  }
  try {
    const payload = JSON.parse(await readBody(request));
    const deepseek = validateSecret(payload.deepseek, 'DeepSeek API Key', true);
    const zhipu = validateSecret(payload.zhipu, '智谱 API Key', false);
    const existing = readExistingSecrets();
    const wechatToken =
      validSecret(existing.WECHAT_TOKEN) ?
        existing.WECHAT_TOKEN :
        randomBytes(32).toString('base64url');
    writeSecrets({
      WECHAT_TOKEN: wechatToken,
      DEEPSEEK_API_KEY: deepseek,
      ZHIPU_API_KEY: zhipu,
    });
    const install = spawnSync(
      process.execPath,
      [join(projectDirectory, 'scripts', 'remind-services.mjs'), 'install'],
      { cwd: projectDirectory, encoding: 'utf8' },
    );
    if (install.status !== 0) {
      throw new Error(
        install.stderr.trim() || install.stdout.trim() || '本地服务启动失败',
      );
    }
    configured = true;
    respond(
      response,
      200,
      'application/json',
      JSON.stringify({
        ok: true,
        address: localServiceAddress(),
        visionConfigured: Boolean(zhipu),
      }),
    );
    setTimeout(() => server.close(), 1_500);
  } catch (error) {
    respond(
      response,
      400,
      'application/json',
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : '配置失败',
      }),
    );
  }
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}/?token=${setupToken}`;
  console.log('ReMind 设置页面已经打开。请在浏览器中完成配置。');
  execFile('/usr/bin/open', [url]);
});

server.on('close', () => {
  if (configured) console.log('ReMind 本地服务已配置并启动。');
});

function readExistingSecrets() {
  if (!existsSync(secretsPath)) return {};
  return Object.fromEntries(
    readFileSync(secretsPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
}

function writeSecrets(values) {
  mkdirSync(secretsDirectory, { recursive: true, mode: 0o700 });
  chmodSync(secretsDirectory, 0o700);
  const temporaryPath = `${secretsPath}.${randomBytes(8).toString('hex')}.tmp`;
  const text = Object.entries(values)
    .filter(([, value]) => Boolean(value))
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
  writeFileSync(temporaryPath, `${text}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporaryPath, secretsPath);
  chmodSync(secretsPath, 0o600);
}

function validateSecret(value, label, required) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized && !required) return '';
  if (!validSecret(normalized)) {
    throw new Error(`${label} 格式不正确，请检查后重试。`);
  }
  return normalized;
}

function validSecret(value) {
  return (
    typeof value === 'string' &&
    value.length >= 16 &&
    value.length <= 512 &&
    !/[\r\n\0]/.test(value) &&
    !/replace-with|your-api-key|placeholder/i.test(value)
  );
}

function localServiceAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return `http://${entry.address}:8787`;
      }
    }
  }
  return 'http://你的Mac局域网地址:8787';
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4_096) rejectBody(new Error('请求内容过大'));
    });
    request.on('end', () => resolveBody(body));
    request.on('error', rejectBody);
  });
}

function respond(response, status, contentType, body) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function setupPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>设置 ReMind 本地服务</title>
<style>body{margin:0;background:#f6f4ed;color:#27332e;font:16px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.wrap{max-width:620px;margin:48px auto;padding:0 20px}.card{background:#fffdf8;border:1px solid #d8ddd6;border-radius:24px;padding:28px;box-shadow:0 12px 40px #26332b12}h1{font-family:Georgia,"Songti SC",serif;font-size:34px;margin:0 0 8px}.sub{color:#6f7b75;line-height:1.7;margin:0 0 26px}label{display:block;font-weight:700;margin:18px 0 8px}input{box-sizing:border-box;width:100%;padding:14px;border:1px solid #cfd6d0;border-radius:13px;background:#faf9f4;font-size:15px}small{display:block;color:#7b8781;margin-top:7px;line-height:1.55}button{width:100%;margin-top:24px;padding:15px;border:0;border-radius:14px;background:#6c978b;color:white;font-size:16px;font-weight:800;cursor:pointer}button:disabled{opacity:.5}.notice{margin-top:18px;padding:14px;border-radius:13px;background:#eaf0e8;color:#557166;line-height:1.6}.result{display:none;margin-top:18px;padding:16px;border-radius:13px;background:#eef3ed;line-height:1.7}.error{color:#a4473a;background:#f8e9e5}</style></head>
<body><main class="wrap"><section class="card"><h1>ReMind</h1><p class="sub">配置只保存在这台 Mac。API Key 不会进入 Android App、GitHub 或 ReMind 日志。</p>
<form id="form"><label for="deepseek">DeepSeek API Key（必填）</label><input id="deepseek" type="password" autocomplete="off" required><small>用于文字整理、问答和回望，费用由你的 DeepSeek 账号承担。</small>
<label for="zhipu">智谱 API Key（可选）</label><input id="zhipu" type="password" autocomplete="off"><small>只在视觉分析或云端语音兜底时使用；不填写不会影响普通记录与 DeepSeek 整理。</small>
<button id="save" type="submit">保存并启动本地服务</button></form>
<div class="notice">密钥保存在 <code>~/.remind/secrets.env</code>，文件权限为仅当前用户可读写。页面关闭后不会回显完整密钥。</div><div id="result" class="result"></div></section></main>
<script>const form=document.getElementById('form'),button=document.getElementById('save'),result=document.getElementById('result');form.addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;button.textContent='正在检查并启动…';result.style.display='none';try{const response=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deepseek:document.getElementById('deepseek').value,zhipu:document.getElementById('zhipu').value})});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'配置失败');form.style.display='none';result.classList.remove('error');result.style.display='block';result.innerHTML='<strong>本地服务已启动</strong><br>请在 ReMind App 中填写：<br><code>'+data.address+'</code><br>'+(data.visionConfigured?'智谱兜底已配置。':'智谱未配置，可稍后补充。')}catch(error){result.textContent=error.message;result.classList.add('error');result.style.display='block';button.disabled=false;button.textContent='保存并启动本地服务'}});</script></body></html>`;
}
