const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Miniflare, Log, LogLevel } = require('miniflare');

const source = fs.readFileSync(path.join(__dirname, '../worker/index.js'), 'utf8');
const token = 'fake-token-canary-do-not-expose';
const endpoint = 'https://api.ratelslop.studio/repos';
const outputKey = 'https://api.ratelslop.studio/repos-public-v2';
const stateKey = 'https://api.ratelslop.studio/repos-revalidation-v1';
const etag = 'W/"' + 'a'.repeat(64) + '"';
const publicRepo = { name: 'visible', private: false, language: 'JavaScript' };
const json = (data, headers = {}) => new Response(JSON.stringify(data), {
  headers: { 'Content-Type': 'application/json', ...headers },
});

async function runtime(t, upstream, script = source) {
  const calls = [];
  const mf = new Miniflare({
    modules: true, script, compatibilityDate: '2024-09-01',
    bindings: { GITHUB_TOKEN: token }, cf: false, log: new Log(LogLevel.NONE),
    // Return raw responses: a Node fetch proxy could follow redirects before workerd sees them.
    outboundService: async request => {
      calls.push(request);
      assert.equal(new URL(request.url).origin, 'https://api.github.com');
      assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
      assert.equal(request.headers.get('x-github-api-version'), '2022-11-28');
      return upstream(request, calls);
    },
  });
  t.after(() => mf.dispose());
  return { mf, calls, cache: (await mf.getCaches()).default };
}

test('workerd serves/cache filters public metadata and gives HEAD no body', async t => {
  const { mf, calls, cache } = await runtime(t, request => new URL(request.url).pathname.endsWith('/languages')
    ? json({ JavaScript: 100 })
    : json([{ ...publicRepo, homepage: 'javascript:alert(1)', owner: { email: token }, languages: [{ secret: token }] },
      { name: 'private', private: true, description: token }]));
  const head = await mf.dispatchFetch(endpoint, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const get = await mf.dispatchFetch(endpoint);
  const body = await get.text();
  assert.equal(get.headers.get('X-Edge-Cache'), 'HIT');
  assert.deepEqual(JSON.parse(body).map(repo => repo.name), ['visible']);
  assert.equal(JSON.parse(body)[0].homepage, null);
  assert.ok(!body.includes(token));
  assert.equal(calls.length, 2);
  const stored = await cache.match(stateKey);
  assert.ok(!(await stored.text()).includes(token));
});

test('workerd conditional refresh reuses only corresponding validated public data', async t => {
  let refresh = false;
  const { mf, calls, cache } = await runtime(t, request => {
    if (refresh) {
      assert.equal(request.headers.get('if-none-match'), etag);
      return new Response(null, { status: 304 });
    }
    return json(new URL(request.url).pathname.endsWith('/languages') ? { CSS: 30, JavaScript: 80 } : [publicRepo], { ETag: etag });
  });
  const first = await (await mf.dispatchFetch(endpoint)).json();
  assert.equal(await cache.delete(outputKey), true);
  refresh = true;
  const second = await (await mf.dispatchFetch(endpoint)).json();
  assert.deepEqual(second, first);
  assert.equal(calls.length, 4);
});

test('workerd handles real numeric GitHub pagination links without changing organization', async t => {
  const next = '<https://api.github.com/organizations/333489520/repos?type=public&sort=pushed&direction=desc&per_page=100&page=2>; rel="next"';
  const { mf, calls } = await runtime(t, request => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/languages')) return json({ JavaScript: 10 });
    if (url.searchParams.get('page') === '2') return json([{ name: 'second', private: false }]);
    return json([publicRepo], { Link: next });
  });
  const body = await (await mf.dispatchFetch(endpoint)).json();
  assert.deepEqual(body.map(repo => repo.name), ['visible', 'second']);
  assert.ok(calls.every(request => new URL(request.url).pathname.startsWith('/orgs/RatelSlop/')
    || new URL(request.url).pathname.startsWith('/repos/RatelSlop/')));
});

test('workerd picks up new pagination Link headers on an unchanged first page', async t => {
  let refresh = false;
  const next = '<https://api.github.com/organizations/333489520/repos?type=public&sort=pushed&direction=desc&per_page=100&page=2>; rel="next"';
  const { mf, cache } = await runtime(t, request => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/languages')) return json({ JavaScript: 10 }, { ETag: etag });
    if (url.searchParams.get('page') === '2') return json([{ name: 'new-old-project', private: false }]);
    return refresh ? new Response(null, { status: 304, headers: { Link: next } }) : json([publicRepo], { ETag: etag });
  });
  await mf.dispatchFetch(endpoint);
  await cache.delete(outputKey);
  refresh = true;
  const body = await (await mf.dispatchFetch(endpoint)).json();
  assert.deepEqual(body.map(repo => repo.name), ['visible', 'new-old-project']);
});

test('workerd rejects foreign pagination and redirects before sending the token elsewhere', async t => {
  for (const scenario of ['link', 'redirect']) {
    const { mf, calls } = await runtime(t, () => scenario === 'redirect'
      ? new Response('', { status: 302, headers: { Location: 'https://untrusted.invalid/capture' } })
      : json([publicRepo], { Link: '<https://untrusted.invalid/repos?page=2>; rel="next"' }));
    const response = await mf.dispatchFetch(endpoint);
    assert.equal(response.status, 502);
    assert.equal(calls.length, 1);
    assert.ok(!(await response.text()).includes(token));
  }
});

test('workerd cooldown pauses upstream calls and keeps diagnostic storage sanitized', async t => {
  const { mf, calls, cache } = await runtime(t, () => new Response(JSON.stringify({ message: token }), {
    status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '60', 'x-secret': token },
  }));
  const first = await mf.dispatchFetch(endpoint);
  assert.equal(first.status, 502);
  assert.ok(Number(first.headers.get('Retry-After')) > 0);
  assert.ok(!(await first.text()).includes(token));
  const second = await mf.dispatchFetch(endpoint);
  assert.equal(second.status, 502);
  assert.equal(calls.length, 1);
  assert.equal(await cache.match(outputKey), undefined);
  assert.ok(!(await (await cache.match(stateKey)).text()).includes(token));
});

test('workerd budget avoids excessive calls and supplies primary language for remaining projects', async t => {
  const { mf, calls } = await runtime(t, request => new URL(request.url).pathname.endsWith('/languages')
    ? json({ CSS: 5 }) : json(Array.from({ length: 55 }, (_, index) => ({ ...publicRepo, name: `project-${index}` }))));
  const body = await (await mf.dispatchFetch(endpoint)).json();
  assert.equal(body.length, 55);
  assert.equal(calls.length, 40);
  assert.deepEqual(body.at(-1).languages, ['JavaScript']);
});

test('workerd falls back on malformed language JSON and stops after language throttling', async t => {
  for (const scenario of ['array', 'throttle']) {
    const { mf, calls } = await runtime(t, request => new URL(request.url).pathname.endsWith('/languages')
      ? scenario === 'array' ? json([10, 20]) : new Response('', { status: 429, headers: { 'retry-after': '60' } })
      : json([publicRepo, { ...publicRepo, name: 'second' }]));
    const body = await (await mf.dispatchFetch(endpoint)).json();
    assert.deepEqual(body.map(repo => repo.languages), [['JavaScript'], ['JavaScript']]);
    assert.equal(calls.length, scenario === 'array' ? 3 : 2);
  }
});

test('workerd cache failure remains optional and cannot log or expose exception text', async t => {
  const brokenCache = source.replace('const cache = caches.default;',
    `const cache = { match: async () => { throw new Error('${token}'); }, put: async () => { throw new Error('${token}'); } };`);
  const { mf } = await runtime(t, () => json([]), brokenCache);
  const response = await mf.dispatchFetch(endpoint);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '[]');
});

test('workerd deadline includes a stalled GitHub body and preserves primary-language fallback', async t => {
  const fastDeadline = source.replace('const GITHUB_TIMEOUT_MS = 8000;', 'const GITHUB_TIMEOUT_MS = 100;');
  const { mf } = await runtime(t, request => new URL(request.url).pathname.endsWith('/languages')
    ? new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } })
    : json([publicRepo]), fastDeadline);
  const start = Date.now();
  const response = await mf.dispatchFetch(endpoint);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json())[0].languages, ['JavaScript']);
  assert.ok(Date.now() - start < 2000);
});

test('workerd repository-body deadline returns a sanitized failure without caching output', async t => {
  const fastDeadline = source.replace('const GITHUB_TIMEOUT_MS = 8000;', 'const GITHUB_TIMEOUT_MS = 100;');
  const { mf, cache } = await runtime(t, () => new Response(new ReadableStream({ start() {} }), {
    headers: { 'Content-Type': 'application/json' },
  }), fastDeadline);
  const start = Date.now();
  const response = await mf.dispatchFetch(endpoint);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'Failed to fetch repositories' });
  assert.equal(await cache.match(outputKey), undefined);
  assert.ok(Date.now() - start < 2000);
});

test('workerd cache Age preserves the original browser freshness window', async t => {
  // Model a sixty-second-old Cache API hit with a refreshed Date header.
  const agedHit = source.replace('return await cache.match(key);',
    "const hit = await cache.match(key); if (!hit) return hit; const aged = new Response(hit.body, hit); aged.headers.set('Age', '60'); aged.headers.set('Date', new Date().toUTCString()); return aged;");
  const { mf, calls } = await runtime(t, () => json([]), agedHit);
  await mf.dispatchFetch(endpoint);
  const response = await mf.dispatchFetch(endpoint);
  assert.equal(response.headers.get('X-Edge-Cache'), 'HIT');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=180, s-maxage=180');
  assert.ok(Number(response.headers.get('Age')) >= 60);
  assert.ok(Number(response.headers.get('Age')) < 65);
  assert.equal(calls.length, 1);
});

test('workerd rejects cyclic pagination and pages beyond its repository budget', async t => {
  for (const scenario of ['cycle', 'limit']) {
    const { mf, calls, cache } = await runtime(t, request => {
      const page = Number(new URL(request.url).searchParams.get('page') || 1);
      return json([{ ...publicRepo, name: `page-${page}` }], {
        Link: `<https://api.github.com/organizations/333489520/repos?type=public&sort=pushed&direction=desc&per_page=100&page=${scenario === 'cycle' ? 2 : page + 1}>; rel="next"`,
      });
    });
    const response = await mf.dispatchFetch(endpoint);
    assert.equal(response.status, 502);
    assert.equal(await cache.match(outputKey), undefined);
    assert.equal(calls.length, scenario === 'cycle' ? 2 : 5);
  }
});
