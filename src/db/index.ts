import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const SCHEMA_VERSION = 1;

function defaultDbPath(): string {
  return process.env.LEADZY_STUDIO_DB ?? join(homedir(), '.leadzy-studio', 'studio.sqlite');
}

export interface ProjectRow {
  readonly id: number;
  readonly path: string;
  readonly opened_at: string;
}

export interface MediaRow {
  readonly id: number;
  readonly project_id: number;
  readonly rel_path: string;
  readonly hash: string;
  readonly duration_s: number;
  readonly transcript_status: 'none' | 'scribe';
}

export interface RenderRow {
  readonly id: number;
  readonly project_id: number;
  readonly kind: 'preview' | 'final';
  readonly output_rel: string;
  readonly duration_s: number;
  readonly qa_ok: 0 | 1 | null;
  readonly created_at: string;
}

export interface SearchHit {
  readonly projectPath: string;
  readonly mediaRelPath: string;
  readonly snippet: string;
}

export interface MediaIndexEntry {
  readonly relPath: string;
  readonly hash: string;
  readonly durationS: number;
  readonly transcriptStatus: 'none' | 'scribe';
  readonly transcriptText: string | null;
}

/**
 * The SQLite file is an INDEX, never the source of truth: edits live in
 * edit.json, transcripts in their caches. Deleting the db loses nothing —
 * reindexProject rebuilds everything from the files.
 */
export class StudioDb {
  private readonly db: Database.Database;

  constructor(dbPath: string = defaultDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.backupBeforeMigration(dbPath);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private backupBeforeMigration(dbPath: string): void {
    if (!existsSync(dbPath)) return;
    const current = new Database(dbPath, { readonly: true });
    const version = (current.pragma('user_version', { simple: true }) as number | undefined) ?? 0;
    current.close();
    if (version < SCHEMA_VERSION) {
      copyFileSync(dbPath, `${dbPath}.backup-v${String(version)}`);
    }
  }

  private migrate(): void {
    const version = (this.db.pragma('user_version', { simple: true }) as number | undefined) ?? 0;
    if (version >= SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        opened_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS media (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        rel_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        duration_s REAL NOT NULL,
        transcript_status TEXT NOT NULL DEFAULT 'none',
        UNIQUE(project_id, rel_path)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
        text,
        media_id UNINDEXED
      );
      CREATE TABLE IF NOT EXISTS renders (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        output_rel TEXT NOT NULL,
        duration_s REAL NOT NULL,
        qa_ok INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    this.db.pragma(`user_version = ${String(SCHEMA_VERSION)}`);
  }

  upsertProject(projectPath: string): ProjectRow {
    this.db
      .prepare(
        `INSERT INTO projects (path) VALUES (?)
         ON CONFLICT(path) DO UPDATE SET opened_at = datetime('now')`,
      )
      .run(projectPath);
    return this.db.prepare('SELECT * FROM projects WHERE path = ?').get(projectPath) as ProjectRow;
  }

  listProjects(limit = 12): ProjectRow[] {
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    return this.db
      .prepare('SELECT * FROM projects ORDER BY opened_at DESC, id DESC LIMIT ?')
      .all(safeLimit) as ProjectRow[];
  }

  upsertMedia(projectId: number, entry: MediaIndexEntry): MediaRow {
    this.db
      .prepare(
        `INSERT INTO media (project_id, rel_path, hash, duration_s, transcript_status)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, rel_path) DO UPDATE SET
           hash = excluded.hash,
           duration_s = excluded.duration_s,
           transcript_status = excluded.transcript_status`,
      )
      .run(projectId, entry.relPath, entry.hash, entry.durationS, entry.transcriptStatus);
    const row = this.db
      .prepare('SELECT * FROM media WHERE project_id = ? AND rel_path = ?')
      .get(projectId, entry.relPath) as MediaRow;

    this.db.prepare('DELETE FROM transcript_fts WHERE media_id = ?').run(row.id);
    if (entry.transcriptText !== null && entry.transcriptText.length > 0) {
      this.db
        .prepare('INSERT INTO transcript_fts (text, media_id) VALUES (?, ?)')
        .run(entry.transcriptText, row.id);
    }
    return row;
  }

  recordRender(
    projectId: number,
    kind: 'preview' | 'final',
    outputRel: string,
    durationS: number,
    qaOk: boolean | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO renders (project_id, kind, output_rel, duration_s, qa_ok)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, kind, outputRel, durationS, qaOk === null ? null : qaOk ? 1 : 0);
  }

  setRenderQa(projectId: number, outputRel: string, qaOk: boolean): void {
    this.db
      .prepare(
        `UPDATE renders SET qa_ok = ? WHERE id = (
           SELECT id FROM renders WHERE project_id = ? AND output_rel = ?
           ORDER BY created_at DESC, id DESC LIMIT 1
         )`,
      )
      .run(qaOk ? 1 : 0, projectId, outputRel);
  }

  listRenders(projectId: number): RenderRow[] {
    return this.db
      .prepare('SELECT * FROM renders WHERE project_id = ? ORDER BY created_at DESC, id DESC')
      .all(projectId) as RenderRow[];
  }

  /** "acha o vídeo em que falei de follow-up" — FTS5 over the spoken text. */
  search(query: string, limit = 20): SearchHit[] {
    // FTS5 gives hyphens/colons operator meaning — quote every term so user
    // input is always literal ("follow-up" would otherwise parse as a column).
    const safeQuery = query
      .split(/\s+/)
      .filter((term) => term.length > 0)
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(' ');
    if (safeQuery.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT p.path AS projectPath, m.rel_path AS mediaRelPath,
                snippet(transcript_fts, 0, '«', '»', '…', 12) AS snippet
         FROM transcript_fts f
         JOIN media m ON m.id = f.media_id
         JOIN projects p ON p.id = m.project_id
         WHERE transcript_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(safeQuery, limit);
    return rows as SearchHit[];
  }

  /** Rebuild a project's index from scratch — the files are the truth. */
  reindexProject(projectPath: string, entries: readonly MediaIndexEntry[]): ProjectRow {
    const project = this.upsertProject(projectPath);
    const knownIds = this.db
      .prepare('SELECT id FROM media WHERE project_id = ?')
      .all(project.id) as { id: number }[];
    for (const { id } of knownIds) {
      this.db.prepare('DELETE FROM transcript_fts WHERE media_id = ?').run(id);
    }
    this.db.prepare('DELETE FROM media WHERE project_id = ?').run(project.id);
    for (const entry of entries) {
      this.upsertMedia(project.id, entry);
    }
    return project;
  }

  close(): void {
    this.db.close();
  }
}
