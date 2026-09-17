import { Router, Request, Response } from 'express';
import { DecisionEvaluationService } from '../services/decision/decisionEvaluationService';
import { DiagnosisRuleCatalog } from '../services/decision/rules/diagnosisRuleCatalog';
import { LearningLoopEngine } from '../services/decision/learningLoopEngine';
import { ActionQueueProducer } from '../queues/actionQueueProducer';
import { RuleWeightResolver } from '../services/bayesian/ruleWeightResolver';
import { requireWebsiteAccess } from '../security/authMiddleware';

const router = Router();

// POST /api/decision/evaluate
router.post('/evaluate', requireWebsiteAccess('EDITOR'), async (req: Request, res: Response) => {
  try {
    const websiteId = req.website!.id;
    const asyncMode = req.query.async === 'true';

    if (asyncMode) {
      const { jobId, deduplicated } = await ActionQueueProducer.enqueueAction({
        jobType: 'EVALUATE_DECISIONS',
        websiteId,
      });
      return res.json({ status: 'QUEUED', jobId, deduplicated });
    }

    const result = await DecisionEvaluationService.evaluateDecisions({
      websiteId,
      targetUrl: req.body.targetUrl,
      targetKeyword: req.body.targetKeyword,
      cmsProvider: req.body.cmsProvider,
      pageArchetype: req.body.pageArchetype,
      persist: req.body.persist !== false,
      correlationId: req.body.correlationId || (req.headers['x-correlation-id'] as string),
    });

    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/decision/rules
router.get('/rules', requireWebsiteAccess('VIEWER'), async (req: Request, res: Response) => {
  const websiteId = req.website?.id || (req.headers['x-website-id'] as string) || (req.query.websiteId as string);
  const rules = DiagnosisRuleCatalog.getAllRules().map((r) => ({
    id: r.id,
    version: r.version,
    name: r.name,
    category: r.category,
    description: r.description,
    defaultAutomationLevel: r.defaultAutomationLevel,
    baseEffort: r.baseEffort,
    baseRisk: r.baseRisk,
  }));

  if (websiteId) {
    const weights = await RuleWeightResolver.resolveWeightsForRules(websiteId, rules.map((r) => r.id));
    return res.json({ rules, resolvedWeights: weights });
  }

  return res.json({ rules });
});

// GET /api/decision/learning-stats
router.get('/learning-stats', requireWebsiteAccess('VIEWER'), async (req: Request, res: Response) => {
  const profiles = LearningLoopEngine.getAllProfiles();
  const history = LearningLoopEngine.getLearningHistory();
  return res.json({
    profiles,
    historyCount: history.length,
    recentAudits: history.slice(-20),
    dataProvenanceRules: {
      allowedSourcesForBayesianCalibration: ['GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS', 'SERP_PROVIDER'],
      rejectedSourcesForRankingEvidence: ['INTERNAL_DIAGNOSTIC', 'SIMULATION'],
    },
  });
});

export default router;
