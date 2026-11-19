import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DB_PATH = join(import.meta.dirname, '..', 'data', 'radar.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    source_id     TEXT NOT NULL,
    company       TEXT,
    title         TEXT NOT NULL,
    salary_raw    TEXT,
    salary_min    REAL,
    salary_max    REAL,
    salary_currency TEXT,
    salary_period TEXT,
    location      TEXT,
    city          TEXT,
    remote        INTEGER DEFAULT 0,
    remote_note   TEXT,
    channel       TEXT,
    tags          TEXT,
    summary       TEXT,
    company_meta  TEXT,
    url           TEXT,
    original_url  TEXT,
    posted_at     TEXT,
    first_seen_at TEXT,
    last_seen_at  TEXT,
    relevance     INTEGER DEFAULT 0,
    raw           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_channel ON jobs(channel);
  CREATE INDEX IF NOT EXISTS idx_jobs_posted  ON jobs(posted_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_city    ON jobs(city);
  CREATE INDEX IF NOT EXISTS idx_jobs_rel     ON jobs(relevance);

  CREATE TABLE IF NOT EXISTS applications (
    job_id       TEXT PRIMARY KEY,
    status       TEXT NOT NULL DEFAULT 'todo',
    note         TEXT,
    cover_letter TEXT,
    resume_name  TEXT,
    created_at   TEXT,
    updated_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS scans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT,
    finished_at TEXT,
    status      TEXT,
    stats       TEXT,
    log         TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS translations (
    job_id     TEXT PRIMARY KEY,
    title_zh   TEXT,
    summary_zh TEXT,
    at         TEXT
  );
`);

const now = () => new Date().toISOString();

// 清理历史遗留的孤儿投递记录（岗位已不存在）
try { db.prepare('DELETE FROM applications WHERE job_id NOT IN (SELECT id FROM jobs)').run(); } catch { /* ignore */ }

// 轻量迁移：简历匹配分
{
  const cols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
  if (!cols.includes('match_score')) db.exec('ALTER TABLE jobs ADD COLUMN match_score INTEGER DEFAULT 0');
  if (!cols.includes('cover_url')) db.exec('ALTER TABLE jobs ADD COLUMN cover_url TEXT');
  if (!cols.includes('note_likes')) db.exec('ALTER TABLE jobs ADD COLUMN note_likes TEXT');
}

const upsert = db.prepare(`
  INSERT INTO jobs (
    id, source, source_id, company, title, salary_raw, salary_min, salary_max,
    salary_currency, salary_period, location, city, remote, remote_note, channel,
    tags, summary, company_meta, url, original_url, posted_at, first_seen_at,
    last_seen_at, relevance, raw, cover_url, note_likes
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    company=excluded.company, title=excluded.title,
    salary_raw=excluded.salary_raw, salary_min=excluded.salary_min,
    salary_max=excluded.salary_max, salary_currency=excluded.salary_currency,
    salary_period=excluded.salary_period, location=excluded.location,
    city=excluded.city, remote=excluded.remote, remote_note=excluded.remote_note,
    channel=excluded.channel, tags=excluded.tags, summary=excluded.summary,
    company_meta=excluded.company_meta, url=excluded.url,
    original_url=COALESCE(excluded.original_url, jobs.original_url),
    posted_at=excluded.posted_at, last_seen_at=excluded.last_seen_at,
    relevance=excluded.relevance, raw=excluded.raw,
    cover_url=excluded.cover_url, note_likes=excluded.note_likes
`);

export function saveJobs(jobs) {
  let added = 0, updated = 0;
  const seen = db.prepare('SELECT 1 FROM jobs WHERE id = ?');
  const tx = db.prepare('SELECT 1'); // noop to keep API similar
  db.exec('BEGIN');
  try {
    for (const j of jobs) {
      const exists = seen.get(j.id);
      upsert.run(
        j.id, j.source, j.source_id, j.company ?? null, j.title,
        j.salary_raw ?? null, j.salary_min ?? null, j.salary_max ?? null,
        j.salary_currency ?? null, j.salary_period ?? null,
        j.location ?? null, j.city ?? null, j.remote ? 1 : 0,
        j.remote_note ?? null, j.channel ?? null,
        JSON.stringify(j.tags ?? []), j.summary ?? null,
        j.company_meta ?? null, j.url ?? null, j.original_url ?? null,
        j.posted_at ?? null, now(), now(),
        j.relevance ?? 0, JSON.stringify(j.raw ?? {}), j.cover_url ?? null, j.note_likes ?? null
      );
      exists ? updated++ : added++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { added, updated };
}

// 详情页补充原站链接
export function setOriginalUrl(id, url) {
  db.prepare('UPDATE jobs SET original_url = ? WHERE id = ?').run(url, id);
}

export function queryJobs({ channel, q, source, minSalary, relevantOnly, sort, limit, offset }) {
  const where = [];
  const args = [];
  if (channel && channel !== 'all') { where.push('channel = ?'); args.push(channel); }
  if (source && source !== 'all') { where.push('source = ?'); args.push(source); }
  if (relevantOnly) { where.push('relevance >= 30'); }
  if (minSalary) { where.push('(salary_max >= ? OR salary_min >= ?)'); args.push(minSalary, minSalary); }
  if (q) {
    where.push('(title LIKE ? OR company LIKE ? OR summary LIKE ? OR tags LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  const order = sort === 'salary' ? 'COALESCE(salary_max, salary_min, 0) DESC, posted_at DESC'
    : sort === 'relevance' ? 'relevance DESC, posted_at DESC'
    : sort === 'match' ? 'match_score DESC, relevance DESC'
    : 'COALESCE(posted_at, first_seen_at) DESC';
  const sql = `
    SELECT j.*, a.status AS apply_status, a.updated_at AS apply_updated_at,
           a.note AS apply_note
    FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${order} LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...args, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...args).c;
  return { total, rows: rows.map(hydrate) };
}

function hydrate(r) {
  return {
    ...r,
    remote: !!r.remote,
    tags: safeJson(r.tags, []),
    raw: undefined,
    apply: r.apply_status ? { status: r.apply_status, updated_at: r.apply_updated_at, note: r.apply_note } : null,
  };
}

export function getJob(id) {
  const r = db.prepare(`SELECT j.*, a.status apply_status, a.updated_at apply_updated_at,
      a.note apply_note, a.cover_letter apply_cover_letter, a.resume_name apply_resume
    FROM jobs j LEFT JOIN applications a ON a.job_id=j.id WHERE j.id = ?`).get(id);
  if (!r) return null;
  return { ...hydrate(r), apply: r.apply_status ? { status: r.apply_status, note: r.apply_note, cover_letter: r.apply_cover_letter, resume_name: r.apply_resume, updated_at: r.apply_updated_at } : null };
}

export function stats() {
  const total = db.prepare('SELECT COUNT(*) c FROM jobs').get().c;
  const rows = db.prepare(`SELECT channel, COUNT(*) c FROM jobs GROUP BY channel`).all();
  const byChannel = Object.fromEntries(rows.map(r => [r.channel, r.c]));
  const sources = db.prepare('SELECT source, COUNT(*) c FROM jobs GROUP BY source ORDER BY c DESC').all();
  const fresh = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE first_seen_at >= datetime('now','-24 hours')`).get().c;
  const companies = db.prepare(`SELECT company, COUNT(*) c FROM jobs WHERE company IS NOT NULL AND company != ''
    GROUP BY company ORDER BY c DESC LIMIT 8`).all();
  const applied = db.prepare(`SELECT status, COUNT(*) c FROM applications GROUP BY status`).all();
  const lastScan = db.prepare('SELECT * FROM scans WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get();
  const avgMatch = db.prepare('SELECT ROUND(AVG(match_score)) a FROM jobs WHERE match_score > 0').get()?.a ?? 0;
  return { total, fresh, byChannel, sources, companies, applied, avgMatch, lastScan: lastScan ? { ...lastScan, stats: safeJson(lastScan.stats, {}) } : null };
}

export function jobsMissingOriginalUrl(limit = 10) {
  return db.prepare(`SELECT id, url FROM jobs
    WHERE source='jobui' AND original_url IS NULL
    ORDER BY relevance DESC LIMIT ?`).all(limit);
}

export function countMissingOriginalUrl() {
  return db.prepare(`SELECT COUNT(*) c FROM jobs WHERE source='jobui' AND original_url IS NULL`).get().c;
}

export function allJobs() {
  return db.prepare('SELECT * FROM jobs').all();
}

export function allJobsForMatch() {
  return db.prepare(`SELECT id, title, company, summary, tags, location, city, remote, channel, relevance FROM jobs`).all();
}

export function setMatchScores(entries) {
  const stmt = db.prepare('UPDATE jobs SET match_score = ? WHERE id = ?');
  db.exec('BEGIN');
  try { for (const e of entries) stmt.run(e.score, e.id); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function ncssPending(limit = 5) {
  return db.prepare(`SELECT id, original_url, summary FROM jobs
    WHERE original_url LIKE '%ncss.cn%' AND LENGTH(COALESCE(summary,'')) < 120
    LIMIT ?`).all(limit);
}

export function updateJobSummary(id, summary) {
  db.prepare('UPDATE jobs SET summary=?, last_seen_at=? WHERE id=?').run(summary, new Date().toISOString(), id);
}

export function getTranslation(jobId) {
  return db.prepare('SELECT title_zh, summary_zh, at FROM translations WHERE job_id=?').get(jobId) || null;
}

export function saveTranslation(jobId, titleZh, summaryZh) {
  db.prepare(`INSERT INTO translations (job_id,title_zh,summary_zh,at) VALUES (?,?,?,?)
    ON CONFLICT(job_id) DO UPDATE SET title_zh=excluded.title_zh, summary_zh=excluded.summary_zh, at=excluded.at`)
    .run(jobId, titleZh ?? '', summaryZh ?? '', new Date().toISOString());
}

export function saveApplication({ job_id, status, note, cover_letter, resume_name }) {
  const t = now();
  db.prepare(`INSERT INTO applications (job_id,status,note,cover_letter,resume_name,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(job_id) DO UPDATE SET status=excluded.status, note=excluded.note,
      cover_letter=excluded.cover_letter, resume_name=excluded.resume_name, updated_at=excluded.updated_at`)
    .run(job_id, status ?? 'todo', note ?? '', cover_letter ?? '', resume_name ?? '', t, t);
  return getJob(job_id);
}

export function deleteApplication(job_id) {
  db.prepare('DELETE FROM applications WHERE job_id = ?').run(job_id);
}

export function listApplications() {
  const rows = db.prepare(`SELECT a.*, j.title, j.company, j.salary_raw, j.location, j.remote, j.channel,
      j.url, j.original_url, j.source, j.posted_at
    FROM applications a JOIN jobs j ON j.id = a.job_id ORDER BY a.updated_at DESC`).all();
  return rows.map(r => ({ ...r, remote: !!r.remote }));
}

export function startScan() {
  const r = db.prepare(`INSERT INTO scans (started_at, status) VALUES (?, 'running')`).run(now());
  return Number(r.lastInsertRowid);
}

export function finishScan(id, status, statsObj, log) {
  db.prepare('UPDATE scans SET finished_at=?, status=?, stats=?, log=? WHERE id=?')
    .run(now(), status, JSON.stringify(statsObj ?? {}), log ?? '', id);
}

export function lastScanAt() {
  const r = db.prepare(`SELECT finished_at FROM scans WHERE status='ok' ORDER BY id DESC LIMIT 1`).get();
  return r?.finished_at ?? null;
}

export function getSetting(key, fallback = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : fallback;
}

export function cleanupChannel(channel, minRelevance) {
  const r = db.prepare(`DELETE FROM jobs WHERE channel=? AND relevance < ?
    AND id NOT IN (SELECT job_id FROM applications)`).run(channel, minRelevance);
  return r.changes;
}

export function overseasCandidates() {
  return db.prepare(`SELECT id, title, relevance FROM jobs WHERE channel='overseas'
    AND id NOT IN (SELECT job_id FROM applications)`).all();
}

export function deleteJobs(ids) {
  if (!ids.length) return 0;
  const stmt = db.prepare('DELETE FROM jobs WHERE id = ?');
  let n = 0;
  db.exec('BEGIN');
  try { for (const id of ids) n += stmt.run(id).changes; db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}

export function pendingEnrichment(limit = 10, minRelevance = 40) {
  return db.prepare(`SELECT id, url FROM jobs
    WHERE source='jobui' AND original_url IS NULL AND relevance >= ?
    ORDER BY relevance DESC, posted_at DESC LIMIT ?`).all(minRelevance, limit);
}

export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
}

function safeJson(s, fb) {
  try { return s ? JSON.parse(s) : fb; } catch { return fb; }
}
