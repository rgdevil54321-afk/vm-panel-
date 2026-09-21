#!/usr/bin/env node
/**
 * Venlix licensing & install-auth CLI.
 *
 * Usage:
 *   node scripts/license.js auth-verify <key>         check install auth key (exit 0 ok, 1 wrong, 2 blacklisted)
 *   node scripts/license.js unlock <password>         clear a blacklist
 *   node scripts/license.js license-verify <key>      check a weekly license key
 *   node scripts/license.js gen-license [weeks]       print a weekly license key (default: this week)
 *   node scripts/license.js status                    show install/license state
 */
const license = require('../src/lib/license');

const [cmd, arg] = process.argv.slice(2);

function fail(msg, code) {
  console.log(msg);
  process.exit(code || 1);
}

switch (cmd) {
  case 'auth-verify': {
    if (!arg) fail('Usage: node scripts/license.js auth-verify <key>');
    const r = license.authVerify(arg);
    if (r.ok) {
      console.log('[ok] Authorization key accepted.');
      process.exit(0);
    }
    console.log('[x] ' + r.error);
    process.exit(r.blacklisted ? 2 : 1);
    break;
  }
  case 'unlock': {
    if (!arg) fail('Usage: node scripts/license.js unlock <password>');
    const r = license.unlock(arg);
    if (r.ok) {
      console.log('[ok] ' + r.message);
      process.exit(0);
    }
    console.log('[x] ' + r.error);
    process.exit(1);
    break;
  }
  case 'license-verify': {
    if (!arg) fail('Usage: node scripts/license.js license-verify <key>');
    if (license.isValidKey(arg)) {
      console.log('[ok] Valid license key.');
      process.exit(0);
    }
    console.log('[x] Invalid license key.');
    process.exit(1);
    break;
  }
  case 'gen-license': {
    const weeks = parseInt(arg || '0', 10);
    const d = new Date(Date.now() + (weeks * 7 * 24 * 60 * 60 * 1000));
    console.log(license.makeLicense(d));
    break;
  }
  case 'status': {
    const s = license.status();
    console.log('');
    console.log('  Venlix license status');
    console.log('  ' + '-'.repeat(30));
    console.log('  blacklisted   : ' + s.blacklisted);
    console.log('  auth attempts : ' + s.authAttempts + '/5');
    console.log('  license       : ' + (s.locked ? 'EXPIRED (locked)' : 'active'));
    console.log('  granted       : ' + (s.grantedAt || 'never'));
    console.log('  expires       : ' + (s.expiresAt ? new Date(s.expiresAt).toISOString() : '-'));
    console.log('  days left     : ' + s.daysLeft);
    console.log('  this week key : ' + s.currentLicense);
    console.log('');
    process.exit(s.locked ? 1 : 0);
    break;
  }
  default:
    fail('Usage: node scripts/license.js (auth-verify|unlock|license-verify|gen-license|status)');
}