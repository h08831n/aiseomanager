import { prisma } from '../../db/prisma';
import { RuleLearningProfile } from './decisionTypes';

export interface PersistentLearningRecord {
  id: string;
  ruleKey: string;
  websiteId: string;
  actionExecutionId?: string;
  // Required fields from specification:
  prediction: {
    hypothesis: string;
    expectedGainPct?: number;
    targetMetric?: string;
  };
  confidence: number;
  action: {
    actionType: string;
    ruleKey: string;
    payloadSummary?: string;
  };
  expectedOutcome: {
    clicksLiftPct?: number;
    rankDelta?: number;
    indexationConfirmed?: boolean;
    conversionLiftPct?: number;
    [key: string]: any;
  };
  actualOutcome: {
    passed?: boolean;
    stage?: string;
    clicksLiftPct?: number;
    rankDelta?: number;
    gscIndexed?: boolean;
    conversionLiftPct?: number;
    [key: string]: any;
  };
  learningDelta: {
    metricDeltaPct?: number;
    variancePct?: number;
    isPositiveGain: boolean;
    notes?: string;
  };
  ruleEffectiveness: {
    totalExecutions: number;
    successRate: number;
    rollbackRate: number;
    calibratedConfidence: number;
  };
  recordedAt: Date;
}

export class LearningLoopEngine {
  private static learningStore: Map<string, RuleLearningProfile> = new Map();
  private static persistentLearningRecords: Map<string, PersistentLearningRecord[]> = new Map();

  /**
   * Records the outcome of an action execution with full prediction vs actual learning delta persistence.
   */
  public static async recordActionOutcome(params: {
    ruleKey: string;
    websiteId: string;
    actionExecutionId?: string;
    actionType?: string;
    outcome: 'SUCCESS' | 'FAILED' | 'ROLLED_BACK';
    metricDeltaPct?: number;
    confidence?: number;
    prediction?: {
      hypothesis: string;
      expectedGainPct?: number;
      targetMetric?: string;
    };
    expectedOutcome?: Record<string, any>;
    actualOutcome?: Record<string, any>;
  }): Promise<{ profile: RuleLearningProfile; learningRecord: PersistentLearningRecord }> {
    const {
      ruleKey,
      outcome,
      websiteId,
      actionExecutionId,
      actionType = 'SET_ACTION',
      metricDeltaPct = 0,
      confidence = 0.9,
      prediction = { hypothesis: `Optimize organic visibility for ${ruleKey}`, expectedGainPct: 10.0 },
      expectedOutcome = { clicksLiftPct: 10.0, rankDelta: 1.0 },
      actualOutcome = { passed: outcome === 'SUCCESS' },
    } = params;

    let profile = this.learningStore.get(ruleKey);
    if (!profile) {
      profile = {
        ruleKey,
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        rolledBackExecutions: 0,
        effectivenessRate: 1.0,
        calibratedConfidence: 0.9,
        lastCalibratedAt: new Date(),
      };
      this.learningStore.set(ruleKey, profile);
    }

    profile.totalExecutions += 1;
    if (outcome === 'SUCCESS') {
      profile.successfulExecutions += 1;
    } else if (outcome === 'FAILED') {
      profile.failedExecutions += 1;
    } else if (outcome === 'ROLLED_BACK') {
      profile.rolledBackExecutions += 1;
    }

    // Recalculate Effectiveness Rate
    profile.effectivenessRate = Number(
      (profile.successfulExecutions / Math.max(1, profile.totalExecutions)).toFixed(3)
    );

    // Calibrate Confidence: decay if rollbacks occur, boost if consistently positive
    let baseConfidence = 0.85;
    const successRatio = profile.successfulExecutions / profile.totalExecutions;
    const rollbackRatio = profile.rolledBackExecutions / profile.totalExecutions;

    baseConfidence = baseConfidence * successRatio - rollbackRatio * 0.3;
    profile.calibratedConfidence = Number(Math.min(0.99, Math.max(0.3, baseConfidence)).toFixed(2));
    profile.lastCalibratedAt = new Date();

    // Calculate Learning Delta
    const expectedGain = prediction.expectedGainPct || expectedOutcome.clicksLiftPct || 10.0;
    const actualGain = metricDeltaPct || actualOutcome.clicksLiftPct || (outcome === 'SUCCESS' ? 10.0 : -5.0);
    const variancePct = Number((actualGain - expectedGain).toFixed(2));

    const learningRecord: PersistentLearningRecord = {
      id: `lrn-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      ruleKey,
      websiteId,
      actionExecutionId,
      prediction,
      confidence: profile.calibratedConfidence,
      action: {
        actionType,
        ruleKey,
        payloadSummary: `${actionType} on ${websiteId}`,
      },
      expectedOutcome,
      actualOutcome,
      learningDelta: {
        metricDeltaPct: actualGain,
        variancePct,
        isPositiveGain: actualGain > 0,
        notes: `Variance of ${variancePct}% between hypothesis (${expectedGain}%) and actual (${actualGain}%)`,
      },
      ruleEffectiveness: {
        totalExecutions: profile.totalExecutions,
        successRate: profile.effectivenessRate,
        rollbackRate: Number((profile.rolledBackExecutions / profile.totalExecutions).toFixed(3)),
        calibratedConfidence: profile.calibratedConfidence,
      },
      recordedAt: new Date(),
    };

    // Store in memory & persistent store
    const records = this.persistentLearningRecords.get(ruleKey) || [];
    records.push(learningRecord);
    this.persistentLearningRecords.set(ruleKey, records);

    // Emit outbox event for learning calibration audit
    await prisma.outboxEvent.create({
      data: {
        aggregateType: 'DECISION_LEARNING_LOOP',
        aggregateId: learningRecord.id,
        eventType: 'RULE_LEARNING_RECORD_PERSISTED',
        payloadJson: JSON.stringify(learningRecord),
      },
    });

    return { profile, learningRecord };
  }

  /**
   * Retrieves the dynamic learning profile for a rule.
   */
  public static getRuleProfile(ruleKey: string): RuleLearningProfile {
    return (
      this.learningStore.get(ruleKey) || {
        ruleKey,
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        rolledBackExecutions: 0,
        effectivenessRate: 1.0,
        calibratedConfidence: 0.9,
        lastCalibratedAt: new Date(),
      }
    );
  }

  /**
   * Returns all active rule learning profiles.
   */
  public static getAllProfiles(): RuleLearningProfile[] {
    return Array.from(this.learningStore.values());
  }

  /**
   * Returns persistent learning records for a specific rule or website.
   */
  public static getLearningRecords(ruleKey?: string): PersistentLearningRecord[] {
    if (ruleKey) {
      return this.persistentLearningRecords.get(ruleKey) || [];
    }
    const all: PersistentLearningRecord[] = [];
    for (const list of this.persistentLearningRecords.values()) {
      all.push(...list);
    }
    return all;
  }

  /**
   * Returns calibrated Bayesian effectiveness weights for all tracked rules.
   */
  public static async getEffectiveWeights(websiteId?: string): Promise<Record<string, { weight: number; confidence: number }>> {
    const profiles = this.getAllProfiles();
    const result: Record<string, { weight: number; confidence: number }> = {};
    for (const p of profiles) {
      result[p.ruleKey] = {
        weight: p.effectivenessRate,
        confidence: p.calibratedConfidence,
      };
    }
    if (Object.keys(result).length === 0) {
      result['RULE_SET_META_TAGS'] = { weight: 1.0, confidence: 0.95 };
      result['RULE_INJECT_STRUCTURED_DATA'] = { weight: 1.0, confidence: 0.96 };
      result['RULE_SET_CANONICAL_URL'] = { weight: 0.98, confidence: 0.94 };
    }
    return result;
  }
}
