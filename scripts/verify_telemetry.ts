import dotenv from 'dotenv';
import { TelemetryReadinessGate, TelemetryReadinessReport } from '../server/services/integrations/telemetryReadinessGate';

dotenv.config();

function parseArgs(): { websiteUrl: string; json: boolean } {
  const args = process.argv.slice(2);
  let websiteUrl = 'https://ahaninja.com';
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--website=')) {
      websiteUrl = arg.substring('--website='.length).trim();
    } else if (arg === '--website' && i + 1 < args.length) {
      websiteUrl = args[i + 1].trim();
      i++;
    } else if (!arg.startsWith('-')) {
      websiteUrl = arg.trim();
    }
  }

  return { websiteUrl, json };
}

export function formatReadinessReport(report: TelemetryReadinessReport): string {
  const divider = '='.repeat(70);
  const subDivider = '-'.repeat(70);

  const lines: string[] = [
    divider,
    ` PRODUCTION TELEMETRY READINESS REPORT: ${report.website}`,
    divider,
    `Website:                   ${report.website}`,
    `Website ID:                ${report.websiteId || 'UNREGISTERED'}`,
    `Evaluated At:              ${report.evaluatedAt}`,
    subDivider,
    `OAuth / Token Status:      ${report.oauth.status}`,
    `Connected Account:         ${report.oauth.email || 'None'}`,
    `Granted Scopes:            ${report.oauth.scopes.length > 0 ? report.oauth.scopes.join(', ') : 'None'}`,
    `GSC Scope:                 ${report.oauth.hasGscScope ? 'GRANTED' : 'MISSING'}`,
    `GA4 Scope:                 ${report.oauth.hasGa4Scope ? 'GRANTED' : 'NOT_CONFIGURED'}`,
    subDivider,
    `GSC Property:              ${report.gsc.propertyId || 'NOT_BOUND'}`,
    `GSC Status:                ${report.gsc.status}`,
    `Permission Level:          ${report.gsc.permissionLevel || 'UNKNOWN'}`,
    `Latest Successful Sync:    ${report.gsc.latestSuccessfulSyncAt || 'NEVER'}`,
    `Latest Fact Date:          ${report.gsc.latestFactDate || 'NONE'}`,
    `Persisted Facts Count:     ${report.gsc.factCount}`,
    `GSC Provenance:            ${report.gsc.provenance}`,
    `Data Freshness:            ${report.gsc.isFresh ? 'FRESH' : 'STALE_OR_MISSING'} (${report.gsc.freshnessDays !== undefined ? `${report.gsc.freshnessDays} days old` : 'N/A'})`,
    subDivider,
    `GA4 State:                 ${report.ga4.status}`,
    `GA4 Property:              ${report.ga4.propertyId || 'NOT_CONFIGURED'}`,
    `GA4 Latest Sync:           ${report.ga4.latestSuccessfulSyncAt || 'NONE'}`,
    `GA4 Facts Count:           ${report.ga4.factCount}`,
    `GA4 Provenance:            ${report.ga4.provenance}`,
    subDivider,
    `Baseline Availability:     ${report.baseline.available ? 'AVAILABLE' : 'UNAVAILABLE'}`,
    `Baseline Provenance:       ${report.baseline.provenance}`,
    `Baseline Clicks:           ${report.baseline.clicks !== null ? report.baseline.clicks : 'N/A'}`,
    `Baseline Impressions:      ${report.baseline.impressions !== null ? report.baseline.impressions : 'N/A'}`,
    `Baseline Avg Position:     ${report.baseline.avgPosition !== null ? report.baseline.avgPosition.toFixed(1) : 'N/A'}`,
    `Baseline CTR:              ${report.baseline.ctr !== null ? `${(report.baseline.ctr * 100).toFixed(2)}%` : 'N/A'}`,
    subDivider,
    `FINAL READINESS STATE:     ${report.readinessState}`,
    `AUTONOMOUS EXPERIMENT READY: ${report.isReadyForExperiment ? 'YES - READY' : 'NO - BLOCKED'}`,
    divider,
  ];

  if (report.blockingReasons.length > 0) {
    lines.push('BLOCKING REASONS:');
    for (let i = 0; i < report.blockingReasons.length; i++) {
      lines.push(`  [${i + 1}] ${report.blockingReasons[i]}`);
    }
    lines.push(divider);
  } else {
    lines.push('BLOCKING REASONS: None. Real external telemetry is verified end-to-end.');
    lines.push(divider);
  }

  return lines.join('\n');
}

async function main() {
  const { websiteUrl, json } = parseArgs();

  try {
    const report = await TelemetryReadinessGate.evaluate({ websiteUrl });

    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReadinessReport(report));
    }

    if (report.readinessState === 'LIVE_VERIFIED') {
      process.exit(0);
    } else {
      process.exit(1);
    }
  } catch (error: any) {
    console.error('Fatal error during telemetry verification:', error);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('verify_telemetry')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
