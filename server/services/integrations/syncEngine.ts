import { prisma } from '../../db/prisma';
import { GoogleIntegrationRepository } from '../../repositories/googleIntegrationRepository';
import { AnalyticsRepository } from '../../repositories/analyticsRepository';
import { GoogleSearchConsoleProvider } from './providers/googleSearchConsoleProvider';
import { GoogleAnalytics4Provider } from './providers/googleAnalytics4Provider';
import { SignalDetectionEngine } from '../analytics/signalDetectionEngine';

export interface SyncOptions {
  websiteId: string;
  startDate?: string; // YYYY-MM-DD. Defaults to 28 days ago
  endDate?: string; // YYYY-MM-DD. Defaults to yesterday
  syncType?: 'INITIAL_BACKFILL' | 'INCREMENTAL_SYNC' | 'MANUAL_RESYNC';
  correlationId?: string;
}

export class IntegrationSyncEngine {
  private gscProvider: GoogleSearchConsoleProvider;
  private ga4Provider: GoogleAnalytics4Provider;

  constructor(
    gscProvider = new GoogleSearchConsoleProvider(),
    ga4Provider = new GoogleAnalytics4Provider()
  ) {
    this.gscProvider = gscProvider;
    this.ga4Provider = ga4Provider;
  }

  /**
   * Orchestrates synchronization of Search Console search analytics facts.
   */
  public async syncSearchConsole(options: SyncOptions): Promise<{
    syncRunId: string;
    rowsFetched: number;
    rowsUpserted: number;
    status: string;
  }> {
    const { websiteId } = options;

    const gscBinding = await prisma.searchConsolePropertyBinding.findUnique({
      where: { websiteId },
      include: { integration: true },
    });

    if (!gscBinding) {
      throw new Error(`GSC_NOT_CONFIGURED: No Search Console property bound for website ${websiteId}`);
    }

    const { accessToken } = await GoogleIntegrationRepository.getValidAccessToken(websiteId, 'GSC');

    // Calculate dates: Default to past 28 days ending 3 days ago (GSC data delay)
    const end = options.endDate
      ? new Date(options.endDate)
      : new Date(Date.now() - 3 * 86400000);
    const start = options.startDate
      ? new Date(options.startDate)
      : new Date(end.getTime() - 27 * 86400000);

    const startDateStr = start.toISOString().split('T')[0];
    const endDateStr = end.toISOString().split('T')[0];

    // Create sync run record
    const syncRun = await prisma.integrationSyncRun.create({
      data: {
        websiteId,
        integrationId: gscBinding.integrationId,
        provider: 'GSC',
        dataset: 'SEARCH_ANALYTICS',
        syncType: options.syncType || 'INCREMENTAL_SYNC',
        requestedStartDate: start,
        requestedEndDate: end,
        status: 'RUNNING',
        startedAt: new Date(),
        correlationId: options.correlationId,
      },
    });

    let totalFetched = 0;
    let totalUpserted = 0;

    try {
      // 1. Fetch Authoritative SITE_DAILY facts (Grain = SITE_DAILY)
      const siteResult = await this.gscProvider.querySearchAnalytics(
        accessToken,
        gscBinding.providerPropertyId,
        {
          startDate: startDateStr,
          endDate: endDateStr,
          dimensions: ['date'],
          dataState: 'final',
        }
      );

      const siteFacts = siteResult.rows.map((row) => ({
        websiteId,
        syncRunId: syncRun.id,
        providerPropertyId: gscBinding.providerPropertyId,
        date: new Date(row.date || startDateStr),
        grain: 'SITE_DAILY' as const,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
        provenance: 'GOOGLE_SEARCH_CONSOLE' as const,
      }));

      const siteUpserted = await AnalyticsRepository.upsertGscFacts(siteFacts);
      totalFetched += siteResult.rows.length;
      totalUpserted += siteUpserted;

      // 2. Fetch Multi-Dimensional Breakdown (PAGE_QUERY_DAILY) with pagination
      let startRow = 0;
      const batchLimit = 25000;
      let hasMore = true;

      while (hasMore) {
        const queryResult = await this.gscProvider.querySearchAnalytics(
          accessToken,
          gscBinding.providerPropertyId,
          {
            startDate: startDateStr,
            endDate: endDateStr,
            dimensions: ['page', 'query', 'date', 'country', 'device'],
            dataState: 'final',
            rowLimit: batchLimit,
            startRow,
          }
        );

        totalFetched += queryResult.rows.length;

        if (queryResult.rows.length > 0) {
          // Discover new URLs and insert placeholders in url_identities if not discovered yet
          const pagesInBatch = Array.from(
            new Set(queryResult.rows.map((r) => r.page).filter((p): p is string => Boolean(p)))
          );
          
          await this.discoverGscUrls(websiteId, pagesInBatch);

          const facts = queryResult.rows.map((row) => ({
            websiteId,
            syncRunId: syncRun.id,
            providerPropertyId: gscBinding.providerPropertyId,
            date: new Date(row.date || startDateStr),
            grain: 'PAGE_QUERY_DAILY' as const,
            pageUrl: row.page || '',
            query: row.query || '',
            country: row.country || 'GLOBAL',
            device: row.device || 'ALL',
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
            provenance: 'GOOGLE_SEARCH_CONSOLE' as const,
          }));

          const upserted = await AnalyticsRepository.upsertGscFacts(facts);
          totalUpserted += upserted;
        }

        hasMore = queryResult.hasMore && queryResult.rows.length === batchLimit;
        if (hasMore && queryResult.nextStartRow) {
          startRow = queryResult.nextStartRow;
        } else {
          hasMore = false;
        }
      }

      await prisma.integrationSyncRun.update({
        where: { id: syncRun.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          rowsFetched: totalFetched,
          rowsUpserted: totalUpserted,
        },
      });

      await prisma.integration.update({
        where: { id: gscBinding.integrationId },
        data: {
          lastSyncAt: new Date(),
          lastSuccessfulApiCallAt: new Date(),
          lastError: null,
        },
      });

      // Automatically evaluate signals after sync
      try {
        await SignalDetectionEngine.evaluateSignals({
          websiteId,
          currentStart: start,
          currentEnd: end,
        });
      } catch {
        // Non-blocking for sync completion
      }

      return {
        syncRunId: syncRun.id,
        rowsFetched: totalFetched,
        rowsUpserted: totalUpserted,
        status: 'COMPLETED',
      };
    } catch (err: any) {
      await prisma.integrationSyncRun.update({
        where: { id: syncRun.id },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          errorMessage: err.message,
          errorCode: err.name || 'SYNC_ERROR',
        },
      });
      throw err;
    }
  }

  /**
   * Orchestrates synchronization of GA4 landing page and traffic channel facts.
   */
  public async syncGoogleAnalytics4(options: SyncOptions): Promise<{
    syncRunId: string;
    rowsFetched: number;
    rowsUpserted: number;
    status: string;
  }> {
    const { websiteId } = options;

    const ga4Binding = await prisma.ga4PropertyBinding.findUnique({
      where: { websiteId },
      include: { integration: true },
    });

    if (!ga4Binding) {
      throw new Error(`GA4_NOT_CONFIGURED: No GA4 property bound for website ${websiteId}`);
    }

    const { accessToken } = await GoogleIntegrationRepository.getValidAccessToken(websiteId, 'GA4');

    const end = options.endDate
      ? new Date(options.endDate)
      : new Date(Date.now() - 86400000);
    const start = options.startDate
      ? new Date(options.startDate)
      : new Date(end.getTime() - 27 * 86400000);

    const startDateStr = start.toISOString().split('T')[0];
    const endDateStr = end.toISOString().split('T')[0];

    const syncRun = await prisma.integrationSyncRun.create({
      data: {
        websiteId,
        integrationId: ga4Binding.integrationId,
        provider: 'GA4',
        dataset: 'LANDING_PAGE_DAILY',
        syncType: options.syncType || 'INCREMENTAL_SYNC',
        requestedStartDate: start,
        requestedEndDate: end,
        status: 'RUNNING',
        startedAt: new Date(),
        correlationId: options.correlationId,
      },
    });

    let totalFetched = 0;
    let totalUpserted = 0;

    try {
      const website = await prisma.website.findUnique({ where: { id: websiteId } });
      const baseDomain = website ? website.domain : '';

      // 1. Fetch Landing Page Daily Report with full pagination
      let landingOffset = 0;
      const batchLimit = 10000;
      let hasMoreLanding = true;

      while (hasMoreLanding) {
        const landingPageReport = await this.ga4Provider.runReport(
          accessToken,
          ga4Binding.providerPropertyId,
          {
            startDate: startDateStr,
            endDate: endDateStr,
            dimensions: ['date', 'landingPagePlusQueryString', 'sessionDefaultChannelGroup'],
            metrics: [
              'sessions',
              'engagedSessions',
              'activeUsers',
              'newUsers',
              'keyEvents',
              'totalRevenue',
            ],
            limit: batchLimit,
            offset: landingOffset,
          }
        );

        totalFetched += landingPageReport.rows.length;

        const landingFacts = landingPageReport.rows.map((r) => {
          const dateVal = r.dimensionValues[0];
          const rawPath = r.dimensionValues[1] || '/';
          const channelGroup = r.dimensionValues[2] || 'Unassigned';

          // Format date string YYYYMMDD to Date
          let dateObj = start;
          if (dateVal && dateVal.length === 8) {
            const y = parseInt(dateVal.substring(0, 4), 10);
            const m = parseInt(dateVal.substring(4, 6), 10) - 1;
            const d = parseInt(dateVal.substring(6, 8), 10);
            dateObj = new Date(Date.UTC(y, m, d));
          }

          // Normalize landing page url
          let normalizedLanding = rawPath;
          if (rawPath.startsWith('/') && baseDomain) {
            normalizedLanding = `https://${baseDomain}${rawPath}`;
          }

          return {
            websiteId,
            syncRunId: syncRun.id,
            providerPropertyId: ga4Binding.providerPropertyId,
            date: dateObj,
            landingPageUrl: normalizedLanding,
            channelGroup,
            sessions: Math.round(r.metricValues[0] || 0),
            engagedSessions: Math.round(r.metricValues[1] || 0),
            activeUsers: Math.round(r.metricValues[2] || 0),
            newUsers: Math.round(r.metricValues[3] || 0),
            keyEvents: Math.round(r.metricValues[4] || 0),
            totalRevenue: r.metricValues[5] || 0,
            currency: ga4Binding.currencyCode,
          };
        });

        if (landingFacts.length > 0) {
          const landingUpserted = await AnalyticsRepository.upsertGa4LandingPages(landingFacts);
          totalUpserted += landingUpserted;
        }

        hasMoreLanding = landingPageReport.hasMore && landingPageReport.nextOffset !== undefined;
        if (hasMoreLanding && landingPageReport.nextOffset) {
          landingOffset = landingPageReport.nextOffset;
        } else {
          hasMoreLanding = false;
        }
      }

      // 2. Fetch Channel Breakdown Daily Report
      let channelOffset = 0;
      let hasMoreChannels = true;

      while (hasMoreChannels) {
        const channelReport = await this.ga4Provider.runReport(
          accessToken,
          ga4Binding.providerPropertyId,
          {
            startDate: startDateStr,
            endDate: endDateStr,
            dimensions: ['date', 'sessionDefaultChannelGroup'],
            metrics: [
              'sessions',
              'engagedSessions',
              'activeUsers',
              'newUsers',
              'keyEvents',
              'totalRevenue',
            ],
            limit: batchLimit,
            offset: channelOffset,
          }
        );

        totalFetched += channelReport.rows.length;

        const channelFacts = channelReport.rows.map((r) => {
          const dateVal = r.dimensionValues[0];
          const defaultChannelGroup = r.dimensionValues[1] || 'Unassigned';

          let dateObj = start;
          if (dateVal && dateVal.length === 8) {
            const y = parseInt(dateVal.substring(0, 4), 10);
            const m = parseInt(dateVal.substring(4, 6), 10) - 1;
            const d = parseInt(dateVal.substring(6, 8), 10);
            dateObj = new Date(Date.UTC(y, m, d));
          }

          return {
            websiteId,
            syncRunId: syncRun.id,
            providerPropertyId: ga4Binding.providerPropertyId,
            date: dateObj,
            defaultChannelGroup,
            sessions: Math.round(r.metricValues[0] || 0),
            engagedSessions: Math.round(r.metricValues[1] || 0),
            users: Math.round(r.metricValues[2] || 0),
            newUsers: Math.round(r.metricValues[3] || 0),
            keyEvents: Math.round(r.metricValues[4] || 0),
            totalRevenue: r.metricValues[5] || 0,
            currency: ga4Binding.currencyCode,
          };
        });

        if (channelFacts.length > 0) {
          const channelUpserted = await AnalyticsRepository.upsertGa4Channels(channelFacts);
          totalUpserted += channelUpserted;
        }

        hasMoreChannels = channelReport.hasMore && channelReport.nextOffset !== undefined;
        if (hasMoreChannels && channelReport.nextOffset) {
          channelOffset = channelReport.nextOffset;
        } else {
          hasMoreChannels = false;
        }
      }

      await prisma.integrationSyncRun.update({
        where: { id: syncRun.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          rowsFetched: totalFetched,
          rowsUpserted: totalUpserted,
        },
      });

      await prisma.integration.update({
        where: { id: ga4Binding.integrationId },
        data: {
          lastSyncAt: new Date(),
          lastSuccessfulApiCallAt: new Date(),
          lastError: null,
        },
      });

      // Trigger signal evaluation
      try {
        await SignalDetectionEngine.evaluateSignals({
          websiteId,
          currentStart: start,
          currentEnd: end,
        });
      } catch {
        // Non-blocking
      }

      return {
        syncRunId: syncRun.id,
        rowsFetched: totalFetched,
        rowsUpserted: totalUpserted,
        status: 'COMPLETED',
      };
    } catch (err: any) {
      await prisma.integrationSyncRun.update({
        where: { id: syncRun.id },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          errorMessage: err.message,
          errorCode: err.name || 'SYNC_ERROR',
        },
      });
      throw err;
    }
  }

  /**
   * Discovers URLs found in GSC that don't exist yet in url_identities and registers them.
   */
  private async discoverGscUrls(websiteId: string, pageUrls: string[]): Promise<void> {
    if (pageUrls.length === 0) return;

    for (const rawUrl of pageUrls) {
      try {
        const parsed = new URL(rawUrl);
        const pathname = parsed.pathname || '/';

        await prisma.urlIdentity.upsert({
          where: {
            websiteId_normalizedUrl: {
              websiteId,
              normalizedUrl: rawUrl,
            },
          },
          update: {
            lastSeenAt: new Date(),
          },
          create: {
            websiteId,
            normalizedUrl: rawUrl,
            pathname,
            discoverySources: ['GSC'],
            minCrawlDepth: 1,
          },
        });
      } catch {
        // Skip malformed url strings
      }
    }
  }
}
