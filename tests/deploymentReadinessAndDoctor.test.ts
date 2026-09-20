import { describe, it, expect } from 'vitest';
import {
  CONFIG_SCHEMA,
  getConfigSchema,
  getVariableSchema,
  REQUIRED_PRODUCTION_CREDENTIALS,
} from '../server/config/configSchema';
import {
  validateEnvironment,
  validateStartupEnvironment,
} from '../server/config/environmentValidator';
import {
  runDiagnosticChecks,
  formatDoctorOutput,
  checkGoogleOAuth,
  checkEncryption,
  checkAutonomousExecution,
} from '../scripts/doctor';

describe('Task 1: Single Source of Truth Configuration Schema', () => {
  it('defines all required schema metadata for every configuration variable', () => {
    const schema = getConfigSchema();
    const variableNames = Object.keys(schema);

    expect(variableNames.length).toBeGreaterThanOrEqual(15);

    for (const varName of variableNames) {
      const def = schema[varName];
      // name
      expect(def.name).toBe(varName);
      // required/optional
      expect(['required', 'optional', 'required_in_production']).toContain(def.required);
      // default
      expect(def).toHaveProperty('default');
      // environment scope
      expect(['server', 'client', 'shared']).toContain(def.environmentScope);
      // validation rule
      expect(def.validationRule).toBeDefined();
      expect(typeof def.validationRule.ruleDescription).toBe('string');
      expect(typeof def.validationRule.validate).toBe('function');
    }
  });

  it('declares the 5 strict production credentials in the schema', () => {
    expect(REQUIRED_PRODUCTION_CREDENTIALS).toEqual([
      'DATABASE_URL',
      'DIRECT_URL',
      'ENCRYPTION_MASTER_KEY',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
    ]);

    for (const cred of REQUIRED_PRODUCTION_CREDENTIALS) {
      const spec = getVariableSchema(cred);
      expect(spec).toBeDefined();
      expect(spec?.required).toBe('required_in_production');
      expect(spec?.environmentScope).toBe('server');
    }
  });

  it('validates variables using single source of truth rules', () => {
    const dbSpec = getVariableSchema('DATABASE_URL')!;
    expect(dbSpec.validationRule.validate('invalid-uri', {}).valid).toBe(false);
    expect(dbSpec.validationRule.validate('postgresql://user:pass@localhost:5432/db', {}).valid).toBe(true);

    const encSpec = getVariableSchema('ENCRYPTION_MASTER_KEY')!;
    expect(encSpec.validationRule.validate('short', {}).valid).toBe(false);
    expect(
      encSpec.validationRule.validate('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', {})
        .valid
    ).toBe(true);
  });
});

describe('Task 2: Startup Diagnostic Command (npm run doctor)', () => {
  it('formats the exact diagnostic output structure required', () => {
    const sampleResult = {
      database: 'READY' as const,
      prisma: 'READY' as const,
      redis: 'ERROR' as const,
      googleOAuth: 'READY' as const,
      encryption: 'READY' as const,
      autonomousExecution: 'DISABLED' as const,
    };

    const output = formatDoctorOutput(sampleResult);

    expect(output).toBe(`Database:
READY

Prisma:
READY

Redis:
ERROR

Google OAuth:
READY

Encryption:
READY

Autonomous execution:
DISABLED`);
  });

  it('accurately evaluates Google OAuth status based on credentials and placeholders', () => {
    // Missing credentials -> ERROR
    expect(checkGoogleOAuth({})).toBe('ERROR');

    // Forbidden placeholder -> ERROR
    expect(
      checkGoogleOAuth({
        GOOGLE_CLIENT_ID: 'your-client-id.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'GOCSPX-SecretRealKey12345',
      })
    ).toBe('ERROR');

    // Valid real credentials -> READY
    expect(
      checkGoogleOAuth({
        GOOGLE_CLIENT_ID: '123456789-abc.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'GOCSPX-SecretRealKey12345',
      })
    ).toBe('READY');
  });

  it('accurately evaluates AES-256-GCM encryption status with round-trip test', () => {
    // Missing -> ERROR
    expect(checkEncryption({})).toBe('ERROR');

    // Invalid format -> ERROR
    expect(checkEncryption({ ENCRYPTION_MASTER_KEY: 'not-32-bytes' })).toBe('ERROR');

    // Valid 64-character hex key -> READY
    expect(
      checkEncryption({
        ENCRYPTION_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      })
    ).toBe('READY');
  });

  it('accurately evaluates autonomous execution killswitch status', () => {
    expect(checkAutonomousExecution({})).toBe('DISABLED');
    expect(checkAutonomousExecution({ AUTONOMOUS_EXECUTION_ENABLED: 'false' })).toBe('DISABLED');
    expect(checkAutonomousExecution({ AUTONOMOUS_EXECUTION_ENABLED: 'true' })).toBe('ENABLED');
  });

  it('executes runDiagnosticChecks and returns all 6 subsystems', async () => {
    const result = await runDiagnosticChecks({
      DATABASE_URL: 'invalid-db',
      REDIS_URL: 'redis://invalid-redis:6379',
      AUTONOMOUS_EXECUTION_ENABLED: 'false',
    });

    expect(result).toHaveProperty('database');
    expect(result).toHaveProperty('prisma');
    expect(result).toHaveProperty('redis');
    expect(result).toHaveProperty('googleOAuth');
    expect(result).toHaveProperty('encryption');
    expect(result).toHaveProperty('autonomousExecution');

    expect(['READY', 'ERROR']).toContain(result.database);
    expect(['READY', 'ERROR']).toContain(result.prisma);
    expect(['READY', 'ERROR']).toContain(result.redis);
    expect(['READY', 'ERROR']).toContain(result.googleOAuth);
    expect(['READY', 'ERROR']).toContain(result.encryption);
    expect(['ENABLED', 'DISABLED']).toContain(result.autonomousExecution);
  });
});

describe('Task 3: Development Mode Execution (APP_MODE=development)', () => {
  it('does not throw startup validation error in development mode without production credentials', () => {
    const devEnv = {
      APP_MODE: 'DEVELOPMENT',
      NODE_ENV: 'development',
      DATABASE_URL: '',
      DIRECT_URL: '',
      ENCRYPTION_MASTER_KEY: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    };

    expect(() => {
      validateStartupEnvironment({
        enforceStrict: false,
        exitOnError: false,
        customEnv: devEnv as any,
      });
    }).not.toThrow();
  });
});

describe('Task 4: Production Mode Credential Enforcement', () => {
  const validProductionEnv = {
    APP_MODE: 'PRODUCTION',
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://postgres:pass@db:5432/seo',
    DIRECT_URL: 'postgresql://postgres:pass@direct:5432/seo',
    ENCRYPTION_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    GOOGLE_CLIENT_ID: '123456789.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-SecretRealKey12345',
    GOOGLE_OAUTH_REDIRECT_URI: 'https://mysite.com/api/integrations/google/callback',
    AUTONOMOUS_EXECUTION_ENABLED: 'false',
  };

  it.each([
    'DATABASE_URL',
    'DIRECT_URL',
    'ENCRYPTION_MASTER_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
  ])('strictly requires %s in production mode', (varName) => {
    const incompleteEnv = { ...validProductionEnv };
    delete (incompleteEnv as any)[varName];

    expect(() => {
      validateStartupEnvironment({
        enforceStrict: true,
        exitOnError: false,
        customEnv: incompleteEnv as any,
      });
    }).toThrowError(new RegExp(`STARTUP_ENV_VALIDATION_FAILED.*${varName}`));
  });

  it('passes validation when all 5 credentials and production variables are present', () => {
    const report = validateStartupEnvironment({
      enforceStrict: true,
      exitOnError: false,
      customEnv: validProductionEnv as any,
    });

    expect(report.isValid).toBe(true);
    expect(report.missingVariables).toHaveLength(0);
  });
});
