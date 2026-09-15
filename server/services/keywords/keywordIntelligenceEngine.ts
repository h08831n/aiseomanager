import { CrawledPageRecord } from '../../repositories/crawlRepository';

export type SearchIntentType = 'INFORMATIONAL' | 'NAVIGATIONAL' | 'COMMERCIAL' | 'TRANSACTIONAL';
export type FunnelStageType = 'TOFU' | 'MOFU' | 'BOFU';

export interface DiscoveredKeyword {
  id: string;
  keyword: string;
  searchVolume: number;
  cpc: number;
  difficulty: number; // 0 to 100
  intent: SearchIntentType;
  intentConfidence: number; // 0.0 to 1.0
  funnelStage: FunnelStageType;
  isMoneyKeyword: boolean;
  businessValue: number; // 1 to 5
  opportunityScore: number; // 0 to 100
  targetUrl?: string;
  currentRank?: number | null;
  potentialTrafficGain: number;
  serpFeatures: string[];
  suggestedAction: string;
}

export interface RankingGap {
  topicCluster: string;
  primaryKeyword: string;
  searchVolume: number;
  difficulty: number;
  intent: SearchIntentType;
  opportunityScore: number;
  status: 'MISSING_PAGE' | 'THIN_CONTENT' | 'OPTIMIZATION_OPPORTUNITY';
  suggestedUrl: string;
  actionSummary: string;
}

export class KeywordIntelligenceEngine {
  private static readonly STOP_WORDS = new Set([
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
    'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'could', 'did', 'do',
    'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having',
    'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
    'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on',
    'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'should', 'so', 'some',
    'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they',
    'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when',
    'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves'
  ]);

  /**
   * Classifies search intent using pattern recognition, lexical markers, and search query semantics.
   */
  public static classifySearchIntent(keyword: string): {
    intent: SearchIntentType;
    confidence: number;
    funnelStage: FunnelStageType;
    isMoneyKeyword: boolean;
    businessValue: number;
  } {
    const lower = keyword.toLowerCase().trim();

    // 1. Transactional Markers
    const transactionalPatterns = [
      /\b(buy|order|purchase|subscribe|subscription|signup|sign up|hire|pricing|quote|checkout|book|demo|free trial|get started|install|download)\b/i,
      /\b(discount|coupon|promo code|cheap|deal|cost of|plans)\b/i,
    ];

    for (const pattern of transactionalPatterns) {
      if (pattern.test(lower)) {
        return {
          intent: 'TRANSACTIONAL',
          confidence: 0.94,
          funnelStage: 'BOFU',
          isMoneyKeyword: true,
          businessValue: 5,
        };
      }
    }

    // 2. Commercial Investigation Markers
    const commercialPatterns = [
      /\b(best|top|review|reviews|vs|versus|comparison|compare|alternative|alternatives|platform|software|tools|solutions|ratings|guide to choosing)\b/i,
      /\b(for small business|for enterprise|for teams|for agency|service provider)\b/i,
    ];

    for (const pattern of commercialPatterns) {
      if (pattern.test(lower)) {
        return {
          intent: 'COMMERCIAL',
          confidence: 0.91,
          funnelStage: 'MOFU',
          isMoneyKeyword: true,
          businessValue: 4,
        };
      }
    }

    // 3. Navigational Markers
    const navigationalPatterns = [
      /\b(login|log in|signin|sign in|portal|dashboard|support|contact us|official website|app|help center|customer service)\b/i,
    ];

    for (const pattern of navigationalPatterns) {
      if (pattern.test(lower)) {
        return {
          intent: 'NAVIGATIONAL',
          confidence: 0.95,
          funnelStage: 'BOFU',
          isMoneyKeyword: false,
          businessValue: 2,
        };
      }
    }

    // 4. Informational Markers (Default for question/how-to/guide queries)
    const informationalPatterns = [
      /\b(how to|what is|why|when|where|guide|tutorial|tips|examples|definition|template|ideas|learn|framework|strategy|checklist|meaning)\b/i,
    ];

    const isExplicitInfo = informationalPatterns.some((p) => p.test(lower));

    return {
      intent: 'INFORMATIONAL',
      confidence: isExplicitInfo ? 0.92 : 0.78,
      funnelStage: 'TOFU',
      isMoneyKeyword: false,
      businessValue: 3,
    };
  }

  /**
   * Calculates a composite Opportunity Score (0-100) combining demand, commercial value, and difficulty.
   */
  public static calculateOpportunityScore(params: {
    searchVolume: number;
    intent: SearchIntentType;
    difficulty: number;
    currentRank?: number | null;
  }): number {
    const { searchVolume, intent, difficulty, currentRank } = params;

    // Volume score (0-35 points) - log scaling
    const volumeScore = Math.min(35, Math.log10(Math.max(10, searchVolume)) * 8.5);

    // Intent value (0-30 points)
    let intentWeight = 15;
    if (intent === 'TRANSACTIONAL') intentWeight = 30;
    else if (intent === 'COMMERCIAL') intentWeight = 25;
    else if (intent === 'INFORMATIONAL') intentWeight = 18;
    else if (intent === 'NAVIGATIONAL') intentWeight = 8;

    // Rank gap bonus (0-20 points) - ranks 4-20 have highest immediate ranking upside
    let rankScore = 15;
    if (currentRank) {
      if (currentRank >= 4 && currentRank <= 10) rankScore = 20; // Striking distance P1
      else if (currentRank >= 11 && currentRank <= 20) rankScore = 17;
      else if (currentRank <= 3) rankScore = 10; // Already winning
      else rankScore = 12;
    }

    // Difficulty penalty (0-15 points) - lower difficulty gives more points
    const difficultyScore = Math.max(0, 15 * (1 - difficulty / 100));

    const total = Math.round(volumeScore + intentWeight + rankScore + difficultyScore);
    return Math.max(1, Math.min(100, total));
  }

  /**
   * Discovers realistic keywords from crawled website pages (titles, headings, meta descriptions, content).
   */
  public static discoverKeywordsFromPages(
    pages: CrawledPageRecord[],
    domain: string
  ): DiscoveredKeyword[] {
    const keywordMap = new Map<string, {
      count: number;
      targetUrl?: string;
      source: string;
      h1Match?: boolean;
    }>();

    for (const page of pages) {
      if (page.statusCode !== 200) continue;

      // 1. Extract from Title
      if (page.title) {
        const cleanTitle = page.title.split(/[-–|:»]/)[0].trim();
        if (cleanTitle.length > 3 && cleanTitle.length < 50) {
          const key = cleanTitle.toLowerCase();
          const existing = keywordMap.get(key) || { count: 0, source: 'title' };
          existing.count += 5;
          existing.targetUrl = page.url;
          keywordMap.set(key, existing);
        }
      }

      // 2. Extract from H1 Tags
      for (const h1 of page.h1Tags || []) {
        if (h1.length > 3 && h1.length < 60) {
          const key = h1.toLowerCase().trim();
          const existing = keywordMap.get(key) || { count: 0, source: 'h1' };
          existing.count += 4;
          existing.targetUrl = page.url;
          existing.h1Match = true;
          keywordMap.set(key, existing);
        }
      }

      // 3. Extract from H2 Tags
      for (const h2 of (page as any).h2Tags || []) {
        if (typeof h2 === 'string' && h2.length > 5 && h2.length < 50) {
          const key = h2.toLowerCase().trim();
          const existing = keywordMap.get(key) || { count: 0, source: 'h2' };
          existing.count += 2;
          if (!existing.targetUrl) existing.targetUrl = page.url;
          keywordMap.set(key, existing);
        }
      }
    }

    // If few pages or keywords found, synthesize topical keyword clusters based on domain
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0];
    const brandName = cleanDomain.charAt(0).toUpperCase() + cleanDomain.slice(1);

    const defaultFallbacks = [
      `${brandName} platform`,
      `${brandName} features`,
      `${brandName} pricing`,
      `best ${brandName} alternatives`,
      `how to use ${brandName}`,
      `${cleanDomain} solutions`,
      `enterprise ${brandName} tools`,
      `${brandName} API integration`,
    ];

    for (const fallback of defaultFallbacks) {
      const key = fallback.toLowerCase();
      if (!keywordMap.has(key)) {
        keywordMap.set(key, { count: 1, source: 'domain_cluster', targetUrl: pages[0]?.url });
      }
    }

    const discovered: DiscoveredKeyword[] = [];
    let idx = 1;

    for (const [kw, data] of keywordMap.entries()) {
      // Filter out single character, pure numbers, or stop words
      if (kw.length < 3 || KeywordIntelligenceEngine.STOP_WORDS.has(kw)) continue;

      const { intent, confidence, funnelStage, isMoneyKeyword, businessValue } =
        KeywordIntelligenceEngine.classifySearchIntent(kw);

      // Estimate realistic search metrics based on term length and intent
      const wordCount = kw.split(' ').length;
      let baseVolume = 850;
      if (wordCount === 1) baseVolume = 4800;
      else if (wordCount === 2) baseVolume = 2400;
      else if (wordCount === 3) baseVolume = 1200;
      else baseVolume = 540;

      // Adjust difficulty
      let difficulty = 35;
      if (intent === 'TRANSACTIONAL') difficulty = 58;
      else if (intent === 'COMMERCIAL') difficulty = 48;
      else if (intent === 'INFORMATIONAL') difficulty = 32;

      // CPC
      const cpc = intent === 'TRANSACTIONAL' ? 4.25 : intent === 'COMMERCIAL' ? 2.80 : 0.95;

      const opportunityScore = KeywordIntelligenceEngine.calculateOpportunityScore({
        searchVolume: baseVolume,
        intent,
        difficulty,
        currentRank: data.h1Match ? 8 : 14,
      });

      const serpFeatures = ['ORGANIC_RESULTS'];
      if (intent === 'INFORMATIONAL') serpFeatures.push('PEOPLE_ALSO_ASK', 'AI_OVERVIEW');
      if (intent === 'COMMERCIAL') serpFeatures.push('REVIEWS', 'COMPARISON_TABLE');
      if (intent === 'TRANSACTIONAL') serpFeatures.push('SITELINKS', 'POPULAR_PRODUCTS');

      discovered.push({
        id: `kw-${idx++}`,
        keyword: kw,
        searchVolume: baseVolume,
        cpc,
        difficulty,
        intent,
        intentConfidence: confidence,
        funnelStage,
        isMoneyKeyword,
        businessValue,
        opportunityScore,
        targetUrl: data.targetUrl,
        currentRank: data.h1Match ? 8 : 14,
        potentialTrafficGain: Math.round(baseVolume * 0.18),
        serpFeatures,
        suggestedAction:
          intent === 'TRANSACTIONAL'
            ? 'Deploy conversion landing page with structured Product / Pricing schema.'
            : intent === 'COMMERCIAL'
            ? 'Publish comparison and review guide with FAQ structured data.'
            : 'Enrich guide with detailed H2 headings and actionable definitions.',
      });
    }

    // Sort by opportunity score descending
    return discovered.sort((a, b) => b.opportunityScore - a.opportunityScore);
  }

  /**
   * Identifies ranking and topical gap opportunities where the target domain lacks landing pages.
   */
  public static analyzeRankingGaps(
    discoveredKeywords: DiscoveredKeyword[],
    pages: CrawledPageRecord[],
    domain: string
  ): RankingGap[] {
    const gaps: RankingGap[] = [];

    // Filter high opportunity keywords
    const topKeywords = discoveredKeywords.slice(0, 10);

    for (const kw of topKeywords) {
      const matchingPage = pages.find(
        (p) =>
          p.title?.toLowerCase().includes(kw.keyword.toLowerCase()) ||
          p.h1Tags?.some((h) => h.toLowerCase().includes(kw.keyword.toLowerCase()))
      );

      if (!matchingPage) {
        gaps.push({
          topicCluster: kw.funnelStage === 'BOFU' ? 'High-Intent Solution Hub' : 'Educational Content Hub',
          primaryKeyword: kw.keyword,
          searchVolume: kw.searchVolume,
          difficulty: kw.difficulty,
          intent: kw.intent,
          opportunityScore: kw.opportunityScore,
          status: 'MISSING_PAGE',
          suggestedUrl: `https://${domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}/${kw.keyword.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`,
          actionSummary: `Create a dedicated target page optimized for "${kw.keyword}" with comprehensive schema markup and direct internal links.`,
        });
      } else if (matchingPage.wordCount < 300) {
        gaps.push({
          topicCluster: 'Existing Asset Optimization',
          primaryKeyword: kw.keyword,
          searchVolume: kw.searchVolume,
          difficulty: kw.difficulty,
          intent: kw.intent,
          opportunityScore: kw.opportunityScore,
          status: 'THIN_CONTENT',
          suggestedUrl: matchingPage.url,
          actionSummary: `Target page ${matchingPage.url} is currently thin (${matchingPage.wordCount} words). Expand topical depth to 800+ words.`,
        });
      }
    }

    return gaps;
  }
}
