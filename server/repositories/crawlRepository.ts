import { CrawlRunLifecycle } from '@prisma/client';
import { getPrismaClient } from '../db/prismaClient';
import { isProductionMode } from '../config/runtimeMode';

export interface CrawlRunRecord {
  id: string;
  websiteId: string;
  status: CrawlRunLifecycle;
  seedUrl: string;
  configJson: string;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number;
  totalPages: number;
  totalIssues: number;
  urlsDiscovered: number;
  urlsQueued: number;
  urlsFetched: number;
  urlsSkipped: number;
  urlsFailed: number;
  robotsTxtStatus?: string;
  robotsTxtHash?: string;
  sitemapsDiscovered: string[];
  triggerSource: string;
}

export interface UrlIdentityRecord {
  id: string;
  websiteId: string;
  normalizedUrl: string;
  pathname: string;
  firstDiscoveredAt: string;
  lastSeenAt: string;
  discoverySources: string[];
  inlinksCount: number;
  outlinksCount: number;
  minCrawlDepth: number;
  isOrphanCandidate: boolean;
}

export interface CrawledPageRecord {
  id: string;
  websiteId: string;
  crawlRunId: string;
  url: string;
  normalizedUrl: string;
  pathname: string;
  statusCode: number;
  finalUrl?: string;
  redirectCount: number;
  redirectChainJson?: string;
  loadTimeMs: number;
  contentLengthBytes: number;
  isIndexable: boolean;
  indexabilityStatus: string;
  indexabilityReasons: string[];
  canonicalUrl?: string;
  normalizedCanonicalUrl?: string;
  canonicalMatch: boolean;
  title?: string;
  titleLength: number;
  metaDescription?: string;
  metaDescLength: number;
  metaRobots?: string;
  xRobotsTag?: string;
  h1Tags: string[];
  h2Count: number;
  h3Count: number;
  wordCount: number;
  contentHash?: string;
  simHash?: string;
  isExactDuplicate: boolean;
  duplicateClusterId?: string;
  isThinContent: boolean;
  isPossibleSoft404: boolean;
  soft404Confidence: number;
  internalInlinksCount: number;
  internalOutlinksCount: number;
  externalOutlinksCount: number;
  imagesCount: number;
  missingAltCount: number;
  schemaTypes: string[];
  schemaStatus: string;
  openGraphJson?: string;
  twitterCardJson?: string;
  hreflangsJson?: string;
  crawlDepth: number;
  crawledAt: string;
}

export interface CrawlIssueRecord {
  id: string;
  crawlRunId: string;
  crawledPageId?: string;
  ruleKey: string;
  ruleVersion: string;
  type: string;
  severity: string;
  message: string;
  evidence: string;
  impact: string;
  resolved: boolean;
  createdAt: string;
}

export interface InternalLinkEdgeRecord {
  id: string;
  crawlRunId: string;
  sourceUrlIdentityId?: string;
  targetUrlIdentityId?: string;
  sourceUrl: string;
  targetUrl: string;
  normalizedTarget: string;
  anchorText?: string;
  isInternal: boolean;
  rel?: string;
  isNofollow: boolean;
  targetStatusCode?: number;
  isBroken: boolean;
  createdAt: string;
}

export interface SeoEventRecord {
  id: string;
  websiteId: string;
  crawlRunId?: string;
  eventType: string;
  entityType: string;
  entityUrl: string;
  beforeValue?: string;
  afterValue?: string;
  deltaNotes?: string;
  severity: string;
  source: string;
  detectedAt: string;
}

// In-Memory Store for DEV/TEST fallback
const devUrlIdentities: Map<string, UrlIdentityRecord> = new Map();
const devCrawlRuns: Map<string, CrawlRunRecord> = new Map();
const devCrawledPages: Map<string, CrawledPageRecord[]> = new Map();
const devCrawlIssues: Map<string, CrawlIssueRecord[]> = new Map();
const devLinkEdges: Map<string, InternalLinkEdgeRecord[]> = new Map();
const devSeoEvents: Map<string, SeoEventRecord[]> = new Map();

export class CrawlRepository {
  public static async getOrCreateUrlIdentity(
    websiteId: string,
    normalizedUrl: string,
    discoverySource: string
  ): Promise<UrlIdentityRecord> {
    const prisma = getPrismaClient();
    const pathname = new URL(normalizedUrl).pathname;
    const now = new Date();

    if (prisma) {
      try {
        const existing = await prisma.urlIdentity.findUnique({
          where: { websiteId_normalizedUrl: { websiteId, normalizedUrl } },
        });

        if (existing) {
          const updated = await prisma.urlIdentity.update({
            where: { id: existing.id },
            data: {
              lastSeenAt: now,
              discoverySources: Array.from(new Set([...existing.discoverySources, discoverySource])),
            },
          });
          return {
            id: updated.id,
            websiteId: updated.websiteId,
            normalizedUrl: updated.normalizedUrl,
            pathname: updated.pathname,
            firstDiscoveredAt: updated.firstDiscoveredAt.toISOString(),
            lastSeenAt: updated.lastSeenAt.toISOString(),
            discoverySources: updated.discoverySources,
            inlinksCount: updated.inlinksCount,
            outlinksCount: updated.outlinksCount,
            minCrawlDepth: updated.minCrawlDepth,
            isOrphanCandidate: updated.isOrphanCandidate,
          };
        }

        const created = await prisma.urlIdentity.create({
          data: {
            id: `url-id-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            websiteId,
            normalizedUrl,
            pathname,
            firstDiscoveredAt: now,
            lastSeenAt: now,
            discoverySources: [discoverySource],
            inlinksCount: 0,
            outlinksCount: 0,
            minCrawlDepth: 0,
            isOrphanCandidate: discoverySource === 'SITEMAP',
          },
        });

        return {
          id: created.id,
          websiteId: created.websiteId,
          normalizedUrl: created.normalizedUrl,
          pathname: created.pathname,
          firstDiscoveredAt: created.firstDiscoveredAt.toISOString(),
          lastSeenAt: created.lastSeenAt.toISOString(),
          discoverySources: created.discoverySources,
          inlinksCount: created.inlinksCount,
          outlinksCount: created.outlinksCount,
          minCrawlDepth: created.minCrawlDepth,
          isOrphanCandidate: created.isOrphanCandidate,
        };
      } catch (err) {
        if (isProductionMode()) {
          throw new Error(`PERSISTENCE_UNAVAILABLE: UrlIdentity write failed: ${err}`);
        }
      }
    }

    const key = `${websiteId}:${normalizedUrl}`;
    const existing = devUrlIdentities.get(key);
    if (existing) {
      existing.lastSeenAt = now.toISOString();
      if (!existing.discoverySources.includes(discoverySource)) {
        existing.discoverySources.push(discoverySource);
      }
      return existing;
    }

    const record: UrlIdentityRecord = {
      id: `url-id-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      websiteId,
      normalizedUrl,
      pathname,
      firstDiscoveredAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      discoverySources: [discoverySource],
      inlinksCount: 0,
      outlinksCount: 0,
      minCrawlDepth: 0,
      isOrphanCandidate: discoverySource === 'SITEMAP',
    };
    devUrlIdentities.set(key, record);
    return record;
  }

  public static async createCrawlRunWithOutbox(params: {
    websiteId: string;
    seedUrl: string;
    config: any;
    triggerSource?: string;
    correlationId?: string;
  }): Promise<{ crawlRun: CrawlRunRecord; outboxEventId: string }> {
    const prisma = getPrismaClient();
    const crawlRunId = `crawl-run-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const outboxId = `outbox-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const configJson = JSON.stringify(params.config);

    if (prisma) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          const crawlRun = await tx.crawlRun.create({
            data: {
              id: crawlRunId,
              websiteId: params.websiteId,
              status: 'PENDING',
              seedUrl: params.seedUrl,
              configJson,
              triggerSource: params.triggerSource || 'MANUAL',
              urlsDiscovered: 1,
              urlsQueued: 1,
            },
          });

          const outboxEvent = await tx.outboxEvent.create({
            data: {
              id: outboxId,
              aggregateType: 'CRAWL_RUN',
              aggregateId: crawlRun.id,
              eventType: 'CRAWL_REQUESTED',
              payloadJson: JSON.stringify({
                websiteId: params.websiteId,
                crawlRunId: crawlRun.id,
                config: params.config,
                correlationId: params.correlationId,
              }),
              status: 'PENDING',
              attemptCount: 0,
            },
          });

          return { crawlRun, outboxEvent };
        });

        return {
          crawlRun: {
            id: result.crawlRun.id,
            websiteId: result.crawlRun.websiteId,
            status: result.crawlRun.status,
            seedUrl: result.crawlRun.seedUrl,
            configJson: result.crawlRun.configJson,
            startedAt: result.crawlRun.startedAt ? result.crawlRun.startedAt.toISOString() : undefined,
            completedAt: result.crawlRun.completedAt ? result.crawlRun.completedAt.toISOString() : undefined,
            durationMs: result.crawlRun.durationMs || undefined,
            totalPages: result.crawlRun.totalPages,
            totalIssues: result.crawlRun.totalIssues,
            urlsDiscovered: result.crawlRun.urlsDiscovered,
            urlsQueued: result.crawlRun.urlsQueued,
            urlsFetched: result.crawlRun.urlsFetched,
            urlsSkipped: result.crawlRun.urlsSkipped,
            urlsFailed: result.crawlRun.urlsFailed,
            robotsTxtStatus: result.crawlRun.robotsTxtStatus || undefined,
            robotsTxtHash: result.crawlRun.robotsTxtHash || undefined,
            sitemapsDiscovered: result.crawlRun.sitemapsDiscovered,
            triggerSource: result.crawlRun.triggerSource,
          },
          outboxEventId: result.outboxEvent.id,
        };
      } catch (err) {
        if (isProductionMode()) {
          throw new Error(`PERSISTENCE_UNAVAILABLE: Transactional crawl creation failed: ${err}`);
        }
      }
    }

    const devCrawlRun: CrawlRunRecord = {
      id: crawlRunId,
      websiteId: params.websiteId,
      status: 'PENDING',
      seedUrl: params.seedUrl,
      configJson,
      totalPages: 0,
      totalIssues: 0,
      urlsDiscovered: 1,
      urlsQueued: 1,
      urlsFetched: 0,
      urlsSkipped: 0,
      urlsFailed: 0,
      sitemapsDiscovered: [],
      triggerSource: params.triggerSource || 'MANUAL',
    };
    devCrawlRuns.set(crawlRunId, devCrawlRun);

    return {
      crawlRun: devCrawlRun,
      outboxEventId: outboxId,
    };
  }

  public static async createCrawlRun(params: {
    websiteId: string;
    seedUrl: string;
    config: any;
    status?: CrawlRunLifecycle;
    triggerSource?: string;
  }): Promise<CrawlRunRecord> {
    const prisma = getPrismaClient();
    const id = `crawl-run-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const configJson = JSON.stringify(params.config);
    const initialStatus: CrawlRunLifecycle = params.status || 'PENDING';

    if (prisma) {
      try {
        const record = await prisma.crawlRun.create({
          data: {
            id,
            websiteId: params.websiteId,
            status: initialStatus,
            seedUrl: params.seedUrl,
            configJson,
            triggerSource: params.triggerSource || 'MANUAL',
            urlsDiscovered: 1,
            urlsQueued: 1,
          },
        });
        return {
          id: record.id,
          websiteId: record.websiteId,
          status: record.status,
          seedUrl: record.seedUrl,
          configJson: record.configJson,
          startedAt: record.startedAt ? record.startedAt.toISOString() : undefined,
          completedAt: record.completedAt ? record.completedAt.toISOString() : undefined,
          durationMs: record.durationMs || undefined,
          totalPages: record.totalPages,
          totalIssues: record.totalIssues,
          urlsDiscovered: record.urlsDiscovered,
          urlsQueued: record.urlsQueued,
          urlsFetched: record.urlsFetched,
          urlsSkipped: record.urlsSkipped,
          urlsFailed: record.urlsFailed,
          robotsTxtStatus: record.robotsTxtStatus || undefined,
          robotsTxtHash: record.robotsTxtHash || undefined,
          sitemapsDiscovered: record.sitemapsDiscovered,
          triggerSource: record.triggerSource,
        };
      } catch (err) {
        if (isProductionMode()) {
          throw new Error(`PERSISTENCE_UNAVAILABLE: Database write failed: ${err}`);
        }
      }
    }

    const devRecord: CrawlRunRecord = {
      id,
      websiteId: params.websiteId,
      status: initialStatus,
      seedUrl: params.seedUrl,
      configJson,
      startedAt: initialStatus === 'RUNNING' ? new Date().toISOString() : undefined,
      totalPages: 0,
      totalIssues: 0,
      urlsDiscovered: 1,
      urlsQueued: 1,
      urlsFetched: 0,
      urlsSkipped: 0,
      urlsFailed: 0,
      sitemapsDiscovered: [],
      triggerSource: params.triggerSource || 'MANUAL',
    };

    devCrawlRuns.set(id, devRecord);
    return devRecord;
  }

  public static async updateCrawlRun(
    id: string,
    updates: Partial<CrawlRunRecord>
  ): Promise<CrawlRunRecord | null> {
    const prisma = getPrismaClient();

    if (prisma) {
      try {
        const dataToUpdate: any = { ...updates };
        if (updates.startedAt) dataToUpdate.startedAt = new Date(updates.startedAt);
        if (updates.completedAt) dataToUpdate.completedAt = new Date(updates.completedAt);

        const updated = await prisma.crawlRun.update({
          where: { id },
          data: dataToUpdate,
        });
        return {
          id: updated.id,
          websiteId: updated.websiteId,
          status: updated.status,
          seedUrl: updated.seedUrl,
          configJson: updated.configJson,
          startedAt: updated.startedAt ? updated.startedAt.toISOString() : undefined,
          completedAt: updated.completedAt ? updated.completedAt.toISOString() : undefined,
          durationMs: updated.durationMs || undefined,
          totalPages: updated.totalPages,
          totalIssues: updated.totalIssues,
          urlsDiscovered: updated.urlsDiscovered,
          urlsQueued: updated.urlsQueued,
          urlsFetched: updated.urlsFetched,
          urlsSkipped: updated.urlsSkipped,
          urlsFailed: updated.urlsFailed,
          robotsTxtStatus: updated.robotsTxtStatus || undefined,
          robotsTxtHash: updated.robotsTxtHash || undefined,
          sitemapsDiscovered: updated.sitemapsDiscovered,
          triggerSource: updated.triggerSource,
        };
      } catch (err) {
        if (isProductionMode()) {
          throw new Error(`PERSISTENCE_UNAVAILABLE: updateCrawlRun failed: ${err}`);
        }
      }
    }

    const current = devCrawlRuns.get(id);
    if (!current) return null;

    const merged = { ...current, ...updates };
    devCrawlRuns.set(id, merged);
    return merged;
  }

  public static async getCrawlRun(id: string): Promise<CrawlRunRecord | null> {
    const prisma = getPrismaClient();
    if (prisma) {
      try {
        const res = await prisma.crawlRun.findUnique({ where: { id } });
        if (res) {
          return {
            id: res.id,
            websiteId: res.websiteId,
            status: res.status,
            seedUrl: res.seedUrl,
            configJson: res.configJson,
            startedAt: res.startedAt ? res.startedAt.toISOString() : undefined,
            completedAt: res.completedAt ? res.completedAt.toISOString() : undefined,
            durationMs: res.durationMs || undefined,
            totalPages: res.totalPages,
            totalIssues: res.totalIssues,
            urlsDiscovered: res.urlsDiscovered,
            urlsQueued: res.urlsQueued,
            urlsFetched: res.urlsFetched,
            urlsSkipped: res.urlsSkipped,
            urlsFailed: res.urlsFailed,
            robotsTxtStatus: res.robotsTxtStatus || undefined,
            robotsTxtHash: res.robotsTxtHash || undefined,
            sitemapsDiscovered: res.sitemapsDiscovered,
            triggerSource: res.triggerSource,
          };
        }
      } catch {
        // Fallback
      }
    }
    return devCrawlRuns.get(id) || null;
  }

  public static async listCrawlRuns(
    websiteId: string,
    options: { offset?: number; limit?: number; status?: CrawlRunLifecycle } = {}
  ): Promise<{ total: number; runs: CrawlRunRecord[] }> {
    const { offset = 0, limit = 50, status } = options;
    const prisma = getPrismaClient();

    if (prisma) {
      try {
        const where: any = { websiteId };
        if (status) where.status = status;

        const total = await prisma.crawlRun.count({ where });
        const res = await prisma.crawlRun.findMany({
          where,
          orderBy: { startedAt: 'desc' },
          skip: offset,
          take: limit,
        });

        return {
          total,
          runs: res.map((r) => ({
            id: r.id,
            websiteId: r.websiteId,
            status: r.status,
            seedUrl: r.seedUrl,
            configJson: r.configJson,
            startedAt: r.startedAt ? r.startedAt.toISOString() : undefined,
            completedAt: r.completedAt ? r.completedAt.toISOString() : undefined,
            durationMs: r.durationMs || undefined,
            totalPages: r.totalPages,
            totalIssues: r.totalIssues,
            urlsDiscovered: r.urlsDiscovered,
            urlsQueued: r.urlsQueued,
            urlsFetched: r.urlsFetched,
            urlsSkipped: r.urlsSkipped,
            urlsFailed: r.urlsFailed,
            robotsTxtStatus: r.robotsTxtStatus || undefined,
            robotsTxtHash: r.robotsTxtHash || undefined,
            sitemapsDiscovered: r.sitemapsDiscovered,
            triggerSource: r.triggerSource,
          })),
        };
      } catch {
        // Fallback
      }
    }

    const all = Array.from(devCrawlRuns.values())
      .filter((r) => r.websiteId === websiteId && (!status || r.status === status))
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));

    return {
      total: all.length,
      runs: all.slice(offset, offset + limit),
    };
  }

  public static async saveCrawledPagesBatch(
    crawlRunId: string,
    websiteId: string,
    pages: Omit<CrawledPageRecord, 'id'>[]
  ): Promise<void> {
    const prisma = getPrismaClient();
    const recordsWithId = pages.map((p) => ({
      ...p,
      id: `page-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    }));

    if (prisma) {
      try {
        await prisma.crawledPage.createMany({
          data: recordsWithId.map((p) => ({
            ...p,
            h1Tags: p.h1Tags || [],
            indexabilityReasons: p.indexabilityReasons || [],
            schemaTypes: p.schemaTypes || [],
            crawledAt: new Date(p.crawledAt),
          })),
          skipDuplicates: true,
        });
        return;
      } catch (err) {
        if (isProductionMode()) {
          throw new Error(`PERSISTENCE_UNAVAILABLE: saveCrawledPagesBatch failed: ${err}`);
        }
      }
    }

    const currentPages = devCrawledPages.get(crawlRunId) || [];
    devCrawledPages.set(crawlRunId, [...currentPages, ...recordsWithId]);
  }

  public static async saveIssuesBatch(
    crawlRunId: string,
    issues: Omit<CrawlIssueRecord, 'id'>[]
  ): Promise<void> {
    const prisma = getPrismaClient();
    const records = issues.map((i) => ({
      ...i,
      id: `issue-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    }));

    if (prisma) {
      try {
        await prisma.crawlIssue.createMany({
          data: records.map((r) => ({
            ...r,
            severity: r.severity as any,
            createdAt: new Date(r.createdAt),
          })),
          skipDuplicates: true,
        });
        return;
      } catch (err) {
        if (isProductionMode()) {
          throw new Error(`PERSISTENCE_UNAVAILABLE: saveIssuesBatch failed: ${err}`);
        }
      }
    }

    const current = devCrawlIssues.get(crawlRunId) || [];
    devCrawlIssues.set(crawlRunId, [...current, ...records]);
  }

  public static async saveLinkEdgesBatch(
    crawlRunId: string,
    edges: Omit<InternalLinkEdgeRecord, 'id'>[]
  ): Promise<void> {
    const prisma = getPrismaClient();
    const records = edges.map((e) => ({
      ...e,
      id: `edge-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    }));

    if (prisma) {
      try {
        await prisma.internalLinkEdge.createMany({
          data: records.map((r) => ({
            ...r,
            createdAt: new Date(r.createdAt),
          })),
          skipDuplicates: true,
        });
        return;
      } catch (err) {
        if (isProductionMode()) {
          throw new Error(`PERSISTENCE_UNAVAILABLE: saveLinkEdgesBatch failed: ${err}`);
        }
      }
    }

    const current = devLinkEdges.get(crawlRunId) || [];
    devLinkEdges.set(crawlRunId, [...current, ...records]);
  }

  public static async saveSeoEventsBatch(
    websiteId: string,
    events: Omit<SeoEventRecord, 'id'>[]
  ): Promise<void> {
    const prisma = getPrismaClient();
    const records = events.map((ev) => ({
      ...ev,
      id: `sevt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    }));

    if (prisma) {
      try {
        await prisma.seoEvent.createMany({
          data: records.map((r) => ({
            ...r,
            detectedAt: new Date(r.detectedAt),
          })),
          skipDuplicates: true,
        });
        return;
      } catch (err) {
        if (isProductionMode()) {
          throw new Error(`PERSISTENCE_UNAVAILABLE: saveSeoEventsBatch failed: ${err}`);
        }
      }
    }

    const current = devSeoEvents.get(websiteId) || [];
    devSeoEvents.set(websiteId, [...current, ...records]);
  }

  // Database-Level Pagination
  public static async getCrawledPages(
    crawlRunId: string,
    options: { offset?: number; limit?: number } = {}
  ): Promise<{ total: number; pages: CrawledPageRecord[] }> {
    const { offset = 0, limit = 50 } = options;
    const prisma = getPrismaClient();

    if (prisma) {
      try {
        const total = await prisma.crawledPage.count({ where: { crawlRunId } });
        const rows = await prisma.crawledPage.findMany({
          where: { crawlRunId },
          orderBy: { crawledAt: 'asc' },
          skip: offset,
          take: limit,
        });
        return {
          total,
          pages: rows.map((r) => ({
            ...r,
            crawledAt: r.crawledAt.toISOString(),
            finalUrl: r.finalUrl || undefined,
            redirectChainJson: r.redirectChainJson || undefined,
            canonicalUrl: r.canonicalUrl || undefined,
            normalizedCanonicalUrl: r.normalizedCanonicalUrl || undefined,
            title: r.title || undefined,
            metaDescription: r.metaDescription || undefined,
            metaRobots: r.metaRobots || undefined,
            xRobotsTag: r.xRobotsTag || undefined,
            contentHash: r.contentHash || undefined,
            simHash: r.simHash || undefined,
            duplicateClusterId: r.duplicateClusterId || undefined,
            openGraphJson: r.openGraphJson || undefined,
            twitterCardJson: r.twitterCardJson || undefined,
            hreflangsJson: r.hreflangsJson || undefined,
          })),
        };
      } catch {
        // Fallback
      }
    }

    const all = devCrawledPages.get(crawlRunId) || [];
    return {
      total: all.length,
      pages: all.slice(offset, offset + limit),
    };
  }

  public static async getCrawlIssues(
    crawlRunId: string,
    options: { offset?: number; limit?: number } = {}
  ): Promise<{ total: number; issues: CrawlIssueRecord[] }> {
    const { offset = 0, limit = 100 } = options;
    const prisma = getPrismaClient();

    if (prisma) {
      try {
        const total = await prisma.crawlIssue.count({ where: { crawlRunId } });
        const rows = await prisma.crawlIssue.findMany({
          where: { crawlRunId },
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
        });
        return {
          total,
          issues: rows.map((r) => ({
            ...r,
            crawledPageId: r.crawledPageId || undefined,
            createdAt: r.createdAt.toISOString(),
          })),
        };
      } catch {
        // Fallback
      }
    }

    const all = devCrawlIssues.get(crawlRunId) || [];
    return {
      total: all.length,
      issues: all.slice(offset, offset + limit),
    };
  }

  public static async getSeoEvents(
    websiteId: string,
    options: { offset?: number; limit?: number; crawlRunId?: string; severity?: string; eventType?: string } = {}
  ): Promise<{ total: number; events: SeoEventRecord[] }> {
    const { offset = 0, limit = 100, crawlRunId, severity, eventType } = options;
    const prisma = getPrismaClient();

    if (prisma) {
      try {
        const where: any = { websiteId };
        if (crawlRunId) where.crawlRunId = crawlRunId;
        if (severity) where.severity = severity;
        if (eventType) where.eventType = eventType;

        const total = await prisma.seoEvent.count({ where });
        const rows = await prisma.seoEvent.findMany({
          where,
          orderBy: { detectedAt: 'desc' },
          skip: offset,
          take: limit,
        });
        return {
          total,
          events: rows.map((r) => ({
            ...r,
            crawlRunId: r.crawlRunId || undefined,
            beforeValue: r.beforeValue || undefined,
            afterValue: r.afterValue || undefined,
            deltaNotes: r.deltaNotes || undefined,
            detectedAt: r.detectedAt.toISOString(),
          })),
        };
      } catch {
        // Fallback
      }
    }

    let all = devSeoEvents.get(websiteId) || [];
    if (crawlRunId) all = all.filter((e) => e.crawlRunId === crawlRunId);
    if (severity) all = all.filter((e) => e.severity === severity);
    if (eventType) all = all.filter((e) => e.eventType === eventType);

    return {
      total: all.length,
      events: all.slice(offset, offset + limit),
    };
  }

  public static async getLinkEdges(
    crawlRunId: string,
    options: { offset?: number; limit?: number } = {}
  ): Promise<{ total: number; links: InternalLinkEdgeRecord[] }> {
    const { offset = 0, limit = 100 } = options;
    const prisma = getPrismaClient();

    if (prisma) {
      try {
        const total = await prisma.internalLinkEdge.count({ where: { crawlRunId } });
        const rows = await prisma.internalLinkEdge.findMany({
          where: { crawlRunId },
          skip: offset,
          take: limit,
        });
        return {
          total,
          links: rows.map((r) => ({
            ...r,
            sourceUrlIdentityId: r.sourceUrlIdentityId || undefined,
            targetUrlIdentityId: r.targetUrlIdentityId || undefined,
            anchorText: r.anchorText || undefined,
            rel: r.rel || undefined,
            targetStatusCode: r.targetStatusCode || undefined,
            createdAt: r.createdAt.toISOString(),
          })),
        };
      } catch {
        // Fallback
      }
    }

    const all = devLinkEdges.get(crawlRunId) || [];
    return {
      total: all.length,
      links: all.slice(offset, offset + limit),
    };
  }

  public static async getLatestCrawlRun(websiteId: string): Promise<CrawlRunRecord | null> {
    const runs = await this.listCrawlRuns(websiteId, { limit: 1 });
    return runs.runs.length > 0 ? runs.runs[0] : null;
  }

  public static async getLatestCrawledPages(
    websiteId: string,
    limit = 100
  ): Promise<{ total: number; pages: CrawledPageRecord[] }> {
    const latestRun = await this.getLatestCrawlRun(websiteId);
    if (!latestRun) {
      // Fallback default mocked seed for immediate analysis
      return {
        total: 1,
        pages: [
          {
            id: `p-${websiteId}-seed`,
            websiteId,
            crawlRunId: 'initial-run',
            url: `https://${websiteId}`,
            normalizedUrl: `https://${websiteId}`,
            pathname: '/',
            statusCode: 200,
            redirectCount: 0,
            loadTimeMs: 180,
            contentLengthBytes: 42000,
            isIndexable: true,
            indexabilityStatus: 'INDEXABLE',
            indexabilityReasons: [],
            canonicalMatch: true,
            canonicalUrl: `https://${websiteId}/`,
            title: `${websiteId} - AI Powered Operations`,
            titleLength: 35,
            metaDescription: `Official platform for ${websiteId} delivering high performance automation.`,
            metaDescLength: 72,
            h1Tags: [`Welcome to ${websiteId}`],
            h2Count: 4,
            h3Count: 8,
            wordCount: 1450,
            isExactDuplicate: false,
            isThinContent: false,
            isPossibleSoft404: false,
            soft404Confidence: 0,
            internalInlinksCount: 12,
            internalOutlinksCount: 18,
            externalOutlinksCount: 4,
            imagesCount: 6,
            missingAltCount: 0,
            schemaTypes: ['WebSite', 'Organization'],
            schemaStatus: 'VALID',
            crawlDepth: 0,
            crawledAt: new Date().toISOString(),
          },
        ],
      };
    }
    return this.getCrawledPages(latestRun.id, { limit });
  }

  public static async getLatestCrawlIssues(
    websiteId: string,
    limit = 200
  ): Promise<{ total: number; issues: CrawlIssueRecord[] }> {
    const latestRun = await this.getLatestCrawlRun(websiteId);
    if (!latestRun) {
      return { total: 0, issues: [] };
    }
    return this.getCrawlIssues(latestRun.id, { limit });
  }

  public static async getLatestLinkEdges(
    websiteId: string,
    limit = 200
  ): Promise<{ total: number; links: InternalLinkEdgeRecord[] }> {
    const latestRun = await this.getLatestCrawlRun(websiteId);
    if (!latestRun) {
      return { total: 0, links: [] };
    }
    return this.getLinkEdges(latestRun.id, { limit });
  }

  public static async clearForTesting(): Promise<void> {
    devUrlIdentities.clear();
    devCrawlRuns.clear();
    devCrawledPages.clear();
    devCrawlIssues.clear();
    devLinkEdges.clear();
    devSeoEvents.clear();
  }
}
