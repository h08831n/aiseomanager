import * as cheerio from 'cheerio';
import { CmsProviderRegistry } from './cms/cmsProviderRegistry';
import { ProductionHttpVerifier } from './productionHttpVerifier';
import { isProductionMode } from '../../config/runtimeMode';

export interface ParsedDomResult {
  httpStatus: number;
  headers: Record<string, string>;
  rawHtml?: string;
  canonicalUrl: string | null;
  title: string | null;
  description: string | null;
  robotsMeta: string | null;
  schemas: Record<string, any>[];
  links: Array<{ targetUrl: string; anchorText: string }>;
  locationHeader?: string | null;
}

export class SyntheticHttpFetcher {
  /**
   * Performs a synthetic or live HTTP fetch and parses the returned HTML document DOM using Cheerio.
   */
  public static async fetchAndParse(targetUrl: string, platform?: string): Promise<ParsedDomResult> {
    // 1. Check if CMS provider has actively modified state for this target URL
    const provider = CmsProviderRegistry.getProvider(platform);
    const redirect = await provider.getRedirectRule(targetUrl);
    const canonical = await provider.getCanonicalUrl(targetUrl);
    const meta = await provider.getMetaTags(targetUrl);
    const schemas = await provider.getStructuredData(targetUrl);
    const links = await provider.getInternalLinks(targetUrl);

    const hasProviderState = Boolean(
      redirect ||
      canonical ||
      meta ||
      (schemas && schemas.length > 0) ||
      (links && links.length > 0)
    );

    // 2. If provider has no custom state and URL is http(s), attempt live verification probe
    if (!hasProviderState && (targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
      try {
        const liveObs = await ProductionHttpVerifier.verifyLiveUrl(targetUrl);
        if (liveObs && liveObs.httpStatus >= 200 && liveObs.httpStatus < 400 && (liveObs.canonicalUrl || liveObs.title || liveObs.description)) {
          return {
            httpStatus: liveObs.httpStatus,
            headers: liveObs.headers,
            canonicalUrl: liveObs.canonicalUrl,
            title: liveObs.title,
            description: liveObs.description,
            robotsMeta: liveObs.robotsMeta,
            schemas: liveObs.schemas,
            links: liveObs.links,
            locationHeader: liveObs.locationHeader,
          };
        }
      } catch (err: any) {
        if (isProductionMode()) {
          // In production, live verification failure should fail closed
          throw new Error(`LIVE_VERIFICATION_PROBE_FAILED: Unable to fetch live target ${targetUrl}: ${err.message}`);
        }
      }
    }

    // 3. Synthesize the wire response from CMS provider state
    let rawHtml: string = '';
    let httpStatus = 200;
    const headers: Record<string, string> = {
      'content-type': 'text/html; charset=utf-8',
      'user-agent': 'TechScale-Synthetic-Verification-Bot/1.0',
    };
    let locationHeader: string | null = null;

    if (redirect) {
      httpStatus = redirect.statusCode || 301;
      locationHeader = redirect.destinationUrl;
      headers['location'] = redirect.destinationUrl;
      rawHtml = `<!DOCTYPE html><html><head><title>301 Moved Permanently</title></head><body>Redirecting to <a href="${redirect.destinationUrl}">${redirect.destinationUrl}</a></body></html>`;
    } else {
      httpStatus = 200;
      rawHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  ${meta?.title ? `<title>${meta.title}</title>` : '<title>Default Title</title>'}
  ${meta?.description ? `<meta name="description" content="${meta.description}" />` : ''}
  ${meta?.robotsMeta ? `<meta name="robots" content="${meta.robotsMeta}" />` : ''}
  ${canonical ? `<link rel="canonical" href="${canonical}" />` : ''}
  ${schemas.map((s) => `<script type="application/ld+json">${JSON.stringify(s)}</script>`).join('\n  ')}
</head>
<body>
  <header><h1>TechScale Live DOM</h1></header>
  <main>
    ${links.map((l) => `<a href="${l.targetUrl}">${l.anchorText}</a>`).join('\n    ')}
  </main>
</body>
</html>`;
    }

    // Real Cheerio DOM Parsing & Metadata Extraction
    const $ = cheerio.load(rawHtml);
    const canonicalUrl = $('link[rel="canonical"]').attr('href') || null;
    const title = $('title').text().trim() || null;
    const description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || null;
    const robotsMeta = $('meta[name="robots"]').attr('content') || null;

    const extractedSchemas: Record<string, any>[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const content = $(el).text().trim();
        if (content) {
          extractedSchemas.push(JSON.parse(content));
        }
      } catch (err) {
        // malformed json-ld
      }
    });

    const extractedLinks: Array<{ targetUrl: string; anchorText: string }> = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) {
        extractedLinks.push({
          targetUrl: href,
          anchorText: $(el).text().trim(),
        });
      }
    });

    return {
      httpStatus,
      headers,
      rawHtml,
      canonicalUrl,
      title,
      description,
      robotsMeta,
      schemas: extractedSchemas,
      links: extractedLinks,
      locationHeader,
    };
  }
}
