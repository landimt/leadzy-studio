import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { StudioDb } from './index.js';

let dir: string;
let db: StudioDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'leadzy-db-'));
  db = new StudioDb(join(dir, 'studio.sqlite'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('StudioDb', () => {
  it('upserts projects idempotently by path', () => {
    const a = db.upsertProject('/projects/one');
    const b = db.upsertProject('/projects/one');
    expect(a.id).toBe(b.id);
  });

  it('lists the most recently opened projects first with a bounded limit', () => {
    db.upsertProject('/projects/one');
    db.upsertProject('/projects/two');
    db.upsertProject('/projects/three');

    expect(db.listProjects(2).map((project) => project.path)).toEqual([
      '/projects/three',
      '/projects/two',
    ]);
  });

  it('indexes media with transcript text and finds it via FTS', () => {
    const project = db.upsertProject('/projects/one');
    db.upsertMedia(project.id, {
      relPath: 'camera.mp4',
      hash: 'abc',
      durationS: 64.6,
      transcriptStatus: 'scribe',
      transcriptText: 'hoje a gente fala de follow-up automático no leadzy',
    });
    const hits = db.search('follow-up');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.mediaRelPath).toBe('camera.mp4');
    expect(hits[0]!.snippet).toContain('«follow-up»');
  });

  it('replaces FTS text on media update instead of duplicating', () => {
    const project = db.upsertProject('/projects/one');
    const entry = {
      relPath: 'camera.mp4',
      hash: 'abc',
      durationS: 10,
      transcriptStatus: 'scribe' as const,
      transcriptText: 'primeira versão',
    };
    db.upsertMedia(project.id, entry);
    db.upsertMedia(project.id, { ...entry, transcriptText: 'segunda versão' });
    expect(db.search('primeira')).toHaveLength(0);
    expect(db.search('segunda')).toHaveLength(1);
  });

  it('records renders and updates qa status', () => {
    const project = db.upsertProject('/projects/one');
    db.recordRender(project.id, 'final', 'edit/final.mp4', 53.3, null);
    db.setRenderQa(project.id, 'edit/final.mp4', true);
    const renders = db.listRenders(project.id);
    expect(renders).toHaveLength(1);
    expect(renders[0]!.qa_ok).toBe(1);
  });

  it('attaches QA to the latest render when timestamps share a second', () => {
    const project = db.upsertProject('/projects/one');
    db.recordRender(project.id, 'final', 'edit/final.mp4', 1, null);
    db.recordRender(project.id, 'final', 'edit/final.mp4', 2, null);
    const fixture = new Database(join(dir, 'studio.sqlite'));
    try {
      fixture.prepare('UPDATE renders SET created_at = ?').run('2026-09-11 12:00:00');
    } finally {
      fixture.close();
    }

    db.setRenderQa(project.id, 'edit/final.mp4', true);

    const renders = db.listRenders(project.id);
    expect(renders.map((render) => [render.duration_s, render.qa_ok])).toEqual([
      [2, 1],
      [1, null],
    ]);
  });

  it('reindexProject rebuilds from scratch — the db is disposable', () => {
    const project = db.upsertProject('/projects/one');
    db.upsertMedia(project.id, {
      relPath: 'old.mp4',
      hash: 'x',
      durationS: 5,
      transcriptStatus: 'none',
      transcriptText: 'conteúdo antigo',
    });
    db.reindexProject('/projects/one', [
      {
        relPath: 'new.mp4',
        hash: 'y',
        durationS: 7,
        transcriptStatus: 'scribe',
        transcriptText: 'conteúdo novo',
      },
    ]);
    expect(db.search('antigo')).toHaveLength(0);
    expect(db.search('novo')).toHaveLength(1);
  });
});
