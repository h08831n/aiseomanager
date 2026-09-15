import { CrawlFrontier } from './crawlFrontier';
import { UrlNormalizer } from './urlNormalizer';
import { UrlScopePolicy, CrawlScopeConfig } from './urlScopePolicy';
import { RobotsService, ParsedRobotsTxt } from './robotsService';
import { SitemapService } from './sitemapService';
import { SafeUrlPolicy } from '../../security/safeUrlPolicy';
import { ComprehensiveHtmlParser } from './comprehensiveHtmlParser';
import { CanonicalAnalyzer } from './canonicalAnalyzer';
import { HreflangAnalyzer } from './hreflangAnalyzer';
import { Soft404Detector } from './soft404Detector';
import { IndexabilityAnalyzer } from './indexabilityAnalyzer';
import { DuplicateContentAnalyzer } from './duplicateContentAnalyzer';
import { LinkGraphBuilder, DiscoveredLink } from './linkGraphBuilder';
import { ExpandedTechnicalIssueDetector } from './expandedTechnicalIssueDetector';
import { CrawlSnapshotComparator, CrawledPageSnapshot } from './crawlSnapshotComparator';
import { CrawlCoverageAnalyzer, CrawlCoverageReport } from './crawlCoverageAnalyzer';
import {
  CrawlRepository,
  CrawledPageRecord,
  CrawlIssueRecord,
  InternalLinkEdgeRecord,
} from '../../repositories/crawlRepository';

export interface CrawlConfiguration {
  websiteId: string;
  seedUrl: string;
  userAgent?: string;
  maxUrls?: number;
  maxDepth?: number;
  maxConcurrency?: number;
  requestsPerSecond?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  respectRobots?: boolean;
  crawlSitemaps?: boolean;
  includeSubdomains?: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
}

export interface CrawlExecutionResult {
  crawlRunId: string;
  totalPages: number;
  totalIssues: number;
  durationMs: number;
  status: string;
  coverageReport: CrawlCoverageReport;
  crawledPages: CrawledPageRecord[];
  crawlIssues: CrawlIssueRecord[];
}

export class CrawlCoordinator {
  private static activeCrawlControllers: Map<string, AbortController> = new Map();
  private static pausedCrawls: Set<string> = new Set();

  public static async cancelCrawl(crawlRunId: string): Promise<boolean> {
    const controller = this.activeCrawlControllers.get(crawlRunId);
    this.pausedCrawls.delete(crawlRunId);
    if (controller) {
      controller.abort();
      this.activeCrawlControllers.delete(crawlRunId);
    }
    // Update repository state if crawl run is recorded
    await CrawlRepository.updateCrawlRun(crawlRunId, { status: 'CANCELLED', completedAt: new Date().toISOString() });
    return true;
  }

  public static pauseCrawl(crawlRunId: string): boolean {
    this.pausedCrawls.add(crawlRunId);
    CrawlRepository.updateCrawlRun(crawlRunId, { status: 'PAUSING' });
    return true;
  }

  public static resumeCrawl(crawlRunId: string): boolean {
    this.pausedCrawls.delete(crawlRunId);
    CrawlRepository.updateCrawlRun(crawlRunId, { status: 'RUNNING' });
    return true;
  }

  public static async executeCrawl(
    config: CrawlConfiguration,
    existingCrawlRunId?: string
  ): Promise<{
    crawlRunId: string;
    totalPages: number;
    totalIssues: number;
    durationMs: number;
    status: string;
    coverageReport: CrawlCoverageReport;
    crawledPages: CrawledPageRecord[];
    crawlIssues: CrawlIssueRecord[];
  }> {
    const {
      websiteId,
      seedUrl,
      userAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 (compatible; AISEOManagerBot/2.0)',
      maxUrls = 50,
      maxDepth = 3,
      requestTimeoutMs = 12000,
      maxResponseBytes = 4 * 1024 * 1024,
      maxRedirects = 5,
      respectRobots = true,
      crawlSitemaps = true,
      includeSubdomains = false,
      includePatterns = [],
      excludePatterns = [],
    } = config;

    const normalizedSeed = UrlNormalizer.normalize(seedUrl);
    const parsedSeed = new URL(normalizedSeed);
    const originUrl = `${parsedSeed.protocol}//${parsedSeed.host}`;

    let crawlRunId = existingCrawlRunId;
    if (!crawlRunId) {
      const crawlRun = await CrawlRepository.createCrawlRun({
        websiteId,
        seedUrl: normalizedSeed,
        config,
      });
      crawlRunId = crawlRun.id;
    }

    const abortController = new AbortController();
    this.activeCrawlControllers.set(crawlRunId, abortController);
    const startTime = Date.now();

    const scopeConfig: CrawlScopeConfig = {
      allowedHost: parsedSeed.hostname,
      allowSubdomains: includeSubdomains,
      includePatterns,
      excludePatterns,
      maxDepth,
    };

    const frontier = new CrawlFrontier(crawlRunId);
    let robotsParsed: ParsedRobotsTxt = { ruleGroups: [], sitemaps: [], rawContent: '' };

    // 1. Fetch & Parse robots.txt
    if (respectRobots) {
      const robotsRes = await RobotsService.fetchAndParseRobots(originUrl, userAgent);
      robotsParsed = robotsRes.parsed;
      await CrawlRepository.updateCrawlRun(crawlRunId, {
        robotsTxtStatus: robotsRes.fetchStatus ? `HTTP_${robotsRes.fetchStatus}` : 'FETCH_FAILED',
        robotsTxtHash: robotsParsed.rawContent ? DuplicateContentAnalyzer.generateExactHash(robotsParsed.rawContent) : undefined,
      });
    }

    // 2. Discover Sitemaps
    const sitemapsDiscovered: string[] = [];
    if (crawlSitemaps) {
      const candidateSitemaps = [
        ...robotsParsed.sitemaps,
        `${originUrl}/sitemap.xml`,
        `${originUrl}/sitemap_index.xml`,
      ];
      const uniqueSitemaps = Array.from(new Set(candidateSitemaps));

      for (const smUrl of uniqueSitemaps) {
        if ((await frontier.size()) >= maxUrls) break;
        const smResult = await SitemapService.discoverUrlsFromSitemap(smUrl);
        if (smResult.totalUrls > 0) {
          sitemapsDiscovered.push(smUrl);
          for (const discovered of smResult.discoveredUrls) {
            const scopeCheck = UrlScopePolicy.isUrlInScope(discovered.normalizedUrl, 1, scopeConfig);
            if (scopeCheck.allowed) {
              await frontier.enqueue(
                discovered.loc,
                discovered.normalizedUrl,
                1,
                'SITEMAP',
                discovered.priority ? Math.round(discovered.priority * 10) : 10
              );
            }
          }
        }
      }
    }

    // 3. Seed entrypoint and register stable UrlIdentity
    await CrawlRepository.getOrCreateUrlIdentity(websiteId, normalizedSeed, 'SEED');
    await frontier.enqueue(seedUrl, normalizedSeed, 0, 'SEED', 20);

    const crawledPagesBuffer: CrawledPageRecord[] = [];
    const discoveredLinkEdges: DiscoveredLink[] = [];
    const detectedIssuesBuffer: CrawlIssueRecord[] = [];
    let hadFetchErrors = false;

    // 4. Crawl Execution Loop
    try {
      while ((await frontier.size()) > 0 && crawledPagesBuffer.length < maxUrls) {
        if (abortController.signal.aborted) {
          await CrawlRepository.updateCrawlRun(crawlRunId, { status: 'CANCELLED', completedAt: new Date().toISOString() });
          this.activeCrawlControllers.delete(crawlRunId);
          const emptyCoverage: CrawlCoverageReport = {
            crawlRunId,
            websiteId,
            seedUrl,
            discoveredUrls: crawledPagesBuffer.length,
            pagesAnalyzed: crawledPagesBuffer.length,
            crawlCoveragePercentage: 100,
            sitemapCoverage: {
              sitemapsDiscovered: [],
              totalSitemapUrls: 0,
              sitemapUrlsCrawled: 0,
              sitemapCoveragePercentage: 100,
            },
            skippedUrls: { totalSkipped: 0, reasons: {}, sampleUrls: [] },
            crawlConfidenceScore: 0.1,
            confidenceBreakdown: {
              sampleAdequacyFactor: 0.1,
              coverageFactor: 0.1,
              fetchSuccessFactor: 0.1,
              sitemapFactor: 0.1,
            },
            isSufficientForAutonomousAction: false,
            autonomousSafetyStatus: 'BLOCKED_LOW_CONFIDENCE',
            safetyMessage: 'Crawl cancelled before completion',
            analyzedAt: new Date().toISOString(),
          };
          return {
            crawlRunId,
            totalPages: crawledPagesBuffer.length,
            totalIssues: detectedIssuesBuffer.length,
            durationMs: Date.now() - startTime,
            status: 'CANCELLED',
            coverageReport: emptyCoverage,
            crawledPages: crawledPagesBuffer,
            crawlIssues: detectedIssuesBuffer,
          };
        }

        while (this.pausedCrawls.has(crawlRunId)) {
          await new Promise((r) => setTimeout(r, 500));
          if (abortController.signal.aborted) break;
        }

        const nextItem = await frontier.dequeue();
        if (!nextItem) break;

        // Check Robots
        if (respectRobots) {
          const robotsCheck = RobotsService.isAllowed(robotsParsed, nextItem.url, userAgent);
          if (!robotsCheck.allowed) {
            await frontier.markBlocked(nextItem.normalizedUrl, 'ROBOTS');
            continue;
          }
        }

        // Rate Limiting Throttling
        const rps = config.requestsPerSecond || 10;
        const minIntervalMs = Math.max(10, Math.floor(1000 / rps));
        await new Promise((r) => setTimeout(r, minIntervalMs));

        // Safe Fetch with URL-level Retry
        let fetchResult: any;
        let attempt = 0;
        const maxRetries = 3;

        while (attempt < maxRetries) {
          try {
            fetchResult = await SafeUrlPolicy.safeFetch(nextItem.url, {
              timeoutMs: requestTimeoutMs,
              maxRedirects,
              maxResponseBytes,
              userAgent,
            });
            break;
          } catch (fetchErr: any) {
            attempt++;
            const errMsg = (fetchErr.message || '').toLowerCase();
            const isRetryable =
              errMsg.includes('timeout') ||
              errMsg.includes('502') ||
              errMsg.includes('503') ||
              errMsg.includes('504') ||
              errMsg.includes('429') ||
              errMsg.includes('econnreset') ||
              errMsg.includes('etimedout');

            if (!isRetryable || attempt >= maxRetries) {
              hadFetchErrors = true;
              await frontier.markFailed(nextItem.normalizedUrl, fetchErr.message);
              break;
            }
            await new Promise((r) => setTimeout(r, Math.min(2000, 150 * Math.pow(2, attempt))));
          }
        }

        if (!fetchResult) {
          continue;
        }

        // Comprehensive HTML Parsing
        const parsedHtml = ComprehensiveHtmlParser.parse(
          fetchResult.body,
          fetchResult.finalUrl,
          originUrl
        );

        // 5. Canonical Analysis
        const canonicalResult = CanonicalAnalyzer.analyze(
          fetchResult.finalUrl,
          parsedHtml.canonicalUrl,
          parsedHtml.canonicalTagsCount,
          originUrl
        );

        // 6. Hreflang Analysis
        const hreflangResult = HreflangAnalyzer.analyze(
          fetchResult.finalUrl,
          parsedHtml.hreflangs.map((h) => ({
            lang: h.lang,
            href: h.href,
            normalizedHref: UrlNormalizer.normalize(h.href, originUrl),
            isValidSyntax: true,
          }))
        );

        // 7. Soft 404 Detection
        const soft404Result = Soft404Detector.evaluate({
          statusCode: fetchResult.statusCode,
          title: parsedHtml.title || undefined,
          h1Tags: parsedHtml.h1Tags,
          visibleText: parsedHtml.visibleText,
          wordCount: parsedHtml.wordCount,
        });

        // 8. Indexability Evaluation
        const indexability = IndexabilityAnalyzer.evaluate({
          statusCode: fetchResult.statusCode,
          isNoIndexMeta: Boolean(parsedHtml.metaRobots && parsedHtml.metaRobots.toLowerCase().includes('noindex')),
          isNoIndexHeader: Boolean(fetchResult.headers['x-robots-tag'] && fetchResult.headers['x-robots-tag'].toLowerCase().includes('noindex')),
          isRobotsBlocked: false,
          hasCanonical: Boolean(canonicalResult.hasCanonical),
          isSelfCanonical: canonicalResult.isSelfCanonical,
          canonicalTargetUrl: canonicalResult.normalizedCanonical || undefined,
          isErrorStatus: fetchResult.statusCode >= 400,
        });

        // 9. Text Content Hash & SimHash on NORMALIZED VISIBLE TEXT (prevents markup diff churn)
        const normalizedText = parsedHtml.visibleText.toLowerCase().replace(/\s+/g, ' ').trim();
        const contentHash = DuplicateContentAnalyzer.generateExactHash(normalizedText);
        const simHash = DuplicateContentAnalyzer.generateSimHash64(normalizedText);

        const pageRecord: CrawledPageRecord = {
          id: `page-${crawledPagesBuffer.length + 1}`,
          websiteId,
          crawlRunId,
          url: nextItem.url,
          normalizedUrl: nextItem.normalizedUrl,
          pathname: new URL(nextItem.normalizedUrl).pathname,
          statusCode: fetchResult.statusCode,
          finalUrl: fetchResult.finalUrl,
          redirectCount: fetchResult.redirectCount,
          redirectChainJson: JSON.stringify(fetchResult.redirectChain || []),
          loadTimeMs: fetchResult.loadTimeMs,
          contentLengthBytes: fetchResult.rawBuffer ? fetchResult.rawBuffer.length : fetchResult.body.length,
          isIndexable: indexability.isIndexable,
          indexabilityStatus: indexability.indexabilityStatus,
          indexabilityReasons: indexability.reasons,
          canonicalUrl: canonicalResult.rawCanonical || undefined,
          normalizedCanonicalUrl: canonicalResult.normalizedCanonical || undefined,
          canonicalMatch: canonicalResult.isSelfCanonical,
          title: parsedHtml.title || undefined,
          titleLength: parsedHtml.title ? parsedHtml.title.length : 0,
          metaDescription: parsedHtml.metaDescription || undefined,
          metaDescLength: parsedHtml.metaDescription ? parsedHtml.metaDescription.length : 0,
          metaRobots: parsedHtml.metaRobots || undefined,
          xRobotsTag: fetchResult.headers['x-robots-tag'] || undefined,
          h1Tags: parsedHtml.h1Tags,
          h2Count: parsedHtml.h2Tags.length,
          h3Count: parsedHtml.h3Count,
          wordCount: parsedHtml.wordCount,
          contentHash,
          simHash,
          isExactDuplicate: false, // Calculated in batch duplicate clustering
          isThinContent: parsedHtml.wordCount < 120,
          isPossibleSoft404: soft404Result.isPossibleSoft404,
          soft404Confidence: soft404Result.confidenceScore,
          internalInlinksCount: 0,
          internalOutlinksCount: parsedHtml.internalLinks.length,
          externalOutlinksCount: parsedHtml.externalLinks.length,
          imagesCount: parsedHtml.images.length,
          missingAltCount: parsedHtml.missingAltCount,
          schemaTypes: parsedHtml.schemaTypes,
          schemaStatus: parsedHtml.schemaStatus,
          openGraphJson: JSON.stringify({ ogTitle: parsedHtml.ogTitle, ogDescription: parsedHtml.ogDescription, ogImage: parsedHtml.ogImage }),
          twitterCardJson: JSON.stringify({ twitterCard: parsedHtml.twitterCard }),
          hreflangsJson: JSON.stringify(parsedHtml.hreflangs),
          crawlDepth: nextItem.depth,
          crawledAt: new Date().toISOString(),
        };

        crawledPagesBuffer.push(pageRecord);
        await frontier.markCompleted(nextItem.normalizedUrl);

        // 10. Process and record full link graph (both internal AND external outlinks)
        for (const internalLink of parsedHtml.internalLinks) {
          try {
            const resolvedTarget = UrlNormalizer.resolveAndNormalize(internalLink.href, originUrl);
            discoveredLinkEdges.push({
              sourceUrl: nextItem.normalizedUrl,
              targetUrl: internalLink.href,
              normalizedTarget: resolvedTarget,
              anchorText: internalLink.anchorText,
              isInternal: true,
              isNofollow: internalLink.isNofollow,
              rel: internalLink.rel || undefined,
            });

            // Maintain UrlIdentity for link graph relationships
            await CrawlRepository.getOrCreateUrlIdentity(websiteId, resolvedTarget, 'HTML_LINK');

            const nextDepth = nextItem.depth + 1;
            const scopeCheck = UrlScopePolicy.isUrlInScope(resolvedTarget, nextDepth, scopeConfig);

            if (scopeCheck.allowed && !(await frontier.isVisited(resolvedTarget))) {
              await frontier.enqueue(internalLink.href, resolvedTarget, nextDepth, 'HTML_LINK', 10, nextItem.url);
            }
          } catch {
            // malformed target ignored
          }
        }

        // Persist external link edges with isInternal: false
        for (const externalLink of parsedHtml.externalLinks) {
          try {
            discoveredLinkEdges.push({
              sourceUrl: nextItem.normalizedUrl,
              targetUrl: externalLink.href,
              normalizedTarget: externalLink.href,
              anchorText: externalLink.anchorText,
              isInternal: false,
              isNofollow: externalLink.isNofollow,
              rel: externalLink.rel || undefined,
            });
          } catch {
            // ignore
          }
        }
      }

      // 10. Metadata Map for Technical Issue Detection
      const pageMetadataMap = new Map<
        string,
        {
          hasMultipleCanonicals: boolean;
          isMalformedCanonical: boolean;
          hreflangIssues: any[];
          redirectLoop: boolean;
          isDowngradeToHttp: boolean;
        }
      >();

      for (const item of crawledPagesBuffer) {
        // Find hreflangs & canonical metadata if present
        let parsedHreflangs: any[] = [];
        try {
          if (item.hreflangsJson) parsedHreflangs = JSON.parse(item.hreflangsJson);
        } catch {}

        const hreflangRes = HreflangAnalyzer.analyze(
          item.finalUrl || item.url,
          parsedHreflangs.map((h: any) => ({
            lang: h.lang,
            href: h.href,
            normalizedHref: UrlNormalizer.normalize(h.href, originUrl),
            isValidSyntax: true,
          }))
        );

        const canonicalRes = CanonicalAnalyzer.analyze(
          item.finalUrl || item.url,
          item.canonicalUrl || null,
          item.canonicalUrl ? 1 : 0,
          originUrl
        );

        pageMetadataMap.set(item.normalizedUrl, {
          hasMultipleCanonicals: canonicalRes.hasMultipleCanonicals,
          isMalformedCanonical: canonicalRes.isMalformed,
          hreflangIssues: hreflangRes.issues,
          redirectLoop: item.redirectCount > maxRedirects,
          isDowngradeToHttp: (item.url.startsWith('https://') && (item.finalUrl || '').startsWith('http://')),
        });
      }

      // 11. Exact Duplicate Content Grouping
      const contentGroups = new Map<string, CrawledPageRecord[]>();
      for (const page of crawledPagesBuffer) {
        if (page.contentHash) {
          const group = contentGroups.get(page.contentHash) || [];
          group.push(page);
          contentGroups.set(page.contentHash, group);
        }
      }

      for (const [hash, group] of contentGroups.entries()) {
        if (group.length > 1) {
          for (const page of group) {
            page.isExactDuplicate = true;
            page.duplicateClusterId = `dup-cluster-${hash.substring(0, 8)}`;
          }
        }
      }

      // 12. Complete Link Graph Resolution & Broken Link Status Detection
      const allCrawledMap = new Map<string, CrawledPageRecord>();
      for (const p of crawledPagesBuffer) {
        allCrawledMap.set(p.normalizedUrl, p);
      }

      const allKnownUrls = crawledPagesBuffer.map((p) => p.normalizedUrl);
      const graphNodes = LinkGraphBuilder.computeGraphMetrics(discoveredLinkEdges, [normalizedSeed], allKnownUrls);

      for (const page of crawledPagesBuffer) {
        const node = graphNodes.get(page.normalizedUrl);
        if (node) {
          page.internalInlinksCount = node.inlinksCount;
          page.internalOutlinksCount = node.outlinksCount;
          page.externalOutlinksCount = node.externalOutlinksCount;
          page.crawlDepth = node.crawlDepth;
        }

        const extraMeta = pageMetadataMap.get(page.normalizedUrl);

        // 13. Canonical Technical Issue Detection
        const evaluatedIssues = ExpandedTechnicalIssueDetector.detectIssues({
          url: page.url,
          statusCode: page.statusCode,
          title: page.title,
          metaDescription: page.metaDescription,
          h1Tags: page.h1Tags,
          wordCount: page.wordCount,
          isIndexable: page.isIndexable,
          metaRobots: page.metaRobots,
          xRobotsTag: page.xRobotsTag,
          canonicalUrl: page.canonicalUrl,
          canonicalMatch: page.canonicalMatch,
          hasMultipleCanonicals: extraMeta?.hasMultipleCanonicals,
          isMalformedCanonical: extraMeta?.isMalformedCanonical,
          redirectCount: page.redirectCount,
          redirectLoop: extraMeta?.redirectLoop,
          isDowngradeToHttp: extraMeta?.isDowngradeToHttp,
          imagesCount: page.imagesCount,
          missingAltCount: page.missingAltCount,
          schemaStatus: page.schemaStatus,
          schemaTypes: page.schemaTypes,
          isExactDuplicate: page.isExactDuplicate,
          isPossibleSoft404: page.isPossibleSoft404,
          soft404Confidence: page.soft404Confidence,
          isOrphanCandidate: node?.isOrphanCandidate,
          crawlDepth: page.crawlDepth,
          hreflangIssues: extraMeta?.hreflangIssues,
        });

        for (const issue of evaluatedIssues) {
          detectedIssuesBuffer.push({
            id: `issue-${detectedIssuesBuffer.length + 1}`,
            crawlRunId,
            ruleKey: issue.ruleKey,
            ruleVersion: issue.ruleVersion,
            type: issue.type,
            severity: issue.severity,
            message: issue.message,
            evidence: JSON.stringify(issue.evidence),
            impact: issue.impact,
            resolved: false,
            createdAt: new Date().toISOString(),
          });
        }
      }

      // 14. Broken Internal Link Resolution
      const linkEdgeRecords: InternalLinkEdgeRecord[] = discoveredLinkEdges.map((e, idx) => {
        const targetPage = allCrawledMap.get(e.normalizedTarget);
        const targetStatus = targetPage ? targetPage.statusCode : undefined;
        const isBroken = targetStatus ? targetStatus >= 400 : false;

        if (isBroken) {
          detectedIssuesBuffer.push({
            id: `issue-broken-link-${idx}`,
            crawlRunId,
            ruleKey: 'RULE_BROKEN_INTERNAL_LINK',
            ruleVersion: ExpandedTechnicalIssueDetector.VERSION,
            type: 'BROKEN_INTERNAL_LINK',
            severity: 'HIGH',
            message: `Internal link from ${e.sourceUrl} targets broken URL (${targetStatus})`,
            evidence: JSON.stringify({
              sourceUrl: e.sourceUrl,
              targetUrl: e.targetUrl,
              anchorText: e.anchorText,
              targetStatusCode: targetStatus,
            }),
            impact: 'Wastes crawl budget and disrupts user navigation.',
            resolved: false,
            createdAt: new Date().toISOString(),
          });
        }

        return {
          id: `edge-${idx + 1}`,
          crawlRunId,
          sourceUrl: e.sourceUrl,
          targetUrl: e.targetUrl,
          normalizedTarget: e.normalizedTarget,
          anchorText: e.anchorText,
          isInternal: e.isInternal,
          rel: e.rel,
          isNofollow: e.isNofollow,
          targetStatusCode: targetStatus,
          isBroken,
          createdAt: new Date().toISOString(),
        };
      });

      // 15. Persist Pages, Issues, Link Edges to Repository
      await CrawlRepository.saveCrawledPagesBatch(crawlRunId, websiteId, crawledPagesBuffer);
      await CrawlRepository.saveIssuesBatch(crawlRunId, detectedIssuesBuffer);
      await CrawlRepository.saveLinkEdgesBatch(crawlRunId, linkEdgeRecords);

      // 16. Historical Snapshot Comparison & SEO Event Generation (Paginated Retrieval)
      const previousRuns = await CrawlRepository.listCrawlRuns(websiteId);
      const lastCompleted = previousRuns.runs.find(
        (r) => r.id !== crawlRunId && (r.status === 'COMPLETED' || r.status === 'COMPLETED_WITH_ERRORS')
      );

      if (lastCompleted) {
        let offset = 0;
        const limit = 500;
        const previousPages: CrawledPageRecord[] = [];

        while (true) {
          const pageBatch = await CrawlRepository.getCrawledPages(lastCompleted.id, { offset, limit });
          previousPages.push(...pageBatch.pages);
          if (previousPages.length >= pageBatch.total || pageBatch.pages.length === 0) {
            break;
          }
          offset += limit;
        }

        const currSnapshots: CrawledPageSnapshot[] = crawledPagesBuffer.map((p) => ({
          url: p.url,
          normalizedUrl: p.normalizedUrl,
          statusCode: p.statusCode,
          finalUrl: p.finalUrl,
          title: p.title,
          metaDescription: p.metaDescription,
          h1Tags: p.h1Tags,
          canonicalUrl: p.canonicalUrl,
          metaRobots: p.metaRobots,
          xRobotsTag: p.xRobotsTag,
          isIndexable: p.isIndexable,
          contentHash: p.contentHash,
          inlinksCount: p.internalInlinksCount,
        }));

        const prevSnapshots: CrawledPageSnapshot[] = previousPages.map((p) => ({
          url: p.url,
          normalizedUrl: p.normalizedUrl,
          statusCode: p.statusCode,
          finalUrl: p.finalUrl,
          title: p.title,
          metaDescription: p.metaDescription,
          h1Tags: p.h1Tags,
          canonicalUrl: p.canonicalUrl,
          metaRobots: p.metaRobots,
          xRobotsTag: p.xRobotsTag,
          isIndexable: p.isIndexable,
          contentHash: p.contentHash,
          inlinksCount: p.internalInlinksCount,
        }));

        const events = CrawlSnapshotComparator.compareSnapshots(websiteId, crawlRunId, currSnapshots, prevSnapshots);
        if (events.length > 0) {
          await CrawlRepository.saveSeoEventsBatch(
            websiteId,
            events.map((ev) => ({
              websiteId,
              crawlRunId,
              eventType: ev.eventType,
              entityType: ev.entityType,
              entityUrl: ev.entityUrl,
              beforeValue: ev.beforeValue,
              afterValue: ev.afterValue,
              deltaNotes: ev.deltaNotes,
              severity: ev.severity,
              source: ev.source,
              detectedAt: new Date().toISOString(),
            }))
          );
        }
      }

      // 17. Final Status Determination
      const terminalStatus = hadFetchErrors ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
      const durationMs = Date.now() - startTime;
      const allFrontierItems = await frontier.getAllItems();

      const failedItems = allFrontierItems.filter((i) => i.status === 'FAILED');
      const skippedItems = allFrontierItems
        .filter((i) => i.status !== 'FETCHED' && i.status !== 'FAILED')
        .map((i) => ({ url: i.url, reason: i.status === 'BLOCKED_ROBOTS' ? 'ROBOTS_DISALLOWED' : 'CRAWL_BUDGET_CAPPED' }));

      const sitemapItems = allFrontierItems.filter((i) => i.discoverySource === 'SITEMAP');
      const sitemapCrawledCount = crawledPagesBuffer.filter((p) =>
        sitemapItems.some((s) => s.normalizedUrl === p.normalizedUrl)
      ).length;

      const coverageReport = CrawlCoverageAnalyzer.analyzeCoverage({
        websiteId,
        seedUrl,
        crawlRunId,
        pages: crawledPagesBuffer,
        issues: detectedIssuesBuffer,
        frontierDiscoveredUrls: allFrontierItems.map((i) => i.normalizedUrl),
        sitemapsDiscovered,
        sitemapUrlsCount: sitemapItems.length,
        sitemapUrlsCrawledCount: sitemapCrawledCount,
        failedUrlsCount: failedItems.length,
        skippedUrlsList: skippedItems,
      });

      await CrawlRepository.updateCrawlRun(crawlRunId, {
        status: terminalStatus,
        completedAt: new Date().toISOString(),
        durationMs,
        totalPages: crawledPagesBuffer.length,
        totalIssues: detectedIssuesBuffer.length,
        urlsDiscovered: coverageReport.discoveredUrls,
        urlsFetched: crawledPagesBuffer.length,
        urlsSkipped: coverageReport.skippedUrls.totalSkipped,
        urlsFailed: failedItems.length,
        sitemapsDiscovered,
      });

      this.activeCrawlControllers.delete(crawlRunId);

      return {
        crawlRunId,
        totalPages: crawledPagesBuffer.length,
        totalIssues: detectedIssuesBuffer.length,
        durationMs,
        status: terminalStatus,
        coverageReport,
        crawledPages: crawledPagesBuffer,
        crawlIssues: detectedIssuesBuffer,
      };
    } catch (err: any) {
      await CrawlRepository.updateCrawlRun(crawlRunId, {
        status: 'FAILED',
        completedAt: new Date().toISOString(),
      });
      this.activeCrawlControllers.delete(crawlRunId);
      throw err;
    }
  }
}
