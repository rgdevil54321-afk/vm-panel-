// REST-only Discord integration for the Venlix bot. No websocket gateway is
// used - everything the plans need (invite uses, boost status, DMs) is
// available through Discord's HTTP API with a bot token.
'use strict';
const https = require('https');
const { settings } = require('../lib/db');

const API = 'https://discord.com/api/v10';

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
          'User-Agent': 'VenlixNodes/1.0',
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

module.exports = {
  botConfigured, currentToken, getBotUser, getGuilds, getGuild, getGuildMember,
  getGuildInvites, countInviteUses, openDm, sendDm, fillTemplate,
};