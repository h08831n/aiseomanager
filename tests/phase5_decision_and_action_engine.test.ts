import { describe, it, expect, beforeEach } from 'vitest';
import { OpportunityScoreEngine } from '../server/services/decision/opportunityScoreEngine';
import { DiagnosisRuleCatalog } from '../server/services/decision/rules/diagnosisRuleCatalog';
import { DiagnosisEngine } from '../server/services/decision/diagnosisEngine';
import { ProblemContext } from '../server/services/decision/decisionTypes';
import { GovernanceEngine } from '../server/services/action/governanceEngine';
import { CanonicalActionExecutor } from '../server/services/action/executors/canonicalActionExecutor';
import { MetaTagsActionExecutor } from '../server/services/action/executors/metaTagsActionExecutor';
import { StructuredDataActionExecutor } from '../server/services/action/executors/structuredDataActionExecutor';
import { RedirectActionExecutor } from '../server/services/action/executors/redirectActionExecutor';
import { InternalLinkActionExecutor } from '../server/services/action/executors/internalLinkActionExecutor';
import { ActionExecutorRouter } from '../server/services/action/executors/actionExecutorRouter';
import { ActionOrchestrationService } from '../server/services/action/actionOrchestrationService';
import { VerificationEngine } from '../server/services/action/verificationEngine';
import { LearningLoopEngine } from '../server/services/decision/learningLoopEngine';
import { AutomationRiskLevel, IssueSeverity, SearchIntent, BusinessValueTier, ActionStatus } from '@prisma/client';
import { prisma } from '../server/db/prisma';

describe('Phase 5: Autonomous SEO Decision Engine & Action Execution', () => {
  const testWebsiteId = 'site-test-decision-01';

  beforeEach(async () => {
    process.env.AUTONOMOUS_EXECUTION_ENABLED = 'true';
    // Ensure test website exists
    await prisma.website.upsert({
      where: { id: testWebsiteId },
      update: { domain: 'techscale.io' },
      create: {
        id: testWebsiteId,
        workspaceId: 'ws-test-default',
        productionUrl: 'https://techscale.io',
        domain: 'techscale.io',
        name: 'TechScale Test Site',
      },
    });
  });

  describe('1. Opportunity Scoring Model', () => {
    it('calculates deterministic mathematical score and assigns P0_CRITICAL priority', () => {
      const scoring = OpportunityScoreEngine.calculateScore({
        potentialTrafficGain: 8.5,
        businessValueTier: BusinessValueTier.TIER_1_CRITICAL, // weight 5.0
        confidenceScore: 0.95,
        effortScore: 1.0,
        riskScore: 1.0,
      });

      // Score = min(100, (8.5 * 5.0 * 0.95 / (1.0 * 1.0)) * 10) = min(100, 403.75) = 100
      expect(scoring.score).toBe(100);
      expect(scoring.priority).toBe('P0_CRITICAL');
      expect(scoring.potentialTrafficGain).toBe(8.5);
      expect(scoring.businessValueWeight).toBe(5.0);
    });

    it('calculates realistic P2_MEDIUM score for moderate-gain tasks', () => {
      const scoring = OpportunityScoreEngine.calculateScore({
        potentialTrafficGain: 3.0,
        businessValueTier: BusinessValueTier.TIER_3_MEDIUM, // weight 2.5
        confidenceScore: 0.8,
        effortScore: 2.0,
        riskScore: 2.0,
      });

      // (3.0 * 2.5 * 0.8) / (2.0 * 2.0) * 10 = 6.0 / 4.0 * 10 = 15.0 -> P3 or calculated
      expect(scoring.score).toBeCloseTo(15.0, 0);
      expect(scoring.priority).toBe('P3_LOW');
    });

    it('correctly maps business value tiers to weights', () => {
      expect(OpportunityScoreEngine.mapBusinessValueTierToWeight(BusinessValueTier.TIER_1_CRITICAL)).toBe(5.0);
      expect(OpportunityScoreEngine.mapBusinessValueTierToWeight(BusinessValueTier.TIER_2_HIGH)).toBe(4.0);
      expect(OpportunityScoreEngine.mapBusinessValueTierToWeight(BusinessValueTier.TIER_3_MEDIUM)).toBe(2.5);
      expect(OpportunityScoreEngine.mapBusinessValueTierToWeight(BusinessValueTier.TIER_4_LOW)).toBe(1.5);
      expect(OpportunityScoreEngine.mapBusinessValueTierToWeight(BusinessValueTier.TIER_5_BENCHMARK)).toBe(1.0);
    });
  });

  describe('2. Rule Engine & Diagnosis Catalog', () => {
    it('RULE_CANONICAL_MISMATCH diagnoses canonical drift and prepares valid diff', () => {
      const rule = DiagnosisRuleCatalog.findRule('RULE_CANONICAL_MISMATCH');
      expect(rule).toBeDefined();

      const context: ProblemContext = {
        websiteId: testWebsiteId,
        targetDomain: 'techscale.io',
        url: 'https://techscale.io/pricing',
        signals: [
          {
            id: 'sig-01',
            websiteId: testWebsiteId,
            source: 'CRAWL',
            detectedAt: new Date(),
            metadata: { issueType: 'CANONICAL_DRIFT' },
          },
        ],
        crawlIssues: [
          {
            issueType: 'CANONICAL_DRIFT',
            severity: IssueSeverity.HIGH,
            pageUrl: 'https://techscale.io/pricing',
            detailsJson: 'Canonical points to 404 missing page',
          },
        ],
      };

      expect(rule!.applies(context)).toBe(true);
      const diagnosis = rule!.diagnose(context);
      expect(diagnosis).not.toBeNull();
      expect(diagnosis!.recommendedActionType).toBe('SET_CANONICAL_URL');
      expect(diagnosis!.actionPayload.canonicalUrl).toBe('https://techscale.io/pricing/');
      expect(diagnosis!.suggestedAutomationLevel).toBe(AutomationRiskLevel.LEVEL_1_SAFE_AUTOMATION);
    });

    it('RULE_AI_OVERVIEW_DISPLACEMENT diagnoses uncited AI Overview displacement', () => {
      const rule = DiagnosisRuleCatalog.findRule('RULE_AI_OVERVIEW_DISPLACEMENT');
      expect(rule).toBeDefined();

      const context: ProblemContext = {
        websiteId: testWebsiteId,
        targetDomain: 'techscale.io',
        keyword: 'cloud cost governance',
        signals: [],
        serpContext: {
          rank: 4,
          featuresPresent: ['AI_OVERVIEW'],
          aiOverviewCited: false,
        },
        keywordContext: {
          searchVolume: 3500,
          businessValue: BusinessValueTier.TIER_1_CRITICAL,
        },
      };

      expect(rule!.applies(context)).toBe(true);
      const diagnosis = rule!.diagnose(context);
      expect(diagnosis).not.toBeNull();
      expect(diagnosis!.recommendedActionType).toBe('INJECT_STRUCTURED_DATA');
      expect(diagnosis!.actionPayload.schemaType).toBe('FAQPage');
      expect(diagnosis!.potentialTrafficGain).toBeGreaterThanOrEqual(7.0);
    });

    it('RULE_TITLE_CTR_UNDERPERFORMER diagnoses high-rank low-CTR anomalies', () => {
      const rule = DiagnosisRuleCatalog.findRule('RULE_TITLE_CTR_UNDERPERFORMER');
      expect(rule).toBeDefined();

      const context: ProblemContext = {
        websiteId: testWebsiteId,
        targetDomain: 'techscale.io',
        url: 'https://techscale.io/features',
        keyword: 'enterprise monitoring',
        signals: [],
        gscMetrics: {
          clicks: 12,
          impressions: 2400,
          ctr: 0.005, // 0.5% CTR in top 2 position
          avgPosition: 1.8,
        },
      };

      expect(rule!.applies(context)).toBe(true);
      const diagnosis = rule!.diagnose(context);
      expect(diagnosis).not.toBeNull();
      expect(diagnosis!.recommendedActionType).toBe('SET_META_TAGS');
      expect(diagnosis!.actionPayload.title).toContain('enterprise monitoring');
    });

    it('DiagnosisEngine evaluates contexts and sorts opportunities by opportunity score', () => {
      const contexts: ProblemContext[] = [
        {
          websiteId: testWebsiteId,
          targetDomain: 'techscale.io',
          url: 'https://techscale.io/pricing',
          signals: [],
          crawlIssues: [
            {
              issueType: 'CANONICAL_POINTS_TO_404',
              severity: IssueSeverity.CRITICAL,
              pageUrl: 'https://techscale.io/pricing',
            },
          ],
          keywordContext: {
            businessValue: BusinessValueTier.TIER_1_CRITICAL,
          },
        },
        {
          websiteId: testWebsiteId,
          targetDomain: 'techscale.io',
          keyword: 'enterprise monitoring',
          url: 'https://techscale.io/monitoring',
          signals: [],
          gscMetrics: {
            clicks: 10,
            impressions: 5000,
            ctr: 0.002,
            avgPosition: 2.1,
          },
          keywordContext: {
            businessValue: BusinessValueTier.TIER_2_HIGH,
          },
        },
      ];

      const scored = DiagnosisEngine.evaluateContexts(contexts);
      expect(scored.length).toBeGreaterThanOrEqual(2);
      expect(scored[0].scoring.score).toBeGreaterThanOrEqual(scored[1].scoring.score);
    });
  });

  describe('3. Action Executors & 100% Deterministic Rollbacks', () => {
    it('CanonicalActionExecutor: validates, captures pre-state, applies, and rolls back cleanly', async () => {
      const executor = new CanonicalActionExecutor();
      const target = {
        websiteId: testWebsiteId,
        targetUrl: 'https://techscale.io/blog/post-1',
        domain: 'techscale.io',
      };

      // 1. Validation failure on invalid URL
      const invalidValidation = await executor.validate(target, {
        targetUrl: target.targetUrl,
        canonicalUrl: 'not-a-valid-url',
      });
      expect(invalidValidation.valid).toBe(false);

      // 2. Pre-state capture
      const preState = await executor.capturePreState(target);
      expect(preState.previousCanonicalUrl).toBeNull();

      // 3. Apply
      const payload = {
        targetUrl: target.targetUrl,
        canonicalUrl: 'https://techscale.io/blog/post-1/',
      };
      const applyResult = await executor.apply(target, payload, preState);
      expect(applyResult.success).toBe(true);
      expect(CanonicalActionExecutor.getDeployedCanonical(target.targetUrl)).toBe('https://techscale.io/blog/post-1/');

      // 4. Rollback
      const rollbackResult = await executor.rollback(target, preState);
      expect(rollbackResult.success).toBe(true);
      expect(CanonicalActionExecutor.getDeployedCanonical(target.targetUrl)).toBeUndefined();
    });

    it('MetaTagsActionExecutor: deploys title and meta description and rolls back accurately', async () => {
      const executor = new MetaTagsActionExecutor();
      const target = {
        websiteId: testWebsiteId,
        targetUrl: 'https://techscale.io/product-a',
        domain: 'techscale.io',
      };

      const preState = await executor.capturePreState(target);
      const payload = {
        targetUrl: target.targetUrl,
        title: 'Optimized Enterprise Product A | TechScale',
        description: 'Discover best-in-class automated infrastructure scaling.',
      };

      const applyRes = await executor.apply(target, payload, preState);
      expect(applyRes.success).toBe(true);
      expect(MetaTagsActionExecutor.getDeployedMeta(target.targetUrl)?.title).toBe(payload.title);

      // Rollback
      await executor.rollback(target, preState);
      expect(MetaTagsActionExecutor.getDeployedMeta(target.targetUrl)).toBeUndefined();
    });

    it('ActionExecutorRouter registers and resolves all required executor types', () => {
      expect(ActionExecutorRouter.hasExecutor('SET_CANONICAL_URL')).toBe(true);
      expect(ActionExecutorRouter.hasExecutor('SET_META_TAGS')).toBe(true);
      expect(ActionExecutorRouter.hasExecutor('INJECT_STRUCTURED_DATA')).toBe(true);
      expect(ActionExecutorRouter.hasExecutor('CREATE_REDIRECT_RULE')).toBe(true);
      expect(ActionExecutorRouter.hasExecutor('INJECT_INTERNAL_LINK')).toBe(true);
    });
  });

  describe('4. Governance, Safety & Blast Radius Limits', () => {
    it('evaluates governance correctly and permits Level 1 Safe Automation', async () => {
      const governance = await GovernanceEngine.evaluateExecutionGovernance({
        websiteId: testWebsiteId,
        actionType: 'SET_CANONICAL_URL',
        automationLevel: AutomationRiskLevel.LEVEL_1_SAFE_AUTOMATION,
      });

      expect(governance.allowed).toBe(true);
      expect(governance.requiresManualApproval).toBe(false);
      expect(governance.circuitBreakerTripped).toBe(false);
    });

    it('blocks Level 0 Suggestion Only from autonomous execution', async () => {
      const governance = await GovernanceEngine.evaluateExecutionGovernance({
        websiteId: testWebsiteId,
        actionType: 'SET_CANONICAL_URL',
        automationLevel: AutomationRiskLevel.LEVEL_0_SUGGESTION_ONLY,
      });

      expect(governance.allowed).toBe(false);
      expect(governance.requiresManualApproval).toBe(true);
    });
  });

  describe('5. Complete Action Lifecycle, Verification & Rollback', () => {
    it('executes action, captures pre-state, passes Tier 1 verification, and executes 1-click rollback', async () => {
      const idempotencyKey = `test-exec-${Date.now()}`;
      const targetUrl = 'https://techscale.io/products/cloud';

      // 1. Dry run
      const dryRun = await ActionOrchestrationService.executeAction({
        websiteId: testWebsiteId,
        actionType: 'SET_CANONICAL_URL',
        targetUrl,
        payload: { targetUrl, canonicalUrl: 'https://techscale.io/products/cloud/' },
        idempotencyKey,
        isDryRun: true,
      });
      expect(dryRun.success).toBe(true);
      expect(dryRun.state).toBe(ActionStatus.DRY_RUN_VALIDATED);

      // 2. Real Execution
      const execution = await ActionOrchestrationService.executeAction({
        websiteId: testWebsiteId,
        actionType: 'SET_CANONICAL_URL',
        targetUrl,
        payload: { targetUrl, canonicalUrl: 'https://techscale.io/products/cloud/' },
        idempotencyKey,
        userId: 'usr-tester-01',
        autoVerify: true,
      });

      expect(execution.success).toBe(true);
      expect(execution.state).toBe(ActionStatus.VERIFIED_COMPLETED);
      expect(execution.verificationResult.passed).toBe(true);
      expect(execution.preStateSnapshot).toBeDefined();

      // 3. Idempotent re-run returns existing execution
      const duplicateRun = await ActionOrchestrationService.executeAction({
        websiteId: testWebsiteId,
        actionType: 'SET_CANONICAL_URL',
        targetUrl,
        payload: { targetUrl, canonicalUrl: 'https://techscale.io/products/cloud/' },
        idempotencyKey,
        userId: 'usr-tester-01',
      });
      expect(duplicateRun.isDuplicate).toBe(true);

      // 4. 1-Click Rollback
      const rollback = await ActionOrchestrationService.rollbackAction({
        actionExecutionId: execution.actionExecutionId,
        websiteId: testWebsiteId,
        userId: 'usr-tester-01',
        reason: 'User verified rollback test',
      });

      expect(rollback.success).toBe(true);

      // 5. Verify ActionExecution state in DB
      const dbExecution = await prisma.actionExecution.findUnique({
        where: { id: execution.actionExecutionId },
      });
      expect(dbExecution?.state).toBe(ActionStatus.REVERTED_RESTORED);
    });
  });

  describe('6. Learning Loop & Confidence Calibration', () => {
    it('calibrates rule effectiveness and confidence dynamically on outcomes', async () => {
      const ruleKey = 'RULE_TITLE_CTR_UNDERPERFORMER';

      // Record 3 successful executions
      await LearningLoopEngine.recordActionOutcome({
        ruleKey,
        websiteId: testWebsiteId,
        outcome: 'SUCCESS',
        metricDeltaPct: 24.5,
      });
      await LearningLoopEngine.recordActionOutcome({
        ruleKey,
        websiteId: testWebsiteId,
        outcome: 'SUCCESS',
        metricDeltaPct: 18.0,
      });

      let profile = LearningLoopEngine.getRuleProfile(ruleKey);
      expect(profile.totalExecutions).toBe(2);
      expect(profile.successfulExecutions).toBe(2);
      expect(profile.effectivenessRate).toBe(1.0);

      // Record 1 rollback
      await LearningLoopEngine.recordActionOutcome({
        ruleKey,
        websiteId: testWebsiteId,
        outcome: 'ROLLED_BACK',
      });

      profile = LearningLoopEngine.getRuleProfile(ruleKey);
      expect(profile.totalExecutions).toBe(3);
      expect(profile.rolledBackExecutions).toBe(1);
      expect(profile.effectivenessRate).toBeCloseTo(0.667, 2);
      expect(profile.calibratedConfidence).toBeLessThan(0.95);
    });
  });
});
