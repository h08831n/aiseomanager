import { prisma } from '../../db/prisma';
import { SecretVault } from '../../security/secretVault';
import { GoogleIntegrationRepository } from '../../repositories/googleIntegrationRepository';
import { GoogleOAuthClient } from './providers/googleOAuthClient';
import { GoogleSearchConsoleProvider } from './providers/googleSearchConsoleProvider';
import { GoogleAnalytics4Provider } from './providers/googleAnalytics4Provider';
import { SearchConsoleProvider } from './providers/searchConsoleProvider';
import { AnalyticsProvider } from './providers/analyticsProvider';
import { MetricProvenanceSource } from '../provenance/provenanceTypes';

export type TelemetryReadinessState =
  | 'CONFIGURED'
  | 'CONNECTED'
  | 'LIVE_VERIFIED'
  | 'BLOCKED_EXTERNAL_CREDENTIALS'
  | 'INSUFFICIENT_TELEMETRY';

export interface TelemetryReadinessReport {
  website: string;
  websiteId?: string;
  readinessState: TelemetryReadinessState;
  isReadyForExperiment: boolean;
  oauth: {
    status: 'VALID' | 'REFRESHED' | 'INVALID_OR_REVOKED' | 'EXPIRED_NO_REFRESH' | 'DECRYPTION_ERROR' | 'MISSING';
    email?: string;
    scopes: string[];
    hasGscScope: boolean;
    hasGa4Scope: boolean;
    expiresAt?: string;
    details?: string;
  };
  gsc: {
    status: 'LIVE_VERIFIED' | 'INSUFFICIENT_TELEMETRY' | 'ACCESSIBLE_NO_SYNC' | 'INACCESSIBLE' | 'NOT_BOUND' | 'BLOCKED';
    propertyId?: string;
    propertyType?: string;
    permissionLevel?: string;
    latestSuccessfulSyncAt?: string;
    latestFactDate?: string;
    factCount: number;
    provenance: MetricProvenanceSource | 'NONE';
    isFresh: boolean;
    freshnessDays?: number;
  };
  ga4: {
    status: 'VERIFIED_AND_SYNCED' | 'CONNECTED_NO_SYNC' | 'INSUFFICIENT_TELEMETRY' | 'NOT_CONFIGURED' | 'BLOCKED';
    propertyId?: string;
    isConfigured: boolean;
    latestSuccessfulSyncAt?: string;
    latestFactDate?: string;
    factCount: number;
    provenance: MetricProvenanceSource | 'NONE';
  };
  baseline: {
    available: boolean;
    provenance: MetricProvenanceSource | 'INSUFFICIENT_TELEMETRY';
    clicks?: number | null;
    impressions?: number | null;
    avgPosition?: number | null;
    ctr?: number | null;
    organicSessions?: number | null;
  };
  blockingReasons: string[];
  evaluatedAt: string;
}

export interface TelemetryReadinessOptions {
  websiteUrl: string;
  targetUrl?: string;
  maxFreshnessDays?: number;
  verifyLiveGoogleApi?: boolean;
  gscProvider?: SearchConsoleProvider;
  ga4Provider?: AnalyticsProvider;
}

export class TelemetryReadinessGate {
  private gscProvider: SearchConsoleProvider;
  private ga4Provider: AnalyticsProvider;

  constructor(options?: { gscProvider?: SearchConsoleProvider; ga4Provider?: AnalyticsProvider }) {
    this.gscProvider = options?.gscProvider || new GoogleSearchConsoleProvider();
    this.ga4Provider = options?.ga4Provider || new GoogleAnalytics4Provider();
  }

  /**
   * Static helper to evaluate telemetry readiness for a website.
   */
  public static async evaluate(options: TelemetryReadinessOptions): Promise<TelemetryReadinessReport> {
    const gate = new TelemetryReadinessGate({
      gscProvider: options.gscProvider,
      ga4Provider: options.ga4Provider,
    });
    return gate.verifyReadiness(options);
  }

  /**
   * Evaluates the full production telemetry pipeline for the given website.
   */
  public async verifyReadiness(options: TelemetryReadinessOptions): Promise<TelemetryReadinessReport> {
    const evaluatedAt = new Date().toISOString();
    const blockingReasons: string[] = [];
    const maxFreshnessDays = options.maxFreshnessDays ?? 14;
    const verifyLiveGoogleApi = options.verifyLiveGoogleApi ?? true;

    let normalizedUrl = options.websiteUrl.trim();
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    let parsedDomain = '';
    try {
      const parsed = new URL(normalizedUrl);
      parsedDomain = parsed.hostname;
    } catch {
      parsedDomain = normalizedUrl.replace(/^https?:\/\//, '').split('/')[0];
    }

    // Default report skeleton
    const report: TelemetryReadinessReport = {
      website: normalizedUrl,
      websiteId: undefined,
      readinessState: 'BLOCKED_EXTERNAL_CREDENTIALS',
      isReadyForExperiment: false,
      oauth: {
        status: 'MISSING',
        scopes: [],
        hasGscScope: false,
        hasGa4Scope: false,
      },
      gsc: {
        status: 'BLOCKED',
        factCount: 0,
        provenance: 'NONE',
        isFresh: false,
      },
      ga4: {
        status: 'NOT_CONFIGURED',
        isConfigured: false,
        factCount: 0,
        provenance: 'NONE',
      },
      baseline: {
        available: false,
        provenance: 'INSUFFICIENT_TELEMETRY',
        clicks: null,
        impressions: null,
        avgPosition: null,
        ctr: null,
        organicSessions: null,
      },
      blockingReasons: [],
      evaluatedAt,
    };

    // 1. Resolve Website in database
    const website = await prisma.website.findFirst({
      where: {
        OR: [
          { domain: parsedDomain },
          { productionUrl: { contains: parsedDomain } },
          { domain: parsedDomain.replace(/^www\./, '') },
        ],
      },
    });

    if (!website) {
      report.readinessState = 'BLOCKED_EXTERNAL_CREDENTIALS';
      report.blockingReasons.push(
        `Website '${normalizedUrl}' (domain: ${parsedDomain}) is not registered in the database. No external telemetry configured.`
      );
      return report;
    }

    report.websiteId = website.id;

    // 2. Check GSC Integration Existence & Credentials
    const gscIntegration = await prisma.integration.findUnique({
      where: {
        websiteId_provider: {
          websiteId: website.id,
          provider: 'GSC',
        },
      },
    });

    if (!gscIntegration) {
      report.oauth.status = 'MISSING';
      report.gsc.status = 'BLOCKED';
      report.readinessState = 'BLOCKED_EXTERNAL_CREDENTIALS';
      report.blockingReasons.push(
        `Google Search Console integration row missing for website '${website.domain}' (${website.id}).`
      );
      return report;
    }

    if (!gscIntegration.encryptedCredentials) {
      report.oauth.status = 'MISSING';
      report.gsc.status = 'BLOCKED';
      report.readinessState = 'BLOCKED_EXTERNAL_CREDENTIALS';
      report.blockingReasons.push(
        `Google Search Console credentials not provisioned (encryptedCredentials is null) for website '${website.domain}'.`
      );
      return report;
    }

    // 3. Token Decryption & Validity Check (incorporating automatic refresh flow)
    let validAccessToken: string | null = null;
    let tokenRefreshed = false;

    // Inspect stored expiration before refresh to detect if refresh occurred
    let storedExpiry: Date | null = null;
    try {
      const encryptedObj = JSON.parse(gscIntegration.encryptedCredentials);
      const decryptedStr = SecretVault.decrypt(encryptedObj);
      const payload = JSON.parse(decryptedStr);
      storedExpiry = payload.expiresAt ? new Date(payload.expiresAt) : null;
      report.oauth.email = payload.email || gscIntegration.connectedAccount || undefined;
      report.oauth.scopes = payload.scopes || gscIntegration.grantedScopes || [];
      report.oauth.hasGscScope = report.oauth.scopes.some(
        (s) => s.includes('webmasters.readonly') || s.includes('auth/webmasters')
      );
      report.oauth.hasGa4Scope = report.oauth.scopes.some(
        (s) => s.includes('analytics.readonly') || s.includes('auth/analytics')
      );
    } catch (err: any) {
      report.oauth.status = 'DECRYPTION_ERROR';
      report.readinessState = 'BLOCKED_EXTERNAL_CREDENTIALS';
      report.blockingReasons.push(`Failed to decrypt Google credentials: ${err.message}`);
      return report;
    }

    try {
      const tokenResult = await GoogleIntegrationRepository.getValidAccessToken(website.id, 'GSC');
      validAccessToken = tokenResult.accessToken;
      report.oauth.email = tokenResult.email || report.oauth.email;
      report.oauth.scopes = tokenResult.scopes || report.oauth.scopes;

      if (storedExpiry && storedExpiry.getTime() - Date.now() < 5 * 60 * 1000) {
        tokenRefreshed = true;
        report.oauth.status = 'REFRESHED';
        report.oauth.details = 'Expired/near-expired token was successfully refreshed via GoogleOAuthClient.';
      } else {
        report.oauth.status = 'VALID';
      }
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes('TOKEN_REVOKED_OR_INVALID') || errMsg.includes('invalid_grant')) {
        report.oauth.status = 'INVALID_OR_REVOKED';
        report.readinessState = 'BLOCKED_EXTERNAL_CREDENTIALS';
        report.blockingReasons.push(`Google OAuth refresh token is revoked or invalid: ${errMsg}`);
      } else if (errMsg.includes('CREDENTIAL_DECRYPTION_ERROR')) {
        report.oauth.status = 'DECRYPTION_ERROR';
        report.readinessState = 'BLOCKED_EXTERNAL_CREDENTIALS';
        report.blockingReasons.push(`Credential decryption error: ${errMsg}`);
      } else {
        report.oauth.status = 'INVALID_OR_REVOKED';
        report.readinessState = 'BLOCKED_EXTERNAL_CREDENTIALS';
        report.blockingReasons.push(`Google token retrieval failed: ${errMsg}`);
      }
      return report;
    }

    if (!validAccessToken) {
      report.readinessState = 'BLOCKED_EXTERNAL_CREDENTIALS';
      report.blockingReasons.push('No usable Google access token could be derived.');
      return report;
    }

    // 4. Verify GSC Property Binding & Real API Access
    const gscBinding = await prisma.searchConsolePropertyBinding.findUnique({
      where: { websiteId: website.id },
    });

    if (!gscBinding) {
      report.gsc.status = 'NOT_BOUND';
      report.readinessState = 'CONFIGURED';
      report.isReadyForExperiment = false;
      report.blockingReasons.push(
        `No Search Console property bound to website '${website.domain}'. Run property discovery to bind a verified property.`
      );
      return report;
    } else {
      report.gsc.propertyId = gscBinding.providerPropertyId;
      report.gsc.propertyType = gscBinding.providerPropertyType;
      report.gsc.permissionLevel = gscBinding.permissionLevel || undefined;

      // Verify property access with Google API
      if (verifyLiveGoogleApi) {
        try {
          const access = await this.gscProvider.verifyPropertyAccess(
            validAccessToken,
            gscBinding.providerPropertyId
          );
          if (!access.accessible) {
            report.gsc.status = 'INACCESSIBLE';
            report.readinessState = 'BLOCKED_EXTERNAL_CREDENTIALS';
            report.isReadyForExperiment = false;
            report.blockingReasons.push(
              `GSC property '${gscBinding.providerPropertyId}' is inaccessible for account '${report.oauth.email || 'unknown'}'. Reason: ${access.error || 'Not in accessible properties list'}`
            );
            return report;
          } else {
            report.gsc.permissionLevel = access.permissionLevel || report.gsc.permissionLevel;
          }
        } catch (apiErr: any) {
          report.gsc.status = 'INACCESSIBLE';
          report.readinessState = 'BLOCKED_EXTERNAL_CREDENTIALS';
          report.isReadyForExperiment = false;
          report.blockingReasons.push(
            `Live Google Search Console API verification call failed: ${apiErr.message}`
          );
          return report;
        }
      }
    }

    // 5. Verify Successful Sync Runs & Persisted Facts
    const lastCompletedSync = await prisma.integrationSyncRun.findFirst({
      where: {
        websiteId: website.id,
        provider: 'GSC',
        status: 'COMPLETED',
      },
      orderBy: { completedAt: 'desc' },
    });

    if (lastCompletedSync) {
      report.gsc.latestSuccessfulSyncAt = lastCompletedSync.completedAt
        ? lastCompletedSync.completedAt.toISOString()
        : undefined;
    } else {
      report.blockingReasons.push(
        `No completed GSC sync run recorded. Real external sync job has never finished for website '${website.domain}'.`
      );
    }

    const gscFactCount = await prisma.gscSearchAnalyticsFact.count({
      where: {
        websiteId: website.id,
        provenance: 'GOOGLE_SEARCH_CONSOLE',
      },
    });

    report.gsc.factCount = gscFactCount;
    report.gsc.provenance = gscFactCount > 0 ? 'GOOGLE_SEARCH_CONSOLE' : 'NONE';

    if (gscFactCount === 0) {
      report.gsc.status = 'INSUFFICIENT_TELEMETRY';
      report.blockingReasons.push(
        `Zero persisted GSC facts exist with GOOGLE_SEARCH_CONSOLE provenance for website '${website.domain}'.`
      );
    } else {
      const latestFact = await prisma.gscSearchAnalyticsFact.findFirst({
        where: {
          websiteId: website.id,
          provenance: 'GOOGLE_SEARCH_CONSOLE',
        },
        orderBy: { date: 'desc' },
      });

      if (latestFact && latestFact.date) {
        report.gsc.latestFactDate = latestFact.date.toISOString().split('T')[0];
        const ageMs = Date.now() - latestFact.date.getTime();
        const freshnessDays = Math.max(0, Math.floor(ageMs / (1000 * 60 * 60 * 24)));
        report.gsc.freshnessDays = freshnessDays;

        if (freshnessDays <= maxFreshnessDays) {
          report.gsc.isFresh = true;
          report.gsc.status = 'LIVE_VERIFIED';
        } else {
          report.gsc.isFresh = false;
          report.gsc.status = 'INSUFFICIENT_TELEMETRY';
          report.blockingReasons.push(
            `Persisted GSC telemetry is stale (latest fact date: ${report.gsc.latestFactDate}, ${freshnessDays} days old > ${maxFreshnessDays} day limit). Fresh sync required.`
          );
        }
      }
    }

    // 6. Verify GA4 Integration (Absence is reported explicitly; NEVER synthetic)
    const ga4Integration = await prisma.integration.findUnique({
      where: {
        websiteId_provider: {
          websiteId: website.id,
          provider: 'GA4',
        },
      },
    });

    if (!ga4Integration || ga4Integration.status === 'NOT_CONFIGURED') {
      report.ga4.status = 'NOT_CONFIGURED';
      report.ga4.isConfigured = false;
      report.ga4.provenance = 'NONE';
      // GA4 is optional if GSC provides core SEO telemetry, but its absence is documented explicitly
    } else if (ga4Integration.status === 'CONNECTED') {
      report.ga4.isConfigured = true;
      const ga4Binding = await prisma.ga4PropertyBinding.findFirst({
        where: { websiteId: website.id },
      });

      if (ga4Binding) {
        report.ga4.propertyId = ga4Binding.providerPropertyId;
      }

      const lastGa4Sync = await prisma.integrationSyncRun.findFirst({
        where: {
          websiteId: website.id,
          provider: 'GA4',
          status: 'COMPLETED',
        },
        orderBy: { completedAt: 'desc' },
      });

      if (lastGa4Sync && lastGa4Sync.completedAt) {
        report.ga4.latestSuccessfulSyncAt = lastGa4Sync.completedAt.toISOString();
      }

      const ga4FactCount = await prisma.ga4LandingPageDaily.count({
        where: {
          websiteId: website.id,
          provenance: 'GOOGLE_ANALYTICS',
        },
      });

      report.ga4.factCount = ga4FactCount;
      report.ga4.provenance = ga4FactCount > 0 ? 'GOOGLE_ANALYTICS' : 'NONE';

      if (lastGa4Sync && ga4FactCount > 0) {
        report.ga4.status = 'VERIFIED_AND_SYNCED';
        const latestGa4 = await prisma.ga4LandingPageDaily.findFirst({
          where: { websiteId: website.id, provenance: 'GOOGLE_ANALYTICS' },
          orderBy: { date: 'desc' },
        });
        if (latestGa4?.date) {
          report.ga4.latestFactDate = latestGa4.date.toISOString().split('T')[0];
        }
      } else {
        report.ga4.status = 'INSUFFICIENT_TELEMETRY';
        report.blockingReasons.push(
          `GA4 is configured for website '${website.domain}' but has no completed sync run or 0 persisted facts.`
        );
      }
    }

    // 7. Verify Baseline Availability from Persisted Telemetry
    const targetUrl = options.targetUrl || website.productionUrl || `https://${website.domain}`;
    const baselineGscFacts = await prisma.gscSearchAnalyticsFact.findMany({
      where: {
        websiteId: website.id,
        provenance: 'GOOGLE_SEARCH_CONSOLE',
      },
      orderBy: { date: 'desc' },
      take: 28,
    });

    if (baselineGscFacts.length > 0) {
      report.baseline.available = true;
      report.baseline.provenance = 'GOOGLE_SEARCH_CONSOLE';
      const totalClicks = baselineGscFacts.reduce((sum, f) => sum + f.clicks, 0);
      const totalImpressions = baselineGscFacts.reduce((sum, f) => sum + f.impressions, 0);
      report.baseline.clicks = totalClicks;
      report.baseline.impressions = totalImpressions;
      report.baseline.ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
      const positions = baselineGscFacts.map((f) => f.position).filter((p) => p > 0);
      report.baseline.avgPosition =
        positions.length > 0 ? positions.reduce((a, b) => a + b, 0) / positions.length : null;

      if (report.ga4.status === 'VERIFIED_AND_SYNCED') {
        const ga4Facts = await prisma.ga4LandingPageDaily.findMany({
          where: {
            websiteId: website.id,
            provenance: 'GOOGLE_ANALYTICS',
            channelGroup: 'Organic Search',
          },
          take: 28,
        });
        if (ga4Facts.length > 0) {
          report.baseline.organicSessions = ga4Facts.reduce((sum, f) => sum + f.sessions, 0);
        }
      }
    } else {
      report.baseline.available = false;
      report.baseline.provenance = 'INSUFFICIENT_TELEMETRY';
      report.blockingReasons.push(
        `Experiment engine cannot load baseline metrics from persisted telemetry for target URL '${targetUrl}'.`
      );
    }

    // 8. Determine Final Readiness State
    const hasCredentialBlock = report.blockingReasons.some(
      (r) =>
        r.includes('credentials') ||
        r.includes('token') ||
        r.includes('inaccessible') ||
        r.includes('not registered') ||
        r.includes('permission') ||
        r.includes('revoked')
    );

    const hasTelemetryBlock = report.blockingReasons.some(
      (r) =>
        r.includes('sync run') ||
        r.includes('Zero persisted') ||
        r.includes('stale') ||
        r.includes('baseline') ||
        r.includes('INSUFFICIENT_TELEMETRY')
    );

    if (hasCredentialBlock) {
      report.readinessState = 'BLOCKED_EXTERNAL_CREDENTIALS';
      report.isReadyForExperiment = false;
    } else if (hasTelemetryBlock) {
      report.readinessState = 'INSUFFICIENT_TELEMETRY';
      report.isReadyForExperiment = false;
    } else if (!gscBinding) {
      report.readinessState = 'CONNECTED';
      report.isReadyForExperiment = false;
    } else if (report.blockingReasons.length === 0 && report.gsc.isFresh && report.baseline.available) {
      report.readinessState = 'LIVE_VERIFIED';
      report.isReadyForExperiment = true;
    } else {
      report.readinessState = 'CONNECTED';
      report.isReadyForExperiment = false;
    }

    return report;
  }
}
