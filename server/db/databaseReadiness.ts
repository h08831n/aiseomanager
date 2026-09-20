import { prisma } from './prisma';
import { isProductionMode } from '../config/runtimeMode';

export interface DatabaseReadinessResult {
  status: 'READY' | 'ERROR';
  connection: 'READY' | 'ERROR';
  availability: 'READY' | 'ERROR';
  migrations: 'READY' | 'ERROR';
  details: {
    responseTimeMs?: number;
    appliedMigrationsCount?: number;
    lastMigration?: string;
    verifiedTablesCount?: number;
    error?: string;
    unappliedMigrationsCount?: number;
  };
  timestamp: string;
}

/**
 * Checks database connectivity, roundtrip latency, and migration state.
 */
export async function checkDatabaseReadiness(options: {
  timeoutMs?: number;
  exitOnFailure?: boolean;
} = {}): Promise<DatabaseReadinessResult> {
  const timeoutMs = options.timeoutMs || 5000;
  const start = Date.now();

  let connectionStatus: 'READY' | 'ERROR' = 'ERROR';
  let availabilityStatus: 'READY' | 'ERROR' = 'ERROR';
  let migrationsStatus: 'READY' | 'ERROR' = 'ERROR';
  let errorMessage: string | undefined;
  let appliedMigrationsCount: number | undefined;
  let lastMigration: string | undefined;
  let verifiedTablesCount = 0;

  try {
    // 1. Verify Prisma Connection & Availability via lightweight ping query
    const connectionPromise = prisma.$queryRawUnsafe<any[]>('SELECT 1 as is_connected');
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Database ping query timed out after ${timeoutMs}ms`)), timeoutMs)
    );

    await Promise.race([connectionPromise, timeoutPromise]);
    connectionStatus = 'READY';
    availabilityStatus = 'READY';

    // 2. Verify Migrations
    // First, check for _prisma_migrations table
    try {
      const migrationRows = await prisma.$queryRawUnsafe<any[]>(
        'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" WHERE rolled_back_at IS NULL ORDER BY started_at DESC LIMIT 5;'
      );

      if (Array.isArray(migrationRows) && migrationRows.length > 0) {
        appliedMigrationsCount = migrationRows.length;
        lastMigration = migrationRows[0]?.migration_name || 'unknown';
        migrationsStatus = 'READY';
      }
    } catch {
      // If _prisma_migrations table is not present, check whether core database models exist
      try {
        const tableRows = await prisma.$queryRawUnsafe<any[]>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('Website', 'CrawledPage', 'ActionExecution', 'KeywordUniverse');"
        );
        if (Array.isArray(tableRows) && tableRows.length >= 2) {
          verifiedTablesCount = tableRows.length;
          migrationsStatus = 'READY';
        } else {
          migrationsStatus = 'ERROR';
          errorMessage = 'Migrations check failed: neither _prisma_migrations nor core application tables were found in PostgreSQL public schema.';
        }
      } catch (err: any) {
        migrationsStatus = 'ERROR';
        errorMessage = `Failed to query schema tables: ${err?.message || String(err)}`;
      }
    }

    if (migrationsStatus !== 'READY' && !errorMessage) {
      errorMessage = 'No verified migrations or schema tables detected.';
    }
  } catch (err: any) {
    connectionStatus = 'ERROR';
    availabilityStatus = 'ERROR';
    migrationsStatus = 'ERROR';
    errorMessage = err?.message || String(err);
  }

  const responseTimeMs = Date.now() - start;
  const isAllReady = connectionStatus === 'READY' && availabilityStatus === 'READY' && migrationsStatus === 'READY';
  const overallStatus: 'READY' | 'ERROR' = isAllReady ? 'READY' : 'ERROR';

  const result: DatabaseReadinessResult = {
    status: overallStatus,
    connection: connectionStatus,
    availability: availabilityStatus,
    migrations: migrationsStatus,
    details: {
      responseTimeMs,
      appliedMigrationsCount,
      lastMigration,
      verifiedTablesCount,
      error: errorMessage,
    },
    timestamp: new Date().toISOString(),
  };

  if (overallStatus === 'ERROR' && options.exitOnFailure && isProductionMode()) {
    console.error('========================================================================');
    console.error('FATAL: Database readiness verification failed in PRODUCTION mode.');
    console.error(`Error: ${errorMessage || 'Unknown database failure'}`);
    console.error('Check DATABASE_URL and ensure migrations have been executed: npx prisma migrate deploy');
    console.error('========================================================================');
    process.exit(1);
  }

  return result;
}
