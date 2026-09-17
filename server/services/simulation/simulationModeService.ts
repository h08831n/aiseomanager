import { MetricProvenanceSource } from '../provenance/provenanceTypes';

export interface SimulatedMetricTelemetry {
  isSimulation: true;
  provenance: 'SIMULATION';
  warningNotice: string;
  metrics: {
    clicks: number;
    impressions: number;
    ctr: number;
    avgPosition: number;
    projectedLiftPct: number;
  };
  sampleKeywordRankings: Array<{
    keyword: string;
    simulatedRank: number;
    provenance: 'SIMULATION';
  }>;
}

export class SimulationModeService {
  /**
   * Generates sample telemetry for sandbox, dry-runs, and scenario testing.
   *
   * STRICT GUARANTEE:
   * Any output from this service is marked with provenance = 'SIMULATION'.
   * It is programmatically banned from:
   * 1. Updating Bayesian confidence in LearningLoopEngine
   * 2. Updating rule effectiveness rates
   * 3. Being claimed as real SEO improvement in production reports
   */
  public static generateSimulatedTelemetry(params: {
    targetUrl: string;
    actionType: string;
    targetKeyword?: string;
  }): SimulatedMetricTelemetry {
    return {
      isSimulation: true,
      provenance: 'SIMULATION',
      warningNotice:
        'SIMULATION_MODE_ACTIVE: The metrics below are synthetically generated for scenario modeling. They do NOT reflect live Google Search Console, Google Analytics, or SERP rankings and cannot update autonomous learning models.',
      metrics: {
        clicks: 45,
        impressions: 1800,
        ctr: 2.5,
        avgPosition: 21.0,
        projectedLiftPct: 15.0,
      },
      sampleKeywordRankings: [
        {
          keyword: params.targetKeyword || 'sample keyword',
          simulatedRank: 21,
          provenance: 'SIMULATION',
        },
      ],
    };
  }

  /**
   * Guard validation: Checks if an object or metric contains simulated provenance.
   */
  public static isSimulationData(obj: any): boolean {
    if (!obj) return false;
    if (obj.provenance === 'SIMULATION' || obj.isSimulation === true) return true;
    if (obj.source === 'SIMULATION') return true;
    return false;
  }
}
