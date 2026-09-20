import { defineConfig } from 'prisma/config';

// Prefer DIRECT_URL (unpooled direct PostgreSQL connection) for Prisma migrations,
// falling back to DATABASE_URL if DIRECT_URL is identical or unpooled.
const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!dbUrl && process.env.NODE_ENV === 'production') {
  console.error('[PrismaConfig] FATAL: Neither DIRECT_URL nor DATABASE_URL is configured in production.');
}

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
  },
  datasource: {
    url: dbUrl || '',
  },
});

