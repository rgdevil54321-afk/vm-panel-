// PlanGuard - automated plan-compliance sweeper.
// On an interval it walks every active user_plan and verifies that its
// condition still holds. Depending on plan kind it checks:
//   - paid/free : subscription expiry (grace window -> auto-suspend)
//   - invite    : invite-code usage count via the Discord REST API
//   - booster   : whether the linked Discord account is currently boosting
// Warnings are emailed/notified and DM'd once per grace period; recovery
// (invite/boost satisfied again, or a fresh assignment) lifts the suspension
// automatically. The whole service is a no-op while the bot is disabled.
'use strict';
const { db, settings } = require('../lib/db');
const logger = require('../lib/logger');
const vmService = require('./vmService');
const billing = require('./billingService');
const discord = require('./discordService');

const DAY_MS = 86400000;

function enabled() {
  const e = settings.get('bot.enabled');
  return e === '1' || e === true || e === 1;
}

function graceDays(plan) {
  return (plan && plan.grace_days > 0) ? plan.grace_days : (parseInt(settings.get('plans.grace_days') || '5', 10) || 5);
}

function varsFor(up, plan, need, have) {
  const user = db.prepare('SELECT id, username, discord_id FROM users WHERE id = ?').get(up.user_id);
  return {
    name: user ? user.username : (up.user_id || 'there'),
    plan: plan ? plan.name : 'plan',
    need: need != null ? need : '?',
    have: have != null ? have : '?',
    grace: graceDays(plan),
    user,
  };
}

async function dm(up, key, vars) {
  const tpl = settings.get(key || 'bot.dm_warn');
  if (!tpl) return;
  if (!vars.user || !vars.user.discord_id) return;
  try {
    const r = await discord.sendDm(vars.user.discord_id, discord.fillTemplate(tpl, vars));
    if (!r.ok && r.status) {
      logger.warn(`[planguard] dm to user ${vars.user.id} failed: ${r.status} ${r.error || ''}`);
    }
  } catch (e) {
    logger.warn('[planguard] dm error: ' + e.message);
  }
}

function warn(up, plan, detail, vars) {
  if (!up.warned_at) {
    billing.setUserPlanStatus(up.id, 'warned', detail);
    billing.logPlanCheck(up.id, up.user_id, false, 'warn: ' + detail);
    require('./billingService').notifyUser(up.user_id, 'Plan requirement not met', detail);
    dm(up, 'bot.dm_warn', vars);
    db.prepare("UPDATE user_plans SET warned_at = ?, suspended_at = NULL WHERE id = ?").run(new Date().toISOString(), up.id);
  } else {
    // Still failing inside the grace window: refresh the check log only.
    billing.logPlanCheck(up.id, up.user_id, false, 'still warned: ' + detail);
  }
}

async function suspend(up, plan, detail, vars) {
  billing.setUserPlanStatus(up.id, 'suspended', detail);
  billing.logPlanCheck(up.id, up.user_id, false, 'suspended: ' + detail);
  billing.notifyUser(up.user_id, 'Servers suspended - plan violation', detail);
  db.prepare("UPDATE user_plans SET suspended_at = ? WHERE id = ?").run(new Date().toISOString(), up.id);
  try { await vmService.setUserVmsSuspended(up.user_id, detail); } catch (e) { logger.warn('[planguard] suspend stop failed: ' + e.message); }
  dm(up, 'bot.dm_suspend', vars);
}

async function restore(up, plan, detail) {
  billing.setUserPlanStatus(up.id, 'active', detail);
  billing.logPlanCheck(up.id, up.user_id, true, 'restored: ' + detail);
  billing.notifyUser(up.user_id, 'Plan restored - servers unlocked', detail);
  db.prepare('UPDATE user_plans SET warned_at = NULL, suspended_at = NULL, last_check_ok = 1 WHERE id = ?').run(up.id);
  try { await vmService.setUserVmsUnsuspended(up.user_id); } catch (e) { logger.warn('[planguard] restore failed: ' + e.message); }
  dm(up, 'bot.dm_restore', { ...varsFor(up, plan, 0, 0) });
}

async function checkPlanRow(up) {
  const plan = billing.getPlan(up.plan_id);
  if (!plan) return;
  const grace = graceDays(plan);

  let ok = false;
  let detail = '';
  let need = null;
  let have = null;

  if (plan.kind === 'invite') {
    const required = Number(plan.invites_required) || 0;
    need = required;
    if (!required) {
      ok = true;
      detail = 'no invites required';
    } else if (!up.invite_code) {
      have = 0;
      detail = 'no invite code attached to this plan';
    } else {
      const r = await discord.countInviteUses(up.invite_code);
      ok = r.ok && r.uses >= required;
      have = r.ok ? r.uses : '?';
      detail = r.ok ? `invite ${up.invite_code}: ${r.uses}/${required}` : ('discord: ' + (r.error || 'error'));
    }
  } else if (plan.kind === 'booster') {
    need = '1';
    if (!plan.boost_required) {
      ok = true;
      have = 0;
      detail = 'no boost required';
    } else {
      const u = db.prepare('SELECT discord_id FROM users WHERE id = ?').get(up.user_id);
      const guildId = settings.get('bot.guild_id');
      if (!guildId) {
        have = 0;
        detail = 'no bot guild configured';
      } else if (!u || !u.discord_id) {
        have = 0;
        detail = 'discord account not linked';
      } else {
        const r = await discord.getGuildMember(guildId, u.discord_id);
        const boosting = r.ok && r.data && !!r.data.premium_since;
        ok = !!boosting;
        have = boosting ? 1 : 0;
        detail = r.ok ? ('boost ' + (boosting ? 'yes' : 'no')) : ('discord: ' + (r.error || 'error'));
      }
    }
  } else {
    // paid / free
    if (!up.expires_at) {
      ok = true;
      detail = 'no expiry date';
    } else {
      const exp = new Date(up.expires_at).getTime();
      const now = Date.now();
      if (now <= exp) {
        ok = true;
        detail = 'valid until ' + up.expires_at.slice(0, 10);
      } else if (now <= exp + grace * DAY_MS) {
        ok = false;
        need = 'renewal';
        have = up.expires_at.slice(0, 10);
        detail = 'expired ' + Math.max(0, Math.floor((now - exp) / DAY_MS)) + 'd ago (grace ' + grace + 'd)';
      } else {
        ok = false;
        need = 'renewal';
        have = up.expires_at.slice(0, 10);
        detail = 'expired beyond grace';
      }
    }
  }

  const vars = varsFor(up, plan, need, have);
  if (up.status === 'suspended' || up.status === 'expired') {
    if (ok) {
      await restore(up, plan, detail);
    } else {
      billing.logPlanCheck(up.id, up.user_id, false, 'still ' + up.status + ': ' + detail);
    }
    return;
  }

  if (up.status === 'warned') {
    if (ok) {
      await restore(up, plan, detail);
      return;
    }
    const warnedMs = up.warned_at ? Date.now() - new Date(up.warned_at).getTime() : Infinity;
    if (warnedMs >= grace * DAY_MS) {
      await suspend(up, plan, detail, vars);
    } else {
      billing.logPlanCheck(up.id, up.user_id, false, 'still warned: ' + detail);
    }
    return;
  }

  // active
  if (ok) {
    if (up.last_check_ok !== 1) {
      db.prepare("UPDATE user_plans SET last_check_ok = 1, warned_at = NULL, last_check_at = ?, last_check_detail = ? WHERE id = ?")
        .run(new Date().toISOString(), String(detail).slice(0, 200), up.id);
    }
    billing.logPlanCheck(up.id, up.user_id, true, detail);
  } else {
    await warn(up, plan, detail, vars);
  }
}

async function run() {
  if (!enabled()) return { ok: true, skipped: 'bot disabled', checked: 0 };
  const rows = db.prepare(
    "SELECT * FROM user_plans WHERE status IN ('active','warned','suspended') ORDER BY id"
  ).all();
  let checked = 0;
  for (const up of rows) {
    try {
      await checkPlanRow(up);
      checked++;
    } catch (e) {
      logger.warn('[planguard] check failed for user_plan ' + up.id + ': ' + e.message);
    }
  }
  logger.info(`[planguard] checked ${checked}/${rows.length} user plans`);
  return { ok: true, checked, total: rows.length };
}

function start() {
  const intervalMin = Math.max(1, parseInt(settings.get('bot.check_interval_min') || '5', 10) || 5);
  const timer = setInterval(() => { run().catch(() => {}); }, intervalMin * 60000);
  timer.unref();
  // First pass shortly after boot so already-violating plans act quickly.
  setTimeout(() => { run().catch(() => {}); }, 5000).unref();
  logger.info(`[planguard] plan guard scheduled every ${intervalMin} min`);
  return timer;
}

module.exports = { run, start, enabled, checkPlanRow };