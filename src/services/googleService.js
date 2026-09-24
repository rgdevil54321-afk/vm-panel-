// Google OAuth2 (Login with Google) for the panel. Standard authorization-code
// flow using only a Client ID + Client Secret. Userinfo comes back over the
// verified /oauth2/v3/userinfo endpoint, so `sub` is the stable account id.
'use strict';
const https = require('https');
const { settings } = require('../lib/db');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

function clientId() {
  return String(settings.get('google.client_id') || '').trim();
}
function clientSecret() {
  return String(settings.get('google.client_secret') || '').trim();
}

function oauthConfigured() {
  return !!(clientId() && clientSecret());
}

function authorizeUrl(redirectUri, state) {
  const q = new URL(AUTH_URL);
  q.searchParams.set('client_id', clientId());
  q.searchParams.set('redirect_uri', redirectUri);
  q.searchParams.set('response_type', 'code');
  q.searchParams.set('scope', 'openid email profile');
  q.searchParams.set('access_type', 'online');
  q.searchParams.set('state', state);
  q.searchParams.set('prompt', 'select_account');
  return q.toString();
}

function oauthPost(params) {
  return new Promise((resolve) => {
    const body = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const req = https.request(
      TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'VenlixNodes/1.0',
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
  return oauthPost({
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
}

function requestBearer(token, path) {
  return new Promise((resolve) => {
    const req = https.request(
      new URL(path),
      {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + token, 'User-Agent': 'VenlixNodes/1.0' },
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

// Returns { ok, status, data, error } where data = { sub, name, email,
// email_verified, picture, locale } from googleapis userinfo v3.
async function getOAuthUser(accessToken) {
  return requestBearer(accessToken, USERINFO_URL);
}

module.exports = {
  oauthConfigured, authorizeUrl, exchangeCode, getOAuthUser,
};