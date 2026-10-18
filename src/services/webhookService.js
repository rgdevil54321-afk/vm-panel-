const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { db } = require('../lib/db');
const branding = require('../lib/branding');

function getWebhooks(vm) {
  let hooks = [];
  try { hooks = JSON.parse(vm.webhooks || '[]') || []; } catch (_) { hooks = []; }
  return hooks.filter((h) => h && h.url);
}

function setWebhooks(vm, hooks) {
  db.prepare('UPDATE vms SET webhooks = ? WHERE id = ?').run(JSON.stringify(hooks || []), vm.id);
  return getWebhooks(db.prepare('SELECT * FROM vms WHERE id = ?').get(vm.id));
}

function matches(hook, event) {
  const evts = hook.events || [];
  return evts.includes('*') || evts.includes(event);
}

function buildDiscordBody(event, payload) {
  const name = payload && payload.name ? payload.name : (payload && payload.id ? String(payload.id) : 'server');
  const colors = { 'vm:start': 0x10b981, 'vm:stop': 0xf43f5e, 'vm:restart': 0xf59e0b, 'vm:kill': 0xef4444 };
  const color = colors[event] || 0x6366f1;
  const fields = [];
  if (payload) {
    for (const [k, v] of Object.entries(payload)) {
      fields.push({ name: k, value: String(v), inline: fields.length < 6 });
    }
  }
  return {
    embeds: [{
      title: event,
      color,
      fields: fields.slice(0, 12),
      timestamp: new Date().toISOString(),
      footer: { text: branding.name() },
    }],
    username: branding.name(),
  };
}

function buildTelegramBody(event, payload) {
  const lines = ['<b>' + branding.name() + '</b>', '<b>Event:</b> <code>' + event + '</code>'];
  if (payload) {
    for (const [k, v] of Object.entries(payload)) {
      lines.push('<b>' + String(k) + ':</b> <code>' + String(v) + '</code>');
    }
  }
  return { text: lines.join('\n'), parse_mode: 'HTML' };
}

function deliver(hook, event, payload) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(hook.url); } catch (_) { return resolve(false); }

    const kind = hook.kind || 'generic';
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    let body;
    if (kind === 'discord') {
      body = JSON.stringify(buildDiscordBody(event, payload));
    } else if (kind === 'telegram') {
      // url like https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>
      let chatId = hook.chat_id || url.searchParams.get('chat_id') || '';
      let tgUrl = url;
      if (!/sendMessage/.test(url.pathname)) {
        const botToken = url.pathname.replace(/^\//, '').split('/')[0];
        tgUrl = new URL(`https://api.telegram.org/bot${botToken}/sendMessage`);
      }
      const p = buildTelegramBody(event, payload);
      if (chatId) p.chat_id = chatId;
      body = JSON.stringify(p);
      url = tgUrl;
    } else {
      body = JSON.stringify({
        event,
        timestamp: new Date().toISOString(),
        data: payload || {},
      });
    }

    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Venlix-Nodes-Webhook',
      },
    };
    if (hook.secret && kind === 'generic') {
      opts.headers['X-Venlix-Signature'] = 'sha256=' + crypto.createHmac('sha256', String(hook.secret)).update(body).digest('hex');
    }
    const req = mod.request(opts, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.resume();
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(10000, () => req.destroy());
    req.write(body);
    req.end();
  });
}

async function emit(vm, event, payload, log = null) {
  const hooks = getWebhooks(vm);
  let success = 0;
  let attempted = 0;
  for (const hook of hooks) {
    if (!matches(hook, event)) continue;
    attempted++;
    const ok = await deliver(hook, event, payload);
    if (ok) success++;
  }
  if (log && attempted > 0) {
    try {
      log({ webhooks: attempted, delivered: success });
    } catch (_) {}
  }
  return { attempted, delivered: success };
}

module.exports = { getWebhooks, setWebhooks, emit };
