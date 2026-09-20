import { startBackgroundWorker } from './services/worker/backgroundWorker';
import { ActionWatchdogWorker } from './services/worker/actionWatchdogWorker';
import { CrawlerQueueConsumer } from './queues/crawlerQueueConsumer';
import { SyncQueueConsumer } from './queues/syncQueueConsumer';
import { SerpQueueConsumer } from './queues/serpQueueConsumer';
import { ActionQueueConsumer } from './queues/actionQueueConsumer';
import { AttributionQueueConsumer } from './queues/attributionQueueConsumer';
import { OutboxDispatcher } from './services/outbox/outboxDispatcher';
import { recordWorkerHeartbeat } from './routes/observabilityRoutes';
import { isProductionMode } from './config/runtimeMode';
import { validateStartupEnvironment, isAutonomousExecutionEnabled } from './config/environmentValidator';
import { checkDatabaseReadiness } from './db/databaseReadiness';

async function startWorkerRuntime() {
  console.log('[Worker Process] Initializing Autonomous SEO Worker Runtime...');

  // 1. Strict Startup Environment Validation
  validateStartupEnvironment({
    enforceStrict: isProductionMode(),
    exitOnError: isProductionMode(),
  });

  // 2. Production Redis Verification
  if (isProductionMode() && !process.env.REDIS_URL) {
    console.error('[Worker Process] FATAL: REDIS_URL is required in PRODUCTION mode for worker consumers.');
    process.exit(1);
  }

  // 3. Database Readiness Check (Connection, Migrations, Availability)
  console.log('[Worker Process] Verifying database connectivity, migrations, and availability...');
  const dbReadiness = await checkDatabaseReadiness({
    timeoutMs: 8000,
    exitOnFailure: isProductionMode(),
  });

  if (dbReadiness.status === 'ERROR') {
    const errorMsg = dbReadiness.details.error || 'Database unavailable or pending migrations detected';
    if (isProductionMode()) {
      console.error('========================================================================');
      console.error('[Worker Process] FATAL: Database readiness verification failed.');
      console.error(`Reason: ${errorMsg}`);
      console.error('Worker startup aborted. A fully ready PostgreSQL database is required in production.');
      console.error('========================================================================');
      process.exit(1);
    } else {
      console.warn(`[Worker Process] Database readiness warning: ${errorMsg}`);
      console.warn('[Worker Process] Continuing in development fallback mode.');
    }
  } else {
    console.log(
      `[Worker Process] Database verified: READY (${dbReadiness.details.responseTimeMs}ms, Migrations verified).`
    );
  }

  // 4. Verify Autonomous Execution Status
  const autonomyActive = isAutonomousExecutionEnabled();
  console.log(
    `[Worker Process] Autonomy Status: ${autonomyActive ? 'ENABLED (AUTONOMOUS_EXECUTION_ENABLED=true)' : 'DISABLED BY DEFAULT (Safe Mode)'}`
  );

  // 5. Initialize BullMQ Consumers
  CrawlerQueueConsumer.initialize();
  SyncQueueConsumer.start();
  const serpQueueConsumer = new SerpQueueConsumer();
  serpQueueConsumer.start();
  ActionQueueConsumer.start();
  AttributionQueueConsumer.start();

  // 6. Start Transactional Outbox Polling
  OutboxDispatcher.startPolling(2000);

  // 7. Start Background Task Worker & Action Stuck Execution Watchdog Worker
  const workerRuntime = startBackgroundWorker();
  const watchdogWorkerRuntime = ActionWatchdogWorker.start();

  // 8. Print Structured Topology Banner
  console.log(`
========================================
AUTONOMOUS SEO WORKER RUNTIME TOPOLOGY
========================================
Database Check ......... ${dbReadiness.status}
CrawlerConsumer ........ ENABLED
SyncConsumer ........... ENABLED
SerpConsumer ........... ENABLED
ActionConsumer ......... ENABLED
AttributionConsumer .... ENABLED
OutboxDispatcher ....... ENABLED
Watchdog ............... ENABLED
Autonomy Mode .......... ${autonomyActive ? 'ACTIVE' : 'DISABLED_BY_DEFAULT'}
========================================
`);

  // 9. Periodic Worker Heartbeat emitter (local + shared)
  const heartbeatTimer = setInterval(() => {
    recordWorkerHeartbeat();
  }, 10000);

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    console.log(`[Worker Process] Received ${signal}. Shutting down worker gracefully...`);
    clearInterval(heartbeatTimer);
    OutboxDispatcher.stopPolling();
    try {
      await watchdogWorkerRuntime.stop();
      await serpQueueConsumer.stop();
      await ActionQueueConsumer.stop();
      await AttributionQueueConsumer.stop();
      await CrawlerQueueConsumer.shutdown();
      await SyncQueueConsumer.stop();
      await workerRuntime.stop();
      console.log('[Worker Process] Worker shutdown completed.');
      process.exit(0);
    } catch (err) {
      console.error('[Worker Process] Error during worker shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startWorkerRuntime().catch((err) => {
  console.error('[Worker Process] Unhandled fatal worker error:', err);
  process.exit(1);
});
