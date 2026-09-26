// REST-only Discord integration for the Venlix bot. No websocket gateway is
// used - everything the plans need (invite uses, boost status, DMs) is
// available through Discord's HTTP API with a bot token.
'use strict';
const https = require('https');
const { settings } = require('../lib/db');
const branding = require('../lib/branding');

const API = 'https://discord.com/api/v10';
// User-Agent is what Discord shows in client/network inspectors; brand it.
const USER_AGENT = branding.slug() + '/1.0';

function request(token, path, method = 'GET', body = null) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(API + path); } catch (_) { return resolve({ ok: false, status: 0, error: 'bad url' }); }
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      url,
      {
        method,
        headers: {
          'Authorization': 'Bot ' + token,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => { buf += d; });
        res.resume();
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(buf || 'null'); } catch (_) { data = buf; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data, error: buf.slice(0, 300) });
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function botConfigured() {
  const token = String(settings.get('bot.token') || '').trim();
  return !!token;
}

function currentToken() {
  return String(settings.get('bot.token') || '').trim();
}

// Extract the bot's user ID (which equals its OAuth2 Application ID) from the
// token. Discord tokens are <base64(userId)>.<timestamp>.<hmac>. This is how
// we can auto-fix the "unknown application" OAuth linking problem: the Client
// ID can be derived straight from the bot token.
function decodeBotId(tok) {
  const t = String(tok || currentToken() || '').trim();
  const seg = t.split('.');
  if (seg.length < 3) return null;
  try {
    const buf = Buffer.from(seg[0], 'base64').toString('utf8').trim();
    if (/^\d{6,20}$/.test(buf)) return buf;
  } catch (_) { /* malformed */ }
  return null;
}

// Fetch the Discord application that owns the token so we can validate it and
// show its real name/icon in the panel (also proves linking will work).
async function getOAuthApp(tok) {
  const r = await request(tok || currentToken(), '/oauth2/applications/@me');
  if (!r.ok) return { ok: false, error: r.error };
  const a = r.data || {};
  return {
    ok: true,
    app: {
      id: a.id,
      name: a.name,
      icon: a.icon,
      description: a.description,
      flags: a.flags,
      bot_public: !!a.bot_public,
      bot_require_code_grant: !!a.bot_require_code_grant,
    },
  };
}

async function getBotUser(token) {
  return request(token || currentToken(), '/users/@me');
}

async function getGuilds(token) {
  const r = await request(token || currentToken(), '/users/@me/guilds');
  const guilds = (Array.isArray(r.data) ? r.data : []).map((g) => ({ id: g.id, name: g.name, icon: g.icon, member_count: g.approximate_member_count }));
  return { ok: r.ok, status: r.status, guilds, error: r.error };
}

async function getGuild(guildId, token) {
  return request(token || currentToken(), '/guilds/' + encodeURIComponent(guildId));
}

async function getGuildMember(guildId, userId, token) {
  return request(token || currentToken(), `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`);
}

// Add a user to the guild using their own OAuth grant. The bot authorises the
// request and forwards the user's access_token, which is what the
// guilds.join scope is for. Assigns no roles - membership only.
// Discord answers 201 when the member was added, 204 when they were already in.
async function addGuildMember(guildId, userId, userAccessToken, token) {
  if (!guildId || !userId || !userAccessToken) return { ok: false, status: 0, error: 'missing arguments' };
  const r = await request(
    token || currentToken(),
    `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`,
    'PUT',
    { access_token: String(userAccessToken) }
  );
  // 204 has no body, so the shared parser hands back an empty string.
  return { ok: r.ok || r.status === 204, status: r.status, alreadyMember: r.status === 204, error: r.error };
}

async function getGuildInvites(guildId, token) {
  const r = await request(token || currentToken(), `/guilds/${encodeURIComponent(guildId)}/invites`);
  return {
    ok: r.ok,
    status: r.status,
    invites: (Array.isArray(r.data) ? r.data : []).map((i) => ({
      code: i.code,
      channel: i.channel ? i.channel.name : null,
      uses: Number(i.uses) || 0,
      max_uses: Number(i.max_uses) || 0,
      inviter: i.inviter ? { id: i.inviter.id, username: i.inviter.username } : null,
    })),
    error: r.error,
  };
}

async function countInviteUses(code, token) {
  if (!code || !String(code).trim()) return { ok: false, uses: 0, error: 'no invite code' };
  const r = await request(token || currentToken(), '/invites/' + encodeURIComponent(String(code).trim()) + '?with_counts=true');
  return { ok: r.ok, status: r.status, uses: Number(r.data && r.data.uses) || 0, error: r.error };
}

async function openDm(userId, token) {
  return request(token || currentToken(), '/users/@me/channels', 'POST', { recipient_id: String(userId) });
}

async function sendDm(userId, content, token) {
  if (!content || !String(content).trim()) return { ok: true };
  const dm = await openDm(userId, token);
  if (!dm.ok || !dm.data || !dm.data.id) return { ok: false, error: 'cannot open DM: ' + (dm.error || '?') };
  const r = await request(token || currentToken(), '/channels/' + dm.data.id + '/messages', 'POST', { content: String(content) });
  return { ok: r.ok, status: r.status, error: r.error };
}

// Follow a template string replacing {name},{plan},{need},{have},{grace}.
function fillTemplate(tpl, vars) {
  return String(tpl || '')
    .replace(/\{name\}/g, String(vars.name || 'there'))
    .replace(/\{plan\}/g, String(vars.plan || 'plan'))
    .replace(/\{need\}/g, String(vars.need != null ? vars.need : '?'))
    .replace(/\{have\}/g, String(vars.have != null ? vars.have : '?'))
    .replace(/\{grace\}/g, String(vars.grace != null ? vars.grace : '?'));
}

// ---------- User Discord linking via OAuth2 (identify) ----------
function oauthClientId() {
  return String(settings.get('oauth.discord_client_id') || '').trim() || String(settings.get('bot.client_id') || '').trim();
}

function oauthClientSecret() {
  return String(settings.get('oauth.discord_client_secret') || '').trim() || String(settings.get('bot.client_secret') || '').trim();
}

function oauthConfigured() {
  return !!(oauthClientId() && oauthClientSecret());
}

function authorizeUrl(redirectUri, state) {
  const cid = encodeURIComponent(oauthClientId());
  const redir = encodeURIComponent(redirectUri);
  const st = encodeURIComponent(state);
    return `https://discord.com/api/oauth2/authorize?client_id=${cid}&response_type=code&redirect_uri=${redir}&scope=identify%20guilds.join&state=${st}&prompt=consent`;
}

function oauthPost(path, params) {
  return new Promise((resolve) => {
    const body = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const req = https.request(
      new URL('https://discord.com/api/v10' + path),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': USER_AGENT,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => { buf += d; });
        res.resume();
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(buf || 'null'); } catch (_) { data = buf; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data, error: buf.slice(0, 300) });
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

async function exchangeCode(code, redirectUri) {
  return oauthPost('/oauth2/token', {
    client_id: oauthClientId(),
    client_secret: oauthClientSecret(),
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
}

function requestBearer(token, path, method = 'GET') {
  return new Promise((resolve) => {
    const req = https.request(
      new URL('https://discord.com/api/v10' + path),
      {
        method,
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => { buf += d; });
        res.resume();
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(buf || 'null'); } catch (_) { data = buf; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data, error: buf.slice(0, 300) });
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function getOAuthUser(accessToken) {
  return requestBearer(accessToken, '/users/@me');
}

function cdnAvatar(user) {
  if (!user || !user.avatar) return null;
  const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${user.avatar}.${ext}?size=64`;
}

// Edit the bot application account itself (username / avatar). Avatar accepts
// a data URI (data:image/png;base64,...) exactly like the Discord client sends.
async function updateBotProfile({ username, avatar }, token) {
  const body = {};
  if (username !== undefined && String(username).trim()) body.username = String(username).trim().slice(0, 32);
  if (avatar !== undefined && String(avatar).trim().length > 10) body.avatar = String(avatar).trim();
  if (!Object.keys(body).length) return { ok: false, status: 0, error: 'nothing to update' };
  const r = await request(token || currentToken(), '/users/@me', 'PATCH', body);
  return { ok: r.ok, status: r.status, data: r.data, error: r.error };
}

module.exports = {
  botConfigured, currentToken, getBotUser, getGuilds, getGuild, getGuildMember,
  addGuildMember, getGuildInvites, countInviteUses, openDm, sendDm, fillTemplate,
  oauthConfigured, authorizeUrl, exchangeCode, getOAuthUser, cdnAvatar,
  updateBotProfile, decodeBotId, getOAuthApp,
};