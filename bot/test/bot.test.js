import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SatisfactoryApi, phaseLabel } from '../src/sfapi.js';
import { ServerState } from '../src/state.js';
import { BackupManager, safeName } from '../src/backup.js';
import { parseVersion } from '../src/monitor.js';
import { fmtDuration } from '../src/discord.js';

const quiet = { info() {}, warn() {}, error() {} };

// --- Fausse API Satisfactory ------------------------------------------------
const calls = [];
const saves = new Map();
let server;
let port;
const GAME = {
  activeSessionName: 'the One', numConnectedPlayers: 1, playerLimit: 4, techTier: 5,
  activeSchematic: 'x', gamePhase: "/Script/FactoryGame.FGGamePhase'/Game/FactoryGame/GamePhases/GP_Project_Assembly_Phase_2.GP_Project_Assembly_Phase_2'",
  isGameRunning: true, totalGameDuration: 391_234, isGamePaused: false, averageTickRate: 29.8, autoLoadSessionName: 'the One',
};

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { function: fn, data } = JSON.parse(body);
      calls.push({ fn, data, auth: req.headers.authorization });
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json;charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      if (fn === 'HealthCheck') return json(200, { data: { health: 'healthy', serverCustomData: '' } });
      if (req.headers.authorization !== 'Bearer secret') {
        return json(401, { errorCode: 'invalid_token', errorMessage: 'Jeton invalide' });
      }
      if (fn === 'QueryServerState') return json(200, { data: { serverGameState: GAME } });
      if (fn === 'SaveGame') {
        saves.set(data.SaveName, Buffer.from(`SAVE:${data.SaveName}:${'x'.repeat(5000)}`));
        res.writeHead(204);
        return res.end();
      }
      if (fn === 'DownloadSaveGame') {
        const buf = saves.get(data.SaveName);
        if (!buf) return json(404, { errorCode: 'file_not_found', errorMessage: 'Sauvegarde introuvable' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${data.SaveName}.sav"` });
        return res.end(buf);
      }
      json(404, { errorCode: 'unknown_function' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

const api = (token = 'secret') => new SatisfactoryApi({ host: '127.0.0.1', port, token, protocol: 'http' });

test('API : état, santé sans jeton, erreurs', async () => {
  const st = await api().state();
  assert.equal(st.activeSessionName, 'the One');
  assert.equal((await api('').health()).health, 'healthy');
  await assert.rejects(api('faux').state(), (e) => e.code === 'invalid_token' && /Jeton invalide/.test(e.message));
  await assert.rejects(api().downloadSaveGame('inexistant'), (e) => e.code === 'file_not_found');
});

test('API : SaveGame (204) puis DownloadSaveGame (binaire)', async () => {
  assert.equal(await api().saveGame('the_One_discord'), null);
  const dl = await api().downloadSaveGame('the_One_discord');
  assert.equal(dl.filename, 'the_One_discord.sav');
  assert.match(dl.buffer.toString(), /^SAVE:the_One_discord:/);
});

test('phase, version, durée, noms', () => {
  assert.equal(phaseLabel(GAME.gamePhase), 'Phase 2');
  assert.equal(phaseLabel(null), null);
  assert.equal(parseVersion('LogInit: Build: ++FactoryGame+rel-main-1.2.6-CL-520140\nLogInit: x'), '1.2.6');
  assert.equal(parseVersion('rien'), null);
  assert.equal(fmtDuration(391_234), '4 j 12 h');
  assert.equal(fmtDuration(3_900), '1 h 05');
  assert.equal(safeName('the One'), 'the_One');
});

test('état : démarrage, en ligne, arrivées, départs, palier, fin de session', () => {
  const s = new ServerState();
  const notes = [];
  let ends = 0;
  s.on('notify', (n) => notes.push(n.kind));
  s.on('session-end', () => ends++);
  const start = '2026-11-22T16:35:08Z';

  s.apply({ running: true, startedAt: start, restartCount: 0, api: null }, { silent: true });
  assert.equal(s.status, 'starting');
  s.apply({ running: true, startedAt: start, restartCount: 0, api: { ...GAME, numConnectedPlayers: 0 } });
  assert.equal(s.status, 'online');
  s.apply({ running: true, startedAt: start, restartCount: 0, api: { ...GAME, numConnectedPlayers: 2 } });
  s.apply({ running: true, startedAt: start, restartCount: 0, api: { ...GAME, numConnectedPlayers: 1, techTier: 6 } });
  s.apply({ running: true, startedAt: start, restartCount: 0, api: { ...GAME, numConnectedPlayers: 0, techTier: 6 } });
  assert.deepEqual(notes, ['online', 'join', 'leave', 'tier', 'leave']);
  assert.equal(ends, 1);
  assert.equal(s.phase, 'Phase 2');
});

test('état : plantage vu (arrêt), plantage relancé par Docker, redémarrage demandé', () => {
  const s = new ServerState({ unresponsiveAfter: 2 });
  const notes = [];
  s.on('notify', (n) => notes.push(n.kind));
  s.apply({ running: true, startedAt: '2026-11-22T10:00:00Z', restartCount: 0, api: GAME }, { silent: true });

  s.apply({ running: false, exitCode: 139 });
  assert.equal(notes.at(-1), 'crash');

  s.apply({ running: true, startedAt: '2026-11-22T11:00:00Z', restartCount: 1, api: GAME });
  assert.deepEqual(notes.slice(-2), ['starting', 'online']);

  // Docker relance le conteneur entre deux relevés : on ne voit jamais l'arrêt.
  s.apply({ running: true, startedAt: '2026-11-22T12:00:00Z', restartCount: 2, api: null });
  assert.deepEqual(notes.slice(-2), ['crash', 'starting']);

  // Redémarrage demandé par /restart : pas d'alerte de plantage.
  s.apply({ running: true, startedAt: '2026-11-22T12:00:00Z', restartCount: 2, api: GAME });
  s.expectedStop = true;
  const n = notes.length;
  s.apply({ running: true, startedAt: '2026-11-22T13:00:00Z', restartCount: 2, api: null });
  assert.deepEqual(notes.slice(n), ['starting']);

  // L'API ne répond plus deux fois de suite alors que le conteneur tourne.
  s.apply({ running: true, startedAt: '2026-11-22T13:00:00Z', restartCount: 2, api: GAME });
  s.apply({ running: true, startedAt: '2026-11-22T13:00:00Z', restartCount: 2, api: null });
  s.apply({ running: true, startedAt: '2026-11-22T13:00:00Z', restartCount: 2, api: null });
  assert.equal(s.status, 'unresponsive');
  s.apply({ running: true, startedAt: '2026-11-22T13:00:00Z', restartCount: 2, api: GAME });
  assert.equal(notes.at(-1), 'online');
  assert.equal(s.status, 'online');
});

test('sauvegardes : création via l\'API et rotation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-'));
  const bm = new BackupManager({ api: api(), backupDir: dir, log: quiet });
  const before = calls.length;
  const [a, b] = await Promise.all([bm.create({ session: 'the One', reason: 'session' }), bm.create({ session: 'the One', reason: 'session' })]);
  assert.equal(a, b, 'une seule sauvegarde à la fois');
  assert.deepEqual(calls.slice(before).map((c) => c.fn), ['SaveGame', 'DownloadSaveGame']);
  assert.equal(calls.at(-2).data.SaveName, 'the_One_discord');
  assert.match(a.name, /^the_One_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_session\.sav$/);
  assert.ok(fs.readFileSync(a.path).toString().startsWith('SAVE:the_One_discord'));

  const mk = (name, daysAgo) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, 'x');
    const t = new Date(Date.now() - daysAgo * 86400_000);
    fs.utimesSync(p, t, t);
  };
  mk('old_a.sav', 10);
  mk('old_b.sav', 10.01);
  mk('ancient.sav', 40);
  assert.deepEqual((await bm.prune()).sort(), ['ancient.sav', 'old_b.sav']);
  fs.rmSync(dir, { recursive: true });
});
