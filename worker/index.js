/**
 * Cloudflare Worker: RatelSlop Repository Cache & Aggregator
 * 
 * - Caches aggregated repository and language data on the Cloudflare Edge (TTL: 180s / 3 minutes)
 * - Revalidates sanitized public metadata with ETags and pauses calls on throttling
 * - Optionally authenticates using the server-side GITHUB_TOKEN secret
 * - Does not add custom visitor logging; Cloudflare still processes connection data
 */

const GITHUB_ORG = 'RatelSlop';
const CACHE_TTL_SECONDS = 180; // 3 minutes cache (2-5 min freshness requirement)
// Separate this response format from earlier Worker cache entries.
const CACHE_PATH = '/repos-public-v2';

function numericHeader(response, name) {
  const value = response.headers.get(name);
  if (value === null || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

async function githubFailureDiagnostics(response) {
  const remaining = numericHeader(response, 'x-ratelimit-remaining');
  let rateLimit = null;
  if (response.status === 403 || response.status === 429) {
    rateLimit = remaining === 0 ? 'primary' : 'unconfirmed';
    // GitHub error messages can contain the source IP. Only expose a classification.
    if (rateLimit !== 'primary') {
      try {
        const body = await response.json();
        if (typeof body?.message === 'string' && /secondary rate limit/i.test(body.message)) {
          rateLimit = 'secondary';
        }
      } catch {
        // A non-JSON error still has useful status and numeric headers.
      }
    }
  }
  return {
    status: response.status,
    rate_limit: rateLimit,
    limit: numericHeader(response, 'x-ratelimit-limit'),
    remaining,
    reset: numericHeader(response, 'x-ratelimit-reset'),
    retry_after: numericHeader(response, 'retry-after'),
  };
}

function repositoryFailure(github) {
  return new Response(
    JSON.stringify({ error: 'Failed to fetch repositories', ...(github ? { github } : {}) }),
    {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-Edge-Cache': 'MISS',
      },
    }
  );
}

function publicRepositoryMetadata(repo) {
  return {
    name: repo.name,
    private: false,
    description: typeof repo.description === 'string' ? repo.description : null,
    html_url: `https://github.com/${GITHUB_ORG}/${encodeURIComponent(repo.name)}`,
    homepage: safeHomepage(repo.homepage),
    language: typeof repo.language === 'string' ? repo.language : null,
    languages: Array.isArray(repo.languages) ? repo.languages.filter(language => typeof language === 'string' && language.length > 0) : [],
    stargazers_count: Number.isSafeInteger(repo.stargazers_count) && repo.stargazers_count > 0 ? repo.stargazers_count : 0,
    archived: repo.archived === true,
  };
}

function safeHomepage(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u0020\u007f\\]/.test(value.trim())) return null;
  try {
    const trimmed = value.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return ['https:', 'http:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const REVALIDATION_PATH = '/repos-revalidation-v1';
const REVALIDATION_TTL_SECONDS = 3600;
const GITHUB_TIMEOUT_MS = 8000;
const MAX_GITHUB_REQUESTS = 40;
const MAX_REPOSITORY_PAGES = 5;
const REPOSITORIES_URL = `https://api.github.com/orgs/${GITHUB_ORG}/repos?type=public&sort=pushed&direction=desc&per_page=100`;

function validRepository(repo) {
  return repo && repo.private === false && typeof repo.name === 'string'
    && /^[A-Za-z0-9_.-]{1,100}$/.test(repo.name) && !repo.name.startsWith('.');
}

function validEtag(value) {
  return typeof value === 'string' && /^(?:W\/)?"[a-f0-9]{32,128}"$/i.test(value) ? value : null;
}

function validLanguages(value) {
  return Array.isArray(value) && value.every(language => typeof language === 'string' && language.length > 0);
}

function emptyState() {
  return { savedAt: 0, pages: Object.create(null), languages: Object.create(null), cooldown: null };
}

function nextRepositoryUrl(link) {
  const match = typeof link === 'string' && link.match(/<([^>]+)>;\s*rel="next"/);
  if (!match) return null;
  const url = new URL(match[1]);
  const page = url.searchParams.get('page');
  if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash
    || !/^\/(?:orgs\/RatelSlop|organizations\/\d+)\/repos$/.test(url.pathname)
    || url.searchParams.get('type') !== 'public' || url.searchParams.get('per_page') !== '100'
    || url.searchParams.get('sort') !== 'pushed' || url.searchParams.get('direction') !== 'desc'
    || !/^[1-9]\d{0,5}$/.test(page || '')) {
    throw new Error('Invalid GitHub pagination');
  }
  // GitHub uses numeric organization routes in Link headers. Keep our own org fixed.
  const next = new URL(REPOSITORIES_URL);
  next.searchParams.set('page', page);
  return next.href;
}

function readState(value) {
  const state = emptyState();
  if (!value || !Number.isSafeInteger(value.savedAt) || value.savedAt > Date.now()
    || Date.now() - value.savedAt > REVALIDATION_TTL_SECONDS * 1000) return state;
  for (const [url, page] of Object.entries(value.pages || {})) {
    if (url !== REPOSITORIES_URL && nextRepositoryUrl(`<${url}>; rel="next"`) !== url) continue;
    if (!page || !Array.isArray(page.repos) || !page.repos.every(validRepository)) continue;
    const next = page.next === null ? null : nextRepositoryUrl(`<${page.next}>; rel="next"`);
    state.pages[url] = { etag: validEtag(page.etag), next, repos: page.repos.map(publicRepositoryMetadata) };
  }
  for (const [name, entry] of Object.entries(value.languages || {})) {
    if (/^[A-Za-z0-9_.-]{1,100}$/.test(name) && entry && validLanguages(entry.languages)) {
      state.languages[name] = { etag: validEtag(entry.etag), languages: entry.languages };
    }
  }
  const cooldown = value.cooldown;
  if (cooldown && Number.isSafeInteger(cooldown.until) && cooldown.until > Date.now()
    && cooldown.until <= Date.now() + REVALIDATION_TTL_SECONDS * 1000
    && cooldown.github && [403, 429].includes(cooldown.github.status)) {
    const github = cooldown.github;
    state.cooldown = {
      until: cooldown.until,
      github: Object.fromEntries(['status', 'limit', 'remaining', 'reset', 'retry_after']
        .map(key => [key, Number.isSafeInteger(github[key]) && github[key] >= 0 ? github[key] : null])),
    };
    state.cooldown.github.rate_limit = ['primary', 'secondary', 'unconfirmed'].includes(github.rate_limit)
      ? github.rate_limit : null;
  }
  return state;
}

async function cacheRead(cache, key) {
  try { return await cache.match(key); } catch { return null; }
}

function cacheWrite(cache, key, response, ctx) {
  // Cache availability must not turn good public metadata into a failed response.
  ctx.waitUntil(Promise.resolve().then(() => cache.put(key, response)).catch(() => {}));
}

function forClient(response, method, cacheStatus) {
  if (method === 'HEAD' && response.body) response.body.cancel().catch(() => {});
  const result = new Response(method === 'HEAD' ? null : response.body, response);
  if (cacheStatus) result.headers.set('X-Edge-Cache', cacheStatus);
  if (cacheStatus === 'HIT') {
    const date = Date.parse(response.headers.get('date'));
    // Cache implementations can update Date: retain their measured Age too.
    const age = Math.max(numericHeader(response, 'age') || 0,
      Number.isFinite(date) ? Math.floor((Date.now() - date) / 1000) : 0);
    result.headers.set('Age', String(age));
  }
  result.headers.set('X-Content-Type-Options', 'nosniff');
  return result;
}

function recordCooldown(state, github) {
  if (!github || !['primary', 'secondary'].includes(github.rate_limit) && github.retry_after === null) return;
  const now = Date.now();
  const seconds = Math.min(REVALIDATION_TTL_SECONDS, Math.max(1,
    github.retry_after || 0,
    github.rate_limit === 'primary' && github.reset ? github.reset - Math.floor(now / 1000) : 0,
    github.rate_limit === 'secondary' || github.rate_limit === 'primary' && (!github.reset || github.reset <= now / 1000) ? 60 : 0));
  state.cooldown = { until: now + seconds * 1000, github };
}

async function githubJson(url, headers, signal, etag, budget) {
  if (signal.aborted || budget.calls >= MAX_GITHUB_REQUESTS) throw new Error('GitHub request budget exceeded');
  budget.calls++;
  const response = await fetch(url, {
    headers: etag ? { ...headers, 'If-None-Match': etag } : headers,
    redirect: 'manual', signal,
  });
  try {
    if (response.status === 304) return { unchanged: true, link: response.headers.get('link') };
    if (!response.ok) return { github: await githubFailureDiagnostics(response) };
    return {
      value: await response.json(),
      etag: validEtag(response.headers.get('etag')),
      link: response.headers.get('link'),
    };
  } finally {
    if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/repos') return forClient(new Response('Not Found', { status: 404 }), request.method);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } });
    }

    const cache = caches.default;
    const cacheKey = new Request(url.origin + CACHE_PATH);
    const stateKey = new Request(url.origin + REVALIDATION_PATH);
    const cached = await cacheRead(cache, cacheKey);
    if (cached) return forClient(cached, request.method, 'HIT');

    let state = emptyState();
    try {
      const saved = await cacheRead(cache, stateKey);
      if (saved) state = readState(await saved.json());
    } catch { /* Invalid or unavailable revalidation data is optional. */ }
    if (state.cooldown) {
      const response = repositoryFailure(state.cooldown.github);
      response.headers.set('Retry-After', String(Math.max(1, Math.ceil((state.cooldown.until - Date.now()) / 1000))));
      return forClient(response, request.method);
    }

    const headers = {
      'User-Agent': 'RatelSlop-Cloudflare-Worker/1.0',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
    const budget = { calls: 0 };
    const updated = emptyState();
    let response;
    try {
      let next = REPOSITORIES_URL;
      const seen = new Set();
      const repositories = new Map();
      while (next) {
        if (seen.has(next) || seen.size >= MAX_REPOSITORY_PAGES) throw new Error('GitHub pagination budget exceeded');
        seen.add(next);
        const previous = state.pages[next];
        const result = await githubJson(next, headers, controller.signal, previous?.etag, budget);
        if (result.github) {
          recordCooldown(updated, result.github);
          response = repositoryFailure(result.github);
          break;
        }
        let page;
        if (result.unchanged) {
          if (!previous?.etag) throw new Error('Unexpected GitHub 304');
          page = { ...previous, next: result.link === null ? previous.next : nextRepositoryUrl(result.link) };
        } else {
          if (!Array.isArray(result.value)) throw new Error('Invalid GitHub repository response');
          page = {
            repos: result.value.filter(validRepository).map(publicRepositoryMetadata),
            etag: result.etag, next: nextRepositoryUrl(result.link),
          };
        }
        updated.pages[next] = page;
        for (const repo of page.repos) repositories.set(repo.name, { ...repo, languages: repo.language ? [repo.language] : [] });
        next = page.next;
      }
      if (!response) {
        let stopLanguages = false;
        for (const repo of repositories.values()) {
          if (stopLanguages || controller.signal.aborted || budget.calls >= MAX_GITHUB_REQUESTS) continue;
          const previous = state.languages[repo.name];
          try {
            const result = await githubJson(`https://api.github.com/repos/${GITHUB_ORG}/${encodeURIComponent(repo.name)}/languages`,
              headers, controller.signal, previous?.etag, budget);
            if (result.github) {
              recordCooldown(updated, result.github);
              stopLanguages = [403, 429].includes(result.github.status);
            } else if (result.unchanged) {
              if (!previous?.etag) throw new Error('Unexpected GitHub 304');
              updated.languages[repo.name] = previous;
              repo.languages = previous.languages;
            } else {
              if (!result.value || typeof result.value !== 'object' || Array.isArray(result.value)) throw new Error('Invalid GitHub languages');
              repo.languages = Object.entries(result.value)
                .filter(([language, bytes]) => language.trim() && Number.isFinite(bytes) && bytes > 0)
                .sort((a, b) => b[1] - a[1]).map(([language]) => language);
              updated.languages[repo.name] = { etag: result.etag, languages: repo.languages };
            }
          } catch { /* Keep primary language on malformed data, network failure or timeout. */ }
        }
        response = new Response(JSON.stringify([...repositories.values()]), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
            'X-Edge-Cache': 'MISS', Date: new Date().toUTCString(),
          },
        });
        cacheWrite(cache, cacheKey, response.clone(), ctx);
      }
    } catch {
      response = repositoryFailure();
    } finally {
      clearTimeout(timer);
    }
    if (updated.cooldown || Object.keys(updated.pages).length) {
      updated.savedAt = Date.now();
      cacheWrite(cache, stateKey, new Response(JSON.stringify(updated), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${REVALIDATION_TTL_SECONDS}` },
      }), ctx);
    }
    if (updated.cooldown && response.status !== 200) {
      response.headers.set('Retry-After', String(Math.max(1, Math.ceil((updated.cooldown.until - Date.now()) / 1000))));
    }
    return forClient(response, request.method);
  },
};
