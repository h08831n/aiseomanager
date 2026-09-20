import { prisma } from '../../db/prisma';
import { isProductionMode } from '../../config/runtimeMode';
import {
  MIN_RULE_WEIGHT,
  MAX_RULE_WEIGHT,
  DEFAULT_ALPHA_PRIOR,
  DEFAULT_BETA_PRIOR,
} from '../../config/bayesianConstants';

export interface ResolvedRuleWeight {
  ruleKey: string;
  websiteId: string;
  appliedWeight: number;
  alphaPosterior: number;
  betaPosterior: number;
  posteriorMeanWinRate: number;
  approvalStatus: string;
  isAutoDamped: boolean;
  isFallback: boolean;
}

export class RuleWeightResolver {
  /**
   * Resolves the authoritative Bayesian policy weight for a given rule and website.
   * In PRODUCTION mode: Database failure MUST fail closed (throw POLICY_STATE_UNAVAILABLE).
   * In TEST/SIMULATION mode: Returns default 1.0 weight fallback.
   */
  public static async resolveWeight(params: {
    websiteId: string;
    ruleKey: string;
    cmsProvider?: string;
    pageArchetype?: string;
  }): Promise<ResolvedRuleWeight> {
    const { websiteId, ruleKey, cmsProvider = 'ALL', pageArchetype = 'ALL' } = params;

    try {
      // 1. Try granular match (ruleKey + websiteId + cmsProvider + pageArchetype)
      const exactMatch = await prisma.bayesianRuleWeightState.findFirst({
        where: {
          websiteId,
          ruleKey,
          cmsProvider,
          pageArchetype,
        },
      });

      if (exactMatch) {
        const total = exactMatch.alphaPosterior + exactMatch.betaPosterior;
        const posteriorMeanWinRate = total > 0 ? exactMatch.alphaPosterior / total : 0.5;
        return {
          ruleKey,
          websiteId,
          appliedWeight: Math.min(MAX_RULE_WEIGHT, Math.max(MIN_RULE_WEIGHT, exactMatch.approvedAppliedWeight)),
          alphaPosterior: exactMatch.alphaPosterior,
          betaPosterior: exactMatch.betaPosterior,
          posteriorMeanWinRate,
          approvalStatus: exactMatch.approvalStatus,
          isAutoDamped: exactMatch.isAutoDamped,
          isFallback: false,
        };
      }

      // 2. Try website-level rule match
      const siteMatch = await prisma.bayesianRuleWeightState.findFirst({
        where: {
          websiteId,
          ruleKey,
        },
      });

      if (siteMatch) {
        const total = siteMatch.alphaPosterior + siteMatch.betaPosterior;
        const posteriorMeanWinRate = total > 0 ? siteMatch.alphaPosterior / total : 0.5;
        return {
          ruleKey,
          websiteId,
          appliedWeight: Math.min(MAX_RULE_WEIGHT, Math.max(MIN_RULE_WEIGHT, siteMatch.approvedAppliedWeight)),
          alphaPosterior: siteMatch.alphaPosterior,
          betaPosterior: siteMatch.betaPosterior,
          posteriorMeanWinRate,
          approvalStatus: siteMatch.approvalStatus,
          isAutoDamped: siteMatch.isAutoDamped,
          isFallback: false,
        };
      }

      // 3. Try global default rule match (websiteId: 'GLOBAL')
      const globalMatch = await prisma.bayesianRuleWeightState.findFirst({
        where: {
          ruleKey,
          websiteId: 'GLOBAL',
        },
      });

      if (globalMatch) {
        const total = globalMatch.alphaPosterior + globalMatch.betaPosterior;
        const posteriorMeanWinRate = total > 0 ? globalMatch.alphaPosterior / total : 0.5;
        return {
          ruleKey,
          websiteId,
          appliedWeight: Math.min(MAX_RULE_WEIGHT, Math.max(MIN_RULE_WEIGHT, globalMatch.approvedAppliedWeight)),
          alphaPosterior: globalMatch.alphaPosterior,
          betaPosterior: globalMatch.betaPosterior,
          posteriorMeanWinRate,
          approvalStatus: globalMatch.approvalStatus,
          isAutoDamped: globalMatch.isAutoDamped,
          isFallback: false,
        };
      }

      // No prior state found in database -> return default baseline weight
      return {
        ruleKey,
        websiteId,
        appliedWeight: 1.0,
        alphaPosterior: DEFAULT_ALPHA_PRIOR,
        betaPosterior: DEFAULT_BETA_PRIOR,
        posteriorMeanWinRate: DEFAULT_ALPHA_PRIOR / (DEFAULT_ALPHA_PRIOR + DEFAULT_BETA_PRIOR),
        approvalStatus: 'ACTIVE',
        isAutoDamped: false,
        isFallback: true,
      };
    } catch (error: any) {
      if (isProductionMode() || process.env.NODE_ENV === 'production') {
        throw new Error(
          `POLICY_STATE_UNAVAILABLE: Failed to resolve Bayesian rule weight for '${ruleKey}' on site '${websiteId}': ${error.message}`
        );
      }

      // In non-production test/development mode, return safe fallback
      return {
        ruleKey,
        websiteId,
        appliedWeight: 1.0,
        alphaPosterior: DEFAULT_ALPHA_PRIOR,
        betaPosterior: DEFAULT_BETA_PRIOR,
        posteriorMeanWinRate: 0.5,
        approvalStatus: 'ACTIVE',
        isAutoDamped: false,
        isFallback: true,
      };
    }
  }
}
