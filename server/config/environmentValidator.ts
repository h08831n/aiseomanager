import { isProductionMode } from './runtimeMode';
import {
  CONFIG_SCHEMA,
  REQUIRED_PRODUCTION_CREDENTIALS,
  ConfigVariableSchema,
  getConfigSchema,
} from './configSchema';

export {
  CONFIG_SCHEMA,
  REQUIRED_PRODUCTION_CREDENTIALS,
  getConfigSchema,
};
export type { ConfigVariableSchema };

export interface EnvValidationIssue {
  name: string;
  issue: 'MISSING' | 'PLACEHOLDER' | 'INVALID_FORMAT';
  description: string;
}

export interface EnvValidationReport {
  isValid: boolean;
  mode: string;
  issues: EnvValidationIssue[];
  missingVariables: string[];
  checkedVariables: string[];
}

export const REQUIRED_PRODUCTION_VARIABLES = [
  'DATABASE_URL',
  'DIRECT_URL',
  'ENCRYPTION_MASTER_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_OAUTH_REDIRECT_URI',
  'AUTONOMOUS_EXECUTION_ENABLED',
] as const;

export type RequiredProductionVar = typeof REQUIRED_PRODUCTION_VARIABLES[number];

const VARIABLE_PURPOSES: Record<RequiredProductionVar, string> = {
  DATABASE_URL: 'Pooled connection string for PostgreSQL persistence.',
  DIRECT_URL: 'Direct unpooled PostgreSQL connection string for Prisma migrations & schema synchronization.',
  ENCRYPTION_MASTER_KEY: '32-byte master encryption key for AES-256-GCM token & credential encryption at rest.',
  GOOGLE_CLIENT_ID: 'Google Cloud OAuth 2.0 Web Application Client ID for GSC & GA4 integrations.',
  GOOGLE_CLIENT_SECRET: 'Google Cloud OAuth 2.0 Client Secret for server-side token exchange.',
  GOOGLE_OAUTH_REDIRECT_URI: 'Strictly authorized OAuth redirect URI for production token callback routing.',
  AUTONOMOUS_EXECUTION_ENABLED: "Global autonomy killswitch. Must be explicitly declared as 'true' or 'false'.",
};

const COMMON_PLACEHOLDERS = [
  'placeholder',
  'changeme',
  'change-me',
  'change_me',
  'your-client-id',
  'your-client-secret',
  'your-password',
  'your-encryption-key',
  'your-secret',
  'your-project',
  'my-secret',
  'fake',
  'dummy',
  'todo',
  'example',
];

/**
 * Validates a single environment variable against strict production criteria.
 */
export function validateEnvironmentVariable(
  name: RequiredProductionVar,
  value: string | undefined
): EnvValidationIssue | null {
  if (value === undefined || value === null || value.trim().length === 0) {
    return {
      name,
      issue: 'MISSING',
      description: `${VARIABLE_PURPOSES[name]} Variable is missing or empty.`,
    };
  }

  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();

  // 1. Anti-placeholder check (Never use fake fallback values)
  for (const placeholder of COMMON_PLACEHOLDERS) {
    if (lower.includes(placeholder)) {
      return {
        name,
        issue: 'PLACEHOLDER',
        description: `Value contains forbidden placeholder token '${placeholder}'. Real credentials are required.`,
      };
    }
  }

  // 2. Specific format validation per variable
  switch (name) {
    case 'DATABASE_URL':
    case 'DIRECT_URL':
      if (!trimmed.startsWith('postgresql://') && !trimmed.startsWith('postgres://')) {
        return {
          name,
          issue: 'INVALID_FORMAT',
          description: "Must be a valid PostgreSQL connection URI starting with 'postgresql://' or 'postgres://'.",
        };
      }
      break;

    case 'ENCRYPTION_MASTER_KEY':
      // 32-byte raw utf-8 (32 bytes) or 64-hex chars (32 bytes hex)
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        break; // Valid 64-character hex
      }
      if (Buffer.byteLength(trimmed, 'utf8') >= 32) {
        break; // Valid 32+ byte string
      }
      return {
        name,
        issue: 'INVALID_FORMAT',
        description: 'Must be a 64-character hex string or at least 32 bytes in length (e.g. generated via openssl rand -hex 32).',
      };

    case 'GOOGLE_CLIENT_ID':
      if (!trimmed.includes('.apps.googleusercontent.com') && !trimmed.includes('-')) {
        return {
          name,
          issue: 'INVALID_FORMAT',
          description: "Must be a valid Google OAuth Client ID (typically ending in '.apps.googleusercontent.com').",
        };
      }
      break;

    case 'GOOGLE_CLIENT_SECRET':
      if (trimmed.length < 16) {
        return {
          name,
          issue: 'INVALID_FORMAT',
          description: 'Client secret is unexpectedly short for a Google OAuth secret.',
        };
      }
      break;

    case 'GOOGLE_OAUTH_REDIRECT_URI':
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return {
            name,
            issue: 'INVALID_FORMAT',
            description: "Must be an absolute HTTP or HTTPS URL.",
          };
        }
        if (isProductionMode() && parsed.protocol !== 'https:') {
          return {
            name,
            issue: 'INVALID_FORMAT',
            description: "Must be HTTPS in production mode (Google OAuth rejects non-HTTPS redirect URIs outside localhost).",
          };
        }
      } catch {
        return {
          name,
          issue: 'INVALID_FORMAT',
          description: 'Must be a valid, well-formed URL.',
        };
      }
      break;

    case 'AUTONOMOUS_EXECUTION_ENABLED':
      if (trimmed !== 'true' && trimmed !== 'false') {
        return {
          name,
          issue: 'INVALID_FORMAT',
          description: "Must be explicitly set to 'true' or 'false'. Keep 'false' by default for safety.",
        };
      }
      break;
  }

  return null;
}

/**
 * Validates all required environment variables.
 */
export function validateEnvironment(env: NodeJS.ProcessEnv = process.env): EnvValidationReport {
  const issues: EnvValidationIssue[] = [];
  const missingVariables: string[] = [];

  for (const varName of REQUIRED_PRODUCTION_VARIABLES) {
    const val = env[varName];
    const issue = validateEnvironmentVariable(varName, val);
    if (issue) {
      issues.push(issue);
      if (issue.issue === 'MISSING') {
        missingVariables.push(varName);
      }
    }
  }

  const mode = (env.APP_MODE || env.NODE_ENV || 'DEVELOPMENT').toUpperCase();

  return {
    isValid: issues.length === 0,
    mode,
    issues,
    missingVariables,
    checkedVariables: [...REQUIRED_PRODUCTION_VARIABLES],
  };
}

/**
 * Checks whether autonomous execution is enabled.
 * Strictly disabled by default; only active when AUTONOMOUS_EXECUTION_ENABLED is strictly 'true'.
 */
export function isAutonomousExecutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTONOMOUS_EXECUTION_ENABLED === 'true';
}

/**
 * Formats a clear, actionable error banner detailing missing or invalid environment variables.
 */
export function formatStartupValidationBanner(report: EnvValidationReport): string {
  const lines: string[] = [
    '========================================================================',
    `FATAL CONFIGURATION ERROR: Startup Environment Validation Failed [MODE: ${report.mode}]`,
    '========================================================================',
    'The following required production environment variables are missing or invalid:',
    '',
  ];

  for (const issue of report.issues) {
    lines.push(`  [${issue.issue}] ${issue.name}`);
    lines.push(`    -> Description: ${issue.description}`);
    lines.push('');
  }

  lines.push('Resolution Guide:');
  lines.push('  1. Review .env.example for required variables, descriptions, and formats.');
  lines.push('  2. Never use fake fallback or placeholder values in production.');
  lines.push('  3. In Cloud Run or production container, inject secrets via Google Secret Manager or environment variables.');
  lines.push('========================================================================');

  return lines.join('\n');
}

export interface StartupValidationOptions {
  enforceStrict?: boolean;
  exitOnError?: boolean;
  customEnv?: NodeJS.ProcessEnv;
}

/**
 * Validates startup environment.
 * If in production mode or enforceStrict is true, logs error banner and throws or exits.
 */
export function validateStartupEnvironment(options: StartupValidationOptions = {}): EnvValidationReport {
  const env = options.customEnv || process.env;
  const isProd = isProductionMode() || options.enforceStrict === true;
  const report = validateEnvironment(env);

  if (!report.isValid) {
    if (isProd) {
      const banner = formatStartupValidationBanner(report);
      console.error(banner);
      if (options.exitOnError !== false) {
        process.exit(1);
      }
      throw new Error(`STARTUP_ENV_VALIDATION_FAILED: ${report.issues.map((i) => `${i.name} (${i.issue})`).join(', ')}`);
    } else {
      console.warn(
        `[Environment Warning] Missing or incomplete production variables in ${report.mode} mode: ${report.issues.map((i) => i.name).join(', ')}. (Strict enforcement active in PRODUCTION mode).`
      );
    }
  } else {
    console.log(`[Environment] Startup validation passed successfully for ${report.checkedVariables.length} required variables [MODE: ${report.mode}].`);
  }

  return report;
}
