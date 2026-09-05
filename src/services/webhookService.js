const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { db } = require('../lib/db');

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

function deliver(hook, event, payload) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(hook.url); } catch (_) { return resolve(false); }
    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      data: payload || {},
    });
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
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
    if (hook.secret) {
      opts.headers['X-Venlix-Signature'] = 'sha256=' + crypto.createHmac('sha256', String(hook.secret)).update(body).digest('hex');
    }
    const req = mod.request(opts, (res) => {
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
