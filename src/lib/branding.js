'use strict';
// Single source of truth for user-visible branding. Everything that used to
// hardcode "Venlix Nodes" reads from here, so renaming the panel in Settings
// renames it everywhere (bot presence, webhook embeds, mail, neofetch, UA).
const { settings } = require('../lib/db');

const DEFAULTS = {
  name: 'Venlix Nodes',
  tagline: 'VPS Panel',
  botBlurb: 'panel',
  twitchUrl: '',
  supportUrl: '',
  discordUrl: '',
};

function str(key, fallback) {
  const v = settings.get(key);
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || (fallback || DEFAULTS[key.split('.').pop()] || '');
}

const branding = {
  // Display name of the panel, e.g. "TurtleNodes".
  name: () => str('panel.name', DEFAULTS.name),
  // Short descriptor used in page titles and link shares.
  tagline: () => str('panel.tagline', DEFAULTS.tagline),
  // Host identity shown in neofetch / telemetry.
  hostname: () => str('panel.hostname', '') || branding.name(),
  // What the Discord bot calls itself in its presence, e.g. "TurtleNodes panel".
  botBlurb: () => str('panel.bot_blurb', DEFAULTS.botBlurb),
  // Normalised "TurtleNodes panel" style presence text.
  botPresence: () => `${branding.name()} ${branding.botBlurb()}`.trim(),
  // Streaming activity target. Discord rejects an empty url, so omit it.
  twitchUrl: () => str('panel.twitch_url', DEFAULTS.twitchUrl),
  supportUrl: () => str('panel.support_url', DEFAULTS.supportUrl),
  discordUrl: () => str('panel.discord_url', DEFAULTS.discordUrl),
  // Safe token for User-Agent / gateway client identity headers.
  slug: () => (branding.name().replace(/[^A-Za-z0-9]+/g, '') || 'Panel'),
};

module.exports = branding;
