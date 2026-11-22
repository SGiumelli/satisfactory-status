import path from 'node:path';
import { loadConfig } from './config.js';
import { ServerState } from './state.js';
import { Poller, dockerFromHost } from './monitor.js';
import { SatisfactoryApi } from './sfapi.js';
import { BackupManager } from './backup.js';
import { Store } from './store.js';
import { DiscordBot } from './discord.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = console;

const config = loadConfig();
const store = await new Store(config.dataDir).load();
const state = new ServerState();
const api = new SatisfactoryApi({ host: config.sfHost, port: config.sfPort, token: config.sfToken });
const poller = new Poller({
  docker: dockerFromHost(config.dockerHost),
  containerName: config.containerName,
  api,
  state,
  intervalMs: config.pollSeconds * 1000,
  log,
});
const backups = new BackupManager({
  api,
  backupDir: path.join(config.dataDir, 'backups'),
  keepAllDays: config.keepAllDays,
  keepDailyDays: config.keepDailyDays,
  timeZone: config.timeZone,
  log,
});
const bot = new DiscordBot({ config, state, poller, backups, store, log });

const existing = await backups.list();
backups.lastBackupAt = existing[0]?.mtime ?? null;
let lastPeriodicAt = backups.lastBackupAt;

// Le dernier pionnier est parti : on sauvegarde et on poste le fichier.
state.on('session-end', async () => {
  if (!config.postSessionBackups) return;
  await sleep(15_000);
  if (state.players > 0 || state.status !== 'online') return;
  try {
    const result = await backups.create({ session: state.session, reason: 'session' });
    lastPeriodicAt = result.at;
    await bot.postBackup(result, 'session');
    state.emit('change');
  } catch (err) {
    log.error('Sauvegarde de fin de session :', err.message);
    bot.notify(`⚠️ Échec de la sauvegarde de fin de session : ${err.message}`);
  }
});

// Sauvegarde périodique (gardée sur le serveur) pendant qu'on joue.
poller.onPoll(async () => {
  if (!config.periodicBackupHours || state.status !== 'online' || state.players === 0) return;
  if (lastPeriodicAt && Date.now() - lastPeriodicAt < config.periodicBackupHours * 3600_000) return;
  lastPeriodicAt = new Date();
  backups.create({ session: state.session, reason: 'periodique' })
    .then(() => state.emit('change'))
    .catch((err) => log.error('Sauvegarde périodique :', err.message));
});

await bot.start();
await poller.start();
log.info(`Surveillance de « ${config.containerName} » toutes les ${config.pollSeconds} s.`);

const shutdown = async (sig) => {
  log.info(`${sig} reçu, arrêt du bot.`);
  poller.stop();
  await bot.client.destroy();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('Promesse rejetée non gérée :', err));
