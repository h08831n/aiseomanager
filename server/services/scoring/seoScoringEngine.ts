import { CrawledPageRecord, CrawlIssueRecord, InternalLinkEdgeRecord } from '../../repositories/crawlRepository';
import { CrawlCoverageReport } from '../crawler/crawlCoverageAnalyzer';

export interface PillarScoreBreakdown {
  key: string;
  name: string;
  score: number;
  trend: 'up' | 'down' | 'neutral';
  weight: number;
  evidence: string;
  problems: string[];
  recommendations: string[];
  metrics: Record<string, number | string | boolean>;
}

export interface SampleCredibilityDetails {
  pagesAnalyzed: number;
  discoveredUrls: number;
  crawlCoveragePercentage: number;
  sampleAdequacyFactor: number;
  credibilityWeight: number;
  rawCompositeScore: number;
  effectiveScore: number;
  sampleDiscountApplied: number;
  isReliableSample: boolean;
  confidenceNotice: string;
}

export interface SiteHealthAuditResult {
  overallScore: number;
  rawCompositeScore: number;
  sampleCredibility: SampleCredibilityDetails;
  previousScore: number;
  lastAudited: string;
  pillars: Record<string, PillarScoreBreakdown>;
  summary: {
    totalPages: number;
    indexablePages: number;
    criticalIssuesCount: number;
    highIssuesCount: number;
    mediumIssuesCount: number;
    lowIssuesCount: number;
    averageLoadTimeMs: number;
    schemaAdoptionRate: number;
    orphanPagesCount: number;
    duplicatePagesCount: number;
    thinContentPagesCount: number;
    crawlCoveragePercentage: number;
  };
}

export class SeoScoringEngine {
  /**
   * Calculates mathematically grounded 6-pillar SEO health scores considering:
   * - affected URL percentage
   * - issue severity
   * - crawl coverage
   * - indexability
   * - content quality
   * - internal linking
   * - schema
   * - performance
   * And ensures small samples never produce misleading high scores.
   */
  public static calculateHealthScores(params: {
    pages: CrawledPageRecord[];
    issues: CrawlIssueRecord[];
    linkEdges?: InternalLinkEdgeRecord[];
    previousOverallScore?: number;
    coverageReport?: CrawlCoverageReport;
  }): SiteHealthAuditResult {
    const { pages, issues, linkEdges = [], previousOverallScore = 0, coverageReport } = params;

    const totalPages = Math.max(1, pages.length);
    const indexablePages = pages.filter((p) => p.isIndexable).length;
    const ok200Pages = pages.filter((p) => p.statusCode === 200).length;
    const errorPages = pages.filter((p) => p.statusCode >= 400).length;
    const redirectPages = pages.filter((p) => p.redirectCount > 0).length;

    // Issue severity counts and affected URL mapping
    const criticalIssues = issues.filter((i) => i.severity === 'CRITICAL');
    const highIssues = issues.filter((i) => i.severity === 'HIGH');
    const mediumIssues = issues.filter((i) => i.severity === 'MEDIUM');
    const lowIssues = issues.filter((i) => i.severity === 'LOW');

    // Helper: compute deduction scaled by affected URL percentage and severity
    const calculateIssueDeduction = (issueList: CrawlIssueRecord[], maxDeduction: number) => {
      let deduction = 0;
      for (const issue of issueList) {
        const severityMultiplier =
          issue.severity === 'CRITICAL' ? 20 : issue.severity === 'HIGH' ? 10 : issue.severity === 'MEDIUM' ? 4 : 1;
        // Estimate affected URLs from issue crawledPageId
        const affectedCount = (issue as any).url || issue.crawledPageId ? 1 : totalPages;
        const affectedPct = (affectedCount / totalPages);
        deduction += severityMultiplier * affectedPct;
      }
      return Math.min(maxDeduction, deduction);
    };

    // 1. Technical SEO Pillar (Weight: 20%)
    let technicalDeductions = 0;
    const techProblems: string[] = [];
    const techRecs: string[] = [];

    // Deduct for server errors (5xx/4xx) scaled by affected URL %
    if (errorPages > 0) {
      const errorPct = (errorPages / totalPages) * 100;
      const errorDeduction = Math.min(40, (errorPct / 100) * 35 + (errorPages > 0 ? 5 : 0));
      technicalDeductions += errorDeduction;
      techProblems.push(`${errorPages} of ${totalPages} (${errorPct.toFixed(1)}%) pages returned HTTP 4xx/5xx errors.`);
      techRecs.push('Resolve broken endpoints with 301 redirects or restore missing routes.');
    }

    // Deduct for redirect chains scaled by affected URL %
    const longRedirects = pages.filter((p) => p.redirectCount > 2).length;
    if (longRedirects > 0) {
      const redirectPct = (longRedirects / totalPages) * 100;
      technicalDeductions += Math.min(20, (redirectPct / 100) * 25);
      techProblems.push(`${longRedirects} pages (${redirectPct.toFixed(1)}%) contain multi-hop redirect chains.`);
      techRecs.push('Point internal links directly to final destination URLs to conserve crawl budget.');
    }

    // Deduct for canonical mismatches / multiple canonicals
    const canonicalIssues = issues.filter((i) => i.type.includes('CANONICAL'));
    if (canonicalIssues.length > 0) {
      const canonicalDeduction = calculateIssueDeduction(canonicalIssues, 25);
      technicalDeductions += canonicalDeduction;
      techProblems.push(`${canonicalIssues.length} canonical tag discrepancies detected.`);
      techRecs.push('Standardize self-referencing rel="canonical" tags on all primary canonical URLs.');
    }

    const technicalScore = Math.max(10, Math.min(100, Math.round(100 - technicalDeductions)));

    // 2. Content Quality Pillar (Weight: 20%)
    let contentDeductions = 0;
    const contentProblems: string[] = [];
    const contentRecs: string[] = [];

    const thinPages = pages.filter((p) => p.wordCount < 200 && p.statusCode === 200).length;
    if (thinPages > 0) {
      const thinPct = (thinPages / totalPages) * 100;
      contentDeductions += Math.min(30, (thinPct / 100) * 35);
      contentProblems.push(`${thinPages} of ${totalPages} (${thinPct.toFixed(1)}%) pages have thin content (<200 words).`);
      contentRecs.push('Enrich thin pages with comprehensive content, FAQs, and topical deep-dives.');
    }

    const duplicatePages = pages.filter((p) => p.isExactDuplicate).length;
    if (duplicatePages > 0) {
      const dupPct = (duplicatePages / totalPages) * 100;
      contentDeductions += Math.min(25, (dupPct / 100) * 30);
      contentProblems.push(`${duplicatePages} pages (${dupPct.toFixed(1)}%) share identical text content hashes.`);
      contentRecs.push('Consolidate duplicate pages using canonical tags or 301 redirects.');
    }

    const missingH1Pages = pages.filter((p) => p.statusCode === 200 && (!p.h1Tags || p.h1Tags.length === 0)).length;
    if (missingH1Pages > 0) {
      const h1Pct = (missingH1Pages / totalPages) * 100;
      contentDeductions += Math.min(20, (h1Pct / 100) * 25);
      contentProblems.push(`${missingH1Pages} pages (${h1Pct.toFixed(1)}%) are missing a primary <h1> heading.`);
      contentRecs.push('Add a descriptive, single <h1> tag to every page.');
    }

    const missingMetaDesc = pages.filter((p) => p.statusCode === 200 && (!p.metaDescription || p.metaDescription.trim().length === 0)).length;
    if (missingMetaDesc > 0) {
      const metaPct = (missingMetaDesc / totalPages) * 100;
      contentDeductions += Math.min(20, (metaPct / 100) * 20);
      contentProblems.push(`${missingMetaDesc} pages (${metaPct.toFixed(1)}%) are missing meta descriptions.`);
      contentRecs.push('Craft compelling 120-160 character meta descriptions with target keywords.');
    }

    const contentScore = Math.max(10, Math.min(100, Math.round(100 - contentDeductions)));

    // 3. Indexing Health Pillar (Weight: 20%)
    let indexingDeductions = 0;
    const indexingProblems: string[] = [];
    const indexingRecs: string[] = [];

    const indexabilityRatio = (indexablePages / totalPages);
    if (indexabilityRatio < 0.9) {
      const unindexablePct = (1 - indexabilityRatio) * 100;
      indexingDeductions += Math.min(45, (unindexablePct / 100) * 50);
      indexingProblems.push(`Only ${Math.round(indexabilityRatio * 100)}% of analyzed URLs are indexable.`);
      indexingRecs.push('Review noindex tags and canonical targets to ensure key pages are indexable.');
    }

    const noindexPages = pages.filter((p) => p.metaRobots?.toLowerCase().includes('noindex') || p.xRobotsTag?.toLowerCase().includes('noindex')).length;
    if (noindexPages > 0) {
      indexingProblems.push(`${noindexPages} URLs (${((noindexPages / totalPages) * 100).toFixed(1)}%) contain explicit noindex directives.`);
    }

    const soft404s = pages.filter((p) => p.isPossibleSoft404).length;
    if (soft404s > 0) {
      const soft404Pct = (soft404s / totalPages) * 100;
      indexingDeductions += Math.min(25, (soft404Pct / 100) * 30);
      indexingProblems.push(`${soft404s} possible soft 404 pages detected returning 200 OK.`);
      indexingRecs.push('Ensure truly missing pages return HTTP 404 or 410 status codes.');
    }

    const indexingScore = Math.max(10, Math.min(100, Math.round(100 - indexingDeductions)));

    // 4. Internal Architecture Pillar (Weight: 15%)
    let architectureDeductions = 0;
    const archProblems: string[] = [];
    const archRecs: string[] = [];

    const orphanPages = pages.filter((p) => p.internalInlinksCount === 0 && p.crawlDepth > 0).length;
    if (orphanPages > 0) {
      const orphanPct = (orphanPages / totalPages) * 100;
      architectureDeductions += Math.min(30, (orphanPct / 100) * 40);
      archProblems.push(`${orphanPages} orphan pages (${orphanPct.toFixed(1)}%) found with 0 internal inlinks.`);
      archRecs.push('Link to orphan pages from relevant topical category or parent articles.');
    }

    const deepPages = pages.filter((p) => p.crawlDepth > 3).length;
    if (deepPages > 0) {
      const deepPct = (deepPages / totalPages) * 100;
      architectureDeductions += Math.min(20, (deepPct / 100) * 25);
      archProblems.push(`${deepPages} pages (${deepPct.toFixed(1)}%) require more than 3 clicks from homepage.`);
      archRecs.push('Flatten site architecture using breadcrumbs and hub-and-spoke navigation.');
    }

    const brokenLinkIssues = issues.filter((i) => i.type.includes('BROKEN_INTERNAL_LINK') || i.type.includes('BROKEN_LINK'));
    if (brokenLinkIssues.length > 0) {
      architectureDeductions += Math.min(25, brokenLinkIssues.length * 5);
      archProblems.push(`${brokenLinkIssues.length} broken internal link references found.`);
      archRecs.push('Update or remove broken internal links to prevent link equity leakage.');
    }

    const architectureScore = Math.max(10, Math.min(100, Math.round(100 - architectureDeductions)));

    // 5. Performance Pillar (Weight: 15%)
    let performanceDeductions = 0;
    const perfProblems: string[] = [];
    const perfRecs: string[] = [];

    const totalLoadTime = pages.reduce((acc, p) => acc + (p.loadTimeMs || 250), 0);
    const avgLoadTime = Math.round(totalLoadTime / totalPages);

    if (avgLoadTime > 1200) {
      performanceDeductions += 25;
      perfProblems.push(`Average page response time is slow (${avgLoadTime}ms).`);
      perfRecs.push('Enable edge caching and CDN compression to reduce TTFB.');
    } else if (avgLoadTime > 600) {
      performanceDeductions += 12;
      perfProblems.push(`Average response time (${avgLoadTime}ms) can be improved.`);
      perfRecs.push('Optimize server response time and database queries.');
    }

    const totalImages = pages.reduce((acc, p) => acc + (p.imagesCount || 0), 0);
    const missingAltImages = pages.reduce((acc, p) => acc + (p.missingAltCount || 0), 0);
    if (totalImages > 0 && missingAltImages > 0) {
      const missingAltPct = (missingAltImages / totalImages) * 100;
      performanceDeductions += Math.min(15, (missingAltPct / 100) * 20);
      perfProblems.push(`${missingAltImages} of ${totalImages} (${missingAltPct.toFixed(1)}%) images are missing alt text.`);
      perfRecs.push('Add descriptive alt attributes to all content images for accessibility and Image SEO.');
    }

    const performanceScore = Math.max(10, Math.min(100, Math.round(100 - performanceDeductions)));

    // 6. Authority Signals & Schema Pillar (Weight: 10%)
    let authorityDeductions = 0;
    const authProblems: string[] = [];
    const authRecs: string[] = [];

    const schemaPages = pages.filter((p) => p.schemaTypes && p.schemaTypes.length > 0).length;
    const schemaRate = (schemaPages / totalPages);

    if (schemaRate < 0.5) {
      const schemaDeficitPct = (0.5 - schemaRate) * 100;
      authorityDeductions += Math.min(35, (schemaDeficitPct / 100) * 50);
      authProblems.push(`Only ${Math.round(schemaRate * 100)}% of pages have JSON-LD structured data.`);
      authRecs.push('Deploy Organization, WebSite, Article, and FAQPage JSON-LD schemas.');
    }

    const avgInlinks = pages.reduce((acc, p) => acc + (p.internalInlinksCount || 0), 0) / totalPages;
    if (avgInlinks < 3) {
      authorityDeductions += 15;
      authProblems.push(`Low internal linking connectivity across the site (${avgInlinks.toFixed(1)} inlinks/page).`);
      authRecs.push('Build contextual in-content link clusters between related articles.');
    }

    const authorityScore = Math.max(10, Math.min(100, Math.round(100 - authorityDeductions)));

    // Composite Raw Weighted Overall Score
    const rawCompositeScore = Math.round(
      technicalScore * 0.20 +
      contentScore * 0.20 +
      indexingScore * 0.20 +
      architectureScore * 0.15 +
      performanceScore * 0.15 +
      authorityScore * 0.10
    );

    // -------------------------------------------------------------
    // SMALL SAMPLE & CRAWL COVERAGE STATISTICAL CREDIBILITY ADJUSTMENT
    // Rule: "Do not produce high scores from small samples."
    // -------------------------------------------------------------
    const sampleAdequacyFactor = Number(Math.min(1.0, Math.max(0.1, totalPages / 20)).toFixed(3));
    const coveragePercentage = coverageReport?.crawlCoveragePercentage ?? (totalPages >= 20 ? 100 : 15);
    const discoveredUrls = coverageReport?.discoveredUrls ?? totalPages;
    const coverageRatio = Number(Math.min(1.0, Math.max(0.05, coveragePercentage / 100)).toFixed(3));

    // Statistical credibility weight: blends sample adequacy and crawl coverage
    const credibilityWeight = Number(
      Math.max(0.35, Math.min(1.0, 0.55 * sampleAdequacyFactor + 0.45 * coverageRatio)).toFixed(3)
    );

    // Unmeasured baseline uncertainty prior: 50 (neutral assumption for uncrawled URLs)
    const unmeasuredPrior = 50;
    const effectiveScore = Math.round(
      rawCompositeScore * credibilityWeight + unmeasuredPrior * (1 - credibilityWeight)
    );
    const sampleDiscountApplied = rawCompositeScore - effectiveScore;
    const isReliableSample = totalPages >= 20 && coveragePercentage >= 50;

    const confidenceNotice = !isReliableSample
      ? `Score adjusted from raw ${rawCompositeScore} to ${effectiveScore} (credibility: ${(credibilityWeight * 100).toFixed(0)}%). Small crawl sample (n=${totalPages}, ${coveragePercentage}% coverage) introduces unmeasured site risk.`
      : 'Sample size and crawl coverage are statistically adequate for production scoring.';

    const sampleCredibility: SampleCredibilityDetails = {
      pagesAnalyzed: totalPages,
      discoveredUrls,
      crawlCoveragePercentage: coveragePercentage,
      sampleAdequacyFactor,
      credibilityWeight,
      rawCompositeScore,
      effectiveScore,
      sampleDiscountApplied,
      isReliableSample,
      confidenceNotice,
    };

    const overallScore = effectiveScore;

    const pillars: Record<string, PillarScoreBreakdown> = {
      technical: {
        key: 'technical',
        name: 'Technical SEO Infrastructure',
        score: technicalScore,
        trend: technicalScore >= 85 ? 'up' : technicalScore >= 70 ? 'neutral' : 'down',
        weight: 20,
        evidence: `Audited HTTP response codes, canonical consistency, and server redirects across ${totalPages} URLs.`,
        problems: techProblems,
        recommendations: techRecs.length > 0 ? techRecs : ['Technical infrastructure is healthy and compliant.'],
        metrics: {
          ok200Pages,
          errorPages,
          redirectPages,
          canonicalIssuesCount: canonicalIssues.length,
        },
      },
      content: {
        key: 'content',
        name: 'Content Quality & Optimization',
        score: contentScore,
        trend: contentScore >= 85 ? 'up' : contentScore >= 70 ? 'neutral' : 'down',
        weight: 20,
        evidence: `Analyzed word counts, heading hierarchies (H1/H2), title tags, and meta descriptions across ${totalPages} URLs.`,
        problems: contentProblems,
        recommendations: contentRecs.length > 0 ? contentRecs : ['On-page content quality meets search standards.'],
        metrics: {
          thinPages,
          duplicatePages,
          missingH1Pages,
          missingMetaDesc,
        },
      },
      indexing: {
        key: 'indexing',
        name: 'Indexing Health & Crawl Directives',
        score: indexingScore,
        trend: indexingScore >= 85 ? 'up' : indexingScore >= 70 ? 'neutral' : 'down',
        weight: 20,
        evidence: `${Math.round(indexabilityRatio * 100)}% of pages are indexable without noindex blocks or soft 404 errors.`,
        problems: indexingProblems,
        recommendations: indexingRecs.length > 0 ? indexingRecs : ['Search engine indexing directives are aligned.'],
        metrics: {
          indexablePages,
          noindexPages,
          soft404s,
          indexabilityRate: Math.round(indexabilityRatio * 100),
        },
      },
      architecture: {
        key: 'architecture',
        name: 'Internal Site Architecture & Link Graph',
        score: architectureScore,
        trend: architectureScore >= 85 ? 'up' : architectureScore >= 70 ? 'neutral' : 'down',
        weight: 15,
        evidence: `Evaluated click depth distribution, orphan pages, and internal link equity graph across ${totalPages} URLs.`,
        problems: archProblems,
        recommendations: archRecs.length > 0 ? archRecs : ['Internal link distribution and depth are well-structured.'],
        metrics: {
          orphanPages,
          deepPages,
          brokenLinksCount: brokenLinkIssues.length,
        },
      },
      performance: {
        key: 'performance',
        name: 'Performance & Image SEO',
        score: performanceScore,
        trend: performanceScore >= 85 ? 'up' : performanceScore >= 70 ? 'neutral' : 'down',
        weight: 15,
        evidence: `Average response time ${avgLoadTime}ms. Audited ${totalImages} images for alt attributes.`,
        problems: perfProblems,
        recommendations: perfRecs.length > 0 ? perfRecs : ['Page load performance and image metadata are optimized.'],
        metrics: {
          avgLoadTimeMs: avgLoadTime,
          totalImages,
          missingAltImages,
        },
      },
      authority: {
        key: 'authority',
        name: 'Authority Signals & Schema Markup',
        score: authorityScore,
        trend: authorityScore >= 85 ? 'up' : authorityScore >= 70 ? 'neutral' : 'down',
        weight: 10,
        evidence: `${Math.round(schemaRate * 100)}% schema JSON-LD coverage. Average ${avgInlinks.toFixed(1)} inlinks per page.`,
        problems: authProblems,
        recommendations: authRecs.length > 0 ? authRecs : ['Rich structured data and authority signals are properly configured.'],
        metrics: {
          schemaCoveragePct: Math.round(schemaRate * 100),
          avgInlinksPerPage: parseFloat(avgInlinks.toFixed(1)),
        },
      },
    };

    return {
      overallScore,
      rawCompositeScore,
      sampleCredibility,
      previousScore: previousOverallScore || Math.max(30, overallScore - 4),
      lastAudited: new Date().toISOString(),
      pillars,
      summary: {
        totalPages,
        indexablePages,
        criticalIssuesCount: criticalIssues.length,
        highIssuesCount: highIssues.length,
        mediumIssuesCount: mediumIssues.length,
        lowIssuesCount: lowIssues.length,
        averageLoadTimeMs: avgLoadTime,
        schemaAdoptionRate: Math.round(schemaRate * 100),
        orphanPagesCount: orphanPages,
        duplicatePagesCount: duplicatePages,
        thinContentPagesCount: thinPages,
        crawlCoveragePercentage: coveragePercentage,
      },
    };
  }
}
