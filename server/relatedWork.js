import { isLlmConfigured, runLlm } from './proposalGenerator.js';

// Real related-work retrieval.
// Papers come from arXiv API + Semantic Scholar API (real titles, links, citations).
// The LLM only SCORES relevance and writes rationales; it never invents papers.

const USER_AGENT = 'CS222-ProposalAgent/1.0 (research proposal coursework)';

const TOP_VENUES = [
  'osdi', 'sosp', 'nsdi', 'mlsys', 'asplos', 'isca', 'micro', 'pldi',
  'sigcomm', 'eurosys', 'fast', 'usenix atc', 'atc', 'hpca', 'ppopp', 'sc20', 'sc21', 'sc22', 'sc23', 'sc24'
];
const GOOD_VENUES = [
  'neurips', 'nips', 'icml', 'iclr', 'aaai', 'acl', 'emnlp', 'naacl',
  'cvpr', 'iccv', 'eccv', 'kdd', 'vldb', 'sigmod', 'www', 'icde', 'tpds', 'tocs'
];

const RANK_SYSTEM_PROMPT = `You are a research librarian helping evaluate related work for a CS research proposal.

You receive a research idea and a list of REAL candidate papers retrieved from arXiv and Semantic Scholar.

Return strict JSON:
{
  "rankings": [
    { "index": 0, "relevance": 0, "rationale": "one concise sentence on how this paper relates to the idea" }
  ]
}

Rules:
- relevance is an integer 0-100 measuring how relevant the paper is to the research idea.
- Score every candidate by its given index.
- Use ONLY the provided candidates. Never invent papers, titles, or links.
- The rationale must be specific to the paper's title/abstract and the idea.`;

export async function findRelatedWork({ idea, attachments = [], project = {}, provider }) {
  const query = buildQuery(idea, project);

  if (!query) {
    return { query: '', mode: 'empty', sources: {}, count: 0, top: [] };
  }

  const settled = await Promise.allSettled([
    searchArxiv(query, 8),
    searchSemanticScholar(query, 12)
  ]);

  const arxiv = settled[0].status === 'fulfilled' ? settled[0].value : [];
  const s2 = settled[1].status === 'fulfilled' ? settled[1].value : [];

  const sources = {
    arxiv: settled[0].status === 'fulfilled'
      ? `${arxiv.length} result(s)`
      : `failed: ${reasonText(settled[0].reason)}`,
    semanticScholar: settled[1].status === 'fulfilled'
      ? `${s2.length} result(s)`
      : `failed: ${reasonText(settled[1].reason)}`
  };

  // Semantic Scholar first so its venue/citation metadata wins on duplicates.
  let candidates = dedupe([...s2, ...arxiv]).slice(0, 24);

  candidates.forEach((paper) => {
    paper.influence = scoreInfluence(paper);
    paper.freshness = scoreFreshness(paper);
  });

  let mode = 'heuristic';

  if (candidates.length && isLlmConfigured(provider)) {
    try {
      const rankings = await rankWithLlm(idea, candidates, attachments, provider);
      applyRelevance(candidates, rankings);
      mode = 'llm-ranked';
    } catch {
      mode = 'heuristic-fallback';
    }
  }

  candidates.forEach((paper) => {
    if (typeof paper.relevance !== 'number') {
      paper.relevance = heuristicRelevance(paper, idea);
      paper.rationale = paper.rationale || 'Scored by keyword overlap, citations, and recency (LLM ranking unavailable).';
    }
    paper.score = Math.round(0.5 * paper.relevance + 0.3 * paper.influence + 0.2 * paper.freshness);
  });

  const top = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  return { query, mode, sources, count: candidates.length, top };
}

function buildQuery(idea, project) {
  const raw = clean(idea) || clean(project.title) || clean(project.topic);
  return raw.replace(/\.$/, '').slice(0, 220);
}

async function rankWithLlm(idea, candidates, attachments, provider) {
  const payload = {
    idea,
    candidates: candidates.map((paper, index) => ({
      index,
      title: paper.title,
      venue: paper.venue || 'unknown',
      year: paper.year || 'unknown',
      citationCount: paper.citationCount ?? 'unknown',
      abstract: clean(paper.abstract).slice(0, 600)
    }))
  };

  const content = await runLlm({
    systemPrompt: RANK_SYSTEM_PROMPT,
    payload,
    attachments,
    temperature: 0.1,
    provider
  });

  const parsed = JSON.parse(stripFence(content));
  return Array.isArray(parsed.rankings) ? parsed.rankings : [];
}

function applyRelevance(candidates, rankings) {
  rankings.forEach((row) => {
    const index = Number(row.index);
    if (Number.isInteger(index) && candidates[index]) {
      const relevance = Math.max(0, Math.min(100, Math.round(Number(row.relevance) || 0)));
      candidates[index].relevance = relevance;
      candidates[index].rationale = clean(row.rationale) || 'Relevant to the proposed research direction.';
    }
  });
}

// --- arXiv ---

async function searchArxiv(query, max) {
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:${query}`)}&start=0&max_results=${max}&sortBy=relevance&sortOrder=descending`;
  const response = await fetchWithRetry(url, { headers: { 'User-Agent': USER_AGENT } });

  if (!response.ok) {
    throw new Error(`arXiv ${response.status}`);
  }

  return parseArxiv(await response.text());
}

function parseArxiv(xml) {
  const entries = String(xml).split('<entry>').slice(1);

  return entries
    .map((block) => {
      const get = (tag) => {
        const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        return match ? decodeXml(match[1].trim()) : '';
      };

      const id = get('id');
      const published = get('published');

      return {
        source: 'arXiv',
        title: get('title').replace(/\s+/g, ' ').trim(),
        abstract: get('summary').replace(/\s+/g, ' ').trim(),
        url: id,
        venue: 'arXiv (preprint)',
        year: published ? new Date(published).getFullYear() : null,
        published,
        citationCount: null,
        arxivId: (id.match(/abs\/([^v]+)/) || [])[1] || null
      };
    })
    .filter((paper) => paper.title);
}

// --- Semantic Scholar ---

async function searchSemanticScholar(query, limit) {
  const fields = 'title,abstract,year,venue,citationCount,url,externalIds';
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${fields}`;
  const response = await fetchWithRetry(url, { headers: { 'User-Agent': USER_AGENT } });

  if (!response.ok) {
    throw new Error(`Semantic Scholar ${response.status}`);
  }

  const data = await response.json();

  return (data.data || [])
    .map((paper) => ({
      source: 'Semantic Scholar',
      title: clean(paper.title),
      abstract: clean(paper.abstract),
      url: paper.url || (paper.externalIds?.ArXiv ? `https://arxiv.org/abs/${paper.externalIds.ArXiv}` : ''),
      venue: clean(paper.venue),
      year: paper.year || null,
      citationCount: typeof paper.citationCount === 'number' ? paper.citationCount : null,
      arxivId: paper.externalIds?.ArXiv || null
    }))
    .filter((paper) => paper.title);
}

// --- scoring ---

function scoreInfluence(paper) {
  const cites = Number(paper.citationCount) || 0;
  const citeScore = Math.min(70, Math.round((Math.log10(cites + 1) / Math.log10(2000)) * 70));
  return Math.min(100, citeScore + venueBoost(paper.venue));
}

function venueBoost(venue) {
  const value = String(venue || '').toLowerCase();
  if (TOP_VENUES.some((name) => value.includes(name))) return 30;
  if (GOOD_VENUES.some((name) => value.includes(name))) return 18;
  if (!value || value.includes('arxiv')) return 0;
  return 8;
}

function scoreFreshness(paper) {
  const year = Number(paper.year) || (paper.published ? new Date(paper.published).getFullYear() : 0);
  if (!year) return 50;
  const age = new Date().getFullYear() - year;
  return Math.max(0, Math.min(100, Math.round(100 - age * 25)));
}

function heuristicRelevance(paper, idea) {
  const terms = new Set(
    String(idea).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3)
  );
  if (!terms.size) return 50;
  const haystack = `${paper.title} ${paper.abstract}`.toLowerCase();
  let hits = 0;
  terms.forEach((term) => {
    if (haystack.includes(term)) hits += 1;
  });
  return Math.min(100, Math.round((hits / terms.size) * 100));
}

// --- helpers ---

function dedupe(papers) {
  const seen = new Map();

  papers.forEach((paper) => {
    const key = normTitle(paper.title);
    if (!key) return;
    if (!seen.has(key)) {
      seen.set(key, paper);
      return;
    }
    // Merge: keep the richer record (citation count / venue), preserve a working link.
    const existing = seen.get(key);
    if (existing.citationCount == null && paper.citationCount != null) {
      paper.url = paper.url || existing.url;
      seen.set(key, paper);
    }
  });

  return [...seen.values()];
}

function normTitle(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function fetchWithRetry(url, options = {}, retries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok || (response.status !== 429 && response.status !== 503)) {
        return response;
      }
      if (attempt < retries) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(700 * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError || new Error('Request failed.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reasonText(reason) {
  return reason instanceof Error ? reason.message : String(reason || 'unknown error');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripFence(value) {
  const trimmed = String(value || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function clean(value) {
  return String(value || '').trim();
}
