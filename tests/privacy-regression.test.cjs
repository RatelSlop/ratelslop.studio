const assert = require('node:assert/strict');
const fs = require('node:fs');
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
    Request, Response, URL,
    caches: { default: cache },
    fetch: async (url, options) => {
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
  const cached = await harness.entries.get('https://api.ratelslop.studio/repos-public-v1').clone().text();
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
    () => new Response('internal secret', { status: 403 }),
    () => json({ unexpected: 'internal secret' }),
  ]) {
    const harness = workerHarness(upstream);
    const response = await harness.request();
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Failed to fetch repositories' });
    assert.equal(harness.entries.size, 0);
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
      textContent: '', innerHTML: '', value: '', style: {}, children: [], listeners: {},
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
});

test('Direct fallback filters public projects and omits credentials and referrers', async () => {
  const page = pageHarness('index.html', {
    upstream: url => {
      if (url.includes('api.ratelslop.studio')) throw new Error('proxy unavailable');
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
