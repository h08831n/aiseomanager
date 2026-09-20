import { describe, it, expect } from 'vitest';
import {
  validateEnvironment,
  validateStartupEnvironment,
  isAutonomousExecutionEnabled,
  REQUIRED_PRODUCTION_VARIABLES,
  formatStartupValidationBanner,
} from '../server/config/environmentValidator';
import { checkDatabaseReadiness } from '../server/db/databaseReadiness';

describe('Production Environment Hardening & Startup Validation', () => {
  const mockValidEnv: Record<string, string> = {
    DATABASE_URL: 'postgresql://user:pass@db-host:5432/seo_prod?schema=public',
    DIRECT_URL: 'postgresql://user:pass@db-direct:5432/seo_prod',
    ENCRYPTION_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    GOOGLE_CLIENT_ID: '123456789-abcdef.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-SecretRealKey12345',
    GOOGLE_OAUTH_REDIRECT_URI: 'https://ahaninja.com/api/integrations/google/callback',
    AUTONOMOUS_EXECUTION_ENABLED: 'false',
    APP_MODE: 'PRODUCTION',
    NODE_ENV: 'production',
  };


  it('declares all 7 required production environment variables', () => {
    expect(REQUIRED_PRODUCTION_VARIABLES).toEqual([
      'DATABASE_URL',
      'DIRECT_URL',
      'ENCRYPTION_MASTER_KEY',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_OAUTH_REDIRECT_URI',
      'AUTONOMOUS_EXECUTION_ENABLED',
    ]);
  });

  it('passes validation when all required production variables are valid and non-placeholder', () => {
    const report = validateEnvironment(mockValidEnv as any);
    expect(report.isValid).toBe(true);
    expect(report.issues).toHaveLength(0);
    expect(report.missingVariables).toHaveLength(0);
  });

  it('fails clearly and identifies the exact missing variables when any are omitted', () => {
    const incompleteEnv = { ...mockValidEnv };
    delete incompleteEnv.DIRECT_URL;
    delete incompleteEnv.GOOGLE_CLIENT_SECRET;

    const report = validateEnvironment(incompleteEnv as any);
    expect(report.isValid).toBe(false);
    expect(report.missingVariables).toContain('DIRECT_URL');
    expect(report.missingVariables).toContain('GOOGLE_CLIENT_SECRET');

    const banner = formatStartupValidationBanner(report);
    expect(banner).toContain('[MISSING] DIRECT_URL');
    expect(banner).toContain('[MISSING] GOOGLE_CLIENT_SECRET');
  });

  it('throws an explicit startup error in strict/production mode if variables are missing', () => {
    const incompleteEnv = { ...mockValidEnv };
    delete incompleteEnv.ENCRYPTION_MASTER_KEY;

    expect(() => {
      validateStartupEnvironment({
        enforceStrict: true,
        exitOnError: false,
        customEnv: incompleteEnv as any,
      });
    }).toThrowError(/STARTUP_ENV_VALIDATION_FAILED.*ENCRYPTION_MASTER_KEY/);
  });

  it('detects and rejects fake fallback and placeholder values', () => {
    const fakePlaceholderEnv = {
      ...mockValidEnv,
      GOOGLE_CLIENT_ID: 'your-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'placeholder-secret',
    };

    const report = validateEnvironment(fakePlaceholderEnv as any);
    expect(report.isValid).toBe(false);

    const issues = report.issues.filter((i) => i.issue === 'PLACEHOLDER');
    expect(issues.some((i) => i.name === 'GOOGLE_CLIENT_ID')).toBe(true);
    expect(issues.some((i) => i.name === 'GOOGLE_CLIENT_SECRET')).toBe(true);
  });

  it('validates database URL protocol format', () => {
    const invalidUrlEnv = {
      ...mockValidEnv,
      DATABASE_URL: 'mysql://localhost:3306/db',
    };

    const report = validateEnvironment(invalidUrlEnv as any);
    expect(report.isValid).toBe(false);
    const dbIssue = report.issues.find((i) => i.name === 'DATABASE_URL');
    expect(dbIssue?.issue).toBe('INVALID_FORMAT');
  });

  it('validates encryption key length and format', () => {
    const shortKeyEnv = {
      ...mockValidEnv,
      ENCRYPTION_MASTER_KEY: 'short-key',
    };

    const report = validateEnvironment(shortKeyEnv as any);
    expect(report.isValid).toBe(false);
    const encIssue = report.issues.find((i) => i.name === 'ENCRYPTION_MASTER_KEY');
    expect(encIssue?.issue).toBe('INVALID_FORMAT');
  });

  it('keeps autonomous execution strictly disabled by default', () => {
    // Missing -> disabled
    expect(isAutonomousExecutionEnabled({})).toBe(false);
    // Explicit 'false' -> disabled
    expect(isAutonomousExecutionEnabled({ AUTONOMOUS_EXECUTION_ENABLED: 'false' })).toBe(false);
    // Invalid value -> disabled
    expect(isAutonomousExecutionEnabled({ AUTONOMOUS_EXECUTION_ENABLED: '0' })).toBe(false);
    expect(isAutonomousExecutionEnabled({ AUTONOMOUS_EXECUTION_ENABLED: 'yes' })).toBe(false);
    // Only 'true' enables autonomy
    expect(isAutonomousExecutionEnabled({ AUTONOMOUS_EXECUTION_ENABLED: 'true' })).toBe(true);
  });

  it('performs database readiness check with complete status breakdown', async () => {
    const result = await checkDatabaseReadiness({ timeoutMs: 2000, exitOnFailure: false });
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('connection');
    expect(result).toHaveProperty('availability');
    expect(result).toHaveProperty('migrations');
    expect(result).toHaveProperty('details');
    expect(typeof result.timestamp).toBe('string');
  });
});
