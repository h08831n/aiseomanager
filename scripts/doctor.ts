import pg from 'pg';
import IORedis from 'ioredis';
import dotenv from 'dotenv';
import { SecretVault } from '../server/security/secretVault';
import { containsPlaceholder } from '../server/config/configSchema';

dotenv.config();

export interface DiagnosticResult {
  database: 'READY' | 'ERROR';
  prisma: 'READY' | 'ERROR';
  redis: 'READY' | 'ERROR';
  googleOAuth: 'READY' | 'ERROR';
  encryption: 'READY' | 'ERROR';
  autonomousExecution: 'ENABLED' | 'DISABLED';
}

/**
 * Validates raw PostgreSQL database connectivity.
 */
export async function checkDatabase(env: NodeJS.ProcessEnv = process.env): Promise<'READY' | 'ERROR'> {
  const dbUrl = env.DATABASE_URL?.trim();
  if (!dbUrl || (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://')) || containsPlaceholder(dbUrl)) {
    return 'ERROR';
  }

  const client = new pg.Client({
    connectionString: dbUrl,
    connectionTimeoutMillis: 3000,
  });

  try {
    await client.connect();
    const res = await client.query('SELECT 1 as ping');
    await client.end();
    return res && res.rows && res.rows.length > 0 ? 'READY' : 'ERROR';
  } catch {
    return 'ERROR';
  }
}

/**
 * Validates Prisma ORM client query execution and schema binding.
 */
export async function checkPrisma(env: NodeJS.ProcessEnv = process.env): Promise<'READY' | 'ERROR'> {
  const dbUrl = env.DATABASE_URL?.trim();
  if (!dbUrl || (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://')) || containsPlaceholder(dbUrl)) {
    return 'ERROR';
  }

  try {
    const { PrismaClient } = await import('@prisma/client');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const pool = new pg.Pool({
      connectionString: dbUrl,
      connectionTimeoutMillis: 3000,
    });
    const adapter = new PrismaPg(pool);
    const prismaClient = new PrismaClient({ adapter });

    await prismaClient.$queryRawUnsafe('SELECT 1');
    await prismaClient.$disconnect();
    await pool.end();
    return 'READY';
  } catch {
    return 'ERROR';
  }
}

/**
 * Validates Redis connection and responsiveness via PING.
 */
export async function checkRedis(env: NodeJS.ProcessEnv = process.env): Promise<'READY' | 'ERROR'> {
  const redisUrl = env.REDIS_URL?.trim();
  if (!redisUrl || (!redisUrl.startsWith('redis://') && !redisUrl.startsWith('rediss://')) || containsPlaceholder(redisUrl)) {
    return 'ERROR';
  }

  return new Promise<'READY' | 'ERROR'>((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          redis.disconnect();
        } catch {}
        resolve('ERROR');
      }
    }, 2500);

    const redis = new IORedis(redisUrl, {
      connectTimeout: 2000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      lazyConnect: true,
      enableOfflineQueue: false,
    });

    redis.on('error', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        try {
          redis.disconnect();
        } catch {}
        resolve('ERROR');
      }
    });

    redis
      .connect()
      .then(() => redis.ping())
      .then((pong) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          redis.quit().catch(() => redis.disconnect());
          resolve(pong === 'PONG' ? 'READY' : 'ERROR');
        }
      })
      .catch(() => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          try {
            redis.disconnect();
          } catch {}
          resolve('ERROR');
        }
      });
  });
}

/**
 * Validates Google OAuth 2.0 credentials.
 */
export function checkGoogleOAuth(env: NodeJS.ProcessEnv = process.env): 'READY' | 'ERROR' {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    return 'ERROR';
  }

  if (containsPlaceholder(clientId) || containsPlaceholder(clientSecret)) {
    return 'ERROR';
  }

  const validId = clientId.includes('.apps.googleusercontent.com') || clientId.includes('-');
  const validSecret = clientSecret.length >= 16;

  return validId && validSecret ? 'READY' : 'ERROR';
}

/**
 * Validates AES-256-GCM encryption key and performs a live round-trip encryption test.
 */
export function checkEncryption(env: NodeJS.ProcessEnv = process.env): 'READY' | 'ERROR' {
  const rawKey = env.ENCRYPTION_MASTER_KEY?.trim();
  if (!rawKey || containsPlaceholder(rawKey)) {
    return 'ERROR';
  }

  const validFormat = /^[0-9a-fA-F]{64}$/.test(rawKey) || Buffer.byteLength(rawKey, 'utf8') >= 32;
  if (!validFormat) {
    return 'ERROR';
  }

  const prevKey = process.env.ENCRYPTION_MASTER_KEY;
  try {
    process.env.ENCRYPTION_MASTER_KEY = rawKey;
    const testSecret = `doctor_diagnostic_${Date.now()}`;
    const encrypted = SecretVault.encrypt(testSecret);
    const decrypted = SecretVault.decrypt(encrypted);
    return decrypted === testSecret ? 'READY' : 'ERROR';
  } catch {
    return 'ERROR';
  } finally {
    process.env.ENCRYPTION_MASTER_KEY = prevKey;
  }
}

/**
 * Evaluates autonomous execution status.
 */
export function checkAutonomousExecution(env: NodeJS.ProcessEnv = process.env): 'ENABLED' | 'DISABLED' {
  return env.AUTONOMOUS_EXECUTION_ENABLED === 'true' ? 'ENABLED' : 'DISABLED';
}

/**
 * Runs all diagnostic checks and returns the structured result.
 */
export async function runDiagnosticChecks(env: NodeJS.ProcessEnv = process.env): Promise<DiagnosticResult> {
  const [database, prisma, redis] = await Promise.all([
    checkDatabase(env),
    checkPrisma(env),
    checkRedis(env),
  ]);

  const googleOAuth = checkGoogleOAuth(env);
  const encryption = checkEncryption(env);
  const autonomousExecution = checkAutonomousExecution(env);

  return {
    database,
    prisma,
    redis,
    googleOAuth,
    encryption,
    autonomousExecution,
  };
}

/**
 * Formats the exact output required by the diagnostic specification:
 * 
 * Database:
 * READY / ERROR
 * 
 * Prisma:
 * READY / ERROR
 * 
 * Redis:
 * READY / ERROR
 * 
 * Google OAuth:
 * READY / ERROR
 * 
 * Encryption:
 * READY / ERROR
 * 
 * Autonomous execution:
 * ENABLED / DISABLED
 */
export function formatDoctorOutput(result: DiagnosticResult): string {
  return [
    `Database:\n${result.database}`,
    `Prisma:\n${result.prisma}`,
    `Redis:\n${result.redis}`,
    `Google OAuth:\n${result.googleOAuth}`,
    `Encryption:\n${result.encryption}`,
    `Autonomous execution:\n${result.autonomousExecution}`,
  ].join('\n\n');
}

// Execute when run directly via CLI (npm run doctor)
if (import.meta.url === `file://${process.argv[1]}`) {
  runDiagnosticChecks(process.env).then((result) => {
    console.log(formatDoctorOutput(result));
    process.exit(0);
  }).catch((err) => {
    console.error('Fatal doctor execution error:', err);
    process.exit(1);
  });
}
