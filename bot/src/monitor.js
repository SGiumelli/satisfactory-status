import Docker from 'dockerode';

export function dockerFromHost(dockerHost) {
  if (dockerHost.startsWith('unix://')) return new Docker({ socketPath: dockerHost.slice(7) });
  const url = new URL(dockerHost.replace(/^tcp:/, 'http:'));
  return new Docker({ host: url.hostname, port: Number(url.port || 2375), protocol: 'http' });
}

// Découpe un flux de logs Docker multiplexé (conteneur sans TTY).
function demuxBuffer(buf) {
  const out = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    out.push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return Buffer.concat(out).toString('utf8');
}

// "LogInit: Build: ++FactoryGame+rel-main-1.2.6-CL-520140" → "1.2.6"
export function parseVersion(text) {
  const m = /LogInit: Build: \+\+FactoryGame\+rel-[\w-]*?-(\d+(?:\.\d+)+)(?:-CL-(\d+))?/.exec(text);
  return m ? m[1] : null;
}

// Relève l'état toutes les `intervalMs` : conteneur (Docker) puis API du jeu.
export class Poller {
  constructor({ docker, containerName, api, state, intervalMs = 30_000, log = console }) {
    this.container = docker.getContainer(containerName);
    this.name = containerName;
    this.api = api;
    this.state = state;
    this.intervalMs = intervalMs;
    this.log = log;
    this.timer = null;
    this.stopped = false;
    this.versionTries = 0;
    this.listeners = [];
  }

  onPoll(fn) {
    this.listeners.push(fn);
  }

  async start() {
    await this.poll({ silent: true });
    this.schedule();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      await this.poll().catch((err) => this.log.warn('Relevé impossible :', err.message));
      this.schedule();
    }, this.intervalMs);
  }

  async poll({ silent = false } = {}) {
    let info;
    try {
      info = await this.container.inspect();
    } catch (err) {
      this.log.warn(`Conteneur « ${this.name} » introuvable :`, err.message);
      this.state.apply({ running: false }, { silent: true });
      return;
    }
    const running = Boolean(info.State.Running);
    let api = null;
    if (running) {
      try {
        api = await this.api.state();
      } catch (err) {
        if (this.state.status === 'online') this.log.warn('API du serveur :', err.message);
      }
    }
    const startedAt = info.State.StartedAt;
    this.state.apply({ running, startedAt, exitCode: info.State.ExitCode ?? 0, restartCount: info.RestartCount ?? null, api }, { silent });
    if (running && !this.state.version && this.versionTries < 20) await this.readVersion(info);
    for (const fn of this.listeners) await fn();
  }

  // La version n'est pas dans l'API : on la lit dans les premières lignes du conteneur.
  async readVersion(info) {
    this.versionTries++;
    try {
      const raw = await this.container.logs({
        stdout: true,
        stderr: true,
        follow: false,
        since: Math.floor(new Date(info.State.StartedAt).getTime() / 1000),
        tail: 3000,
      });
      const text = info.Config.Tty ? raw.toString('utf8') : demuxBuffer(raw);
      const v = parseVersion(text);
      if (v) {
        this.state.version = v;
        this.state.emit('change');
      }
    } catch {
      // logs refusés ou indisponibles : on réessaiera
    }
  }

  async restart() {
    this.state.expectedStop = true;
    await this.container.restart({ t: 120 });
  }

  async stats() {
    try {
      const s = await this.container.stats({ stream: false });
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage ?? 0);
      const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
      const cpus = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
      const cpu = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
      const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0;
      const mem = Math.max(0, (s.memory_stats.usage ?? 0) - cache);
      return { cpu, mem };
    } catch {
      return null;
    }
  }
}
