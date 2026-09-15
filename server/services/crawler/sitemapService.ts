import * as cheerio from 'cheerio';
import zlib from 'zlib';
import { SafeUrlPolicy } from '../../security/safeUrlPolicy';
import { UrlNormalizer } from './urlNormalizer';

export interface DiscoveredSitemapUrl {
  loc: string;
  normalizedUrl: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

export interface SitemapDiscoveryResult {
  discoveredUrls: DiscoveredSitemapUrl[];
  sitemapIndexUrls: string[];
  totalUrls: number;
  errors: string[];
}

function decompressGzipBounded(buffer: Buffer, maxDecompressedBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    gunzip.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxDecompressedBytes) {
        gunzip.destroy(new Error(`Decompressed sitemap size exceeded safety limit of ${maxDecompressedBytes} bytes`));
      } else {
        chunks.push(chunk);
      }
    });

    gunzip.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    gunzip.on('error', (err) => {
      reject(err);
    });

    gunzip.end(buffer);
  });
}

export class SitemapService {
  public static readonly MAX_SITEMAP_BYTES = 10 * 1024 * 1024; // 10MB max raw bytes
  public static readonly MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024; // 50MB decompressed max
  public static readonly MAX_GLOBAL_SITEMAP_URLS = 50000;
  public static readonly MAX_SITEMAP_FILES = 100;
  public static readonly MAX_SITEMAP_INDEX_DEPTH = 3;

  /**
   * Fetches and parses a sitemap XML or sitemap index with global safety caps and streaming gzip support
   */
  public static async discoverUrlsFromSitemap(
    sitemapUrl: string,
    currentDepth = 0,
    visitedSitemaps: Set<string> = new Set(),
    globalUrlCountRef = { count: 0 }
  ): Promise<SitemapDiscoveryResult> {
    const result: SitemapDiscoveryResult = {
      discoveredUrls: [],
      sitemapIndexUrls: [],
      totalUrls: 0,
      errors: [],
    };

    if (currentDepth > this.MAX_SITEMAP_INDEX_DEPTH) {
      result.errors.push(`Maximum sitemap index nesting depth of ${this.MAX_SITEMAP_INDEX_DEPTH} exceeded`);
      return result;
    }

    if (visitedSitemaps.size >= this.MAX_SITEMAP_FILES) {
      result.errors.push(`Maximum sitemap file limit (${this.MAX_SITEMAP_FILES}) reached`);
      return result;
    }

    const normalizedSitemapUrl = UrlNormalizer.normalize(sitemapUrl);
    if (visitedSitemaps.has(normalizedSitemapUrl)) {
      return result;
    }
    visitedSitemaps.add(normalizedSitemapUrl);

    try {
      const fetchResult = await SafeUrlPolicy.safeFetch(sitemapUrl, {
        timeoutMs: 12000,
        maxRedirects: 3,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 (compatible; AISEOManagerBot/2.0)',
        maxResponseBytes: this.MAX_SITEMAP_BYTES,
        allowedContentTypes: ['application/xml', 'text/xml', 'application/gzip', 'application/x-gzip', 'text/plain', '*/*'],
      });

      let xmlContent = fetchResult.body;

      // Handle gzip compressed sitemaps (.xml.gz or gzip content type or magic bytes)
      if (
        sitemapUrl.endsWith('.gz') ||
        fetchResult.contentType.includes('gzip') ||
        fetchResult.contentType.includes('octet-stream') ||
        fetchResult.rawBuffer.slice(0, 2).equals(Buffer.from([0x1f, 0x8b]))
      ) {
        try {
          const decompressed = await decompressGzipBounded(fetchResult.rawBuffer, this.MAX_DECOMPRESSED_BYTES);
          xmlContent = decompressed.toString('utf-8');
        } catch (decompErr: any) {
          if (!xmlContent.includes('<?xml') && !xmlContent.includes('<urlset') && !xmlContent.includes('<sitemapindex')) {
            result.errors.push(`Failed to decompress gzipped sitemap: ${decompErr.message}`);
            return result;
          }
        }
      }

      const $ = cheerio.load(xmlContent, { xmlMode: true });

      // 1. Sitemap Index (<sitemapindex>)
      const sitemapTags = $('sitemapindex > sitemap');
      if (sitemapTags.length > 0) {
        const nestedSitemaps: string[] = [];
        sitemapTags.each((_, el) => {
          const loc = $(el).find('loc').text().trim();
          if (loc) nestedSitemaps.push(loc);
        });

        result.sitemapIndexUrls.push(...nestedSitemaps);

        for (const nestedUrl of nestedSitemaps.slice(0, 5)) {
          if (globalUrlCountRef.count >= this.MAX_GLOBAL_SITEMAP_URLS) break;
          const subResult = await this.discoverUrlsFromSitemap(nestedUrl, currentDepth + 1, visitedSitemaps, globalUrlCountRef);
          result.discoveredUrls.push(...subResult.discoveredUrls);
          result.sitemapIndexUrls.push(...subResult.sitemapIndexUrls);
          result.errors.push(...subResult.errors);
        }
      } else {
        // 2. Standard URL set (<urlset > url>)
        $('urlset > url').each((_, el) => {
          if (globalUrlCountRef.count >= this.MAX_GLOBAL_SITEMAP_URLS) return;

          const loc = $(el).find('loc').text().trim();
          if (!loc) return;

          try {
            const normalized = UrlNormalizer.normalize(loc);
            const lastmod = $(el).find('lastmod').text().trim() || undefined;
            const changefreq = $(el).find('changefreq').text().trim() || undefined;
            const priorityText = $(el).find('priority').text().trim();
            const priority = priorityText ? parseFloat(priorityText) : undefined;

            result.discoveredUrls.push({
              loc,
              normalizedUrl: normalized,
              lastmod,
              changefreq,
              priority: isNaN(priority || 0) ? undefined : priority,
            });

            globalUrlCountRef.count++;
          } catch {
            // Ignore malformed URL
          }
        });
      }

      result.totalUrls = result.discoveredUrls.length;
      return result;
    } catch (err: any) {
      result.errors.push(`Error fetching sitemap ${sitemapUrl}: ${err.message}`);
      return result;
    }
  }
}
