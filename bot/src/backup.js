import fs from 'node:fs/promises';
import path from 'node:path';

const DAY = 24 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function localStamp(date, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('fr-FR', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, full: `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.second}` };
}

export const safeName = (s) => String(s || 'usine').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'usine';

// Sauvegardes via l'API : SaveGame puis DownloadSaveGame. Le fichier .sav
// du jeu est déjà compressé, il est gardé tel quel. Rotation comme pour Dragonwilds.
export class BackupManager {
  constructor({ api, backupDir, keepAllDays = 7, keepDailyDays = 30, timeZone = 'Europe/Paris', saveSuffix = 'discord', log = console }) {
    this.api = api;
    this.backupDir = backupDir;
    this.keepAllDays = keepAllDays;
    this.keepDailyDays = keepDailyDays;
    this.timeZone = timeZone;
    this.saveSuffix = saveSuffix;
    this.log = log;
    this.running = null;
    this.lastBackupAt = null;
  }

  create({ session, reason = 'manuel' }) {
    if (this.running) return this.running;
    this.running = this.#create({ session, reason }).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async #create({ session, reason }) {
    // Un nom fixe par session : on écrase toujours la même sauvegarde « _discord »
    // sur le serveur, les autosaves du jeu ne sont pas touchées.
    const saveName = `${safeName(session)}_${this.saveSuffix}`;
    await this.api.saveGame(saveName);
    await sleep(1500);
    const { buffer } = await this.api.downloadSaveGame(saveName);
    if (!buffer?.length) throw new Error('sauvegarde téléchargée vide');

    await fs.mkdir(this.backupDir, { recursive: true });
    const now = new Date();
    const name = `${safeName(session)}_${localStamp(now, this.timeZone).full}_${reason}.sav`;
    const dest = path.join(this.backupDir, name);
    await fs.writeFile(`${dest}.tmp`, buffer);
    await fs.rename(`${dest}.tmp`, dest);
    this.lastBackupAt = now;
    this.log.info(`Sauvegarde créée : ${name} (${buffer.length} octets)`);
    await this.prune().catch((err) => this.log.warn('Rotation des sauvegardes :', err.message));
    return { path: dest, name, size: buffer.length, at: now };
  }

  async list() {
    let entries;
    try {
      entries = await fs.readdir(this.backupDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of entries.filter((f) => f.endsWith('.sav'))) {
      const full = path.join(this.backupDir, name);
      const st = await fs.stat(full);
      out.push({ name, path: full, size: st.size, mtime: st.mtime });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  // Tout pendant keepAllDays, puis la plus récente de chaque jour jusqu'à keepDailyDays.
  async prune(now = new Date()) {
    const seenDays = new Set();
    const removed = [];
    for (const b of await this.list()) {
      const age = now - b.mtime;
      if (age <= this.keepAllDays * DAY) continue;
      const day = localStamp(b.mtime, this.timeZone).day;
      if (age <= this.keepDailyDays * DAY && !seenDays.has(day)) {
        seenDays.add(day);
        continue;
      }
      await fs.unlink(b.path);
      removed.push(b.name);
    }
    if (removed.length) this.log.info(`Rotation : ${removed.length} sauvegarde(s) supprimée(s).`);
    return removed;
  }
}
