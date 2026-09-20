import { prisma } from '../../db/prisma';
import { OutboxDispatcher } from '../outbox/outboxDispatcher';

export interface AttributionLineageContext {
  actionExecutionId: string;
  websiteId: string;
  targetUrl: string;
  normalizedUrl: string;
  urlIdentityId?: string;
  primaryKeywordId?: string;
  primaryKeywordText?: string;
  ruleKey: string;
  cmsProvider: string;
  pageArchetype: string;
  executedAt: Date;
  seoEventId?: string;
}

export class AttributionLineageService {
  /**
   * Normalizes a URL to a consistent key format (lowercase host + path, stripped UTM & trailing slash).
   */
  public static normalizeUrl(urlStr: string): { normalizedUrl: string; pathname: string } {
    try {
      const parsed = new URL(urlStr.startsWith('http') ? urlStr : `https://${urlStr}`);
      const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
      const normalizedUrl = `${parsed.protocol}//${parsed.hostname.toLowerCase()}${pathname}`;
      return { normalizedUrl, pathname };
    } catch {
      const cleaned = urlStr.trim().toLowerCase().replace(/\/+$/, '');
      return { normalizedUrl: cleaned, pathname: cleaned.replace(/^https?:\/\/[^\/]+/, '') || '/' };
    }
  }

  /**
   * Derives or resolves the Page Archetype from URL structure.
   */
  public static derivePageArchetype(pathname: string): string {
    const lower = pathname.toLowerCase();
    if (lower === '/' || lower === '') return 'HOMEPAGE';
    if (lower.includes('/product/') || lower.includes('/item/') || lower.includes('/p/')) return 'PRODUCT_PAGE';
    if (lower.includes('/category/') || lower.includes('/collection/') || lower.includes('/c/')) return 'CATEGORY_HUB';
    if (lower.includes('/blog/') || lower.includes('/article/') || lower.includes('/post/')) return 'BLOG_POST';
    if (lower.includes('/pricing') || lower.includes('/plans')) return 'PRICING_PAGE';
    if (lower.includes('/docs/') || lower.includes('/guide/') || lower.includes('/kb/')) return 'DOCUMENTATION';
    return 'GENERAL_CONTENT';
  }

  /**
   * Traces and builds the complete lineage chain for an ActionExecution:
   * ActionExecution -> UrlIdentity -> Primary Keyword / Cluster -> SeoEvent History
   */
  public static async resolveLineage(actionExecutionId: string): Promise<AttributionLineageContext> {
    const execution = await prisma.actionExecution.findUnique({
      where: { id: actionExecutionId },
      include: {
        task: true,
        recommendation: true,
        website: true,
      },
    });

    if (!execution) {
      throw new Error(`ActionExecution '${actionExecutionId}' not found for lineage resolution.`);
    }

    // Resolve recommendation explicitly if not populated in mock/runtime
    let recommendation = execution.recommendation;
    if (!recommendation && execution.recommendationId) {
      recommendation = await prisma.seoRecommendation.findUnique({
        where: { id: execution.recommendationId },
      });
    }

    let task = execution.task;
    if (!task && execution.taskId) {
      task = await prisma.seoTask.findUnique({
        where: { id: execution.taskId },
      });
    }

    const { websiteId, targetUrl, actionType } = execution;
    const { normalizedUrl, pathname } = this.normalizeUrl(targetUrl);
    const ruleKey = recommendation?.ruleKey || task?.category || actionType;
    const pageArchetype = this.derivePageArchetype(pathname);

    // 1. Resolve or match UrlIdentity
    let urlIdentity = await prisma.urlIdentity.findFirst({
      where: { websiteId, normalizedUrl },
    });

    if (!urlIdentity) {
      urlIdentity = await prisma.urlIdentity.create({
        data: {
          websiteId,
          normalizedUrl,
          pathname,
          firstDiscoveredAt: new Date(),
          lastSeenAt: new Date(),
          discoverySources: ['ACTION_EXECUTION'],
        },
      });
    }

    // 2. Discover primary target keyword for this URL Identity
    // Strategy A: Check keyword universe explicitly bound to this targetUrl or targetUrlIdentityId
    let primaryKeyword = await prisma.keywordUniverse.findFirst({
      where: {
        websiteId,
        OR: [
          { targetUrlIdentityId: urlIdentity.id },
          { targetUrl: normalizedUrl },
          { targetUrl },
        ],
      },
      orderBy: [
        { businessValue: 'asc' }, // TIER_1_CRITICAL comes first
        { searchVolume: 'desc' },
      ],
    });

    // Strategy B: Fallback to GSC facts top query for this URL
    if (!primaryKeyword) {
      const topGscFact = await prisma.gscSearchAnalyticsFact.findFirst({
        where: {
          websiteId,
          OR: [{ urlIdentityId: urlIdentity.id }, { pageUrl: normalizedUrl }],
          query: { not: null },
        },
        orderBy: [{ clicks: 'desc' }, { impressions: 'desc' }],
      });

      if (topGscFact?.query) {
        const normalizedKw = topGscFact.query.trim().toLowerCase();
        primaryKeyword = await prisma.keywordUniverse.findFirst({
          where: { websiteId, normalizedKeyword: normalizedKw },
        });

        if (!primaryKeyword) {
          // Register keyword in universe
          primaryKeyword = await prisma.keywordUniverse.create({
            data: {
              websiteId,
              keyword: topGscFact.query,
              normalizedKeyword: normalizedKw,
              targetUrl: normalizedUrl,
              targetUrlIdentityId: urlIdentity.id,
              searchIntent: 'INFORMATIONAL',
              discoverySource: 'GSC_INGESTION',
              provenanceSource: 'ATTRIBUTION_LINEAGE_RESOLVER',
              provenanceMethod: 'GSC_TOP_QUERY_MATCH',
            },
          });
        }
      }
    }

    // 3. Integrate with SeoEvent timeline: check if already linked or find/create SeoEvent
    let seoEvent = (execution as any).seoEventId
      ? await prisma.seoEvent.findUnique({ where: { id: (execution as any).seoEventId } })
      : null;

    if (!seoEvent) {
      const eventFingerprint = `action_exec:${execution.id}`;
      seoEvent = await prisma.seoEvent.findFirst({
        where: { websiteId, eventFingerprint },
      });

      if (!seoEvent) {
        seoEvent = await prisma.seoEvent.create({
          data: {
            websiteId,
            eventType: 'ACTION_VERIFIED_COMPLETED',
            entityType: 'URL',
            entityUrl: targetUrl,
            beforeValue: execution.beforeEvidenceJson || null,
            afterValue: execution.afterEvidenceJson || null,
            deltaNotes: `Action ${actionType} verified on ${targetUrl}. Primed for attribution lag tracking.`,
            details: JSON.stringify({
              actionExecutionId: execution.id,
              ruleKey,
              pageArchetype,
              primaryKeywordId: primaryKeyword?.id || null,
              primaryKeywordText: primaryKeyword?.keyword || null,
            }),
            severity: 'INFO',
            source: 'ACTION_ORCHESTRATOR',
            provenance: 'INTERNAL_DIAGNOSTIC',
            eventFingerprint,
            detectedAt: execution.verifiedAt || execution.executedAt || new Date(),
          },
        });
      }
    }

    // CMS Provider detection (defaulting to custom API / detected platform)
    const cmsProvider = (execution as any).platform || 'CUSTOM_API';

    return {
      actionExecutionId: execution.id,
      websiteId,
      targetUrl,
      normalizedUrl,
      urlIdentityId: urlIdentity.id,
      primaryKeywordId: primaryKeyword?.id,
      primaryKeywordText: primaryKeyword?.keyword,
      ruleKey,
      cmsProvider,
      pageArchetype,
      executedAt: execution.executedAt || execution.createdAt,
      seoEventId: seoEvent.id,
    };
  }
}
