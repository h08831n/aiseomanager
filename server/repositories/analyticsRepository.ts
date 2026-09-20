import { prisma } from '../db/prisma';
import { SafeUrlPolicy } from '../security/safeUrlPolicy';
import { UrlNormalizer } from '../services/crawler/urlNormalizer';
import { MetricProvenanceSource } from '../services/provenance/provenanceTypes';

export interface GscFactUpsertInput {
  websiteId: string;
  syncRunId?: string;
  providerPropertyId?: string | null;
  date: Date;
  grain: 'SITE_DAILY' | 'PAGE_DAILY' | 'QUERY_DAILY' | 'PAGE_QUERY_DAILY' | 'COUNTRY_DAILY' | 'DEVICE_DAILY';
  pageUrl?: string | null;
  query?: string | null;
  country?: string;
  device?: string;
  searchType?: string;
  searchAppearance?: string | null;
  dataState?: 'FINALIZED' | 'FRESH' | 'HOURLY_PARTIAL';
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  provenance?: MetricProvenanceSource | 'MEASURED_PROVIDER' | 'CALCULATED';
}

export interface Ga4LandingPageUpsertInput {
  websiteId: string;
  syncRunId?: string;
  providerPropertyId?: string | null;
  date: Date;
  landingPageUrl: string;
  channelGroup?: string;
  sessions: number;
  engagedSessions?: number;
  activeUsers?: number;
  newUsers?: number;
  keyEvents?: number;
  totalRevenue?: number;
  currency?: string;
  dataState?: string;
}

export interface Ga4ChannelUpsertInput {
  websiteId: string;
  syncRunId?: string;
  providerPropertyId?: string | null;
  date: Date;
  defaultChannelGroup: string;
  sessions: number;
  engagedSessions?: number;
  users?: number;
  newUsers?: number;
  keyEvents?: number;
  totalRevenue?: number;
  currency?: string;
  dataState?: string;
}

export class AnalyticsRepository {
  /**
   * Batch upserts GSC search analytics facts, linking to UrlIdentities where possible.
   */
  public static async upsertGscFacts(facts: GscFactUpsertInput[]): Promise<number> {
    if (facts.length === 0) return 0;

    const websiteId = facts[0].websiteId;

    // Normalize all page URLs to resolve UrlIdentity mappings using UrlNormalizer
    const normalizedToRaw = new Map<string, string>();
    for (const f of facts) {
      if (f.pageUrl && f.pageUrl.trim().length > 0) {
        try {
          const norm = UrlNormalizer.normalize(f.pageUrl);
          normalizedToRaw.set(norm, f.pageUrl);
        } catch {
          normalizedToRaw.set(f.pageUrl, f.pageUrl);
        }
      }
    }

    const uniqueNormalizedUrls = Array.from(normalizedToRaw.keys());
    const urlMap = new Map<string, string>(); // rawUrl or normUrl -> urlIdentityId

    if (uniqueNormalizedUrls.length > 0) {
      // Find matching UrlIdentities
      const identities = await prisma.urlIdentity.findMany({
        where: {
          websiteId,
          normalizedUrl: { in: uniqueNormalizedUrls },
        },
        select: { id: true, normalizedUrl: true },
      });

      for (const idn of identities) {
        urlMap.set(idn.normalizedUrl, idn.id);
        const raw = normalizedToRaw.get(idn.normalizedUrl);
        if (raw) urlMap.set(raw, idn.id);
      }
    }

    let upsertCount = 0;
    // Chunk upserts in batches of 500 for high performance & safe payload sizes
    const chunkSize = 500;
    for (let i = 0; i < facts.length; i += chunkSize) {
      const chunk = facts.slice(i, i + chunkSize);

      await prisma.$transaction(
        chunk.map((fact) => {
          let matchedIdentityId: string | null = null;
          if (fact.pageUrl) {
            matchedIdentityId = urlMap.get(fact.pageUrl) || null;
            if (!matchedIdentityId) {
              try {
                const norm = UrlNormalizer.normalize(fact.pageUrl);
                matchedIdentityId = urlMap.get(norm) || null;
              } catch {
                // Ignore parse errors
              }
            }
          }

          const urlMatchStatus = fact.pageUrl
            ? matchedIdentityId
              ? 'MATCHED_URL_IDENTITY'
              : 'UNMATCHED_PROVIDER_URL'
            : 'NOT_APPLICABLE';

          return prisma.gscSearchAnalyticsFact.upsert({
            where: {
              websiteId_date_grain_pageUrl_query_country_device_searchType_searchAppearance_providerPropertyId: {
                websiteId: fact.websiteId,
                date: fact.date,
                grain: fact.grain,
                pageUrl: fact.pageUrl || '',
                query: fact.query || '',
                country: fact.country || 'GLOBAL',
                device: fact.device || 'ALL',
                searchType: fact.searchType || 'WEB',
                searchAppearance: fact.searchAppearance || '',
                providerPropertyId: fact.providerPropertyId || '',
              },
            },
            update: {
              clicks: fact.clicks,
              impressions: fact.impressions,
              ctr: fact.ctr,
              position: fact.position,
              dataState: fact.dataState || 'FINALIZED',
              syncRunId: fact.syncRunId || null,
              urlIdentityId: matchedIdentityId,
              urlMatchStatus,
              retrievedAt: new Date(),
            },
            create: {
              websiteId: fact.websiteId,
              syncRunId: fact.syncRunId || null,
              urlIdentityId: matchedIdentityId,
              date: fact.date,
              grain: fact.grain,
              pageUrl: fact.pageUrl || '',
              query: fact.query || '',
              country: fact.country || 'GLOBAL',
              device: fact.device || 'ALL',
              searchType: fact.searchType || 'WEB',
              searchAppearance: fact.searchAppearance || null,
              dataState: fact.dataState || 'FINALIZED',
              clicks: fact.clicks,
              impressions: fact.impressions,
              ctr: fact.ctr,
              position: fact.position,
              provenance: fact.provenance === 'MEASURED_PROVIDER' ? 'GOOGLE_SEARCH_CONSOLE' : (fact.provenance || 'GOOGLE_SEARCH_CONSOLE'),
              urlMatchStatus,
              retrievedAt: new Date(),
            },
          });
        })
      );
      upsertCount += chunk.length;
    }

    return upsertCount;
  }

  /**
   * Batch upserts GA4 landing page daily records.
   */
  public static async upsertGa4LandingPages(rows: Ga4LandingPageUpsertInput[]): Promise<number> {
    if (rows.length === 0) return 0;
    const websiteId = rows[0].websiteId;

    const rawUrls = Array.from(new Set(rows.map((r) => r.landingPageUrl)));
    const identities = await prisma.urlIdentity.findMany({
      where: {
        websiteId,
        normalizedUrl: { in: rawUrls },
      },
      select: { id: true, normalizedUrl: true },
    });

    const urlMap = new Map<string, string>();
    for (const idn of identities) {
      urlMap.set(idn.normalizedUrl, idn.id);
    }

    let count = 0;
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);

      await prisma.$transaction(
        chunk.map((row) => {
          const matchedIdentityId = urlMap.get(row.landingPageUrl) || null;
          const urlMatchStatus = matchedIdentityId ? 'MATCHED_URL_IDENTITY' : 'UNMATCHED_PROVIDER_URL';

          return prisma.ga4LandingPageDaily.upsert({
            where: {
              websiteId_date_landingPageUrl_channelGroup_providerPropertyId: {
                websiteId: row.websiteId,
                date: row.date,
                landingPageUrl: row.landingPageUrl,
                channelGroup: row.channelGroup || 'Organic Search',
                providerPropertyId: row.providerPropertyId || '',
              },
            },
            update: {
              sessions: row.sessions,
              engagedSessions: row.engagedSessions || 0,
              activeUsers: row.activeUsers || 0,
              newUsers: row.newUsers || 0,
              keyEvents: row.keyEvents || 0,
              totalRevenue: row.totalRevenue || 0,
              currency: row.currency || 'USD',
              dataState: row.dataState || 'FINALIZED',
              syncRunId: row.syncRunId || null,
              urlIdentityId: matchedIdentityId,
              urlMatchStatus,
              retrievedAt: new Date(),
            },
            create: {
              websiteId: row.websiteId,
              syncRunId: row.syncRunId || null,
              urlIdentityId: matchedIdentityId,
              date: row.date,
              landingPageUrl: row.landingPageUrl,
              channelGroup: row.channelGroup || 'Organic Search',
              sessions: row.sessions,
              engagedSessions: row.engagedSessions || 0,
              activeUsers: row.activeUsers || 0,
              newUsers: row.newUsers || 0,
              keyEvents: row.keyEvents || 0,
              totalRevenue: row.totalRevenue || 0,
              currency: row.currency || 'USD',
              dataState: row.dataState || 'FINALIZED',
              provenance: 'GOOGLE_ANALYTICS',
              urlMatchStatus,
              retrievedAt: new Date(),
            },
          });
        })
      );
      count += chunk.length;
    }

    return count;
  }

  /**
   * Batch upserts GA4 channel breakdown daily records.
   */
  public static async upsertGa4Channels(rows: Ga4ChannelUpsertInput[]): Promise<number> {
    if (rows.length === 0) return 0;

    let count = 0;
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);

      await prisma.$transaction(
        chunk.map((row) =>
          prisma.ga4ChannelDaily.upsert({
            where: {
              websiteId_date_defaultChannelGroup_providerPropertyId: {
                websiteId: row.websiteId,
                date: row.date,
                defaultChannelGroup: row.defaultChannelGroup,
                providerPropertyId: row.providerPropertyId || '',
              },
            },
            update: {
              sessions: row.sessions,
              engagedSessions: row.engagedSessions || 0,
              users: row.users || 0,
              newUsers: row.newUsers || 0,
              keyEvents: row.keyEvents || 0,
              totalRevenue: row.totalRevenue || 0,
              currency: row.currency || 'USD',
              dataState: row.dataState || 'FINALIZED',
              syncRunId: row.syncRunId || null,
              retrievedAt: new Date(),
            },
            create: {
              websiteId: row.websiteId,
              syncRunId: row.syncRunId || null,
              date: row.date,
              defaultChannelGroup: row.defaultChannelGroup,
              sessions: row.sessions,
              engagedSessions: row.engagedSessions || 0,
              users: row.users || 0,
              newUsers: row.newUsers || 0,
              keyEvents: row.keyEvents || 0,
              totalRevenue: row.totalRevenue || 0,
              currency: row.currency || 'USD',
              dataState: row.dataState || 'FINALIZED',
              provenance: 'GOOGLE_ANALYTICS',
              retrievedAt: new Date(),
            },
          })
        )
      );
      count += chunk.length;
    }

    return count;
  }

  /**
   * Retrieves high-level GSC time series (SITE_DAILY grain) for a given date range.
   */
  public static async getGscTimeSeries(
    websiteId: string,
    startDate: Date,
    endDate: Date
  ): Promise<
    Array<{
      date: string;
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    }>
  > {
    const facts = await prisma.gscSearchAnalyticsFact.findMany({
      where: {
        websiteId,
        grain: 'SITE_DAILY',
        date: { gte: startDate, lte: endDate },
      },
      orderBy: { date: 'asc' },
    });

    return facts.map((f) => ({
      date: f.date.toISOString().split('T')[0],
      clicks: f.clicks,
      impressions: f.impressions,
      ctr: f.impressions > 0 ? (f.clicks / f.impressions) * 100 : 0,
      position: f.position,
    }));
  }

  /**
   * Aggregates Top Queries with mathematically sound weighted CTR and weighted position.
   * Strictly enforces grain isolation (QUERY_DAILY preferred, fallback to PAGE_QUERY_DAILY only if 0 rows)
   * to guarantee no double-counting across multi-grain facts.
   */
  public static async getTopQueries(
    websiteId: string,
    startDate: Date,
    endDate: Date,
    limit = 50,
    offset = 0
  ): Promise<
    Array<{
      query: string;
      clicks: number;
      impressions: number;
      ctr: number;
      avgPosition: number;
      sourceGrain: string;
    }>
  > {
    // 1. First attempt to query dedicated QUERY_DAILY grain facts
    let sourceGrain = 'QUERY_DAILY';
    let facts = await prisma.gscSearchAnalyticsFact.findMany({
      where: {
        websiteId,
        grain: 'QUERY_DAILY',
        date: { gte: startDate, lte: endDate },
        query: { not: '' },
      },
    });

    // 2. Fallback to PAGE_QUERY_DAILY only if dedicated QUERY_DAILY is not populated
    if (facts.length === 0) {
      sourceGrain = 'PAGE_QUERY_DAILY';
      facts = await prisma.gscSearchAnalyticsFact.findMany({
        where: {
          websiteId,
          grain: 'PAGE_QUERY_DAILY',
          date: { gte: startDate, lte: endDate },
          query: { not: '' },
        },
      });
    }

    const queryAgg = new Map<
      string,
      { clicks: number; impressions: number; weightedPositionSum: number }
    >();

    for (const f of facts) {
      if (!f.query) continue;
      const current = queryAgg.get(f.query) || { clicks: 0, impressions: 0, weightedPositionSum: 0 };
      current.clicks += f.clicks;
      current.impressions += f.impressions;
      current.weightedPositionSum += f.position * f.impressions;
      queryAgg.set(f.query, current);
    }

    const results = Array.from(queryAgg.entries()).map(([query, stats]) => {
      const ctr = stats.impressions > 0 ? (stats.clicks / stats.impressions) * 100 : 0;
      const avgPosition =
        stats.impressions > 0 ? stats.weightedPositionSum / stats.impressions : 0;
      return {
        query,
        clicks: stats.clicks,
        impressions: stats.impressions,
        ctr: parseFloat(ctr.toFixed(2)),
        avgPosition: parseFloat(avgPosition.toFixed(1)),
        sourceGrain,
      };
    });

    // Sort by clicks descending, then impressions descending
    results.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

    return results.slice(offset, offset + limit);
  }

  /**
   * Aggregates Top Pages with mathematically sound weighted CTR and weighted position.
   * Strictly enforces grain isolation (PAGE_DAILY preferred, fallback to PAGE_QUERY_DAILY only if 0 rows)
   * to guarantee no double-counting across multi-grain facts.
   */
  public static async getTopPages(
    websiteId: string,
    startDate: Date,
    endDate: Date,
    limit = 50,
    offset = 0
  ): Promise<
    Array<{
      pageUrl: string;
      clicks: number;
      impressions: number;
      ctr: number;
      avgPosition: number;
      urlIdentityId?: string | null;
      sourceGrain: string;
    }>
  > {
    // 1. First attempt to query dedicated PAGE_DAILY grain facts
    let sourceGrain = 'PAGE_DAILY';
    let facts = await prisma.gscSearchAnalyticsFact.findMany({
      where: {
        websiteId,
        grain: 'PAGE_DAILY',
        date: { gte: startDate, lte: endDate },
        pageUrl: { not: '' },
      },
    });

    // 2. Fallback to PAGE_QUERY_DAILY only if dedicated PAGE_DAILY is not populated
    if (facts.length === 0) {
      sourceGrain = 'PAGE_QUERY_DAILY';
      facts = await prisma.gscSearchAnalyticsFact.findMany({
        where: {
          websiteId,
          grain: 'PAGE_QUERY_DAILY',
          date: { gte: startDate, lte: endDate },
          pageUrl: { not: '' },
        },
      });
    }

    const pageAgg = new Map<
      string,
      { clicks: number; impressions: number; weightedPositionSum: number; urlIdentityId?: string | null }
    >();

    for (const f of facts) {
      if (!f.pageUrl) continue;
      const current = pageAgg.get(f.pageUrl) || {
        clicks: 0,
        impressions: 0,
        weightedPositionSum: 0,
        urlIdentityId: f.urlIdentityId,
      };
      current.clicks += f.clicks;
      current.impressions += f.impressions;
      current.weightedPositionSum += f.position * f.impressions;
      if (f.urlIdentityId) current.urlIdentityId = f.urlIdentityId;
      pageAgg.set(f.pageUrl, current);
    }

    const results = Array.from(pageAgg.entries()).map(([pageUrl, stats]) => {
      const ctr = stats.impressions > 0 ? (stats.clicks / stats.impressions) * 100 : 0;
      const avgPosition =
        stats.impressions > 0 ? stats.weightedPositionSum / stats.impressions : 0;
      return {
        pageUrl,
        clicks: stats.clicks,
        impressions: stats.impressions,
        ctr: parseFloat(ctr.toFixed(2)),
        avgPosition: parseFloat(avgPosition.toFixed(1)),
        urlIdentityId: stats.urlIdentityId,
        sourceGrain,
      };
    });

    results.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

    return results.slice(offset, offset + limit);
  }

  /**
   * Retrieves summary totals for GSC for a specific window.
   */
  public static async getGscTotals(
    websiteId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{
    totalClicks: number;
    totalImpressions: number;
    weightedCtr: number;
    weightedPosition: number;
  }> {
    // Check SITE_DAILY facts first for authoritative totals
    const siteFacts = await prisma.gscSearchAnalyticsFact.findMany({
      where: {
        websiteId,
        grain: 'SITE_DAILY',
        date: { gte: startDate, lte: endDate },
      },
    });

    if (siteFacts.length > 0) {
      let clicks = 0;
      let impressions = 0;
      let positionSum = 0;

      for (const f of siteFacts) {
        clicks += f.clicks;
        impressions += f.impressions;
        positionSum += f.position * f.impressions;
      }

      const weightedCtr = impressions > 0 ? (clicks / impressions) * 100 : 0;
      const weightedPosition = impressions > 0 ? positionSum / impressions : 0;

      return {
        totalClicks: clicks,
        totalImpressions: impressions,
        weightedCtr: parseFloat(weightedCtr.toFixed(2)),
        weightedPosition: parseFloat(weightedPosition.toFixed(1)),
      };
    }

    // Fallback: Aggregate across page facts if SITE_DAILY not yet populated
    const pageFacts = await prisma.gscSearchAnalyticsFact.findMany({
      where: {
        websiteId,
        grain: 'PAGE_DAILY',
        date: { gte: startDate, lte: endDate },
      },
    });

    let clicks = 0;
    let impressions = 0;
    let positionSum = 0;

    for (const f of pageFacts) {
      clicks += f.clicks;
      impressions += f.impressions;
      positionSum += f.position * f.impressions;
    }

    const weightedCtr = impressions > 0 ? (clicks / impressions) * 100 : 0;
    const weightedPosition = impressions > 0 ? positionSum / impressions : 0;

    return {
      totalClicks: clicks,
      totalImpressions: impressions,
      weightedCtr: parseFloat(weightedCtr.toFixed(2)),
      weightedPosition: parseFloat(weightedPosition.toFixed(1)),
    };
  }

  /**
   * Retrieves summary totals for GA4 for a specific window.
   */
  public static async getGa4Totals(
    websiteId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{
    totalSessions: number;
    engagedSessions: number;
    activeUsers: number;
    newUsers: number;
    keyEvents: number;
    totalRevenue: number;
    engagementRate: number;
  }> {
    const channelRows = await prisma.ga4ChannelDaily.findMany({
      where: {
        websiteId,
        defaultChannelGroup: 'Organic Search',
        date: { gte: startDate, lte: endDate },
      },
    });

    let totalSessions = 0;
    let engagedSessions = 0;
    let activeUsers = 0;
    let newUsers = 0;
    let keyEvents = 0;
    let totalRevenue = 0;

    for (const r of channelRows) {
      totalSessions += r.sessions;
      engagedSessions += r.engagedSessions;
      activeUsers += r.users;
      newUsers += r.newUsers;
      keyEvents += r.keyEvents;
      totalRevenue += r.totalRevenue;
    }

    const engagementRate = totalSessions > 0 ? (engagedSessions / totalSessions) * 100 : 0;

    return {
      totalSessions,
      engagedSessions,
      activeUsers,
      newUsers,
      keyEvents,
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      engagementRate: parseFloat(engagementRate.toFixed(2)),
    };
  }
}
