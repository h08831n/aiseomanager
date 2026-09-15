import dns from 'dns';
import { promisify } from 'util';
import net from 'net';
import { Agent, fetch as undiciFetch } from 'undici';

const lookupAsync = promisify(dns.lookup);

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  allowedContentTypes?: string[];
  userAgent?: string;
  headers?: Record<string, string>;
}

export interface RedirectHopRecord {
  sourceUrl: string;
  targetUrl: string;
  statusCode: number;
  hopIndex: number;
}

export interface SafeFetchResult {
  requestedUrl: string;
  finalUrl: string;
  redirectCount: number;
  redirectChain: RedirectHopRecord[];
  isDowngradeToHttp: boolean;
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  rawBuffer: Buffer;
  contentType: string;
  loadTimeMs: number;
}

export type DnsResolverFn = (hostname: string) => Promise<string[]>;

/**
 * 1. SafeDestinationPolicy: Validates Host, IP, Protocol, and Port
 */
export class SafeDestinationPolicy {
  private static customResolver: DnsResolverFn | null = null;

  public static setCustomResolver(resolver: DnsResolverFn | null): void {
    this.customResolver = resolver;
  }

  public static isIpBlocked(ip: string): boolean {
    if (ip.startsWith('::ffff:')) {
      const ipv4 = ip.substring(7);
      return this.isIpBlocked(ipv4);
    }

    if (net.isIPv6(ip)) {
      const normalized = ip.toLowerCase();
      if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
      if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
      if (
        normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') ||
        normalized.startsWith('fea') ||
        normalized.startsWith('feb')
      )
        return true;
      if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
      return false;
    }

    if (net.isIPv4(ip)) {
      const parts = ip.split('.').map((p) => parseInt(p, 10));
      if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return true;

      const [b0, b1, b2, b3] = parts;
      if (b0 === 0) return true; // Current network
      if (b0 === 127) return true; // Loopback
      if (b0 === 10) return true; // RFC1918 Private
      if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // RFC1918 Private
      if (b0 === 192 && b1 === 168) return true; // RFC1918 Private
      if (b0 === 169 && b1 === 254) return true; // Link-Local & Cloud Metadata
      if (b0 === 100 && b1 >= 64 && b1 <= 127) return true; // Carrier-grade NAT
      if (
        (b0 === 192 && b1 === 0 && b2 === 2) ||
        (b0 === 198 && b1 === 51 && b2 === 100) ||
        (b0 === 203 && b1 === 0 && b2 === 113)
      )
        return true;
      if (b0 >= 224) return true; // Multicast & Reserved

      return false;
    }

    return true;
  }

  public static async resolveAndValidate(
    hostname: string
  ): Promise<{ valid: boolean; resolvedIps: string[]; error?: string }> {
    const lowerHost = hostname.toLowerCase();

    if (
      lowerHost === 'localhost' ||
      lowerHost.endsWith('.localhost') ||
      lowerHost.endsWith('.local') ||
      lowerHost.endsWith('.internal') ||
      lowerHost === 'metadata.google.internal' ||
      lowerHost === 'instance-data'
    ) {
      return {
        valid: false,
        resolvedIps: [],
        error: `Access to internal hostname "${hostname}" is blocked.`,
      };
    }

    if (net.isIP(hostname)) {
      if (this.isIpBlocked(hostname)) {
        return {
          valid: false,
          resolvedIps: [hostname],
          error: `IP address "${hostname}" is in a private or restricted range.`,
        };
      }
      return { valid: true, resolvedIps: [hostname] };
    }

    try {
      let ips: string[] = [];
      if (this.customResolver) {
        ips = await this.customResolver(hostname);
      } else {
        const lookupResult = await lookupAsync(hostname, { all: true });
        ips = lookupResult.map((r) => r.address);
      }

      if (!ips || ips.length === 0) {
        return { valid: false, resolvedIps: [], error: `DNS returned no addresses for ${hostname}` };
      }

      for (const ip of ips) {
        if (this.isIpBlocked(ip)) {
          return {
            valid: false,
            resolvedIps: ips,
            error: `Domain "${hostname}" resolved to restricted IP "${ip}". Access blocked.`,
          };
        }
      }

      return { valid: true, resolvedIps: ips };
    } catch (err: any) {
      return { valid: false, resolvedIps: [], error: `DNS resolution failed: ${err.message}` };
    }
  }
}

/**
 * 2. ResponseContentPolicy
 */
export class ResponseContentPolicy {
  public static validateContentType(contentType: string, allowedTypes: string[]): boolean {
    if (!allowedTypes || allowedTypes.length === 0 || allowedTypes.includes('*/*')) return true;
    const lower = (contentType || '').toLowerCase();
    return allowedTypes.some((t) => lower.includes(t.toLowerCase()));
  }

  public static validateByteSize(currentBytes: number, maxBytes: number): void {
    if (currentBytes > maxBytes) {
      throw new Error(`Response payload exceeded size limit of ${maxBytes} bytes`);
    }
  }
}

/**
 * 3. SafeUrlPolicy
 */
export class SafeUrlPolicy {
  public static isIpBlocked(ip: string): boolean {
    return SafeDestinationPolicy.isIpBlocked(ip);
  }

  public static async validateUrl(targetUrl: string): Promise<{ valid: boolean; error?: string; resolvedIp?: string; parsedUrl?: URL }> {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return { valid: false, error: 'Invalid URL format' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: `Disallowed protocol: ${parsed.protocol}. Only http: and https: are permitted.` };
    }

    const destCheck = await SafeDestinationPolicy.resolveAndValidate(parsed.hostname);
    if (!destCheck.valid) {
      return { valid: false, error: destCheck.error };
    }

    return { valid: true, resolvedIp: destCheck.resolvedIps[0], parsedUrl: parsed };
  }

  public static async safeFetch(
    initialUrl: string,
    options: SafeFetchOptions = {}
  ): Promise<SafeFetchResult> {
    const {
      timeoutMs = 8000,
      maxRedirects = 5,
      maxResponseBytes = 5 * 1024 * 1024,
      allowedContentTypes = ['text/html', 'application/xhtml+xml', 'text/plain', 'application/xml', 'text/xml', 'application/x-gzip', 'application/gzip', '*/*'],
      userAgent = 'Mozilla/5.0 (compatible; AI-SEO-Manager/2.0; +https://techscale.io/bot)',
    } = options;

    let currentUrl = initialUrl;
    let redirectCount = 0;
    const redirectChain: RedirectHopRecord[] = [];
    let isDowngradeToHttp = false;
    const startTime = Date.now();

    while (redirectCount <= maxRedirects) {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch {
        throw new Error(`Invalid URL: ${currentUrl}`);
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Protocol "${parsed.protocol}" not allowed. Only HTTP and HTTPS are permitted.`);
      }

      const destCheck = await SafeDestinationPolicy.resolveAndValidate(parsed.hostname);
      if (!destCheck.valid) {
        throw new Error(`SSRF Guard blocked request to ${currentUrl}: ${destCheck.error}`);
      }

      const pinnedIp = destCheck.resolvedIps[0];

      // Undici Agent with DNS pinning to pinned IP, enforcing TLS verification & SNI
      const dispatcher = new Agent({
        connect: {
          lookup: (_hostname: string, opts: any, cb: any) => {
            if (typeof opts === 'function') {
              cb = opts;
              opts = {};
            }
            if (SafeDestinationPolicy.isIpBlocked(pinnedIp)) {
              cb(new Error(`SSRF TOCTOU Guard: Target IP ${pinnedIp} is blocked`), null as any, 4);
              return;
            }
            const family = net.isIPv6(pinnedIp) ? 6 : 4;
            if (opts && opts.all) {
              cb(null, [{ address: pinnedIp, family }]);
            } else {
              cb(null, pinnedIp, family);
            }
          },
          rejectUnauthorized: true,
          servername: parsed.hostname,
        },
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await undiciFetch(currentUrl, {
          method: 'GET',
          headers: {
            'User-Agent': userAgent,
            Accept: allowedContentTypes.join(', '),
            'Accept-Language': 'en-US,en;q=0.5',
            Host: parsed.host,
            ...(options.headers || {}),
          },
          signal: controller.signal,
          redirect: 'manual',
          dispatcher,
        });

        clearTimeout(timeoutId);

        // Check redirects
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) {
            throw new Error(`Redirect ${response.status} missing Location header`);
          }

          const nextUrl = new URL(location, currentUrl).toString();
          redirectCount++;

          redirectChain.push({
            sourceUrl: currentUrl,
            targetUrl: nextUrl,
            statusCode: response.status,
            hopIndex: redirectCount,
          });

          if (currentUrl.startsWith('https://') && nextUrl.startsWith('http://')) {
            isDowngradeToHttp = true;
          }

          if (redirectCount > maxRedirects) {
            throw new Error(`Exceeded maximum redirect limit of ${maxRedirects}`);
          }

          currentUrl = nextUrl;
          continue;
        }

        // Validate Content-Type
        const contentType = response.headers.get('content-type') || '';
        if (!ResponseContentPolicy.validateContentType(contentType, allowedContentTypes)) {
          throw new Error(`CONTENT_TYPE_NOT_ALLOWED: Response content-type "${contentType}" is not in allowed list [${allowedContentTypes.join(', ')}]`);
        }

        // Stream and bound reading of response body
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;

        if (response.body) {
          const reader = (response.body as any).getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              totalBytes += value.length;
              if (totalBytes > maxResponseBytes) {
                controller.abort();
                throw new Error(`Response payload exceeded size limit of ${maxResponseBytes} bytes`);
              }
              chunks.push(value);
            }
          }
        }

        const rawBuffer = Buffer.concat(chunks);
        const bodyText = rawBuffer.toString('utf-8');

        const headersMap: Record<string, string> = {};
        response.headers.forEach((val, key) => {
          headersMap[key.toLowerCase()] = val;
        });

        return {
          requestedUrl: initialUrl,
          finalUrl: currentUrl,
          redirectCount,
          redirectChain,
          isDowngradeToHttp,
          statusCode: response.status,
          headers: headersMap,
          body: bodyText,
          rawBuffer,
          contentType,
          loadTimeMs: Date.now() - startTime,
        };
      } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          throw new Error(`Request timed out after ${timeoutMs}ms`);
        }
        throw err;
      }
    }

    throw new Error(`Exceeded maximum redirect limit of ${maxRedirects}`);
  }

  public static async safeMutateRequest(
    targetUrl: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      headers?: Record<string, string>;
      body?: any;
      timeoutMs?: number;
      maxRedirects?: number;
    } = {}
  ): Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    json?: any;
  }> {
    const {
      method = 'POST',
      headers = {},
      body,
      timeoutMs = 10000,
      maxRedirects = 3,
    } = options;

    let currentUrl = targetUrl;
    let redirectCount = 0;

    while (redirectCount <= maxRedirects) {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch {
        throw new Error(`Invalid URL: ${currentUrl}`);
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Protocol "${parsed.protocol}" not allowed. Only HTTP and HTTPS are permitted.`);
      }

      const destCheck = await SafeDestinationPolicy.resolveAndValidate(parsed.hostname);
      if (!destCheck.valid) {
        throw new Error(`SSRF Guard blocked mutation request to ${currentUrl}: ${destCheck.error}`);
      }

      const pinnedIp = destCheck.resolvedIps[0];

      const dispatcher = new Agent({
        connect: {
          lookup: (_hostname: string, _opts: any, cb: any) => {
            if (SafeDestinationPolicy.isIpBlocked(pinnedIp)) {
              cb(new Error(`SSRF TOCTOU Guard: Target IP ${pinnedIp} is blocked`), null as any, 4);
            } else {
              cb(null, pinnedIp, net.isIPv6(pinnedIp) ? 6 : 4);
            }
          },
          rejectUnauthorized: true,
          servername: parsed.hostname,
        },
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      let payloadString: string | undefined = undefined;
      const requestHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (compatible; AI-SEO-Manager-MutationEngine/2.0)',
        ...headers,
      };

      if (body !== undefined && body !== null) {
        if (typeof body === 'string') {
          payloadString = body;
        } else if (Buffer.isBuffer(body)) {
          payloadString = body.toString('utf-8');
        } else {
          payloadString = JSON.stringify(body);
          if (!requestHeaders['content-type'] && !requestHeaders['Content-Type']) {
            requestHeaders['Content-Type'] = 'application/json';
          }
        }
      }

      try {
        const response = await undiciFetch(currentUrl, {
          method,
          headers: requestHeaders,
          body: payloadString,
          signal: controller.signal,
          redirect: 'manual',
          dispatcher,
        });

        clearTimeout(timeoutId);

        // Check for redirects
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) {
            throw new Error(`Redirect ${response.status} missing Location header`);
          }

          const nextUrl = new URL(location, currentUrl).toString();
          redirectCount++;

          if (currentUrl.startsWith('https://') && nextUrl.startsWith('http://')) {
            throw new Error(`SSRF Guard: Insecure redirect downgrade from HTTPS to HTTP blocked: ${nextUrl}`);
          }

          if (redirectCount > maxRedirects) {
            throw new Error(`Exceeded maximum redirect limit of ${maxRedirects}`);
          }

          currentUrl = nextUrl;
          continue;
        }

        const bodyText = await response.text();
        const headersMap: Record<string, string> = {};
        response.headers.forEach((val, key) => {
          headersMap[key.toLowerCase()] = val;
        });

        let json: any = undefined;
        try {
          json = JSON.parse(bodyText);
        } catch {
          // not JSON
        }

        return {
          statusCode: response.status,
          headers: headersMap,
          body: bodyText,
          json,
        };
      } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          throw new Error(`Mutation request timed out after ${timeoutMs}ms`);
        }
        throw err;
      }
    }

    throw new Error(`Exceeded maximum redirect limit of ${maxRedirects}`);
  }
}

export class SafeMutationHttpClient {
  public static async execute(params: {
    url: string;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    headers?: Record<string, string>;
    body?: any;
    timeoutMs?: number;
  }) {
    return SafeUrlPolicy.safeMutateRequest(params.url, {
      method: params.method,
      headers: params.headers,
      body: params.body,
      timeoutMs: params.timeoutMs,
    });
  }
}
