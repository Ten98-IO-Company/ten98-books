import { PgBoss } from 'pg-boss';
import { getConfig } from './config.ts';
import { getDatabase } from './db.ts';
import { registerResourceCleanup } from './resource-cleanup.ts';

// Job contract (D-03): a handler that touches company data receives `companyId` and the acting `userId` in its payload
// and does all of its company work inside withCompany(userId, companyId, ...), so authorization is rechecked when the
// job runs. M0 has no such job; the worker runs the queue infrastructure and its heartbeat only.

/**
 * pg-boss runs as the application role in the `pgboss` schema that role owns (migration 0001 creates it, so no CREATE
 * on the database is needed). Only the worker holds the LISTEN connection and the schedule timekeeper.
 */
export const bossOptions = (connectionString: string, listen: boolean) => ({ connectionString, schema: 'pgboss', createSchema: false, schedule: listen, connectionTimeoutMillis: 5000, useListenNotify: listen });
let listenForJobs = false;
let bossPromise: Promise<PgBoss> | undefined;
let workerPromise: Promise<void> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let heartbeatTask: Promise<unknown> | undefined;
let workerStarted = false;

export function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    registerResourceCleanup('jobs', stopJobs);
    const boss = new PgBoss(bossOptions(getConfig().databaseUrl, listenForJobs));
    boss.on('error', () => console.error('Job queue unavailable; check database availability.'));
    bossPromise = (async () => {
      try {
        await boss.start();
        return boss;
      } catch (error) {
        await boss.stop({ graceful: false }).catch(() => undefined);
        bossPromise = undefined;
        throw error;
      }
    })();
  }
  return bossPromise;
}

// ponytail: one worker health row covers the single-worker Compose profile; use instance IDs before scaling workers.
const heartbeat = () => getDatabase().pool.query(
  `INSERT INTO worker_heartbeat(id, last_seen_at) VALUES ('foundation-worker', now())
   ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
);

export function startWorker(): Promise<void> {
  if (!workerPromise) workerPromise = (async () => {
    try {
      listenForJobs = true;
      await getBoss();
      workerStarted = true;
      await heartbeat();
      heartbeatTimer = setInterval(() => {
        if (!heartbeatTask) heartbeatTask = heartbeat()
          .catch(() => console.error('Worker heartbeat failed; check database availability.'))
          .finally(() => { heartbeatTask = undefined; });
      }, 10_000);
    } catch (error) {
      await stopJobs();
      throw error;
    }
  })();
  return workerPromise;
}

export async function stopJobs() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
  await heartbeatTask;
  const boss = await bossPromise?.catch(() => undefined);
  try {
    await boss?.stop({ graceful: true, timeout: 30_000 });
  } finally {
    bossPromise = undefined;
    workerPromise = undefined;
    if (workerStarted) {
      workerStarted = false;
      await getDatabase().pool.query("DELETE FROM worker_heartbeat WHERE id = 'foundation-worker'")
        .catch(() => console.error('Worker heartbeat cleanup failed; it will expire automatically.'));
    }
  }
}
