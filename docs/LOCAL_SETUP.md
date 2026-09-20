# Local Setup & Deployment Readiness Guide

This document defines the **exact, reproducible steps** to configure and run the Autonomous AI SEO Manager locally, as well as the architectural mandates governing credentials, fallbacks, and data authenticity.

---

## 1. Core Operating Mandates

### A. No Fake Credentials
- **Strict Prohibition**: Never supply dummy, synthetic, or placeholder credentials (e.g. `changeme`, `your-client-id`, `your-password`, `fake`, `dummy`).
- **Validation Rule**: The startup environment validator (`server/config/environmentValidator.ts`) and schema validator (`server/config/configSchema.ts`) scan all inputs against banned placeholder patterns.
- **Outcome**: Supplying placeholder tokens will cause immediate validation failure.

### B. No Silent Fallback
- **Strict Transparency**: The system never masks connection or configuration errors.
- **Production Mode**: Missing or malformed production variables immediately halt the process with code `1` and output a structured diagnostic failure banner listing the exact offending variables.
- **Development Mode**: If optional services (e.g. Redis, live Google OAuth) are absent, explicit warning banners are logged to `stderr`/`stdout`. Services will run in transparent dev mode with explicit status indicators (`DISCONNECTED`, `INSUFFICIENT_DATA`) rather than silently pretending to be operational.

### C. No Synthetic SEO Data
- **Empirical Evidence Only**: The engine strictly enforces an **anti-synthetic evidence mandate**.
- **No Fabricated Metrics**: If Google Search Console (GSC), Google Analytics 4 (GA4), or SERP providers are disconnected or lack recorded search history, the reporting engine and Bayesian confidence updater record `INSUFFICIENT_DATA` or zero observed lift.
- **Telemetry Integrity**: Under no circumstances are mock clicks, synthetic impressions, or estimated rank lifts recorded to database models or used to calibrate autonomous machine learning weights.

---

## 2. Prerequisites

Ensure your development workstation has:
- **Node.js**: v20.x or v22.x LTS
- **npm**: v10.x or later
- **Docker & Docker Compose**: For local PostgreSQL 16 and Redis 7 containers
- **OpenSSL**: For generating the 32-byte AES-256-GCM encryption key (`openssl rand -hex 32`)

---

## 3. Step-by-Step Setup Procedure

### Step 1: Install Dependencies
```bash
npm install
```
This also triggers Prisma client code generation (`prisma generate`).

---

### Step 2: Initialize Environment Configuration
Copy the template to your local environment file:
```bash
cp .env.example .env
```

---

### Step 3: Generate Master Encryption Key
Integration credentials (OAuth refresh tokens, CMS secrets) are encrypted with **AES-256-GCM** at rest. Generate a cryptographically random 32-byte (64 hex characters) key:
```bash
openssl rand -hex 32
```
Copy the generated 64-character string into `.env`:
```env
ENCRYPTION_MASTER_KEY=4a8f9c2d1e0b5a7c3e9f1d2b4a6c8e0f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d
```
*(Do NOT use the example key above; generate your own random key).*

---

### Step 4: Launch Local PostgreSQL & Redis via Docker
Start the isolated development database and Redis instances:
```bash
docker compose up -d postgres redis
```
Verify the containers are healthy:
```bash
docker compose ps
```

In `.env`, set:
```env
DATABASE_URL="postgresql://postgres:postgres_dev_password@localhost:5432/ai_seo_manager?schema=public"
DIRECT_URL="postgresql://postgres:postgres_dev_password@localhost:5432/ai_seo_manager?schema=public"
REDIS_URL="redis://localhost:6379"
```

---

### Step 5: Synchronize Database Schema
Push the Prisma schema to create tables, indexes, and relations:
```bash
npm run db:push
```

---

### Step 6: Run the System Diagnostic Command
Verify the health and configuration of all system layers:
```bash
npm run doctor
```
**Diagnostic Output:**
```text
Database:
READY / ERROR

Prisma:
READY / ERROR

Redis:
READY / ERROR

Google OAuth:
READY / ERROR

Encryption:
READY / ERROR

Autonomous execution:
ENABLED / DISABLED
```

- When PostgreSQL, Prisma, Redis, and Encryption are properly configured, their status will show `READY`.
- Google OAuth will display `READY` once real client credentials are added, or `ERROR` if unconfigured.
- Autonomous execution shows `DISABLED` by default as a safety safeguard (`AUTONOMOUS_EXECUTION_ENABLED=false`).

---

### Step 7: (Optional) Configure Google OAuth for Live GSC & GA4 Sync
To connect live Google Search Console and GA4 properties:
1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select your project and enable:
   - **Google Search Console API**
   - **Google Analytics Data API**
   - **Google Analytics Admin API**
3. Configure the OAuth Consent Screen (Scopes: `webmasters.readonly`, `analytics.readonly`).
4. Create an **OAuth Client ID** (Type: Web Application):
   - Authorized JavaScript origin: `http://localhost:3000`
   - Authorized redirect URI: `http://localhost:3000/api/integrations/google/callback`
5. Place the credentials in `.env`:
   ```env
   GOOGLE_CLIENT_ID="[your-id].apps.googleusercontent.com"
   GOOGLE_CLIENT_SECRET="[your-secret]"
   GOOGLE_OAUTH_REDIRECT_URI="http://localhost:3000/api/integrations/google/callback"
   ```

---

### Step 8: Start the Application

#### Option A: Single Command Development
```bash
npm run dev
```
Starts the Express API server and Vite frontend on `http://localhost:3000`.

#### Option B: Split Architecture (API + Background Worker)
For deep autonomous crawls and queue processing:
- **Terminal 1 (Web & API Server):**
  ```bash
  npm run dev:api
  ```
- **Terminal 2 (Autonomous Worker Runtime):**
  ```bash
  npm run dev:worker
  ```

---

## 4. Environment Modes: Development vs. Production

| Capability | Development (`APP_MODE=DEVELOPMENT`) | Production (`APP_MODE=PRODUCTION`) |
| :--- | :--- | :--- |
| **Strict Variable Gate** | Soft warning; boots with in-memory fallbacks | **Hard fatal exit** if any of the 5 core credentials are missing |
| **Required Variables** | None (runs offline sandbox) | `DATABASE_URL`, `DIRECT_URL`, `ENCRYPTION_MASTER_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| **Redis Requirement** | Optional (falls back to in-process poller) | Required for distributed BullMQ workers |
| **Redirect Protocol** | Allows `http://localhost:3000/...` | Strictly requires `https://` |
| **Autonomy Safety** | Default `false` (recommendations require approval) | Default `false` (`AUTONOMOUS_EXECUTION_ENABLED=true` required for live writes) |

---

## 5. Verification Checklist
- [ ] Run `npm run doctor` to confirm `Database`, `Prisma`, and `Encryption` are `READY`.
- [ ] Run `npm test` to verify unit and integration tests pass.
- [ ] Verify `http://localhost:3000/api/health/integrations` returns valid integration statuses without leaking secrets.
