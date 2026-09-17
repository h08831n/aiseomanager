import { BusinessValueTier } from '@prisma/client';
import { OpportunityScoreBreakdown } from './decisionTypes';

export type { OpportunityScoreBreakdown };

export class OpportunityScoreEngine {
  /**
   * Business Value Tier mapping to 1.0 - 5.0 scale
   */
  public static mapBusinessValueTierToWeight(tier?: BusinessValueTier | string): number {
    switch (tier) {
      case BusinessValueTier.TIER_1_CRITICAL:
      case 'TIER_1_CRITICAL':
        return 5.0;
      case BusinessValueTier.TIER_2_HIGH:
      case 'TIER_2_HIGH':
        return 4.0;
      case BusinessValueTier.TIER_3_MEDIUM:
      case 'TIER_3_MEDIUM':
        return 2.5;
      case BusinessValueTier.TIER_4_LOW:
      case 'TIER_4_LOW':
        return 1.5;
      case BusinessValueTier.TIER_5_BENCHMARK:
      case 'TIER_5_BENCHMARK':
      default:
        return 1.0;
    }
  }

  /**
   * Computes potential traffic gain factor on a 1.0 to 10.0 scale
   * using search volume and target position delta.
   */
  public static calculatePotentialTrafficGain(params: {
    searchVolume?: number;
    currentRank?: number | null;
    targetRank?: number;
    gscImpressions?: number;
  }): number {
    const volume = params.searchVolume || params.gscImpressions || 100;
    // Log scale volume factor from 1.0 to 5.0
    const volumeFactor = Math.min(5.0, Math.max(1.0, Math.log10(Math.max(10, volume)) / 1.2));

    let rankImprovementFactor = 1.5;
    if (params.currentRank !== undefined && params.currentRank !== null) {
      if (params.currentRank > 10) {
        rankImprovementFactor = 2.0; // Moving into page 1
      } else if (params.currentRank >= 4) {
        rankImprovementFactor = 1.8; // Moving into top 3
      } else if (params.currentRank >= 2) {
        rankImprovementFactor = 1.2; // Moving to #1
      }
    }

    const trafficGain = Number((volumeFactor * rankImprovementFactor).toFixed(2));
    return Math.min(10.0, Math.max(1.0, trafficGain));
  }

  /**
   * Deterministic Opportunity Score Calculation:
   * Opportunity Score = (Impact × Probability × Confidence) / Effort
   * Scaled to 0-100 with risk penalty adjustment.
   */
  public static calculateScore(params: {
    potentialTrafficGain?: number; // 1.0 to 10.0 (Traffic Opportunity)
    businessImpact?: number; // 1.0 to 10.0 (Business Impact)
    trafficOpportunity?: number; // 1.0 to 10.0
    rankingProbability?: number; // 0.05 to 1.0
    businessValueTier?: BusinessValueTier | string;
    businessValueWeight?: number; // 1.0 to 5.0
    confidenceScore: number; // 0.1 to 1.0
    effortScore?: number; // 1.0 to 5.0 (Implementation Cost)
    implementationCost?: number; // 1.0 to 5.0
    riskScore?: number; // 1.0 to 5.0
    riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
    ruleWeight?: number; // 0.2 to 2.5 (Bayesian multiplier)
  }): OpportunityScoreBreakdown {
    // 1. Business Impact (1.0 to 10.0)
    let businessImpact = params.businessImpact;
    if (businessImpact === undefined) {
      const baseWeight =
        params.businessValueWeight !== undefined
          ? params.businessValueWeight
          : this.mapBusinessValueTierToWeight(params.businessValueTier);
      businessImpact = Math.min(10.0, Math.max(1.0, baseWeight * 2.0));
    } else {
      businessImpact = Math.min(10.0, Math.max(1.0, businessImpact));
    }

    // 2. Traffic Opportunity (1.0 to 10.0)
    const trafficOpportunity = Math.min(
      10.0,
      Math.max(1.0, params.trafficOpportunity ?? params.potentialTrafficGain ?? 5.0)
    );

    // Composite Impact (blends business impact and traffic opportunity on 1.0 to 10.0 scale)
    const impact = Number((businessImpact * 0.60 + trafficOpportunity * 0.40).toFixed(2));

    // 3. Ranking Probability (0.05 to 1.0)
    const rankingProbability = Math.min(
      1.0,
      Math.max(0.05, params.rankingProbability ?? (0.45 + (trafficOpportunity / 10.0) * 0.40))
    );

    // 4. Confidence (0.1 to 1.0)
    const confidenceScore = Math.min(1.0, Math.max(0.1, params.confidenceScore));

    // 5. Implementation Cost / Effort (1.0 to 5.0)
    const implementationCost = Math.min(
      5.0,
      Math.max(1.0, params.implementationCost ?? params.effortScore ?? 2.0)
    );

    // 6. Risk (1.0 to 5.0) and Risk Level
    let riskWeight = params.riskScore;
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = params.riskLevel || 'LOW';
    if (riskWeight === undefined) {
      if (params.riskLevel === 'HIGH') riskWeight = 3.5;
      else if (params.riskLevel === 'MEDIUM') riskWeight = 2.0;
      else riskWeight = 1.0;
    } else {
      riskWeight = Math.min(5.0, Math.max(1.0, riskWeight));
      riskLevel = riskWeight >= 3.0 ? 'HIGH' : riskWeight >= 1.8 ? 'MEDIUM' : 'LOW';
    }

    const ruleWeight = params.ruleWeight !== undefined ? Math.max(0.1, params.ruleWeight) : 1.0;

    // Direct mathematical formula:
    // Opportunity Score = (Impact × Probability × Confidence) / Effort
    // With risk dampening: normalized to 0-100 scale: (Numerator / Denominator) * 10.0
    const rawOpportunity = (impact * rankingProbability * confidenceScore * ruleWeight) / implementationCost;
    const riskFactor = 1.0 + (riskWeight - 1.0) * 0.25; // 1.0 to 2.0 risk divisor
    const scaledScore = (rawOpportunity / riskFactor) * 20.0;
    const score = Number(Math.min(100.0, Math.max(1.0, scaledScore)).toFixed(1));

    let priority: 'P0_CRITICAL' | 'P1_HIGH' | 'P2_MEDIUM' | 'P3_LOW';
    if (score >= 75.0 || (riskLevel === 'LOW' && businessImpact >= 8.0 && score >= 65.0)) {
      priority = 'P0_CRITICAL';
    } else if (score >= 55.0) {
      priority = 'P1_HIGH';
    } else if (score >= 35.0) {
      priority = 'P2_MEDIUM';
    } else {
      priority = 'P3_LOW';
    }

    const formulaDetails =
      `Opportunity Score = (Impact(${impact}) × Probability(${rankingProbability.toFixed(2)}) × Confidence(${confidenceScore.toFixed(2)})) / Effort(${implementationCost}) [RiskFactor=${riskFactor.toFixed(2)}] => ${score}/100`;

    return {
      score,
      priority,
      businessImpact,
      trafficOpportunity,
      rankingProbability: Number(rankingProbability.toFixed(3)),
      implementationCost,
      risk: riskWeight,
      riskLevel,
      confidenceScore,
      effortWeight: implementationCost,
      riskWeight,
      potentialTrafficGain: trafficOpportunity,
      businessValueWeight: businessImpact / 2.0,
      ruleWeight,
      formulaDetails,
    };
  }

  /**
   * Sorts any collection of tasks descending by their opportunity score.
   */
  public static rankTasksByOpportunityScore<T extends { opportunityScore?: number; priority?: string }>(
    tasks: T[]
  ): T[] {
    return [...tasks].sort((a, b) => (b.opportunityScore || 0) - (a.opportunityScore || 0));
  }
}
