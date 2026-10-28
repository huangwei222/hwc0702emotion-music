/**
 * cdp.mjs —— 极简 Chrome DevTools Protocol 客户端
 * 用 Node 22 内建 WebSocket，无需任何依赖。
 *
 * 用法:
 *   node tools/cdp.mjs <url> "<js表达式>" [等待毫秒] [截图路径]
 *   node tools/cdp.mjs <url> @path/to/script.js [等待毫秒]
 *     —— 表达式以 @ 开头时从文件读取，避免长脚本被 shell 引号吃掉
 * 前提: Chrome 已以 --remote-debugging-port=9222 启动
 */
const [, , url, exprArg = '1+1', waitMs = '6000', shotPath = ''] = process.argv;
import fs from 'node:fs';

const expr = exprArg.startsWith('@') ? fs.readFileSync(exprArg.slice(1), 'utf8') : exprArg;

const CDP_PORT = process.env.CDP_PORT || 9222;
const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    logs.push(`[console.${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push(`[exception] ${d.text} ${d.exception?.description || ''}`.slice(0, 600));
  }
  if (msg.method === 'Log.entryAdded') {
    logs.push(`[log.${msg.params.entry.level}] ${msg.params.entry.text}`.slice(0, 400));
  }
});

await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
// 无头浏览器窗口有最小宽度（约 500px），窄屏必须用设备模拟才能真正测到 375/390
// 注意：override 会留在 target 上直到显式清除，所以测完窄屏要再跑一次 CDP_VIEWPORT=reset
const vp = process.env.CDP_VIEWPORT;
if (vp === 'reset') {
  await send('Emulation.clearDeviceMetricsOverride');
} else if (vp && /^\d+x\d+$/.test(vp)) {
  const [width, height] = vp.split('x').map(Number);
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: Number(process.env.CDP_DPR || 2), mobile: true,
  });
}
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, Number(waitMs)));

try {
  const res = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  console.log('=== EVAL ===');
  console.log(JSON.stringify(res.result?.value ?? res.result, null, 2));
} catch (e) {
  console.log('=== EVAL FAILED ===');
  console.log(e.message);
}

if (shotPath) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('screenshot ->', shotPath);
}

if (logs.length) {
  console.log('=== CONSOLE ===');
  console.log(logs.slice(-40).join('\n'));
}
ws.close();
process.exit(0);
