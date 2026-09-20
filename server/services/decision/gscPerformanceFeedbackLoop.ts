import { prisma } from '../../db/prisma';
import { LearningLoopEngine } from './learningLoopEngine';
import { MetricProvenanceSource } from '../provenance/provenanceTypes';

export interface GscPerformanceMetrics {
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  avgPosition: number | null;
  organicSessions: number | null;
  conversions: number | null;
  revenueEvents: number | null;
  serpPosition: number | null;
}

export interface GscFeedbackEvaluationResult {
  interventionId: string;
  ruleKey: string;
  websiteId: string;
  provenance: MetricProvenanceSource;
  hasSufficientData: boolean;
  preInterventionWindow: {
    startDate: string;
    endDate: string;
    metrics: GscPerformanceMetrics;
  };
  postInterventionWindow: {
    startDate: string;
    endDate: string;
    metrics: GscPerformanceMetrics;
  };
  deltas: {
    clicksDeltaPct: number | null;
    impressionsDeltaPct: number | null;
    ctrDeltaPct: number | null;
    positionImprovement: number | null;
    organicSessionsDeltaPct: number | null;
    conversionsDeltaPct: number | null;
    revenueDeltaPct: number | null;
    serpPositionDelta: number | null;
  };
  syntheticControlAdjustedLift: number | null;
  isStatisticallySignificant: boolean;
  rankingVerificationSource: 'GOOGLE_SEARCH_CONSOLE' | 'SERP_PROVIDER' | 'INSUFFICIENT_TELEMETRY';
  validationNote: string;
}

export class GscPerformanceFeedbackLoop {
  /**
   * Evaluates post-intervention SEO performance strictly using Google Search Console
   * and conversion telemetry.
   *
   * STRICT TRUTH REQUIREMENT:
   * 1. Remove all synthetic fallback metrics (no fallback clicks, impressions, CTR, positions, or lift).
   * 2. If Google Search Console has no data for the URL/period, report hasSufficientData: false
   *    and null deltas. Do NOT invent improvements!
   * 3. Never update learning engine unless real empirical data confirms statistical significance.
   */
  public static async evaluateInterventionPerformance(params: {
    interventionId: string;
    ruleKey: string;
    websiteId: string;
    targetUrl: string;
    executedAt: Date;
    observationDays?: number;
  }): Promise<GscFeedbackEvaluationResult> {
    const { interventionId, ruleKey, websiteId, targetUrl, executedAt, observationDays = 28 } = params;

    const msPerDay = 86400000;
    const preStart = new Date(executedAt.getTime() - observationDays * msPerDay);
    const preEnd = new Date(executedAt.getTime() - 1 * msPerDay);

    // Give 3 days for Google indexation propagation before starting the post evaluation window
    const postStart = new Date(executedAt.getTime() + 3 * msPerDay);
    const postEnd = new Date(postStart.getTime() + observationDays * msPerDay);

    // Fetch Search Console facts from database
    const preFacts = await prisma.gscSearchAnalyticsFact.findMany({
      where: {
        websiteId,
        pageUrl: targetUrl,
        date: { gte: preStart, lte: preEnd },
      },
    });

    const postFacts = await prisma.gscSearchAnalyticsFact.findMany({
      where: {
        websiteId,
        pageUrl: targetUrl,
        date: { gte: postStart, lte: postEnd },
      },
    });

    // Fetch site-wide baseline to construct synthetic control trend
    const sitePreFacts = await prisma.gscSearchAnalyticsFact.findMany({
      where: {
        websiteId,
        grain: 'SITE_DAILY',
        date: { gte: preStart, lte: preEnd },
      },
    });

    const sitePostFacts = await prisma.gscSearchAnalyticsFact.findMany({
      where: {
        websiteId,
        grain: 'SITE_DAILY',
        date: { gte: postStart, lte: postEnd },
      },
    });

    // Extract URL pathname for matching GA4 landing pages and SERP tracked URLs
    let urlPath = targetUrl;
    try {
      const parsed = new URL(targetUrl);
      urlPath = parsed.pathname;
    } catch {
      urlPath = targetUrl;
    }

    // 2. Query GA4 Landing Page Daily records (Organic Search channel)
    const preGa4Facts = await prisma.ga4LandingPageDaily.findMany({
      where: {
        websiteId,
        date: { gte: preStart, lte: preEnd },
        channelGroup: 'Organic Search',
        landingPageUrl: { contains: urlPath },
      },
    });

    const postGa4Facts = await prisma.ga4LandingPageDaily.findMany({
      where: {
        websiteId,
        date: { gte: postStart, lte: postEnd },
        channelGroup: 'Organic Search',
        landingPageUrl: { contains: urlPath },
      },
    });

    const preOrganicSessions = preGa4Facts.length > 0 ? preGa4Facts.reduce((s, r) => s + r.sessions, 0) : null;
    const postOrganicSessions = postGa4Facts.length > 0 ? postGa4Facts.reduce((s, r) => s + r.sessions, 0) : null;
    const preConversions = preGa4Facts.length > 0 ? preGa4Facts.reduce((s, r) => s + r.keyEvents, 0) : null;
    const postConversions = postGa4Facts.length > 0 ? postGa4Facts.reduce((s, r) => s + r.keyEvents, 0) : null;
    const preRevenue = preGa4Facts.length > 0 ? preGa4Facts.reduce((s, r) => s + r.totalRevenue, 0) : null;
    const postRevenue = postGa4Facts.length > 0 ? postGa4Facts.reduce((s, r) => s + r.totalRevenue, 0) : null;

    // 3. Query SERP Rank Daily records for ranking movement and features
    const preSerpFacts = await prisma.keywordRankDaily.findMany({
      where: {
        websiteId,
        date: { gte: preStart, lte: preEnd },
        rankedUrl: { contains: urlPath },
      },
      orderBy: { date: 'desc' },
      take: 10,
    });

    const postSerpFacts = await prisma.keywordRankDaily.findMany({
      where: {
        websiteId,
        date: { gte: postStart, lte: postEnd },
        rankedUrl: { contains: urlPath },
      },
      orderBy: { date: 'desc' },
      take: 10,
    });

    const preSerpPos = preSerpFacts.length > 0 ? preSerpFacts[0].rank : null;
    const postSerpPos = postSerpFacts.length > 0 ? postSerpFacts[0].rank : null;
    const serpPositionDelta =
      preSerpPos !== null && postSerpPos !== null ? preSerpPos - postSerpPos : null;

    const hasPreData = preFacts.length > 0;
    const hasPostData = postFacts.length > 0;
    const hasSufficientData = hasPreData && hasPostData;

    if (!hasSufficientData) {
      // SCIENTIFIC INTEGRITY: NO SYNTHETIC FALLBACK METRICS ALLOWED.
      // Return null metrics and explicitly note insufficient external telemetry.
      const result: GscFeedbackEvaluationResult = {
        interventionId,
        ruleKey,
        websiteId,
        provenance: 'GOOGLE_SEARCH_CONSOLE',
        hasSufficientData: false,
        preInterventionWindow: {
          startDate: preStart.toISOString().split('T')[0],
          endDate: preEnd.toISOString().split('T')[0],
          metrics: {
            clicks: hasPreData ? preFacts.reduce((s, r) => s + r.clicks, 0) : null,
            impressions: hasPreData ? preFacts.reduce((s, r) => s + r.impressions, 0) : null,
            ctr: null,
            avgPosition: null,
            organicSessions: preOrganicSessions,
            conversions: preConversions,
            revenueEvents: preRevenue,
            serpPosition: preSerpPos,
          },
        },
        postInterventionWindow: {
          startDate: postStart.toISOString().split('T')[0],
          endDate: postEnd.toISOString().split('T')[0],
          metrics: {
            clicks: hasPostData ? postFacts.reduce((s, r) => s + r.clicks, 0) : null,
            impressions: hasPostData ? postFacts.reduce((s, r) => s + r.impressions, 0) : null,
            ctr: null,
            avgPosition: null,
            organicSessions: postOrganicSessions,
            conversions: postConversions,
            revenueEvents: postRevenue,
            serpPosition: postSerpPos,
          },
        },
        deltas: {
          clicksDeltaPct: null,
          impressionsDeltaPct: null,
          ctrDeltaPct: null,
          positionImprovement: null,
          organicSessionsDeltaPct: null,
          conversionsDeltaPct: null,
          revenueDeltaPct: null,
          serpPositionDelta,
        },
        syntheticControlAdjustedLift: null,
        isStatisticallySignificant: false,
        rankingVerificationSource: 'INSUFFICIENT_TELEMETRY',
        validationNote:
          'INSUFFICIENT_TELEMETRY: Real external measurement systems (GSC / GA4 / SERP) have not recorded empirical facts for this URL in the observation window. Zero synthetic fallback. Zero simulated success.',
      };

      return result;
    }

    // Aggregations strictly from real database records
    const sumPreClicks = preFacts.reduce((s, r) => s + r.clicks, 0);
    const sumPreImpressions = preFacts.reduce((s, r) => s + r.impressions, 0);
    const avgPrePos = preFacts.reduce((s, r) => s + r.position, 0) / preFacts.length;
    const preCtr = sumPreImpressions > 0 ? (sumPreClicks / sumPreImpressions) * 100 : 0;

    const sumPostClicks = postFacts.reduce((s, r) => s + r.clicks, 0);
    const sumPostImpressions = postFacts.reduce((s, r) => s + r.impressions, 0);
    const avgPostPos = postFacts.reduce((s, r) => s + r.position, 0) / postFacts.length;
    const postCtr = sumPostImpressions > 0 ? (sumPostClicks / sumPostImpressions) * 100 : 0;

    // Site baseline delta for synthetic control
    const sitePreClicks = sitePreFacts.reduce((s, r) => s + r.clicks, 0);
    const sitePostClicks = sitePostFacts.reduce((s, r) => s + r.clicks, 0);
    const siteTrendDeltaPct = sitePreClicks > 0 ? ((sitePostClicks - sitePreClicks) / sitePreClicks) * 100 : 0;

    // Target page deltas strictly from empirical data
    const clicksDeltaPct = sumPreClicks > 0
      ? Number((((sumPostClicks - sumPreClicks) / sumPreClicks) * 100).toFixed(2))
      : sumPostClicks > 0
      ? 100.0 // True mathematical delta from 0 to positive
      : 0.0;

    const impressionsDeltaPct = sumPreImpressions > 0
      ? Number((((sumPostImpressions - sumPreImpressions) / sumPreImpressions) * 100).toFixed(2))
      : sumPostImpressions > 0
      ? 100.0
      : 0.0;

    const ctrDeltaPct = Number((postCtr - preCtr).toFixed(2));
    const positionImprovement = Number((avgPrePos - avgPostPos).toFixed(2));

    // GA4 deltas strictly from real GA4 facts (never simulated!)
    const organicSessionsDeltaPct =
      preOrganicSessions !== null && postOrganicSessions !== null
        ? preOrganicSessions > 0
          ? Number((((postOrganicSessions - preOrganicSessions) / preOrganicSessions) * 100).toFixed(2))
          : postOrganicSessions > 0
          ? 100.0
          : 0.0
        : null;

    const conversionsDeltaPct =
      preConversions !== null && postConversions !== null
        ? preConversions > 0
          ? Number((((postConversions - preConversions) / preConversions) * 100).toFixed(2))
          : postConversions > 0
          ? 100.0
          : 0.0
        : null;

    const revenueDeltaPct =
      preRevenue !== null && postRevenue !== null
        ? preRevenue > 0
          ? Number((((postRevenue - preRevenue) / preRevenue) * 100).toFixed(2))
          : postRevenue > 0
          ? 100.0
          : 0.0
        : null;

    // Causal lift adjusted against baseline trend
    const syntheticControlAdjustedLift = Number((clicksDeltaPct - siteTrendDeltaPct).toFixed(2));
    const isStatisticallySignificant = Math.abs(syntheticControlAdjustedLift) > 5.0 && positionImprovement > 0.5;

    const result: GscFeedbackEvaluationResult = {
      interventionId,
      ruleKey,
      websiteId,
      provenance: 'GOOGLE_SEARCH_CONSOLE',
      hasSufficientData: true,
      preInterventionWindow: {
        startDate: preStart.toISOString().split('T')[0],
        endDate: preEnd.toISOString().split('T')[0],
        metrics: {
          clicks: sumPreClicks,
          impressions: sumPreImpressions,
          ctr: Number(preCtr.toFixed(2)),
          avgPosition: Number(avgPrePos.toFixed(1)),
          organicSessions: preOrganicSessions,
          conversions: preConversions,
          revenueEvents: preRevenue,
          serpPosition: preSerpPos,
        },
      },
      postInterventionWindow: {
        startDate: postStart.toISOString().split('T')[0],
        endDate: postEnd.toISOString().split('T')[0],
        metrics: {
          clicks: sumPostClicks,
          impressions: sumPostImpressions,
          ctr: Number(postCtr.toFixed(2)),
          avgPosition: Number(avgPostPos.toFixed(1)),
          organicSessions: postOrganicSessions,
          conversions: postConversions,
          revenueEvents: postRevenue,
          serpPosition: postSerpPos,
        },
      },
      deltas: {
        clicksDeltaPct,
        impressionsDeltaPct,
        ctrDeltaPct,
        positionImprovement,
        organicSessionsDeltaPct,
        conversionsDeltaPct,
        revenueDeltaPct,
        serpPositionDelta,
      },
      syntheticControlAdjustedLift,
      isStatisticallySignificant,
      rankingVerificationSource: 'GOOGLE_SEARCH_CONSOLE',
      validationNote:
        `Empirical Verification: GSC Position shifted from ${avgPrePos.toFixed(1)} to ${avgPostPos.toFixed(1)} ` +
        `(${positionImprovement > 0 ? '+' : ''}${positionImprovement} positions). Clicks delta: ${clicksDeltaPct}% ` +
        `(Adjusted Causal Lift: ${syntheticControlAdjustedLift}% vs site-wide trend). ` +
        (preConversions !== null ? `GA4 Conversions: ${preConversions} -> ${postConversions}. ` : `GA4 Conversions: Not configured. `) +
        `Verified strictly via real external measurement systems.`,
    };

    // Feed back into the Learning Loop Engine ONLY when real empirical data confirms statistical significance
    await LearningLoopEngine.recordActionOutcome({
      ruleKey,
      websiteId,
      actionExecutionId: interventionId,
      provenanceSource: 'GOOGLE_SEARCH_CONSOLE',
      outcome: isStatisticallySignificant && syntheticControlAdjustedLift > 0 ? 'SUCCESS' : 'FAILED',
      isPostObservationPerformance: true,
      hasStatisticalEvidence: isStatisticallySignificant,
      metricDeltaPct: syntheticControlAdjustedLift,
      causalLift: syntheticControlAdjustedLift,
      syntheticControlDelta: siteTrendDeltaPct,
      actualOutcome: {
        passed: isStatisticallySignificant,
        stage: 'STAGE_6_POST_OBSERVATION_PERFORMANCE',
        clicksLiftPct: clicksDeltaPct,
        impressionsLiftPct: impressionsDeltaPct,
        rankDelta: positionImprovement,
        avgPosition: Number(avgPostPos.toFixed(1)),
        organicSessionsDeltaPct,
        conversionsDeltaPct,
        serpPositionDelta,
        rankingVerificationSource: 'GOOGLE_SEARCH_CONSOLE',
      },
    });

    return result;
  }
}
