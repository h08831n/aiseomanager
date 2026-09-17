import { Router, Request, Response } from 'express';
import { requireWorkspaceAuth, requireWebsiteAccess } from '../security/authMiddleware';
import { WebsiteRepository } from '../repositories/websiteRepository';
import { CrawlRepository } from '../repositories/crawlRepository';
import { SeoScoringEngine } from '../services/scoring/seoScoringEngine';
import { KeywordIntelligenceEngine } from '../services/keywords/keywordIntelligenceEngine';
import { CompetitorIntelligenceEngine } from '../services/competitors/competitorIntelligenceEngine';
import { AiSeoStrategistService } from '../services/ai/aiSeoStrategistService';
import { AutonomousExecutionEngine } from '../services/action/autonomousExecutionEngine';
import { prisma } from '../db/prisma';
import { z } from 'zod';

import { ProductionValidationWorkflow } from '../services/validation/productionValidationWorkflow';
import { SafeExecutionPlanner } from '../services/action/safeExecutionPlanner';
import { WebsiteImprovementReportService } from '../services/reporting/websiteImprovementReportService';
import { CrawlCoverageAnalyzer } from '../services/crawler/crawlCoverageAnalyzer';

const router = Router();

// GET /api/seo/audit/:websiteId - Real 6-Pillar Health Audit
router.get('/audit/:websiteId', requireWebsiteAccess('VIEWER'), async (req: Request, res: Response) => {
  const website = req.website!;
  const [crawlData, issueData, linkData] = await Promise.all([
    CrawlRepository.getLatestCrawledPages(website.id, 100),
    CrawlRepository.getLatestCrawlIssues(website.id, 200),
    CrawlRepository.getLatestLinkEdges(website.id, 200),
  ]);

  const audit = SeoScoringEngine.calculateHealthScores({
    pages: crawlData.pages,
    issues: issueData.issues,
    linkEdges: linkData.links,
  });

  return res.json({
    websiteId: website.id,
    domain: website.domain,
    productionUrl: website.productionUrl,
    audit,
  });
});

// GET /api/seo/keywords/:websiteId - Keyword Discovery & Intent Classification
router.get('/keywords/:websiteId', requireWebsiteAccess('VIEWER'), async (req: Request, res: Response) => {
  const website = req.website!;
  const crawlData = await CrawlRepository.getLatestCrawledPages(website.id, 100);

  const keywords = KeywordIntelligenceEngine.discoverKeywordsFromPages(crawlData.pages, website.domain);
  const gaps = KeywordIntelligenceEngine.analyzeRankingGaps(keywords, crawlData.pages, website.domain);

  return res.json({
    websiteId: website.id,
    domain: website.domain,
    totalDiscovered: keywords.length,
    keywords,
    rankingGaps: gaps,
  });
});

// GET & POST /api/seo/competitors/:websiteId - Competitor Gap Analysis
router.get('/competitors/:websiteId', requireWebsiteAccess('VIEWER'), async (req: Request, res: Response) => {
  const website = req.website!;
  const competitorDomain = (req.query.competitor as string) || 'competitor-reference.com';
  const crawlData = await CrawlRepository.getLatestCrawledPages(website.id, 100);

  const report = await CompetitorIntelligenceEngine.analyzeCompetitor({
    targetDomain: website.domain,
    competitorDomain,
    ourPages: crawlData.pages,
  });

  return res.json(report);
});

router.post('/competitors/:websiteId/analyze', requireWebsiteAccess('EDITOR'), async (req: Request, res: Response) => {
  const website = req.website!;
  const { competitorDomain } = req.body;
  if (!competitorDomain || typeof competitorDomain !== 'string') {
    return res.status(400).json({ error: 'competitorDomain is required' });
  }

  const crawlData = await CrawlRepository.getLatestCrawledPages(website.id, 100);
  const report = await CompetitorIntelligenceEngine.analyzeCompetitor({
    targetDomain: website.domain,
    competitorDomain,
    ourPages: crawlData.pages,
  });

  return res.json(report);
});

// GET /api/seo/strategist/:websiteId/tasks - AI SEO Strategist Tasks
router.get('/strategist/:websiteId/tasks', requireWebsiteAccess('VIEWER'), async (req: Request, res: Response) => {
  const website = req.website!;
  const [crawlData, issueData, linkData] = await Promise.all([
    CrawlRepository.getLatestCrawledPages(website.id, 100),
    CrawlRepository.getLatestCrawlIssues(website.id, 200),
    CrawlRepository.getLatestLinkEdges(website.id, 200),
  ]);

  const audit = SeoScoringEngine.calculateHealthScores({
    pages: crawlData.pages,
    issues: issueData.issues,
    linkEdges: linkData.links,
  });

  const keywords = KeywordIntelligenceEngine.discoverKeywordsFromPages(crawlData.pages, website.domain);

  const tasks = await AiSeoStrategistService.generateStrategicTasks({
    websiteId: website.id,
    domain: website.domain,
    pages: crawlData.pages,
    issues: issueData.issues,
    healthAudit: audit,
    keywords,
  });

  return res.json({
    websiteId: website.id,
    domain: website.domain,
    tasksCount: tasks.length,
    tasks,
  });
});

// POST /api/seo/execute - Real Autonomous Execution & Verification Loop
const ExecuteSchema = z.object({
  websiteId: z.string(),
  taskId: z.string().optional(),
  actionType: z.string(),
  targetUrl: z.string(),
  actionPayload: z.record(z.string(), z.any()),
  platform: z.string().default('WORDPRESS'),
});

router.post('/execute', requireWorkspaceAuth('EDITOR' as any), async (req: Request, res: Response) => {
  const parseResult = ExecuteSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid execution request', details: parseResult.error.flatten() });
  }

  const site = await WebsiteRepository.getById(parseResult.data.websiteId, req.workspaceId!);
  if (!site) {
    return res.status(404).json({ error: 'Website not found or unauthorized' });
  }

  try {
    const result = await AutonomousExecutionEngine.executeAndVerify({
      websiteId: site.id,
      taskId: parseResult.data.taskId,
      actionType: parseResult.data.actionType,
      targetUrl: parseResult.data.targetUrl,
      actionPayload: parseResult.data.actionPayload,
      platform: parseResult.data.platform,
    });

    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({
      error: 'Execution or verification failed',
      message: err.message,
    });
  }
});

// POST /api/seo/quick-optimize/:websiteId - 1-Click Autonomous Optimization Suite
router.post('/quick-optimize/:websiteId', requireWebsiteAccess('EDITOR'), async (req: Request, res: Response) => {
  const website = req.website!;

  const [crawlData, issueData] = await Promise.all([
    CrawlRepository.getLatestCrawledPages(website.id, 100),
    CrawlRepository.getLatestCrawlIssues(website.id, 200),
  ]);

  const audit = SeoScoringEngine.calculateHealthScores({
    pages: crawlData.pages,
    issues: issueData.issues,
  });

  const keywords = KeywordIntelligenceEngine.discoverKeywordsFromPages(crawlData.pages, website.domain);

  const tasks = await AiSeoStrategistService.generateStrategicTasks({
    websiteId: website.id,
    domain: website.domain,
    pages: crawlData.pages,
    issues: issueData.issues,
    healthAudit: audit,
    keywords,
  });

  // Execute the top P0/P1 safe automation tasks
  const executableTasks = tasks.filter((t) => t.automationLevel === 'LEVEL_1_SAFE_AUTOMATION').slice(0, 3);
  const executionResults = [];

  for (const task of executableTasks) {
    try {
      const execResult = await AutonomousExecutionEngine.executeAndVerify({
        websiteId: website.id,
        taskId: task.id,
        actionType: task.actionType,
        targetUrl: task.targetUrl,
        actionPayload: task.actionPayload,
        platform: 'WORDPRESS',
      });
      executionResults.push(execResult);
    } catch (err: any) {
      executionResults.push({
        taskId: task.id,
        error: err.message,
        verificationPassed: false,
      });
    }
  }

  return res.json({
    websiteId: website.id,
    domain: website.domain,
    tasksGenerated: tasks.length,
    executedCount: executionResults.length,
    executionResults,
    message: `Autonomous SEO optimization completed. Executed ${executionResults.length} safe tasks with full live DOM verification.`,
  });
});

// POST /api/seo/validation/run - Run real website autonomous SEO validation
router.post('/validation/run', async (req: Request, res: Response) => {
  try {
    const { websiteUrl = 'https://ahaninja.com', maxPagesToCrawl = 25, forceSkipSafetyGate = false } = req.body;
    const result = await ProductionValidationWorkflow.executeRealWebsiteValidation({
      websiteUrl,
      maxPagesToCrawl,
      forceSkipSafetyGate,
    });
    return res.json(result);
  } catch (err: any) {
    console.error('Validation workflow error:', err);
    return res.status(500).json({ error: 'Production validation failed', message: err.message });
  }
});

// GET /api/seo/validation/ahaninja - Quick test endpoint for target site
router.get('/validation/ahaninja', async (req: Request, res: Response) => {
  try {
    const result = await ProductionValidationWorkflow.executeRealWebsiteValidation({
      websiteUrl: 'https://ahaninja.com',
      maxPagesToCrawl: 20,
    });
    return res.json(result);
  } catch (err: any) {
    console.error('Validation ahaninja error:', err);
    return res.status(500).json({ error: 'Production validation failed', message: err.message });
  }
});

// GET /api/seo/report/ahaninja - 7-Part Real Website Improvement Report for ahaninja.com
router.get('/report/ahaninja', async (req: Request, res: Response) => {
  try {
    const report = await WebsiteImprovementReportService.generateReport({
      websiteUrl: 'https://ahaninja.com',
      maxPagesToCrawl: 20,
    });
    return res.json(report);
  } catch (err: any) {
    console.error('Report ahaninja error:', err);
    return res.status(500).json({ error: 'Report generation failed', message: err.message });
  }
});

// POST /api/seo/report - Generate 7-Part Real Website Improvement Report for any domain
router.post('/report', async (req: Request, res: Response) => {
  try {
    const { websiteUrl = 'https://ahaninja.com', maxPagesToCrawl = 20 } = req.body;
    const report = await WebsiteImprovementReportService.generateReport({
      websiteUrl,
      maxPagesToCrawl,
    });
    return res.json(report);
  } catch (err: any) {
    console.error('Report generation error:', err);
    return res.status(500).json({ error: 'Report generation failed', message: err.message });
  }
});

// POST /api/seo/plan/:websiteId - Generate Safe Execution Plan
router.post('/plan/:websiteId', requireWebsiteAccess('EDITOR'), async (req: Request, res: Response) => {
  try {
    const website = req.website!;
    const [crawlData, issueData] = await Promise.all([
      CrawlRepository.getLatestCrawledPages(website.id, 100),
      CrawlRepository.getLatestCrawlIssues(website.id, 200),
    ]);

    const coverageReport = CrawlCoverageAnalyzer.analyzeCoverage({
      websiteId: website.id,
      seedUrl: website.domain.startsWith('http') ? website.domain : `https://${website.domain}`,
      crawlRunId: 'ad-hoc-plan',
      pages: crawlData.pages,
      issues: issueData.issues,
    });

    const healthAudit = SeoScoringEngine.calculateHealthScores({
      pages: crawlData.pages,
      issues: issueData.issues,
      coverageReport,
    });

    const tasks = await AiSeoStrategistService.generateStrategicTasks({
      websiteId: website.id,
      domain: website.domain,
      pages: crawlData.pages,
      issues: issueData.issues,
      healthAudit,
      keywords: [],
    });

    const plan = SafeExecutionPlanner.generatePlan({
      websiteId: website.id,
      domain: website.domain,
      tasks,
      coverageReport,
      crawledPages: crawlData.pages,
    });

    return res.json(plan);
  } catch (err: any) {
    console.error('Plan generation error:', err);
    return res.status(500).json({ error: 'Plan generation failed', message: err.message });
  }
});

// POST /api/seo/plan/:websiteId/execute-safe-batch - Execute Autonomous Batch
router.post('/plan/:websiteId/execute-safe-batch', requireWebsiteAccess('ADMIN'), async (req: Request, res: Response) => {
  try {
    const website = req.website!;
    const { platform = 'WORDPRESS' } = req.body;

    const [crawlData, issueData] = await Promise.all([
      CrawlRepository.getLatestCrawledPages(website.id, 100),
      CrawlRepository.getLatestCrawlIssues(website.id, 200),
    ]);

    const coverageReport = CrawlCoverageAnalyzer.analyzeCoverage({
      websiteId: website.id,
      seedUrl: website.domain.startsWith('http') ? website.domain : `https://${website.domain}`,
      crawlRunId: 'ad-hoc-exec',
      pages: crawlData.pages,
      issues: issueData.issues,
    });

    const healthAudit = SeoScoringEngine.calculateHealthScores({
      pages: crawlData.pages,
      issues: issueData.issues,
      coverageReport,
    });

    const tasks = await AiSeoStrategistService.generateStrategicTasks({
      websiteId: website.id,
      domain: website.domain,
      pages: crawlData.pages,
      issues: issueData.issues,
      healthAudit,
      keywords: [],
    });

    const plan = SafeExecutionPlanner.generatePlan({
      websiteId: website.id,
      domain: website.domain,
      tasks,
      coverageReport,
      crawledPages: crawlData.pages,
    });

    const executionResults = await SafeExecutionPlanner.executeAutonomousBatch({
      plan,
      platform,
    });

    return res.json({
      websiteId: website.id,
      domain: website.domain,
      autonomousBatchCount: plan.autonomousBatch.length,
      executedCount: executionResults.executed.length,
      executionResults,
    });
  } catch (err: any) {
    console.error('Batch execution error:', err);
    return res.status(500).json({ error: 'Batch execution failed', message: err.message });
  }
});

export default router;
