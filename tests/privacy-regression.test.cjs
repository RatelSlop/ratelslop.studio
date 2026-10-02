const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const json = value => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json' },
});
const plain = value => JSON.parse(JSON.stringify(value));

function workerHarness(upstream) {
  const calls = [];
  const entries = new Map();
  const writes = [];
  const cache = {
    async match(key) { return entries.get(key.url)?.clone(); },
    async put(key, response) { entries.set(key.url, response.clone()); },
  };
  const context = vm.createContext({
    Request, Response, URL, AbortController, setTimeout, clearTimeout,
    caches: { default: cache },
    fetch: async (url, options) => {
      // Match workerd's supported modes; Node also accepts the unsupported 'error'.
      if (options?.redirect !== undefined && !['follow', 'manual'].includes(options.redirect)) {
        throw new TypeError('Unsupported Worker redirect mode');
      }
      calls.push({ url, options });
      return upstream(url, options);
    },
  });
  vm.runInContext(read('worker/index.js').replace('export default', 'globalThis.worker ='), context);
  return {
    calls, entries,
    async request(method = 'GET', pathname = '/repos', token) {
      const response = await context.worker.fetch(
        new Request('https://api.ratelslop.studio' + pathname, {
          method, headers: { Cookie: 'visitor=private', 'X-Visitor-Data': 'private' },
        }),
        { GITHUB_TOKEN: token },
        { waitUntil: promise => writes.push(promise) },
      );
      await Promise.all(writes);
      return response;
    },
  };
}

test('Worker excludes private/unknown repositories before language requests and caching', async () => {
  const harness = workerHarness(url => url.includes('/languages')
    ? json({ CSS: 10, JavaScript: 90, empty: 0 })
    : json([
      { name: 'visible', private: false, description: 'public', language: 'JavaScript',
        owner: { email: 'unneeded@example.org' }, permissions: { admin: true },
        html_url: 'https://untrusted.invalid', homepage: 'https://demo.example.org' },
      { name: 'secret', private: true, description: 'confidential' },
      { name: 'unknown', description: 'must not expose without explicit public flag' },
      { name: '.github', private: false },
      null,
    ]));
  // Old responses must not be reused after changing the public-data filter.
  harness.entries.set('https://api.ratelslop.studio/repos', json([{ name: 'old-secret', private: true }]));
  const response = await harness.request('GET', '/repos?visitor=ignored', 'test-secret-token');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Edge-Cache'), 'MISS');
  const body = await response.json();
  assert.deepEqual(body.map(repo => repo.name), ['visible']);
  assert.equal(body[0].html_url, 'https://github.com/RatelSlop/visible');
  assert.deepEqual(body[0].languages, ['JavaScript', 'CSS']);
  assert.deepEqual(Object.keys(body[0]).sort(), [
    'archived', 'description', 'homepage', 'html_url', 'language', 'languages',
    'name', 'private', 'stargazers_count',
  ].sort());
  assert.equal(new URL(harness.calls[0].url).searchParams.get('type'), 'public');
  assert.equal(harness.calls.length, 2);
  for (const call of harness.calls) {
    assert.equal(call.options.headers.Authorization, 'Bearer test-secret-token');
    assert.equal(call.options.headers.Cookie, undefined);
    assert.equal(call.options.headers['X-Visitor-Data'], undefined);
  }
  const cached = await harness.entries.get('https://api.ratelslop.studio/repos-public-v2').clone().text();
  assert.doesNotMatch(cached, /confidential|old-secret|test-secret-token|unneeded@example/);
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=180, s-maxage=180');
  const hit = await harness.request();
  assert.equal(hit.headers.get('X-Edge-Cache'), 'HIT');
  assert.deepEqual(await hit.json(), body);
  assert.equal(harness.calls.length, 2);
});

test('Worker accepts empty public results and works without a token', async () => {
  const harness = workerHarness(() => json([]));
  assert.deepEqual(await (await harness.request()).json(), []);
  assert.equal(harness.calls[0].options.headers.Authorization, undefined);
});

test('Worker errors do not expose upstream secrets or cache failed results', async () => {
  for (const upstream of [
    () => { throw new Error('internal secret'); },
    () => json({ unexpected: 'internal secret' }),
  ]) {
    const harness = workerHarness(upstream);
    const response = await harness.request();
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Failed to fetch repositories' });
    assert.equal(harness.entries.has('https://api.ratelslop.studio/repos-public-v2'), false);
  }
});

test('Worker identifies GitHub primary rate limits without exposing upstream data', async () => {
  const harness = workerHarness(() => new Response(JSON.stringify({
    message: 'API rate limit exceeded for 192.0.2.1. internal secret',
  }), {
    status: 403,
    headers: {
      'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1790850600', 'x-visitor-data': 'internal secret',
    },
  }));
  const response = await harness.request('GET', '/repos', 'test-secret-token');
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Edge-Cache'), 'MISS');
  assert.deepEqual(await response.json(), {
    error: 'Failed to fetch repositories',
    github: { status: 403, rate_limit: 'primary', limit: 60, remaining: 0,
      reset: 1790850600, retry_after: null },
  });
  assert.equal(response.headers.get('x-visitor-data'), null);
  assert.equal(harness.entries.has('https://api.ratelslop.studio/repos-public-v2'), false);
  assert.equal(harness.calls.length, 1);
});

test('Worker distinguishes secondary limits, ambiguous forbidden responses, and other errors', async () => {
  for (const { status, message, rateLimit } of [
    { status: 429, message: 'You have exceeded a secondary rate limit. internal secret', rateLimit: 'secondary' },
    { status: 403, message: 'Resource not accessible. internal secret', rateLimit: 'unconfirmed' },
    { status: 401, message: 'Bad credentials. internal secret', rateLimit: null },
    { status: 500, message: 'internal secret', rateLimit: null },
  ]) {
    const harness = workerHarness(() => new Response(JSON.stringify({ message }), {
      status,
      headers: { 'x-ratelimit-remaining': '40', 'retry-after': '60' },
    }));
    const response = await harness.request();
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: 'Failed to fetch repositories',
      github: { status, rate_limit: rateLimit, limit: null, remaining: 40,
        reset: null, retry_after: 60 },
    });
    assert.equal(harness.entries.has('https://api.ratelslop.studio/repos-public-v2'), false);
  }
});

test('Worker handles non-JSON GitHub failures and rejects non-numeric diagnostic headers', async () => {
  const harness = workerHarness(() => new Response('internal secret', {
    status: 403,
    headers: {
      'x-ratelimit-limit': 'internal secret', 'x-ratelimit-remaining': '-1',
      'x-ratelimit-reset': '9007199254740992', 'retry-after': '1.5',
    },
  }));
  assert.deepEqual(await (await harness.request()).json(), {
    error: 'Failed to fetch repositories',
    github: { status: 403, rate_limit: 'unconfirmed', limit: null, remaining: null,
      reset: null, retry_after: null },
  });
  assert.equal(harness.entries.has('https://api.ratelslop.studio/repos-public-v2'), false);
});

test('Worker never reflects a configured token from upstream errors into responses or cache', async () => {
  const token = 'fake-token-canary-do-not-expose';
  for (const upstream of [
    () => { throw new Error(token); },
    () => new Response(token),
    () => json({ message: token }),
    () => new Response(JSON.stringify({ message: token }), {
      status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-upstream-secret': token },
    }),
    () => new Response(JSON.stringify({ message: `secondary rate limit ${token}` }), {
      status: 429, headers: { 'x-ratelimit-limit': token, 'retry-after': token },
    }),
    () => new Response(token, { status: 401, headers: { 'authorization': `Bearer ${token}` } }),
  ]) {
    const harness = workerHarness(upstream);
    const response = await harness.request('GET', '/repos', token);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), new RegExp(token));
    assert.doesNotMatch(JSON.stringify([...response.headers]), new RegExp(token));
    assert.equal(harness.entries.has('https://api.ratelslop.studio/repos-public-v2'), false);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].options.headers.Authorization, `Bearer ${token}`);
    for (const stored of harness.entries.values()) {
      assert.doesNotMatch(await stored.clone().text(), new RegExp(token));
      assert.doesNotMatch(JSON.stringify([...stored.headers]), new RegExp(token));
    }
  }
});

test('Worker language request failures preserve public project responses and caching without leaking errors', async () => {
  for (const languageResponse of [
    () => { throw new Error('fake-token-canary-do-not-expose'); },
    () => new Response('fake-token-canary-do-not-expose', { status: 403 }),
    () => new Response('invalid JSON fake-token-canary-do-not-expose'),
  ]) {
    const harness = workerHarness(url => url.includes('/languages')
      ? languageResponse()
      : json([{ name: 'visible', private: false, language: 'JavaScript' }]));
    const response = await harness.request('GET', '/repos', 'fake-token-canary-do-not-expose');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body[0].languages, ['JavaScript']);
    assert.equal(body[0].name, 'visible');
    assert.doesNotMatch(JSON.stringify(body), /fake-token-canary/);
    const cached = await harness.request();
    assert.equal(cached.headers.get('X-Edge-Cache'), 'HIT');
    assert.deepEqual(await cached.json(), body);
    assert.equal(harness.calls.length, 2);
  }
});

test('Worker refuses repository and language redirects without sending requests to their destination', async t => {
  let redirectedPath;
  let redirectStatus;
  let destinationRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/destination') {
      destinationRequests++;
      response.setHeader('Content-Type', 'application/json');
      response.end('[]');
    } else if (request.url === redirectedPath) {
      response.writeHead(redirectStatus, { Location: '/destination' });
      response.end();
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([{ name: 'visible', private: false, language: 'JavaScript' }]));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = 'fake-token-canary-do-not-expose';
  for (redirectedPath of ['/repos', '/languages']) {
    for (redirectStatus of [301, 302, 303, 307, 308]) {
      const harness = workerHarness((url, options) => fetch(
        origin + (url.includes('/languages') ? '/languages' : '/repos'), options,
      ));
      const response = await harness.request('GET', '/repos', token);
      const body = await response.text();
      assert.doesNotMatch(body, new RegExp(token));
      assert.equal(destinationRequests, 0, `${redirectedPath} ${redirectStatus} destination`);
      if (redirectedPath === '/repos') {
        assert.equal(response.status, 502);
        assert.equal(JSON.parse(body).github.status, redirectStatus);
        assert.equal(harness.entries.has('https://api.ratelslop.studio/repos-public-v2'), false);
      } else {
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(body)[0].languages, ['JavaScript']);
        assert.equal(harness.entries.size, 2);
      }
    }
  }
});

test('Worker rejects unrelated paths and writes; preflight does not call GitHub', async () => {
  const harness = workerHarness(() => { throw new Error('should not run'); });
  assert.equal((await harness.request('POST')).status, 405);
  assert.equal((await harness.request('GET', '/other')).status, 404);
  assert.equal((await harness.request('OPTIONS')).headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(harness.calls.length, 0);
});

function pageHarness(file, { blocked = false, stored = {}, upstream = () => json([]) } = {}) {
  const html = read(file);
  const elements = new Map();
  function element() {
    return {
      textContent: '', innerHTML: '', value: '', style: {}, children: [], listeners: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name] ?? null; },
      addEventListener(type, listener) { this.listeners[type] = listener; },
      appendChild(child) { this.children.push(child); },
    };
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], element());
  const attrs = new Map();
  const documentElement = {
    setAttribute: (name, value) => attrs.set(name, value),
    getAttribute: name => attrs.get(name),
  };
  const writes = [];
  const reads = [];
  const calls = [];
  const storage = new Map(Object.entries(stored));
  const media = { matches: false, addEventListener(type, listener) { this.listener = listener; } };
  const context = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout,
    document: {
      documentElement,
      getElementById: id => elements.get(id) || null,
      createElement: () => element(),
    },
    window: { matchMedia: () => media },
    localStorage: {
      getItem(key) { reads.push(key); if (blocked) throw new Error('blocked'); return storage.get(key) ?? null; },
      setItem(key, value) { if (blocked) throw new Error('blocked'); writes.push([key, value]); storage.set(key, value); },
    },
    console: { warn() {} },
    fetch: async (url, options) => { calls.push({ url, options }); return upstream(url); },
  });
  for (const [index, match] of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].entries()) {
    vm.runInContext(match[1], context, { filename: `${file}:script${index}` });
  }
  return { context, elements, writes, reads, calls, media, documentElement, html };
}

for (const file of ['index.html', 'privacy/index.html', 'terms/index.html', '404.html']) {
  test(`${file}: initial load writes nothing; explicit choices write only display preferences`, async () => {
    const page = pageHarness(file, { stored: { ratelslop_repos_cache_en: 'unused old data' } });
    await new Promise(setImmediate);
    assert.deepEqual(page.writes, []);
    assert.ok(page.reads.every(key => ['theme', 'lang'].includes(key)));
    page.elements.get('theme-toggle').listeners.click();
    assert.deepEqual(page.writes, [['theme', 'light']]);
    if (file !== '404.html') {
      page.elements.get('lang-select').listeners.change({ target: { value: 'nl' } });
      assert.deepEqual(page.writes, [['theme', 'light'], ['lang', 'nl']]);
      assert.equal(page.documentElement.lang, 'nl');
    }
  });

  test(`${file}: blocked storage does not break display controls`, async () => {
    const page = pageHarness(file, { blocked: true });
    await new Promise(setImmediate);
    page.elements.get('theme-toggle').listeners.click();
    assert.equal(page.documentElement.getAttribute('data-theme'), 'light');
    if (file !== '404.html') {
      page.elements.get('lang-select').listeners.change({ target: { value: 'nl' } });
      assert.equal(page.documentElement.lang, 'nl');
    }
    if (file === 'index.html') {
      page.media.listener({ matches: false });
      assert.equal(page.documentElement.getAttribute('data-theme'), 'light');
    }
    assert.deepEqual(page.writes, []);
  });
}

test('Empty proxy response does not cause unnecessary direct GitHub requests', async () => {
  const page = pageHarness('index.html');
  await new Promise(setImmediate);
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].url, 'https://api.ratelslop.studio/repos');
  assert.equal(page.elements.get('repo-table').style.display, 'none');
  assert.equal(page.elements.get('coming-soon-container').hidden, false);
  assert.equal(page.elements.get('repo-status').hidden, true);
});

test('Homepage shows loading until a validated list arrives, including during language changes', async () => {
  let resolveRepos;
  const page = pageHarness('index.html', { upstream: () => new Promise(resolve => { resolveRepos = resolve; }) });
  assert.equal(page.elements.get('repo-status').hidden, false);
  assert.equal(page.elements.get('repo-status-title').textContent, 'Loading projects');
  assert.equal(page.elements.get('repo-status').getAttribute('aria-busy'), 'true');
  assert.equal(page.elements.get('coming-soon-container').hidden, true);
  assert.equal(page.elements.get('repo-table').hidden, true);
  page.elements.get('lang-select').listeners.change({ target: { value: 'nl' } });
  assert.equal(page.elements.get('repo-status-title').textContent, 'Projecten laden');
  assert.equal(page.calls.length, 1);
  resolveRepos(json([{ name: 'public', private: false }]));
  await new Promise(setImmediate);
  assert.equal(page.elements.get('repo-status').hidden, true);
  assert.equal(page.elements.get('coming-soon-container').hidden, true);
  assert.equal(page.elements.get('repo-table').hidden, false);
  assert.equal(page.elements.get('repo-status').getAttribute('aria-busy'), 'false');
});

test('Homepage keeps loading during fallback and only shows coming soon after confirmed empty data', async () => {
  let rejectProxy;
  let resolveFallback;
  const page = pageHarness('index.html', { upstream: url => new Promise((resolve, reject) => {
    if (url.includes('api.ratelslop.studio')) rejectProxy = reject;
    else resolveFallback = resolve;
  }) });
  rejectProxy(new Error('proxy unavailable'));
  await new Promise(setImmediate);
  assert.equal(page.calls.length, 2);
  assert.equal(page.elements.get('repo-status-title').textContent, 'Loading projects');
  assert.equal(page.elements.get('coming-soon-container').hidden, true);
  assert.equal(page.elements.get('retry-repos').hidden, true);
  resolveFallback(json([]));
  await new Promise(setImmediate);
  assert.equal(page.elements.get('repo-status').hidden, true);
  assert.equal(page.elements.get('coming-soon-container').hidden, false);
  assert.equal(page.elements.get('repo-table').hidden, true);
});

for (const failure of ['network', 'http', 'invalid data', 'invalid array']) {
  test(`Homepage shows a translated error after ${failure} and retry can recover`, async () => {
    let recovering = false;
    let resolveRetry;
    const page = pageHarness('index.html', { upstream: url => {
      if (recovering) return new Promise(resolve => { resolveRetry = resolve; });
      if (failure === 'network') throw new Error('unavailable');
      return failure === 'http' ? new Response('', { status: 502 })
        : failure === 'invalid array' ? json([null, { error: 'invalid list' }]) : json({ error: 'invalid list' });
    } });
    await new Promise(setImmediate);
    assert.equal(page.elements.get('coming-soon-container').hidden, true);
    assert.equal(page.elements.get('repo-table').hidden, true);
    assert.equal(page.elements.get('repo-status-title').textContent, 'Projects could not be loaded');
    assert.equal(page.elements.get('retry-repos').hidden, false);
    assert.equal(page.elements.get('repo-status').getAttribute('aria-busy'), 'false');
    page.elements.get('lang-select').listeners.change({ target: { value: 'nl' } });
    assert.equal(page.elements.get('repo-status-title').textContent, 'Projecten konden niet worden geladen');
    assert.equal(page.elements.get('retry-repos').textContent, 'Opnieuw proberen');
    assert.equal(page.calls.length, 2);
    recovering = true;
    page.elements.get('retry-repos').listeners.click();
    page.elements.get('retry-repos').listeners.click();
    assert.equal(page.calls.length, 3, 'overlapping retries share one request');
    assert.equal(page.elements.get('repo-status-title').textContent, 'Projecten laden');
    assert.equal(page.elements.get('retry-repos').hidden, true);
    resolveRetry(json([{ name: 'recovered', private: false }]));
    await new Promise(setImmediate);
    assert.equal(page.elements.get('repo-table').hidden, false);
    assert.equal(page.elements.get('repo-status').hidden, true);
    assert.equal(page.elements.get('coming-soon-container').hidden, true);
    assert.match(page.elements.get('repo-list').children[0].innerHTML, /recovered/);
    assert.ok(page.calls.every(call => call.options.credentials === 'omit' && call.options.referrerPolicy === 'no-referrer'));
  });
}

for (const proxyFailure of ['network', 'diagnostic 502']) {
  test(`Direct fallback after ${proxyFailure} filters public projects and omits credentials and referrers`, async () => {
    const page = pageHarness('index.html', {
      upstream: url => {
        if (url.includes('api.ratelslop.studio')) {
          if (proxyFailure === 'network') throw new Error('proxy unavailable');
          return new Response(JSON.stringify({
            error: 'Failed to fetch repositories',
            github: { status: 403, rate_limit: 'primary', limit: 60, remaining: 0 },
          }), { status: 502, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/languages')) return json({ JavaScript: 10 });
        return json([
          { name: 'public', private: false, html_url: 'https://github.com/RatelSlop/public' },
          { name: 'secret', private: true }, { name: 'unknown' },
        ]);
      },
    });
    await new Promise(setImmediate);
    assert.equal(page.calls.length, 3);
    assert.equal(new URL(page.calls[1].url).searchParams.get('type'), 'public');
    assert.ok(page.calls[2].url.includes('/public/languages'));
    for (const call of page.calls) {
      assert.equal(call.options.credentials, 'omit');
      assert.equal(call.options.referrerPolicy, 'no-referrer');
    }
    assert.deepEqual(page.writes, []);
    assert.equal(page.elements.get('repo-table').style.display, 'table');
    assert.doesNotMatch(page.elements.get('repo-list').children.map(row => row.innerHTML).join(''), /secret|unknown/);
  });
}

function normalizeText(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", bull: '•' };
  return html.replace(/<[^>]*>/g, '').replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (match, code) => {
    if (code.startsWith('#x')) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
    return entities[code] ?? match;
  }).replace(/\s+/g, ' ').trim();
}

for (const file of ['privacy/index.html', 'terms/index.html']) {
  test(`${file}: initial English HTML and both translated legal sections remain synchronized`, () => {
    const page = pageHarness(file);
    const translations = vm.runInContext('TRANSLATIONS', page.context);
    assert.deepEqual(Object.keys(translations.en).sort(), Object.keys(translations.nl).sort());
    for (const [key, value] of Object.entries(translations.en)) {
      const section = key.match(/^sec(\d+)(Title|P(\d+))$/);
      const id = section ? `sec${section[1]}-${section[2] === 'Title' ? 'title' : 'p' + section[3]}`
        : ({ pageTitle: 'page-title', pageDesc: 'page-desc', pageDate: 'page-date', preferenceNote: 'preference-note' })[key];
      if (!id) continue;
      const initial = page.html.match(new RegExp(`<([a-z][\\w-]*)[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'));
      assert.ok(initial, `${key} has initial HTML`);
      assert.equal(normalizeText(initial[2]), normalizeText(value), `${key} initial English text`);
      for (const lang of ['en', 'nl']) {
        page.context.applyLanguage(lang);
        const element = page.elements.get(id);
        assert.equal(normalizeText(element.innerHTML || element.textContent), normalizeText(translations[lang][key]), `${key} ${lang} binding`);
      }
    }
    assert.deepEqual(page.writes, []);
    assert.ok(plain(translations.nl).sec5P1);
  });
}
