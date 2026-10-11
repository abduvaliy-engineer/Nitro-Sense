const fs = require("fs/promises");
const path = require("path");

// Small JSON store for UI state (widget order, panel state, scenarios, ...).
class Settings {
  constructor(dir) {
    this.file = path.join(dir, "settings.json");
    this.data = null;
    this.writing = Promise.resolve();
  }

  async load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      this.data = {};
    }
    return this.data;
  }

  async get(key) {
    return (await this.load())[key];
  }

  async set(key, value) {
    (await this.load())[key] = value;
    const json = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(`${this.file}.tmp`, json);
      await fs.rename(`${this.file}.tmp`, this.file);
    });
    await this.writing;
  }
}

module.exports = { Settings };
