// 极简 SMTP 客户端：SSL(465) / STARTTLS(587)，AUTH LOGIN / PLAIN，MIME 附件
import tls from 'node:tls';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const wrap76 = (s) => s.replace(/(.{76})/g, '$1\r\n');

class Smtp {
  constructor(socket) {
    this.socket = socket;
    this.buf = '';
    this.queue = [];
    socket.on('data', (d) => this.onData(d));
    socket.on('error', (e) => this.fail(e));
    socket.on('timeout', () => this.fail(new Error('SMTP 连接超时')));
  }
  onData(d) {
    this.buf += d.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\r\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.lines = this.lines || [];
      this.lines.push(line);
      // 多行响应以 "250-" 开头，最后一行是 "250 "
      if (/^\d{3} /.test(line)) {
        const text = this.lines.join('\n');
        this.lines = [];
        const code = Number(line.slice(0, 3));
        const pending = this.queue.shift();
        if (pending) pending({ code, text });
      }
    }
  }
  fail(e) { const p = this.queue.shift(); if (p) p({ code: 0, text: e.message, error: e }); }
  expect(socket) {
    return new Promise((resolve) => this.queue.push(resolve));
  }
  async cmd(line, okCodes = [250]) {
    this.socket.write(line + '\r\n');
    const r = await this.expect();
    if (r.error || !okCodes.includes(r.code)) throw new Error(`SMTP 失败(${r.code})：${r.text.split('\n').slice(-1)[0]}`);
    return r;
  }
}

async function openSocket(cfg) {
  const secure = cfg.secure !== false && Number(cfg.port) !== 587;
  let socket;
  if (secure) {
    socket = tls.connect({ host: cfg.host, port: Number(cfg.port) || 465, servername: cfg.host });
  } else {
    socket = net.connect({ host: cfg.host, port: Number(cfg.port) || 587 });
  }
  socket.setTimeout(20000);
  await new Promise((resolve, reject) => {
    socket.once(secure ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });
  return { socket, secure };
}

async function handshake(socket) {
  const c = new Smtp(socket);
  const greet = await c.expect();
  if (greet.error || greet.code !== 220) throw new Error(`SMTP 连接失败：${greet.text || greet.error?.message}`);
  await c.cmd('EHLO job-radar', [250]);
  return c;
}

async function auth(c, user, pass) {
  await c.cmd('AUTH LOGIN', [334]);
  await c.cmd(b64(user), [334]);
  await c.cmd(b64(pass), [235]);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}s）`)), ms); }),
  ]);
}

function message(cfg, { to, subject, text, attachmentPath }) {
  const boundary = `----radar${Date.now().toString(36)}`;
  const fromName = cfg.fromName || '';
  const from = cfg.fromEmail || cfg.user;
  const headers = [
    `From: ${fromName ? `=?UTF-8?B?${b64(fromName)}?= ` : ''}<${from}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${b64(String(subject).replace(/[\r\n]+/g, " "))}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@job-radar>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join('\r\n');

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(text)),
  ];

  if (attachmentPath) {
    const data = readFileSync(attachmentPath);
    const filename = basename(attachmentPath);
    parts.push(
      `--${boundary}`,
      `Content-Type: application/pdf; name="=?UTF-8?B?${b64(filename)}?="`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="=?UTF-8?B?${b64(filename)}?="`,
      '',
      wrap76(data.toString('base64')),
    );
  }
  parts.push(`--${boundary}--`, '');
  return headers + '\r\n\r\n' + parts.join('\r\n');
}

export async function sendMail(cfg, mail) {
  return withTimeout(_sendMail(cfg, mail), 45000, '发信');
}

async function _sendMail(cfg, mail) {
  if (!cfg?.host || !cfg?.user || !cfg?.pass) throw new Error('邮箱未配置');
  let { socket } = await openSocket(cfg);
  let c = await handshake(socket);

  if (cfg.secure === false || Number(cfg.port) === 587) {
    await c.cmd('STARTTLS', [220]);
    const secured = tls.connect({ socket, servername: cfg.host });
    await new Promise((resolve, reject) => {
      secured.once('secureConnect', resolve);
      secured.once('error', reject);
    });
    c = new Smtp(secured);
    await c.cmd('EHLO job-radar', [250]);
    socket = secured;
  }

  await auth(c, cfg.user, cfg.pass);
  const from = cfg.fromEmail || cfg.user;
  await c.cmd(`MAIL FROM:<${from}>`, [250]);
  await c.cmd(`RCPT TO:<${mail.to}>`, [250, 251]);
  await c.cmd('DATA', [354]);
  socket.write(message(cfg, mail));
  socket.write('\r\n.\r\n');
  const done = await c.expect();
  if (done.error || done.code !== 250) throw new Error(`发信失败(${done.code})：${done.text}`);
  await c.cmd('QUIT', [221]).catch(() => {});
  socket.end();
  return true;
}

export async function verifyMailbox(cfg) {
  return withTimeout(_verifyMailbox(cfg), 25000, 'SMTP 连接');
}

async function _verifyMailbox(cfg) {
  if (!cfg?.host) throw new Error('SMTP 服务器未配置');
  const { socket } = await openSocket(cfg);
  try {
    const c = await handshake(socket);
    if (cfg.user && cfg.pass) await auth(c, cfg.user, cfg.pass);
    await c.cmd('QUIT', [221]).catch(() => {});
    return true;
  } finally {
    socket.destroy();
  }
}
