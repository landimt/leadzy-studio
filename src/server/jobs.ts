import { EventEmitter } from 'node:events';

export type JobType =
  'render' | 'audio-preview' | 'transcribe' | 'qa' | 'suggest' | 'title' | 'library-overlay';
type JobState = 'running' | 'done' | 'error';

export interface JobEvent {
  readonly kind: 'job';
  readonly id: number;
  readonly type: JobType;
  readonly state: JobState;
  readonly progress?: string;
  readonly error?: string;
  readonly result?: unknown;
}

interface EditChangedEvent {
  readonly kind: 'edit-changed';
  readonly hash: string;
  readonly external: boolean;
}

interface ArtifactsChangedEvent {
  readonly kind: 'artifacts-changed';
}

interface AssetsChangedEvent {
  readonly kind: 'assets-changed';
}

/** Authoritative state sent once for every SSE connection/reconnection. */
interface JobsSnapshotEvent {
  readonly kind: 'jobs-snapshot';
  readonly jobs: readonly JobEvent[];
}

export type ServerEvent =
  JobEvent | EditChangedEvent | AssetsChangedEvent | ArtifactsChangedEvent | JobsSnapshotEvent;

/**
 * One job of each type at a time; every state change is broadcast to the SSE
 * stream so the UI (and a watching agent) can follow along.
 */
export class JobManager {
  private readonly emitter = new EventEmitter();
  private readonly running = new Map<JobType, JobEvent>();
  private nextId = 1;

  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  broadcast(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  isRunning(type: JobType): boolean {
    return this.running.has(type);
  }

  /** Current progress for reconnecting SSE clients; returned as a detached snapshot. */
  runningJobs(): readonly JobEvent[] {
    return [...this.running.values()];
  }

  start(
    type: JobType,
    work: (progress: (message: string) => void) => Promise<unknown>,
  ): number | null {
    if (this.running.has(type)) return null;
    const id = this.nextId;
    this.nextId += 1;
    const started: JobEvent = { kind: 'job', id, type, state: 'running' };
    this.running.set(type, started);
    this.broadcast(started);

    void work((message) => {
      // A badly behaved worker may retain the callback after settling. Never
      // resurrect a completed job or overwrite its newer replacement.
      if (this.running.get(type)?.id !== id) return;
      const progress: JobEvent = { kind: 'job', id, type, state: 'running', progress: message };
      this.running.set(type, progress);
      this.broadcast(progress);
    })
      .then((result) => {
        // Delete before broadcasting the terminal event. A client that
        // reconnects immediately after missing this event must see it absent.
        this.running.delete(type);
        this.broadcast({ kind: 'job', id, type, state: 'done', result });
      })
      .catch((error: unknown) => {
        this.running.delete(type);
        this.broadcast({
          kind: 'job',
          id,
          type,
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return id;
  }
}
