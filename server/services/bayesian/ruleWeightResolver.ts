/**
 * Phase A: Rule Weight Resolver
 * 
 * Provides hierarchical contextual resolution of Bayesian rule weights
 * to seamlessly link attribution learning into the live decision loop.
 * 
 * Fallback Precedence:
 * 1. websiteId + ruleKey + cmsProvider + pageArchetype
 * 2. websiteId + ruleKey + cmsProvider + ALL
 * 3. websiteId + ruleKey + ALL + ALL
 * 4. Default baseline weight: 1.0 (ACTIVE)
 */

import { prisma } from '../../db/prisma';
import { BayesianApprovalStatus } from '../../config/bayesianConstants';
import { isProductionMode } from '../../config/runtimeMode';

export interface ResolvedRuleWeight {
  ruleKey: string;
  appliedWeight: number;
  rawCalculatedWeight: number;
  approvalStatus: BayesianApprovalStatus;
  isAutoDamped: boolean;
  dampedReason?: string | null;
  observedWins: number;
  observedLosses: number;
  evidenceCount: number;
  resolvedGrain: 'EXACT' | 'CMS_ONLY' | 'GLOBAL_SITE' | 'DEFAULT';
  sourceGrainKey: string;
}

export class RuleWeightResolver {
  private static inMemoryOverrides: Map<string, number> = new Map();

  /**
   * Resolves the authoritative Bayesian rule weight for a single context.
   */
  public static async resolveWeight(params: {
    websiteId: string;
    ruleKey: string;
    cmsProvider?: string;
    pageArchetype?: string;
  }): Promise<ResolvedRuleWeight> {
    const { websiteId, ruleKey, cmsProvider = 'ALL', pageArchetype = 'ALL' } = params;

    // Check in-memory override for test/local mocks if present
    const overrideKey = `${websiteId}::${ruleKey}`;
    if (this.inMemoryOverrides.has(overrideKey)) {
      const weight = this.inMemoryOverrides.get(overrideKey)!;
      return {
        ruleKey,
        appliedWeight: weight,
        rawCalculatedWeight: weight,
        approvalStatus: 'ACTIVE',
        isAutoDamped: false,
        observedWins: 0,
        observedLosses: 0,
        evidenceCount: 0,
        resolvedGrain: 'DEFAULT',
        sourceGrainKey: 'IN_MEMORY_OVERRIDE',
      };
    }

    try {
      // Query all candidate states for this website and rule in one efficient query
      const candidateStates = await prisma.bayesianRuleWeightState.findMany({
        where: {
          websiteId,
          ruleKey,
        },
      });

      if (candidateStates.length > 0) {
        // 1. Check exact grain: (cmsProvider, pageArchetype)
        const exact = candidateStates.find(
          (s) => s.cmsProvider === cmsProvider && s.pageArchetype === pageArchetype
        );
        if (exact) {
          return {
            ruleKey,
            appliedWeight: exact.approvedAppliedWeight,
            rawCalculatedWeight: exact.rawCalculatedWeight,
            approvalStatus: exact.approvalStatus as BayesianApprovalStatus,
            isAutoDamped: exact.isAutoDamped,
            observedWins: exact.observedWins,
            observedLosses: exact.observedLosses,
            evidenceCount: exact.observedWins + exact.observedLosses,
            resolvedGrain: 'EXACT',
            sourceGrainKey: `${websiteId}::${ruleKey}::${exact.cmsProvider}::${exact.pageArchetype}`,
          };
        }

        // 2. Check CMS-specific fallback: (cmsProvider, 'ALL')
        if (cmsProvider !== 'ALL') {
          const cmsMatch = candidateStates.find(
            (s) => s.cmsProvider === cmsProvider && s.pageArchetype === 'ALL'
          );
          if (cmsMatch) {
            return {
              ruleKey,
              appliedWeight: cmsMatch.approvedAppliedWeight,
              rawCalculatedWeight: cmsMatch.rawCalculatedWeight,
              approvalStatus: cmsMatch.approvalStatus as BayesianApprovalStatus,
              isAutoDamped: cmsMatch.isAutoDamped,
              observedWins: cmsMatch.observedWins,
              observedLosses: cmsMatch.observedLosses,
              evidenceCount: cmsMatch.observedWins + cmsMatch.observedLosses,
              resolvedGrain: 'CMS_ONLY',
              sourceGrainKey: `${websiteId}::${ruleKey}::${cmsMatch.cmsProvider}::ALL`,
            };
          }
        }

        // 3. Check site-wide fallback: ('ALL', 'ALL')
        const siteWide = candidateStates.find(
          (s) => s.cmsProvider === 'ALL' && s.pageArchetype === 'ALL'
        );
        if (siteWide) {
          return {
            ruleKey,
            appliedWeight: siteWide.approvedAppliedWeight,
            rawCalculatedWeight: siteWide.rawCalculatedWeight,
            approvalStatus: siteWide.approvalStatus as BayesianApprovalStatus,
            isAutoDamped: siteWide.isAutoDamped,
            observedWins: siteWide.observedWins,
            observedLosses: siteWide.observedLosses,
            evidenceCount: siteWide.observedWins + siteWide.observedLosses,
            resolvedGrain: 'GLOBAL_SITE',
            sourceGrainKey: `${websiteId}::${ruleKey}::ALL::ALL`,
          };
        }
      }
    } catch (err: any) {
      if (isProductionMode() || process.env.NODE_ENV === 'production') {
        throw new Error(`POLICY_STATE_UNAVAILABLE: Failed to resolve Bayesian rule weight from database in production: ${err.message}`);
      }
      // If database is temporarily unavailable in non-production, fall back to default
    }

    // 4. Default baseline
    return {
      ruleKey,
      appliedWeight: 1.0,
      rawCalculatedWeight: 1.0,
      approvalStatus: 'ACTIVE',
      isAutoDamped: false,
      observedWins: 0,
      observedLosses: 0,
      evidenceCount: 0,
      resolvedGrain: 'DEFAULT',
      sourceGrainKey: `${websiteId}::${ruleKey}::DEFAULT`,
    };
  }

  /**
   * Resolves weights in batch for an array of rules across the specified website context.
   */
  public static async resolveWeightsForRules(
    websiteId: string,
    ruleKeys: string[],
    cmsProvider: string = 'ALL',
    pageArchetype: string = 'ALL'
  ): Promise<Record<string, number>> {
    const weightsMap: Record<string, number> = {};

    try {
      const states = await prisma.bayesianRuleWeightState.findMany({
        where: {
          websiteId,
          ruleKey: { in: ruleKeys },
        },
      });

      for (const ruleKey of ruleKeys) {
        const matchingStates = states.filter((s) => s.ruleKey === ruleKey);

        if (matchingStates.length > 0) {
          // Exact match
          const exact = matchingStates.find(
            (s) => s.cmsProvider === cmsProvider && s.pageArchetype === pageArchetype
          );
          if (exact) {
            weightsMap[ruleKey] = exact.approvedAppliedWeight;
            continue;
          }

          // CMS match
          if (cmsProvider !== 'ALL') {
            const cmsMatch = matchingStates.find(
              (s) => s.cmsProvider === cmsProvider && s.pageArchetype === 'ALL'
            );
            if (cmsMatch) {
              weightsMap[ruleKey] = cmsMatch.approvedAppliedWeight;
              continue;
            }
          }

          // Site-wide match
          const siteMatch = matchingStates.find(
            (s) => s.cmsProvider === 'ALL' && s.pageArchetype === 'ALL'
          );
          if (siteMatch) {
            weightsMap[ruleKey] = siteMatch.approvedAppliedWeight;
            continue;
          }
        }

        // Default
        weightsMap[ruleKey] = 1.0;
      }
    } catch (err: any) {
      if (isProductionMode()) {
        throw new Error(`POLICY_STATE_UNAVAILABLE: Failed to resolve batch Bayesian rule weights from database in production: ${err.message}`);
      }
      for (const ruleKey of ruleKeys) {
        weightsMap[ruleKey] = 1.0;
      }
    }

    return weightsMap;
  }

  public static async resolveEffectiveWeight(params: {
    websiteId: string;
    ruleKey: string;
    cmsProvider?: string;
    pageArchetype?: string;
  }): Promise<ResolvedRuleWeight> {
    return this.resolveWeight(params);
  }

  /**
   * Testing hook to set in-memory rule weight override.
   */
  public static setTestOverride(websiteId: string, ruleKey: string, weight: number): void {
    this.inMemoryOverrides.set(`${websiteId}::${ruleKey}`, weight);
  }

  public static clearTestOverrides(): void {
    this.inMemoryOverrides.clear();
  }
}
