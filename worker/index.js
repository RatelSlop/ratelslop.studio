/**
 * Cloudflare Worker: RatelSlop Repository Cache & Aggregator
 * 
 * - Caches aggregated repository and language data on the Cloudflare Edge (TTL: 180s / 3 minutes)
 * - Reduces GitHub API requests by sharing public repository metadata at the edge
 * - Optionally authenticates using the server-side GITHUB_TOKEN secret
 * - Does not add custom visitor logging; Cloudflare still processes connection data
 */

const GITHUB_ORG = 'RatelSlop';
const CACHE_TTL_SECONDS = 180; // 3 minutes cache (2-5 min freshness requirement)
// A new key prevents responses cached by the older, unfiltered Worker being reused.
const CACHE_PATH = '/repos-public-v1';

function publicRepositoryMetadata(repo) {
  return {
    name: repo.name,
    private: false,
    description: typeof repo.description === 'string' ? repo.description : null,
    html_url: `https://github.com/${GITHUB_ORG}/${encodeURIComponent(repo.name)}`,
    homepage: typeof repo.homepage === 'string' ? repo.homepage : null,
    language: typeof repo.language === 'string' ? repo.language : null,
    languages: Array.isArray(repo.languages) ? repo.languages : [],
    stargazers_count: Number.isSafeInteger(repo.stargazers_count) && repo.stargazers_count > 0 ? repo.stargazers_count : 0,
    archived: repo.archived === true,
  };
}

export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS preflight
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
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/repos') {
      return new Response('Not Found', { status: 404 });
    }

    // 2. Check Cloudflare Edge Cache
    const cache = caches.default;
    const cacheKey = new Request(url.origin + CACHE_PATH, { method: 'GET' });
    const cachedResponse = await cache.match(cacheKey);

    if (cachedResponse) {
      const response = new Response(cachedResponse.body, cachedResponse);
      response.headers.set('X-Edge-Cache', 'HIT');
      return response;
    }

    // 3. Cache MISS: Fetch from GitHub API
    const headers = {
      'User-Agent': 'RatelSlop-Cloudflare-Worker/1.0',
      'Accept': 'application/vnd.github.v3+json',
    };

    if (env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
    }

    try {
      const orgReposRes = await fetch(
        `https://api.github.com/orgs/${GITHUB_ORG}/repos?type=public&sort=pushed&direction=desc&per_page=100`,
        { headers }
      );

      if (!orgReposRes.ok) {
        throw new Error(`GitHub API error: ${orgReposRes.status}`);
      }

      const repos = await orgReposRes.json();
      if (!Array.isArray(repos)) {
        throw new Error('Unexpected GitHub response format: expected array');
      }

      // Fail closed even if an authenticated upstream unexpectedly includes private data.
      const publicRepos = repos
        .filter(repo => repo && repo.private === false && typeof repo.name === 'string' && !repo.name.startsWith('.'))
        .map(publicRepositoryMetadata);

      // Fetch languages in parallel for each repository
      await Promise.all(
        publicRepos.map(async (repo) => {
          try {
            const langRes = await fetch(
              `https://api.github.com/repos/${GITHUB_ORG}/${encodeURIComponent(repo.name)}/languages`,
              { headers }
            );
            if (langRes.ok) {
              const langData = await langRes.json();
              repo.languages = Object.entries(langData)
                .filter(([, bytes]) => Number.isFinite(bytes) && bytes > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([lang]) => lang);
            } else {
              repo.languages = repo.language ? [repo.language] : [];
            }
          } catch {
            repo.languages = repo.language ? [repo.language] : [];
          }
        })
      );

      const jsonPayload = JSON.stringify(publicRepos);
      const response = new Response(jsonPayload, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
          'X-Edge-Cache': 'MISS',
        },
      });

      // Save into Cloudflare Edge Cache
      ctx.waitUntil(cache.put(cacheKey, response.clone()));

      return response;
    } catch {
      return new Response(
        JSON.stringify({ error: 'Failed to fetch repositories' }),
        {
          status: 502,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
          },
        }
      );
    }
  },
};
