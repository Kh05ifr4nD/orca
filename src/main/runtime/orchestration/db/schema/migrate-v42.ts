import type { OrchestrationDb } from '../orchestration-db'
import { backfillStructuredWorkerActors } from './structured-worker-actor-backfill'

const ACTOR_COLUMNS = [
  ['runs', 'coordinator_actor'],
  ['dispatch_contexts', 'assignee_actor'],
  ['dispatch_contexts', 'creator_actor']
] as const

/**
 * Orchestration actor columns (`session:<id>`, see orchestration-actor): who a Run's coordinator
 * and a Dispatch's assignee and creator are when that party is a structured session. PTY rows keep
 * NULL and keep their handle and pane-key identity.
 *
 * Dev databases stamped v42 by an earlier prototype hold `*_principal` columns instead. They are
 * unsupported: the version-skew probe finds the actor columns missing and replays the chain, which
 * adds these columns and leaves the stale ones unread.
 */
export function migrateV42(this: OrchestrationDb, current: number): void {
  if (current >= 42) {
    return
  }
  // Guarded because createTables runs first on every open and already gives a fresh database these.
  for (const [table, column] of ACTOR_COLUMNS) {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
    }
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runs_coordinator_actor
      ON runs(coordinator_actor) WHERE coordinator_actor IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_actor
      ON dispatch_contexts(assignee_actor) WHERE assignee_actor IS NOT NULL;
  `)
  // A handle-less coordinator is remembered by its actor, which is already a mailbox address, so
  // every reader of this cache matches it unchanged. This step owns the trigger form: the static
  // createTables SQL must stay handle-only (see create-core-tables-sql), and CREATE TRIGGER IF NOT
  // EXISTS never replaces an existing database's triggers, so they are dropped and recreated by name.
  this.db.exec(`
    DROP TRIGGER IF EXISTS trg_runs_remember_coordinator_insert;
    DROP TRIGGER IF EXISTS trg_runs_remember_coordinator_update;
    CREATE TRIGGER trg_runs_remember_coordinator_insert
    AFTER INSERT ON runs
    WHEN NEW.legacy = 0 AND COALESCE(NEW.coordinator_handle, NEW.coordinator_actor) IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
      VALUES (NEW.id, COALESCE(NEW.coordinator_handle, NEW.coordinator_actor));
    END;
    CREATE TRIGGER trg_runs_remember_coordinator_update
    AFTER UPDATE OF coordinator_handle, coordinator_actor ON runs
    WHEN NEW.legacy = 0 AND COALESCE(NEW.coordinator_handle, NEW.coordinator_actor) IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
      VALUES (NEW.id, COALESCE(NEW.coordinator_handle, NEW.coordinator_actor));
    END;
  `)
  backfillStructuredWorkerActors(this.db)
}
