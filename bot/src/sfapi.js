import http from 'node:http';
import https from 'node:https';

// Client de l'API HTTPS officielle du serveur dédié Satisfactory (POST /api/v1).
// Le serveur utilise un certificat auto-signé : la vérification est désactivée,
// comme le faisait `curl -k` dans l'ancien script. Le trafic reste sur le réseau Docker.
export class SatisfactoryApi {
  constructor({ host, port = 7777, token = '', protocol = 'https', timeoutMs = 10_000 }) {
    this.host = host;
    this.port = Number(port);
    this.token = token;
    this.lib = protocol === 'http' ? http : https;
    this.agent = protocol === 'http' ? undefined : new https.Agent({ rejectUnauthorized: false, keepAlive: true });
    this.timeoutMs = timeoutMs;
  }

  request(fn, data = {}, { auth = true, binary = false, timeoutMs = this.timeoutMs } = {}) {
    const body = JSON.stringify({ function: fn, data });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    return new Promise((resolve, reject) => {
      const req = this.lib.request(
        { host: this.host, port: this.port, path: '/api/v1', method: 'POST', agent: this.agent, headers, timeout: timeoutMs },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('error', reject);
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const type = String(res.headers['content-type'] ?? '');
            const isJson = type.includes('json');
            if (res.statusCode === 204) return resolve(null);
            if (binary && !isJson && res.statusCode < 300) {
              const disp = String(res.headers['content-disposition'] ?? '');
              const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
              return resolve({ buffer: buf, filename: m ? decodeURIComponent(m[1]) : null });
            }
            let json = null;
            try {
              json = buf.length ? JSON.parse(buf.toString('utf8')) : null;
            } catch {
              // réponse non JSON
            }
            if (res.statusCode >= 400 || json?.errorCode) {
              const err = new Error(json?.errorMessage || json?.errorCode || `HTTP ${res.statusCode}`);
              err.code = json?.errorCode ?? `http_${res.statusCode}`;
              err.status = res.statusCode;
              return reject(err);
            }
            resolve(json?.data ?? json);
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`${fn} : délai dépassé`)));
      req.on('error', reject);
      req.end(body);
    });
  }

  // Ne demande pas d'authentification.
  health() {
    return this.request('HealthCheck', { ClientCustomData: '' }, { auth: false });
  }

  async state() {
    const data = await this.request('QueryServerState');
    if (!data?.serverGameState) throw new Error('réponse QueryServerState inattendue');
    return data.serverGameState;
  }

  saveGame(saveName) {
    return this.request('SaveGame', { SaveName: saveName }, { timeoutMs: 120_000 });
  }

  downloadSaveGame(saveName) {
    return this.request('DownloadSaveGame', { SaveName: saveName }, { binary: true, timeoutMs: 300_000 });
  }
}

// "/Script/FactoryGame.FGGamePhase'/Game/.../GP_Project_Assembly_Phase_2.GP_Project_Assembly_Phase_2'" → "Phase 2"
export function phaseLabel(gamePhase) {
  if (!gamePhase) return null;
  const m = /Phase_(\d+)/i.exec(gamePhase);
  if (m) return `Phase ${m[1]}`;
  const last = String(gamePhase).split(/[./']/).filter(Boolean).pop();
  return last?.replace(/^GP_/, '').replace(/_/g, ' ') ?? null;
}
