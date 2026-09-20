import { prisma } from '../../db/prisma';
import { PeriodComparisonEngine } from './periodComparisonEngine';
import { MetricProvenanceSource } from '../provenance/provenanceTypes';

export type SignalSource = 'GOOGLE_SEARCH_CONSOLE' | 'GOOGLE_ANALYTICS_4' | 'CRAWLER';
export type SignalProvenance = MetricProvenanceSource | 'MEASURED_PROVIDER' | 'CALCULATED' | 'USER_PROVIDED' | 'AI_INFERENCE' | 'DATA_UNAVAILABLE';

export interface DetectedSignal {
  websiteId: string;
  eventType: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  source: SignalSource;
  provenance: SignalProvenance;
  details: Record<string, any>;
}

export class SignalDetectionEngine {
  /**
   * Evaluates performance data for the given website and generates actionable SEO events.
   * Deduplicates recommendations and publishes outbox events safely.
   */
  public static async evaluateSignals(params: {
    websiteId: string;
    currentStart: Date;
    currentEnd: Date;
  }): Promise<DetectedSignal[]> {
    const { websiteId, currentStart, currentEnd } = params;

    const comparison = await PeriodComparisonEngine.comparePeriods({
      websiteId,
      currentStart,
      currentEnd,
    });

    const detectedSignals: DetectedSignal[] = [];

    // --- 1. GSC CLICKS SIGNALS ---
    if (comparison.gsc.clicks.previous >= 30) {
      if (comparison.gsc.clicks.percentChange <= -25) {
        detectedSignals.push({
          websiteId,
          eventType: 'CLICKS_DROP',
          severity: comparison.gsc.clicks.percentChange <= -40 ? 'CRITICAL' : 'HIGH',
          source: 'GOOGLE_SEARCH_CONSOLE',
          provenance: 'CALCULATED',
          details: {
            metric: 'clicks',
            current: comparison.gsc.clicks.current,
            previous: comparison.gsc.clicks.previous,
            delta: comparison.gsc.clicks.delta,
            percentChange: comparison.gsc.clicks.percentChange,
            message: `Organic search clicks dropped by ${Math.abs(comparison.gsc.clicks.percentChange)}% (${comparison.gsc.clicks.delta} clicks) compared to the prior period.`,
          },
        });
      } else if (comparison.gsc.clicks.percentChange >= 25 && comparison.gsc.clicks.delta >= 20) {
        detectedSignals.push({
          websiteId,
          eventType: 'CLICKS_GAIN',
          severity: 'INFO',
          source: 'GOOGLE_SEARCH_CONSOLE',
          provenance: 'CALCULATED',
          details: {
            metric: 'clicks',
            current: comparison.gsc.clicks.current,
            previous: comparison.gsc.clicks.previous,
            delta: comparison.gsc.clicks.delta,
            percentChange: comparison.gsc.clicks.percentChange,
            message: `Organic search clicks grew by +${comparison.gsc.clicks.percentChange}% (+${comparison.gsc.clicks.delta} clicks) over the prior period.`,
          },
        });
      }
    }

    // --- 2. GSC IMPRESSIONS SIGNALS ---
    if (comparison.gsc.impressions.previous >= 500) {
      if (comparison.gsc.impressions.percentChange <= -30) {
        detectedSignals.push({
          websiteId,
          eventType: 'IMPRESSIONS_DROP',
          severity: 'HIGH',
          source: 'GOOGLE_SEARCH_CONSOLE',
          provenance: 'CALCULATED',
          details: {
            metric: 'impressions',
            current: comparison.gsc.impressions.current,
            previous: comparison.gsc.impressions.previous,
            delta: comparison.gsc.impressions.delta,
            percentChange: comparison.gsc.impressions.percentChange,
            message: `Search impressions decreased by ${Math.abs(comparison.gsc.impressions.percentChange)}% (${comparison.gsc.impressions.delta} impressions).`,
          },
        });
      } else if (comparison.gsc.impressions.percentChange >= 30) {
        detectedSignals.push({
          websiteId,
          eventType: 'IMPRESSIONS_GAIN',
          severity: 'INFO',
          source: 'GOOGLE_SEARCH_CONSOLE',
          provenance: 'CALCULATED',
          details: {
            metric: 'impressions',
            current: comparison.gsc.impressions.current,
            previous: comparison.gsc.impressions.previous,
            delta: comparison.gsc.impressions.delta,
            percentChange: comparison.gsc.impressions.percentChange,
            message: `Search impressions grew by +${comparison.gsc.impressions.percentChange}% (+${comparison.gsc.impressions.delta} impressions).`,
          },
        });
      }
    }

    // --- 3. GSC CTR & POSITION SIGNALS ---
    if (comparison.gsc.impressions.current >= 500) {
      if (comparison.gsc.ctr.delta <= -1.5) {
        detectedSignals.push({
          websiteId,
          eventType: 'CTR_DROP',
          severity: 'MEDIUM',
          source: 'GOOGLE_SEARCH_CONSOLE',
          provenance: 'CALCULATED',
          details: {
            metric: 'ctr',
            current: comparison.gsc.ctr.current,
            previous: comparison.gsc.ctr.previous,
            delta: comparison.gsc.ctr.delta,
            message: `Site-wide search CTR dropped by ${Math.abs(comparison.gsc.ctr.delta)} percentage points (${comparison.gsc.ctr.previous}% → ${comparison.gsc.ctr.current}%).`,
          },
        });
      } else if (comparison.gsc.ctr.delta >= 1.5) {
        detectedSignals.push({
          websiteId,
          eventType: 'CTR_GAIN',
          severity: 'INFO',
          source: 'GOOGLE_SEARCH_CONSOLE',
          provenance: 'CALCULATED',
          details: {
            metric: 'ctr',
            current: comparison.gsc.ctr.current,
            previous: comparison.gsc.ctr.previous,
            delta: comparison.gsc.ctr.delta,
            message: `Site-wide search CTR improved by +${comparison.gsc.ctr.delta} percentage points.`,
          },
        });
      }

      // Average Position Drop (> 3.0 position worsening)
      if (comparison.gsc.position.delta >= 3.0 && comparison.gsc.position.previous > 0) {
        detectedSignals.push({
          websiteId,
          eventType: 'POSITION_DROP',
          severity: 'HIGH',
          source: 'GOOGLE_SEARCH_CONSOLE',
          provenance: 'CALCULATED',
          details: {
            metric: 'position',
            current: comparison.gsc.position.current,
            previous: comparison.gsc.position.previous,
            delta: comparison.gsc.position.delta,
            message: `Average position slipped from ${comparison.gsc.position.previous.toFixed(1)} to ${comparison.gsc.position.current.toFixed(1)} (worsened by +${comparison.gsc.position.delta.toFixed(1)} positions).`,
          },
        });
      }
    }

    // --- 4. GA4 SESSIONS & CONVERSIONS SIGNALS ---
    if (comparison.ga4.sessions.previous >= 50) {
      if (comparison.ga4.sessions.percentChange <= -25) {
        detectedSignals.push({
          websiteId,
          eventType: 'ORGANIC_SESSIONS_DROP',
          severity: 'HIGH',
          source: 'GOOGLE_ANALYTICS_4',
          provenance: 'CALCULATED',
          details: {
            metric: 'sessions',
            current: comparison.ga4.sessions.current,
            previous: comparison.ga4.sessions.previous,
            percentChange: comparison.ga4.sessions.percentChange,
            message: `GA4 sessions dropped by ${Math.abs(comparison.ga4.sessions.percentChange)}% (${comparison.ga4.sessions.delta} sessions).`,
          },
        });
      }

      if (comparison.ga4.keyEvents.previous >= 10 && comparison.ga4.keyEvents.percentChange <= -30) {
        detectedSignals.push({
          websiteId,
          eventType: 'KEY_EVENT_DROP',
          severity: 'CRITICAL',
          source: 'GOOGLE_ANALYTICS_4',
          provenance: 'CALCULATED',
          details: {
            metric: 'keyEvents',
            current: comparison.ga4.keyEvents.current,
            previous: comparison.ga4.keyEvents.previous,
            percentChange: comparison.ga4.keyEvents.percentChange,
            message: `GA4 key events / conversions dropped by ${Math.abs(comparison.ga4.keyEvents.percentChange)}% (${comparison.ga4.keyEvents.delta} conversions).`,
          },
        });
      }

      if (comparison.ga4.totalRevenue.previous >= 500 && comparison.ga4.totalRevenue.percentChange <= -30) {
        detectedSignals.push({
          websiteId,
          eventType: 'REVENUE_DROP',
          severity: 'CRITICAL',
          source: 'GOOGLE_ANALYTICS_4',
          provenance: 'CALCULATED',
          details: {
            metric: 'totalRevenue',
            current: comparison.ga4.totalRevenue.current,
            previous: comparison.ga4.totalRevenue.previous,
            percentChange: comparison.ga4.totalRevenue.percentChange,
            message: `GA4 attributed revenue dropped by ${Math.abs(comparison.ga4.totalRevenue.percentChange)}% ($${Math.abs(comparison.ga4.totalRevenue.delta)} loss).`,
          },
        });
      }
    }

    // --- 5. STRIKING DISTANCE OPPORTUNITIES (Page 2 Keywords) ---
    for (const kw of comparison.strikingDistanceKeywords) {
      if (kw.impressions >= 100) {
        detectedSignals.push({
          websiteId,
          eventType: 'STRIKING_DISTANCE_OPPORTUNITY',
          severity: 'MEDIUM',
          source: 'GOOGLE_SEARCH_CONSOLE',
          provenance: 'GOOGLE_SEARCH_CONSOLE',
          details: {
            query: kw.query,
            position: kw.position,
            impressions: kw.impressions,
            clicks: kw.clicks,
            ctr: kw.ctr,
            message: `Query '${kw.query}' is ranking in striking distance (position ${kw.position.toFixed(1)}) with ${kw.impressions} impressions. Targeted on-page optimization could push it to page 1.`,
          },
        });
      }
    }

    // --- 6. CONTENT DECAY CANDIDATES ---
    for (const decliner of comparison.decliners) {
      if (decliner.previousClicks >= 30 && decliner.clicksDiff <= -15) {
        detectedSignals.push({
          websiteId,
          eventType: 'CONTENT_DECAY_CANDIDATE',
          severity: 'HIGH',
          source: 'GOOGLE_SEARCH_CONSOLE',
          provenance: 'CALCULATED',
          details: {
            query: decliner.query,
            currentClicks: decliner.currentClicks,
            previousClicks: decliner.previousClicks,
            clicksLost: Math.abs(decliner.clicksDiff),
            currentPosition: decliner.currentPos,
            message: `Query '${decliner.query}' shows traffic decay: dropped by ${Math.abs(decliner.clicksDiff)} clicks in the current period. Refresh content to reclaim lost positions.`,
          },
        });
      }
    }

    // --- 7. ORPHAN PAGES WITH ORGANIC TRAFFIC ---
    const orphanPagesWithTraffic = await prisma.urlIdentity.findMany({
      where: {
        websiteId,
        isOrphanCandidate: true,
        gscFacts: {
          some: {
            date: { gte: currentStart, lte: currentEnd },
            clicks: { gt: 0 },
          },
        },
      },
      include: {
        gscFacts: {
          where: { date: { gte: currentStart, lte: currentEnd } },
          select: { clicks: true, impressions: true },
        },
      },
      take: 5,
    });

    for (const orphan of orphanPagesWithTraffic) {
      const totalClicks = orphan.gscFacts.reduce((sum, f) => sum + f.clicks, 0);
      detectedSignals.push({
        websiteId,
        eventType: 'ORPHAN_PAGE_RECEIVING_TRAFFIC',
        severity: 'HIGH',
        source: 'GOOGLE_SEARCH_CONSOLE',
        provenance: 'GOOGLE_SEARCH_CONSOLE',
        details: {
          url: orphan.normalizedUrl,
          pathname: orphan.pathname,
          clicks: totalClicks,
          message: `Orphan page '${orphan.pathname}' has 0 internal inlinks but received ${totalClicks} organic clicks. Add internal navigation links to preserve authority.`,
        },
      });
    }

    // Save detected signals following Measured facts -> Signal -> SeoEvent -> Recommendation (deduplicated)
    if (detectedSignals.length > 0) {
      const windowKey = `${currentStart.toISOString().split('T')[0]}_${currentEnd.toISOString().split('T')[0]}`;

      for (const sig of detectedSignals) {
        const entity = sig.details.query || sig.details.url || 'SITE';
        const deterministicKey = `${sig.websiteId}:${sig.eventType}:${entity}:${windowKey}`;

        // 1. Check for existing recommendation with the same deterministic signature to prevent duplicate creation on every sync
        const existingRec = await prisma.seoRecommendation.findFirst({
          where: {
            websiteId: sig.websiteId,
            ruleKey: deterministicKey,
          },
        });

        if (!existingRec) {
          await prisma.$transaction([
            prisma.seoRecommendation.create({
              data: {
                websiteId: sig.websiteId,
                title: sig.details.message || sig.eventType,
                category: 'ANALYTICS_SIGNAL',
                actionType: sig.eventType,
                ruleKey: deterministicKey,
                evidence: JSON.stringify({
                  ...sig.details,
                  source: sig.source,
                  provenance: sig.provenance,
                  comparisonWindow: windowKey,
                  detectedAt: new Date().toISOString(),
                }),
                source: sig.source,
                impactScore: sig.severity === 'CRITICAL' ? 9 : sig.severity === 'HIGH' ? 8 : 6,
                effortScore: 4,
                riskScore: 2,
                businessValue: sig.severity === 'CRITICAL' ? 10 : 7,
                status: 'RECOMMENDED',
              },
            }),
            prisma.outboxEvent.create({
              data: {
                aggregateType: 'SEO_EVENT',
                aggregateId: deterministicKey,
                eventType: 'SEO_SIGNAL_DETECTED',
                payloadJson: JSON.stringify({
                  ...sig,
                  deterministicKey,
                  comparisonWindow: windowKey,
                  timestamp: new Date().toISOString(),
                }),
                status: 'PENDING',
              },
            }),
          ]);
        } else {
          // Update existing recommendation evidence in place
          await prisma.seoRecommendation.update({
            where: { id: existingRec.id },
            data: {
              evidence: JSON.stringify({
                ...sig.details,
                source: sig.source,
                provenance: sig.provenance,
                comparisonWindow: windowKey,
                refreshedAt: new Date().toISOString(),
              }),
              impactScore: sig.severity === 'CRITICAL' ? 9 : sig.severity === 'HIGH' ? 8 : 6,
            },
          });
        }
      }
    }

    return detectedSignals;
  }
}
