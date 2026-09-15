import { CrawledPageRecord, CrawlIssueRecord } from '../../repositories/crawlRepository';

export interface SitemapCoverageStats {
  sitemapsDiscovered: string[];
  totalSitemapUrls: number;
  sitemapUrlsCrawled: number;
  sitemapCoveragePercentage: number;
}

export interface SkippedUrlStats {
  totalSkipped: number;
  reasons: Record<string, number>;
  sampleUrls: string[];
}

export interface CrawlCoverageReport {
  websiteId: string;
  seedUrl: string;
  crawlRunId: string;
  discoveredUrls: number;
  pagesAnalyzed: number;
  crawlCoveragePercentage: number;
  sitemapCoverage: SitemapCoverageStats;
  skippedUrls: SkippedUrlStats;
  crawlConfidenceScore: number;
  confidenceBreakdown: {
    sampleAdequacyFactor: number;
    coverageFactor: number;
    fetchSuccessFactor: number;
    sitemapFactor: number;
  };
  isSufficientForAutonomousAction: boolean;
  autonomousSafetyStatus: 'APPROVED' | 'BLOCKED_LOW_CONFIDENCE' | 'BLOCKED_SMALL_SAMPLE';
  safetyMessage: string;
  analyzedAt: string;
}

export class CrawlCoverageAnalyzer {
  public static readonly MINIMUM_PAGES_FOR_AUTONOMOUS = 15;
  public static readonly MINIMUM_CONFIDENCE_FOR_AUTONOMOUS = 0.70;

  /**
   * Evaluates crawl coverage, sitemap integration, skipped URL counts, and statistical confidence.
   */
  public static analyzeCoverage(params: {
    websiteId: string;
    seedUrl: string;
    crawlRunId: string;
    pages: CrawledPageRecord[];
    issues: CrawlIssueRecord[];
    frontierDiscoveredUrls?: string[];
    sitemapsDiscovered?: string[];
    sitemapUrlsCount?: number;
    sitemapUrlsCrawledCount?: number;
    failedUrlsCount?: number;
    skippedUrlsList?: { url: string; reason: string }[];
  }): CrawlCoverageReport {
    const {
      websiteId,
      seedUrl,
      crawlRunId,
      pages,
      frontierDiscoveredUrls = [],
      sitemapsDiscovered = [],
      sitemapUrlsCount = 0,
      sitemapUrlsCrawledCount = 0,
      failedUrlsCount = 0,
      skippedUrlsList = [],
    } = params;

    const pagesAnalyzed = pages.length;

    // Build unique discovered set
    const allDiscovered = new Set<string>();
    for (const p of pages) {
      allDiscovered.add(p.normalizedUrl || p.url);
    }
    for (const u of frontierDiscoveredUrls) {
      allDiscovered.add(u);
    }
    const discoveredUrls = Math.max(pagesAnalyzed, allDiscovered.size);

    // Sitemap stats
    const effectiveSitemapUrls = Math.max(sitemapUrlsCount, sitemapsDiscovered.length > 0 ? 1 : 0);
    const sitemapCovPct =
      effectiveSitemapUrls > 0
        ? Number(Math.min(100, (sitemapUrlsCrawledCount / effectiveSitemapUrls) * 100).toFixed(1))
        : 0;

    const sitemapCoverage: SitemapCoverageStats = {
      sitemapsDiscovered,
      totalSitemapUrls: effectiveSitemapUrls,
      sitemapUrlsCrawled: sitemapUrlsCrawledCount,
      sitemapCoveragePercentage: sitemapCovPct,
    };

    // Skipped URLs stats
    const skippedReasons: Record<string, number> = {};
    const skippedSamples: string[] = [];
    for (const item of skippedUrlsList) {
      skippedReasons[item.reason] = (skippedReasons[item.reason] || 0) + 1;
      if (skippedSamples.length < 10) {
        skippedSamples.push(item.url);
      }
    }
    const totalSkipped = Math.max(skippedUrlsList.length, discoveredUrls - pagesAnalyzed);

    const skippedUrls: SkippedUrlStats = {
      totalSkipped,
      reasons: Object.keys(skippedReasons).length > 0 ? skippedReasons : { CRAWL_BUDGET_CAPPED: totalSkipped },
      sampleUrls: skippedSamples,
    };

    // Crawl coverage percentage
    const crawlCoveragePercentage = Number(
      discoveredUrls > 0 ? ((pagesAnalyzed / discoveredUrls) * 100).toFixed(2) : 0
    );

    // 1. Sample adequacy factor: 0 at 0, 0.25 at 5, 0.50 at 10, 0.75 at 15, 1.0 at 20+
    const sampleAdequacyFactor = Number(
      Math.min(1.0, Math.max(0.05, pagesAnalyzed / 20)).toFixed(3)
    );

    // 2. Coverage ratio factor: proportion of discovered URLs actually crawled
    const coverageFactor = Number(
      Math.min(1.0, Math.max(0.05, pagesAnalyzed / Math.max(pagesAnalyzed, discoveredUrls))).toFixed(3)
    );

    // 3. Fetch success factor: penalty for failed or timed out URLs
    const totalAttempted = pagesAnalyzed + failedUrlsCount;
    const fetchSuccessFactor = Number(
      (totalAttempted > 0 ? Math.max(0, 1.0 - failedUrlsCount / totalAttempted) : 1.0).toFixed(3)
    );

    // 4. Sitemap coverage factor
    const sitemapFactor = Number(
      (sitemapsDiscovered.length > 0 ? Math.max(0.4, sitemapCovPct / 100) : 0.6).toFixed(3)
    );

    // Composite crawl confidence score (0.00 to 1.00)
    const rawConfidence =
      0.40 * sampleAdequacyFactor +
      0.30 * coverageFactor +
      0.20 * fetchSuccessFactor +
      0.10 * sitemapFactor;

    const crawlConfidenceScore = Number(Math.min(1.0, Math.max(0.05, rawConfidence)).toFixed(3));

    // Determine autonomous readiness
    let autonomousSafetyStatus: 'APPROVED' | 'BLOCKED_LOW_CONFIDENCE' | 'BLOCKED_SMALL_SAMPLE' = 'APPROVED';
    let safetyMessage = 'Crawl coverage and confidence meet production standards for autonomous optimization.';

    if (pagesAnalyzed < this.MINIMUM_PAGES_FOR_AUTONOMOUS) {
      autonomousSafetyStatus = 'BLOCKED_SMALL_SAMPLE';
      safetyMessage = `Crawl sample size (${pagesAnalyzed} pages) is below minimum safety threshold of ${this.MINIMUM_PAGES_FOR_AUTONOMOUS} pages. Autonomous SEO actions are blocked to prevent unsafe site-wide changes.`;
    } else if (crawlConfidenceScore < this.MINIMUM_CONFIDENCE_FOR_AUTONOMOUS) {
      autonomousSafetyStatus = 'BLOCKED_LOW_CONFIDENCE';
      safetyMessage = `Crawl confidence score (${crawlConfidenceScore}) is below production threshold of ${this.MINIMUM_CONFIDENCE_FOR_AUTONOMOUS}. Discovered coverage (${crawlCoveragePercentage}%) is insufficient for autonomous execution.`;
    }

    return {
      websiteId,
      seedUrl,
      crawlRunId,
      discoveredUrls,
      pagesAnalyzed,
      crawlCoveragePercentage,
      sitemapCoverage,
      skippedUrls,
      crawlConfidenceScore,
      confidenceBreakdown: {
        sampleAdequacyFactor,
        coverageFactor,
        fetchSuccessFactor,
        sitemapFactor,
      },
      isSufficientForAutonomousAction: autonomousSafetyStatus === 'APPROVED',
      autonomousSafetyStatus,
      safetyMessage,
      analyzedAt: new Date().toISOString(),
    };
  }
}
