/**
 * Cloudflare Worker: RatelSlop Repository Cache & Aggregator
 * 
 * - Caches aggregated repository and language data on the Cloudflare Edge (TTL: 180s / 3 minutes)
 * - Eliminates client-side GitHub API rate limits (60 req/hour limit) for website visitors
 * - Optionally uses an environment variable GITHUB_TOKEN for 5,000 requests/hour limit
 */

const GITHUB_ORG = 'RatelSlop';
const CACHE_TTL_SECONDS = 180; // 3 minutes cache (2-5 min freshness requirement)

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

    // 2. Check Cloudflare Edge Cache
    const cache = caches.default;
    const cacheKey = new Request(url.origin + '/repos', { method: 'GET' });
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
        `https://api.github.com/orgs/${GITHUB_ORG}/repos?sort=pushed&direction=desc&per_page=100`,
        { headers }
      );

      if (!orgReposRes.ok) {
        throw new Error(`GitHub API error: ${orgReposRes.status}`);
      }

      const repos = await orgReposRes.json();
      if (!Array.isArray(repos)) {
        throw new Error('Unexpected GitHub response format: expected array');
      }

      // Filter out meta repositories (.github, etc.)
      const publicRepos = repos.filter(repo => !repo.name.startsWith('.'));

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
          'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=60`,
          'X-Edge-Cache': 'MISS',
        },
      });

      // Save into Cloudflare Edge Cache
      ctx.waitUntil(cache.put(cacheKey, response.clone()));

      return response;
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Failed to fetch repositories', details: err.message }),
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
