const http = require('http');
const sshService = require('./sshService');

function agentRequest(vm, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    if (!vm.agent_port || !vm.agent_token) {
      return reject(new Error('Agent not provisioned'));
    }
    const outHeaders = {
      ...headers,
      Authorization: 'Bearer ' + vm.agent_token,
    };
    if (body && !outHeaders['Content-Length']) {
      outHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({
      host: '127.0.0.1',
      port: vm.agent_port,
      method,
      path,
      timeout: 2500,
      headers: outHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('Agent timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function agentJson(vm, opts) {
  const r = await agentRequest(vm, opts);
  if (r.status >= 400) {
    let msg = 'Agent error ' + r.status;
    try { msg = JSON.parse(r.body.toString()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  try { return JSON.parse(r.body.toString()); } catch (_) { return {}; }
}

async function isUp(vm) {
  try {
    const r = await agentRequest(vm, { path: '/ping' });
    return r.status === 200;
  } catch (_) {
    return false;
  }
}

async function withFallback(vm, agentFn, sshFn) {
  if (vm.agent_port && vm.agent_token) {
    try {
      return await agentFn();
    } catch (e) {
      if (e.message === 'Agent not provisioned') throw e;
    }
  }
  return sshFn();
}

function q(name, value) {
  return name + '=' + encodeURIComponent(value);
}

module.exports = {
  isUp,

  async listDir(vm, p = '.') {
    return withFallback(
      vm,
      () => agentJson(vm, { path: '/files?' + q('path', p) }).then((d) => d.files),
      () => sshService.listDir(vm, p)
    );
  },

  async readFile(vm, p) {
    return withFallback(
      vm,
      () => agentJson(vm, { path: '/read?' + q('path', p) }).then((d) => d.content),
      () => sshService.readFile(vm, p)
    );
  },

  async writeFile(vm, p, content) {
    return withFallback(
      vm,
      () => agentJson(vm, { method: 'POST', path: '/write', body: Buffer.from(JSON.stringify({ path: p, content })) }),
      () => sshService.writeFile(vm, p, content)
    );
  },

  async mkdir(vm, p) {
    return withFallback(
      vm,
      () => agentJson(vm, { method: 'POST', path: '/mkdir', body: Buffer.from(JSON.stringify({ path: p })) }),
      () => sshService.mkdir(vm, p)
    );
  },

  async rm(vm, p, { recursive = true } = {}) {
    return withFallback(
      vm,
      () => agentJson(vm, { method: 'POST', path: '/delete', body: Buffer.from(JSON.stringify({ path: p, recursive })) }),
      () => sshService.rm(vm, p, { recursive })
    );
  },

  async rename(vm, from, to) {
    return withFallback(
      vm,
      () => agentJson(vm, { method: 'POST', path: '/rename', body: Buffer.from(JSON.stringify({ from, to })) }),
      () => sshService.rename(vm, from, to)
    );
  },

  async chmod(vm, p, mode) {
    return withFallback(
      vm,
      () => agentJson(vm, { method: 'POST', path: '/chmod', body: Buffer.from(JSON.stringify({ path: p, mode })) }),
      () => sshService.chmod(vm, p, mode)
    );
  },

  async upload(vm, targetPath, buffer) {
    return withFallback(
      vm,
      () => agentJson(vm, {
        method: 'POST',
        path: '/upload',
        headers: { 'X-File-Path': targetPath, 'Content-Type': 'application/octet-stream' },
        body: buffer,
      }),
      async () => {
        const conn = await sshService.connect(vm);
        try {
          const dir = targetPath.slice(0, targetPath.lastIndexOf('/')) || '/';
          await sshService.exec(conn, `mkdir -p "${dir}"`);
          await sshService.uploadBuffer(conn, targetPath, buffer);
        } finally {
          conn.end();
        }
      }
    );
  },

  async download(vm, p) {
    return withFallback(
      vm,
      async () => {
        const r = await agentRequest(vm, { path: '/download?' + q('path', p) });
        if (r.status >= 400) {
          let msg = 'Agent error ' + r.status;
          try { msg = JSON.parse(r.body.toString()).error || msg; } catch (_) {}
          throw new Error(msg);
        }
        return r.body;
      },
      async () => {
        const conn = await sshService.connect(vm);
        try {
          return await sshService.downloadBuffer(conn, p);
        } finally {
          conn.end();
        }
      }
    );
  },
};
