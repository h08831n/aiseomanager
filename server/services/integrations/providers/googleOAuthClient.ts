import crypto from 'crypto';
import { SafeUrlPolicy } from '../../../security/safeUrlPolicy';

export interface GoogleOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number; // seconds
  tokenType: string;
  scope: string;
  idToken?: string;
}

export interface GoogleTokenInfo {
  email?: string;
  userId?: string;
  scopes: string[];
  expiresIn: number;
  issuedTo?: string;
}

export interface GoogleServiceAccountCredentials {
  clientEmail: string;
  privateKey: string;
  projectId?: string;
  tokenUri?: string;
}

export class GoogleOAuthClient {
  public static readonly DEFAULT_SCOPES = [
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/analytics.readonly',
    'openid',
    'email',
    'profile',
  ];

  public static isConfigured(): boolean {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const secret = process.env.GOOGLE_CLIENT_SECRET;
    return Boolean(clientId && clientId.trim().length > 0 && secret && secret.trim().length > 0);
  }

  public static getClientId(): string {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId || clientId.trim().length === 0) {
      throw new Error('GOOGLE_CLIENT_ID environment variable is not configured.');
    }
    return clientId.trim();
  }

  public static getClientSecret(): string {
    const secret = process.env.GOOGLE_CLIENT_SECRET;
    if (!secret || secret.trim().length === 0) {
      throw new Error('GOOGLE_CLIENT_SECRET environment variable is not configured.');
    }
    return secret.trim();
  }

  public static getRedirectUri(overrideUri?: string): string {
    if (overrideUri && overrideUri.trim().length > 0) {
      return overrideUri.trim();
    }
    const envUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    if (envUri && envUri.trim().length > 0) {
      return envUri.trim();
    }
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    return `${appUrl.replace(/\/+$/, '')}/api/integrations/google/callback`;
  }

  /**
   * Generates a cryptographically random OAuth state token.
   */
  public static generateState(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generates a PKCE code verifier and challenge.
   */
  public static generatePkce(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    return { codeVerifier, codeChallenge };
  }

  /**
   * Constructs the full Google OAuth authorization URL.
   */
  public static generateAuthUrl(params: {
    state: string;
    codeChallenge?: string;
    scopes?: string[];
    redirectUri?: string;
    prompt?: 'consent' | 'select_account' | 'none';
  }): string {
    const clientId = this.getClientId();
    const redirectUri = this.getRedirectUri(params.redirectUri);
    const scopes = params.scopes || this.DEFAULT_SCOPES;

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('state', params.state);
    url.searchParams.set('prompt', params.prompt || 'consent');
    url.searchParams.set('include_granted_scopes', 'true');

    if (params.codeChallenge) {
      url.searchParams.set('code_challenge', params.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }

    return url.toString();
  }

  /**
   * Exchanges an authorization code for access and refresh tokens.
   */
  public static async exchangeCodeForTokens(params: {
    code: string;
    codeVerifier?: string;
    redirectUri?: string;
  }): Promise<GoogleOAuthTokens> {
    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();
    const redirectUri = this.getRedirectUri(params.redirectUri);

    const bodyParams: Record<string, string> = {
      code: params.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    };

    if (params.codeVerifier) {
      bodyParams.code_verifier = params.codeVerifier;
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(bodyParams).toString(),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => 'Unknown token exchange error');
      throw new Error(`Google OAuth token exchange failed (HTTP ${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as any;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 3600,
      tokenType: data.token_type || 'Bearer',
      scope: data.scope || '',
      idToken: data.id_token,
    };
  }

  /**
   * Refreshes an expired access token using the stored refresh token.
   */
  public static async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number; scope?: string }> {
    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      if (res.status === 400 || res.status === 401) {
        throw new Error(`TOKEN_REVOKED_OR_INVALID: Google refresh token is invalid or has been revoked: ${errorText}`);
      }
      throw new Error(`TOKEN_REFRESH_FAILED: Google token refresh returned HTTP ${res.status}: ${errorText}`);
    }

    const data = (await res.json()) as any;
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in || 3600,
      scope: data.scope,
    };
  }

  /**
   * Inspects and verifies the Google token metadata against tokeninfo.
   */
  public static async verifyTokenInfo(accessToken: string): Promise<GoogleTokenInfo> {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`Invalid access token: Token verification failed with HTTP ${res.status}`);
    }

    const data = (await res.json()) as any;
    const scopeStr = data.scope || '';
    const scopes = scopeStr.split(' ').filter(Boolean);

    return {
      email: data.email,
      userId: data.sub || data.user_id,
      scopes,
      expiresIn: parseInt(data.expires_in, 10) || 0,
      issuedTo: data.azp || data.aud,
    };
  }

  /**
   * Revokes a Google access or refresh token.
   */
  public static async revokeToken(token: string): Promise<boolean> {
    try {
      const res = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Generates an OAuth 2.0 access token using Google Service Account credentials
   * via RFC 7523 RSA-SHA256 JWT Bearer Grant.
   */
  public static async getServiceAccountAccessToken(params: {
    clientEmail: string;
    privateKey: string;
    scopes?: string[];
    tokenUri?: string;
  }): Promise<{ accessToken: string; expiresIn: number; tokenType: string; scopes: string[] }> {
    const scopes = params.scopes || this.DEFAULT_SCOPES;
    const tokenUri = params.tokenUri || 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);

    const header = {
      alg: 'RS256',
      typ: 'JWT',
    };

    const claimSet = {
      iss: params.clientEmail,
      scope: scopes.join(' '),
      aud: tokenUri,
      exp: now + 3600,
      iat: now,
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedClaims = Buffer.from(JSON.stringify(claimSet)).toString('base64url');
    const signInput = `${encodedHeader}.${encodedClaims}`;

    let formattedKey = params.privateKey.trim();
    if (formattedKey.includes('\\n')) {
      formattedKey = formattedKey.replace(/\\n/g, '\n');
    }

    try {
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(signInput);
      const signature = signer.sign(formattedKey, 'base64url');
      const jwtAssertion = `${signInput}.${signature}`;

      const res = await fetch(tokenUri, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwtAssertion,
        }).toString(),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        throw new Error(`SERVICE_ACCOUNT_AUTH_FAILED (${res.status}): Google service account authorization failed: ${err}`);
      }

      const data = (await res.json()) as any;
      return {
        accessToken: data.access_token,
        expiresIn: data.expires_in || 3600,
        tokenType: data.token_type || 'Bearer',
        scopes,
      };
    } catch (err: any) {
      if (err.message?.startsWith('SERVICE_ACCOUNT_AUTH_FAILED')) {
        throw err;
      }
      throw new Error(`SERVICE_ACCOUNT_KEY_INVALID: Failed to sign JWT with service account private key: ${err.message}`);
    }
  }
}
