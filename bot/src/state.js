import { EventEmitter } from 'node:events';
import { phaseLabel } from './sfapi.js';

// État du serveur, reconstruit à chaque relevé (conteneur Docker + API).
// Statuts : offline | starting | online | unresponsive.
// Émet : 'change', 'notify' ({kind, text}), 'session-end'.
export class ServerState extends EventEmitter {
  constructor({ unresponsiveAfter = 3 } = {}) {
    super();
    this.status = 'offline';
    this.players = 0;
    this.playerLimit = null;
    this.session = null;
    this.techTier = null;
    this.phase = null;
    this.tickRate = null;
    this.paused = false;
    this.gameDuration = null;
    this.version = null;
    this.containerStartedAt = null;
    this.onlineSince = null;
    this.apiFailures = 0;
    this.unresponsiveAfter = unresponsiveAfter;
    this.expectedStop = false;
    this.restartCount = null;
  }

  notify(kind, text, silent) {
    if (!silent) this.emit('notify', { kind, text });
  }

  // Un relevé : { running, startedAt, exitCode, api } — api = serverGameState ou null.
  apply({ running, startedAt = null, exitCode = 0, restartCount = null, api = null }, { silent = false } = {}) {
    const before = JSON.stringify(this.snapshot());

    if (!running) {
      if (this.status !== 'offline') {
        const hadPlayers = this.players;
        if (!this.expectedStop && exitCode !== 0) {
          this.notify('crash', `💥 Le serveur s'est arrêté de façon inattendue (code ${exitCode}).` +
            (hadPlayers ? ` ${hadPlayers} pionnier(s) déconnecté(s).` : ''), silent);
        } else if (!this.expectedStop) {
          this.notify('offline', '🔴 Le serveur est hors ligne.', silent);
        }
      }
      this.expectedStop = false;
      this.status = 'offline';
      this.players = 0;
      this.onlineSince = null;
      this.apiFailures = 0;
      return this.changed(before);
    }

    const startKey = startedAt ? new Date(startedAt).getTime() : null;
    if (startKey && this.containerStartedAt?.getTime() !== startKey) {
      const isFirstSight = this.containerStartedAt === null;
      // Redémarrage automatique par Docker sans qu'on ait vu l'arrêt : c'était un plantage.
      const autoRestarted = restartCount !== null && this.restartCount !== null && restartCount > this.restartCount;
      if (!isFirstSight && autoRestarted && !this.expectedStop && this.status !== 'offline') {
        this.notify('crash', '💥 Le serveur a planté, Docker le relance.', silent);
      }
      this.expectedStop = false;
      this.containerStartedAt = new Date(startKey);
      this.version = null;
      this.players = 0;
      this.onlineSince = null;
      this.status = 'starting';
      if (!isFirstSight) this.notify('starting', '🟡 Le serveur démarre…', silent);
    }

    if (restartCount !== null) this.restartCount = restartCount;
    if (!api) {
      this.apiFailures++;
      if (this.status === 'online' && this.apiFailures >= this.unresponsiveAfter) {
        this.status = 'unresponsive';
        this.notify('unresponsive', '⚠️ Le serveur ne répond plus à l\'API.', silent);
      } else if (this.status === 'offline') {
        this.status = 'starting';
      }
      return this.changed(before);
    }

    this.apiFailures = 0;
    if (restartCount !== null) this.restartCount = restartCount;
    const wasOnline = this.status === 'online';
    const wasUnresponsive = this.status === 'unresponsive';
    this.status = 'online';
    this.onlineSince ??= new Date();
    if (!wasOnline) {
      this.notify('online', wasUnresponsive ? '🟢 Le serveur répond à nouveau.' : '🟢 Le serveur est en ligne, vous pouvez vous connecter.', silent);
    }

    const prevPlayers = this.players;
    const prevTier = this.techTier;
    const prevPhase = this.phase;
    this.players = Number(api.numConnectedPlayers ?? 0);
    this.playerLimit = api.playerLimit ?? this.playerLimit;
    this.session = api.activeSessionName || this.session;
    this.techTier = api.techTier ?? this.techTier;
    this.phase = phaseLabel(api.gamePhase) ?? this.phase;
    this.tickRate = api.averageTickRate ?? this.tickRate;
    this.paused = Boolean(api.isGamePaused);
    this.gameDuration = api.totalGameDuration ?? this.gameDuration;

    // Arrivées et départs : l'API ne donne que le nombre, pas les noms.
    if (wasOnline) {
      const lim = this.playerLimit ? `/${this.playerLimit}` : '';
      if (this.players > prevPlayers) {
        const n = this.players - prevPlayers;
        this.notify('join', `➡️ ${n > 1 ? `${n} pionniers ont` : 'Un pionnier a'} rejoint l'usine (${this.players}${lim}).`, silent);
      } else if (this.players < prevPlayers) {
        const n = prevPlayers - this.players;
        this.notify('leave', `⬅️ ${n > 1 ? `${n} pionniers sont partis` : 'Un pionnier est parti'} (${this.players}${lim}).`, silent);
        if (this.players === 0 && !silent) this.emit('session-end');
      }
      if (prevTier !== null && this.techTier > prevTier) {
        this.notify('tier', `🚀 Palier ${this.techTier} débloqué !`, silent);
      }
      if (prevPhase && this.phase && this.phase !== prevPhase) {
        this.notify('phase', `🛰️ Projet Assemblage : passage en **${this.phase}** !`, silent);
      }
    }
    return this.changed(before);
  }

  snapshot() {
    const { status, players, playerLimit, session, techTier, phase, paused, version } = this;
    return { status, players, playerLimit, session, techTier, phase, paused, version };
  }

  changed(before) {
    if (JSON.stringify(this.snapshot()) !== before) this.emit('change');
  }
}
