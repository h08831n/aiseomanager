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
    };
    ga4: {
      status: 'CONNECTED' | 'DISCONNECTED';
      activeConnectionsCount: number;
      propertyId?: string;
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

    // 2. Evaluate GA4 Integration
    let ga4Status: 'CONNECTED' | 'DISCONNECTED' = 'DISCONNECTED';
    let ga4Count = 0;
    let ga4PropertyId: string | undefined;

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
        const first = ga4Integrations[0];

        if (options.websiteId) {
          try {
            const binding = await prisma.ga4PropertyBinding.findFirst({
              where: { websiteId: options.websiteId },
            });
            if (binding?.providerPropertyId) {
              ga4PropertyId = binding.providerPropertyId;
            }
          } catch {}
        }

        if (!ga4PropertyId) {
          ga4PropertyId = first?.ga4Bindings?.[0]?.providerPropertyId || first?.accountIdentifier || undefined;
        }
      }
    } catch {
      ga4Status = 'DISCONNECTED';
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
        },
        ga4: {
          status: ga4Status,
          activeConnectionsCount: ga4Count,
          propertyId: ga4PropertyId,
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
