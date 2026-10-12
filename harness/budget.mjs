import { DatabaseSync } from 'node:sqlite';

/** Durable, shared admission budget. A crashed run consumes its remaining time reservation. */
export class VerificationBudget {
  constructor(path, config) {
    // Primary acceptance cannot spend the separately retained corrective-rerun allowance.
    this.config = {...config, maxRequests:config.maxRequests-(config.reserveRequests??0), maxLiveMs:config.maxLiveMs-(config.reserveMs??0)};
    config = this.config;
    this.db = new DatabaseSync(path);
    try {
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK(id=1), requests INTEGER NOT NULL, elapsed INTEGER NOT NULL);
      INSERT OR IGNORE INTO budget VALUES (1,0,0);`);
    this.started = Date.now();
    this.previous = this.db.prepare('SELECT * FROM budget WHERE id=1').get();
    if (this.previous.elapsed >= config.maxLiveMs || this.previous.requests >= config.maxRequests) throw new Error('Verification budget exhausted; a new budget needs user authorization');
    this.remainingMs = config.maxLiveMs - this.previous.elapsed;
    this.db.prepare('UPDATE budget SET elapsed=? WHERE id=1').run(config.maxLiveMs);
    } catch (error) { this.db.close(); throw error; }
  }
  reserve() {
    if (Date.now() - this.started >= this.remainingMs) return false;
    return this.db.prepare('UPDATE budget SET requests=requests+1 WHERE id=1 AND requests < ?').run(this.config.maxRequests).changes === 1;
  }
  close() {
    const elapsed = Math.min(this.config.maxLiveMs, this.previous.elapsed + Date.now() - this.started);
    this.db.prepare('UPDATE budget SET elapsed=? WHERE id=1').run(elapsed);
    const result = this.db.prepare('SELECT requests, elapsed FROM budget WHERE id=1').get();
    this.db.close(); return result;
  }
}
