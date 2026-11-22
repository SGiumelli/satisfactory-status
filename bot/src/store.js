import fs from 'node:fs/promises';
import path from 'node:path';

// Petit fichier JSON persistant (id du message de statut, build Steam relevé…).
export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'state.json');
    this.data = {};
  }

  async load() {
    try {
      this.data = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
    return this;
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2));
    await fs.rename(tmp, this.file);
  }
}
