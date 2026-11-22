// Configuration lue depuis les variables d'environnement.

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

function opt(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function num(name, def) {
  const v = Number(opt(name, def));
  if (Number.isNaN(v)) throw new Error(`${name} doit être un nombre`);
  return v;
}

function bool(name, def) {
  return ['1', 'true', 'yes', 'oui'].includes(String(opt(name, def)).toLowerCase());
}

export function loadConfig() {
  const statusChannelId = req('STATUS_CHANNEL_ID');
  return {
    discordToken: req('DISCORD_TOKEN'),
    guildId: req('GUILD_ID'),
    statusChannelId,
    eventsChannelId: opt('EVENTS_CHANNEL_ID', statusChannelId),
    backupChannelId: opt('BACKUP_CHANNEL_ID', statusChannelId),
    adminRoleId: opt('ADMIN_ROLE_ID', ''),

    sfHost: opt('SF_HOST', 'satisfactory'),
    sfPort: num('SF_PORT', 7777),
    sfToken: req('SF_TOKEN'),
    pollSeconds: num('POLL_SECONDS', 30),

    dockerHost: opt('DOCKER_HOST', 'tcp://socket-proxy:2375'),
    containerName: opt('CONTAINER_NAME', 'satisfactory'),
    dataDir: opt('DATA_DIR', '/data'),

    connectAddress: opt('CONNECT_ADDRESS', ''),
    serverLabel: opt('SERVER_LABEL', ''),

    periodicBackupHours: num('PERIODIC_BACKUP_HOURS', 3),
    postSessionBackups: bool('POST_SESSION_BACKUPS', true),
    keepAllDays: num('KEEP_ALL_DAYS', 7),
    keepDailyDays: num('KEEP_DAILY_DAYS', 30),
    uploadLimitMb: num('UPLOAD_LIMIT_MB', 20),

    statusRefreshSeconds: num('STATUS_REFRESH_SECONDS', 300),
    timeZone: opt('TZ', 'Europe/Paris'),
    emojis: {
      online: opt('EMOJI_ONLINE', '🏭'),
      paused: opt('EMOJI_PAUSED', '⏸️'),
      starting: opt('EMOJI_STARTING', '⚙️'),
      unresponsive: opt('EMOJI_UNRESPONSIVE', '⚠️'),
      offline: opt('EMOJI_OFFLINE', '💤'),
    },
  };
}
