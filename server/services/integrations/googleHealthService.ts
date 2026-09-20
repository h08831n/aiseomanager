import { prisma } from '../../db/prisma';
import { checkDatabaseReadiness } from '../../db/databaseReadiness';
import { SecretVault } from '../../security/secretVault';
import { IntegrationProvider, IntegrationStatus } from '@prisma/client';

export interface GoogleIntegrationHealthResponse {
  GSC: 'CONNECTED' | 'DISCONNECTED';
  GA4: 'CONNECTED' | 'DISCONNECTED';
  Database: 'READY' | 'ERROR';
  Encryption: 'READY' | 'ERROR';
  details: {
    gsc: {
      status: 'CONNECTED' | 'DISCONNECTED';
      activeConnectionsCount: number;
      accountEmail?: string;
      isLiveVerified: boolean;
      liveStatus: 'CONFIGURED' | 'CONNECTED' | 'LIVE_VERIFIED' | 'BLOCKED_EXTERNAL_CREDENTIALS' | 'INSUFFICIENT_TELEMETRY';
      telemetryFactCount?: number;
      latestFactDate?: string;
      lastSyncAt?: string;
    };
    ga4: {
      status: 'CONNECTED' | 'DISCONNECTED';
      activeConnectionsCount: number;
      propertyId?: string;
      isLiveVerified: boolean;
      liveStatus: 'CONFIGURED' | 'CONNECTED' | 'LIVE_VERIFIED' | 'BLOCKED_EXTERNAL_CREDENTIALS' | 'INSUFFICIENT_TELEMETRY' | 'NOT_CONFIGURED';
      telemetryFactCount?: number;
      latestFactDate?: string;
      lastSyncAt?: string;
    };
    database: {
      status: 'READY' | 'ERROR';
      connection: 'READY' | 'ERROR';
      migrations: 'READY' | 'ERROR';
      responseTimeMs?: number;
      error?: string;
    };
    encryption: {
      status: 'READY' | 'ERROR';
      keyConfigured: boolean;
      algorithm: string;
      error?: string;
    };
  };
  timestamp: string;
}

export class GoogleHealthService {
  /**
   * Evaluates health of Google integrations (GSC, GA4), Database, and Encryption subsystem.
   */
  public static async getHealth(options: { websiteId?: string } = {}): Promise<GoogleIntegrationHealthResponse> {
    // 1. Evaluate GSC Integration
    let gscStatus: 'CONNECTED' | 'DISCONNECTED' = 'DISCONNECTED';
    let gscCount = 0;
    let gscAccountEmail: string | undefined;

    try {
      const gscWhere: any = {
        provider: IntegrationProvider.GSC,
        status: IntegrationStatus.CONNECTED,
      };
      if (options.websiteId) {
        gscWhere.websiteId = options.websiteId;
      }

      const gscIntegrations = await prisma.integration.findMany({
        where: gscWhere,
        include: { gscBindings: true },
        take: 5,
      });

      if (gscIntegrations.length > 0) {
        gscStatus = 'CONNECTED';
        gscCount = gscIntegrations.length;
        const first = gscIntegrations[0];
        gscAccountEmail = first?.accountIdentifier || first?.connectedAccount || undefined;
      }
    } catch {
      gscStatus = 'DISCONNECTED';
    }

    let gscIsLiveVerified = false;
    let gscLiveStatus: 'CONFIGURED' | 'CONNECTED' | 'LIVE_VERIFIED' | 'BLOCKED_EXTERNAL_CREDENTIALS' | 'INSUFFICIENT_TELEMETRY' =
      gscCount > 0 ? 'CONNECTED' : 'BLOCKED_EXTERNAL_CREDENTIALS';
    let gscFactCount: number | undefined;
    let gscLatestFactDate: string | undefined;
    let gscLastSyncAt: string | undefined;

    if (options.websiteId && gscStatus === 'CONNECTED') {
      try {
        const lastSync = await prisma.integrationSyncRun.findFirst({
          where: { websiteId: options.websiteId, provider: 'GSC', status: 'COMPLETED' },
          orderBy: { completedAt: 'desc' },
        });
        if (lastSync?.completedAt) {
          gscLastSyncAt = lastSync.completedAt.toISOString();
        }

        const count = await prisma.gscSearchAnalyticsFact.count({
          where: { websiteId: options.websiteId, provenance: 'GOOGLE_SEARCH_CONSOLE' },
        });
        gscFactCount = count;

        const latestFact = await prisma.gscSearchAnalyticsFact.findFirst({
          where: { websiteId: options.websiteId, provenance: 'GOOGLE_SEARCH_CONSOLE' },
          orderBy: { date: 'desc' },
        });

        if (latestFact?.date) {
          gscLatestFactDate = latestFact.date.toISOString().split('T')[0];
          const ageDays = Math.floor((Date.now() - latestFact.date.getTime()) / (1000 * 60 * 60 * 24));
          if (lastSync && count > 0 && ageDays <= 14) {
            gscIsLiveVerified = true;
            gscLiveStatus = 'LIVE_VERIFIED';
          } else {
            gscLiveStatus = 'INSUFFICIENT_TELEMETRY';
          }
        } else {
          gscLiveStatus = 'INSUFFICIENT_TELEMETRY';
        }
      } catch {
        gscLiveStatus = 'INSUFFICIENT_TELEMETRY';
      }
    }

    // 2. Evaluate GA4 Integration
    let ga4Status: 'CONNECTED' | 'DISCONNECTED' = 'DISCONNECTED';
    let ga4Count = 0;
    let ga4PropertyId: string | undefined;
    let ga4IsLiveVerified = false;
    let ga4LiveStatus: 'CONFIGURED' | 'CONNECTED' | 'LIVE_VERIFIED' | 'BLOCKED_EXTERNAL_CREDENTIALS' | 'INSUFFICIENT_TELEMETRY' | 'NOT_CONFIGURED' = 'NOT_CONFIGURED';
    let ga4FactCount: number | undefined;
    let ga4LatestFactDate: string | undefined;
    let ga4LastSyncAt: string | undefined;

    try {
      const ga4Where: any = {
        provider: IntegrationProvider.GA4,
        status: IntegrationStatus.CONNECTED,
      };
      if (options.websiteId) {
        ga4Where.websiteId = options.websiteId;
      }

      const ga4Integrations = await prisma.integration.findMany({
        where: ga4Where,
        include: { ga4Bindings: true },
        take: 5,
      });

      if (ga4Integrations.length > 0) {
        ga4Status = 'CONNECTED';
        ga4Count = ga4Integrations.length;
        ga4LiveStatus = 'CONNECTED';
        const first = ga4Integrations[0];

        if (options.websiteId) {
          try {
            const binding = await prisma.ga4PropertyBinding.findFirst({
              where: { websiteId: options.websiteId },
            });
            if (binding?.providerPropertyId) {
              ga4PropertyId = binding.providerPropertyId;
            }

            const lastGa4Sync = await prisma.integrationSyncRun.findFirst({
              where: { websiteId: options.websiteId, provider: 'GA4', status: 'COMPLETED' },
              orderBy: { completedAt: 'desc' },
            });
            if (lastGa4Sync?.completedAt) {
              ga4LastSyncAt = lastGa4Sync.completedAt.toISOString();
            }

            const count = await prisma.ga4LandingPageDaily.count({
              where: { websiteId: options.websiteId, provenance: 'GOOGLE_ANALYTICS' },
            });
            ga4FactCount = count;

            const latestGa4Fact = await prisma.ga4LandingPageDaily.findFirst({
              where: { websiteId: options.websiteId, provenance: 'GOOGLE_ANALYTICS' },
              orderBy: { date: 'desc' },
            });

            if (latestGa4Fact?.date) {
              ga4LatestFactDate = latestGa4Fact.date.toISOString().split('T')[0];
              if (lastGa4Sync && count > 0) {
                ga4IsLiveVerified = true;
                ga4LiveStatus = 'LIVE_VERIFIED';
              } else {
                ga4LiveStatus = 'INSUFFICIENT_TELEMETRY';
              }
            } else {
              ga4LiveStatus = 'INSUFFICIENT_TELEMETRY';
            }
          } catch {
            ga4LiveStatus = 'INSUFFICIENT_TELEMETRY';
          }
        }

        if (!ga4PropertyId) {
          ga4PropertyId = first?.ga4Bindings?.[0]?.providerPropertyId || first?.accountIdentifier || undefined;
        }
      }
    } catch {
      ga4Status = 'DISCONNECTED';
      ga4LiveStatus = 'NOT_CONFIGURED';
    }

    // 3. Evaluate Database Readiness
    let dbStatus: 'READY' | 'ERROR' = 'ERROR';
    let dbConnection: 'READY' | 'ERROR' = 'ERROR';
    let dbMigrations: 'READY' | 'ERROR' = 'ERROR';
    let dbResponseTimeMs: number | undefined;
    let dbError: string | undefined;

    try {
      const dbResult = await checkDatabaseReadiness({ timeoutMs: 3000, exitOnFailure: false });
      dbStatus = dbResult.status;
      dbConnection = dbResult.connection;
      dbMigrations = dbResult.migrations;
      dbResponseTimeMs = dbResult.details.responseTimeMs;
      dbError = dbResult.details.error;
    } catch (err: any) {
      dbStatus = 'ERROR';
      dbError = err?.message || String(err);
    }

    // 4. Evaluate Encryption Subsystem
    let encStatus: 'READY' | 'ERROR' = 'ERROR';
    const isKeyConfigured = SecretVault.isKeyConfigured();
    let encError: string | undefined;

    if (!isKeyConfigured) {
      encStatus = 'ERROR';
      encError = 'ENCRYPTION_MASTER_KEY is not configured or is empty.';
    } else {
      try {
        const testPayload = 'health-check-entropy-probe-' + Date.now();
        const encrypted = SecretVault.encrypt(testPayload);
        const decrypted = SecretVault.decrypt(encrypted);
        if (decrypted === testPayload) {
          encStatus = 'READY';
        } else {
          encStatus = 'ERROR';
          encError = 'Decrypted payload mismatch in encryption health test.';
        }
      } catch (err: any) {
        encStatus = 'ERROR';
        encError = err?.message || String(err);
      }
    }

    return {
      GSC: gscStatus,
      GA4: ga4Status,
      Database: dbStatus,
      Encryption: encStatus,
      details: {
        gsc: {
          status: gscStatus,
          activeConnectionsCount: gscCount,
          accountEmail: gscAccountEmail,
          isLiveVerified: gscIsLiveVerified,
          liveStatus: gscLiveStatus,
          telemetryFactCount: gscFactCount,
          latestFactDate: gscLatestFactDate,
          lastSyncAt: gscLastSyncAt,
        },
        ga4: {
          status: ga4Status,
          activeConnectionsCount: ga4Count,
          propertyId: ga4PropertyId,
          isLiveVerified: ga4IsLiveVerified,
          liveStatus: ga4LiveStatus,
          telemetryFactCount: ga4FactCount,
          latestFactDate: ga4LatestFactDate,
          lastSyncAt: ga4LastSyncAt,
        },
        database: {
          status: dbStatus,
          connection: dbConnection,
          migrations: dbMigrations,
          responseTimeMs: dbResponseTimeMs,
          error: dbError,
        },
        encryption: {
          status: encStatus,
          keyConfigured: isKeyConfigured,
          algorithm: 'AES-256-GCM',
          error: encError,
        },
      },
      timestamp: new Date().toISOString(),
    };
  }
}
