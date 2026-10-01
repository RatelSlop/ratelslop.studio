const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf("    const GITHUB_ORG = 'RatelSlop';");
const end = html.indexOf('    function renderRepos(', start);
assert.ok(start >= 0 && end > start, 'homepage repository script is present');
const source = html.slice(start, end) + '\n' +
  'globalThis.pageApi = { safeHomepage, publicProjects, languageNames, fetchGitHubRepos };';
const json = value => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json' },
});
const plain = value => JSON.parse(JSON.stringify(value));

function pageHarness(upstream, { acceleratedTimeouts = false } = {}) {
  const calls = [];
  const timers = new Set();
  let clock = 0;
  const context = vm.createContext({
    URL, AbortController,
    Date: { now: () => acceleratedTimeouts ? clock : Date.now() },
    setTimeout(callback, delay) {
      const timer = { due: clock + delay };
      timers.add(timer);
      const fire = () => {
        if (!timers.delete(timer)) return;
        if (acceleratedTimeouts) clock = Math.max(clock, timer.due);
        callback();
      };
      timer.handle = acceleratedTimeouts ? setImmediate(fire) : setTimeout(fire, delay);
      return timer;
    },
    clearTimeout(timer) {
      if (!timers.delete(timer)) return;
      if (acceleratedTimeouts) clearImmediate(timer.handle);
      else clearTimeout(timer.handle);
    },
    console: { warn() {} },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return upstream(url, options);
    },
  });
  vm.runInContext(source, context, { filename: 'index.html:repository-script' });
  return { api: context.pageApi, calls, timers, now: () => clock };
}

function stalledUntilAbort(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const error = new Error('Request aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function assertPrivateRequests(calls) {
  for (const { options } of calls) {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.headers?.Authorization, undefined);
    assert.ok(options.signal instanceof AbortSignal);
  }
}

test('Homepage links accept HTTP(S) and bare domains while rejecting unsafe and credentialed URLs', () => {
  const { api } = pageHarness(() => { throw new Error('No fetch expected'); });
  for (const value of [
    null, undefined, 42, false, {}, [], '',
    'javascript:alert(1)', 'data:text/html,example', 'file:///example', 'ftp://example.org',
    'https://user:password@example.org', 'http://user@example.org',
    'https://example.org\\@evil.example', 'https://example.org/path with spaces',
    'https://exam\nple.org', 'https://',
  ]) {
    assert.equal(api.safeHomepage(value), null, String(value));
  }
  assert.equal(api.safeHomepage('  HTTPS://EXAMPLE.ORG/demo  '), 'https://example.org/demo');
  assert.equal(api.safeHomepage('http://example.org/demo?x=1&y=2'), 'http://example.org/demo?x=1&y=2');
  assert.equal(api.safeHomepage('example.org/demo'), 'https://example.org/demo');
});

test('Homepage metadata uses canonical repository links and normalized public fields', () => {
  const { api } = pageHarness(() => { throw new Error('No fetch expected'); });
  const result = plain(api.publicProjects([
    {
      name: 'visible-project', private: false, description: { hidden: 'invalid type' },
      html_url: 'javascript:alert(1)', homepage: { invalid: 'type' },
      language: ' JavaScript ', languages: [' CSS ', 'CSS', '', null, {}, 10],
      stargazers_count: '999', archived: 'yes', owner: { email: 'unneeded@example.org' },
    },
    { name: 'secret', private: true },
    { name: 'unknown' },
    { name: '.github', private: false },
    { name: '../invalid', private: false },
    null,
  ]));
  assert.deepEqual(result, [{
    name: 'visible-project', private: false, description: null,
    html_url: 'https://github.com/RatelSlop/visible-project', homepage: null,
    language: 'JavaScript', languages: ['CSS'], stargazers_count: 0, archived: false,
  }]);
  for (const count of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.equal(api.publicProjects([{ name: 'sample', private: false, stargazers_count: count }])[0].stargazers_count, 0);
  }
  assert.deepEqual(plain(api.publicProjects([{
    name: 'sample', private: false, description: 'Public description', homepage: 'example.org',
    language: 'CSS', languages: [null], stargazers_count: 12, archived: true,
  }]))[0], {
    name: 'sample', private: false, description: 'Public description',
    html_url: 'https://github.com/RatelSlop/sample', homepage: 'https://example.org/',
    language: 'CSS', languages: ['CSS'], stargazers_count: 12, archived: true,
  });
  assert.throws(() => api.publicProjects({ error: 'invalid list' }), /Invalid repository list/);
});

test('Homepage language maps reject malformed shapes and ignore invalid byte counts', () => {
  const { api } = pageHarness(() => { throw new Error('No fetch expected'); });
  assert.deepEqual(plain(api.languageNames({
    JavaScript: 10, CSS: 50, empty: 0, negative: -1, text: '20', unknown: null, ' ': 100,
  })), ['CSS', 'JavaScript']);
  assert.deepEqual(plain(api.languageNames({})), []);
  for (const value of [null, [], [10, 20], 'invalid', 42, false, new Date()]) {
    assert.throws(() => api.languageNames(value), /Invalid language data/);
  }
});

test('Homepage accepts normalized proxy data and avoids fallback for an empty public list', async () => {
  for (const repos of [[], [{
    name: 'sample', private: false, html_url: 'javascript:alert(1)', homepage: 'https://example.org',
    language: 'CSS', languages: ['CSS'], stargazers_count: 3, archived: false,
  }]]) {
    const page = pageHarness(() => json(repos));
    const result = plain(await page.api.fetchGitHubRepos());
    assert.equal(result.length, repos.length);
    if (repos.length) {
      assert.equal(result[0].html_url, 'https://github.com/RatelSlop/sample');
      assert.equal(result[0].homepage, 'https://example.org/');
      assert.deepEqual(result[0].languages, ['CSS']);
    }
    assert.equal(page.calls.length, 1);
    assert.equal(page.calls[0].url, 'https://api.ratelslop.studio/repos');
    assertPrivateRequests(page.calls);
    assert.equal(page.timers.size, 0);
  }
});

test('Homepage fallback language requests run serially and preserve primary languages on invalid JSON shapes', async () => {
  let active = 0;
  let peak = 0;
  const page = pageHarness(async url => {
    if (url.includes('api.ratelslop.studio')) return json({ invalid: 'proxy shape' });
    if (!url.endsWith('/languages')) return json([
      { name: 'one', private: false, language: 'CSS' },
      { name: 'two', private: false, language: 'JavaScript' },
      { name: 'three', private: false, language: 'HTML' },
    ]);
    active++;
    peak = Math.max(peak, active);
    await new Promise(setImmediate);
    active--;
    return url.includes('/one/') ? json({ CSS: 20, JavaScript: 10 }) : json([10, 20]);
  });
  const result = plain(await page.api.fetchGitHubRepos());
  assert.equal(peak, 1);
  assert.deepEqual(result.map(repo => repo.languages), [['CSS', 'JavaScript'], ['JavaScript'], ['HTML']]);
  assert.equal(page.calls.length, 5);
  assert.equal(new URL(page.calls[1].url).searchParams.get('type'), 'public');
  assertPrivateRequests(page.calls);
  assert.equal(page.timers.size, 0);
});

test('Homepage proxy deadline aborts stalled body reads and starts the direct fallback', async () => {
  let proxySignal;
  const page = pageHarness((url, options) => {
    if (url.includes('api.ratelslop.studio')) {
      proxySignal = options.signal;
      return { ok: true, json: () => stalledUntilAbort(options.signal) };
    }
    if (url.endsWith('/languages')) return json({ CSS: 10 });
    return json([{ name: 'sample', private: false, language: 'CSS' }]);
  }, { acceleratedTimeouts: true });
  assert.deepEqual(plain(await page.api.fetchGitHubRepos()).map(repo => repo.languages), [['CSS']]);
  assert.equal(proxySignal.aborted, true);
  assert.equal(page.now(), 10000);
  assert.equal(page.calls.length, 3);
  assertPrivateRequests(page.calls);
  assert.equal(page.timers.size, 0);
});

test('Homepage direct fallback body deadline ends cleanly without language requests', async () => {
  let bodySignal;
  const page = pageHarness((url, options) => {
    if (url.includes('api.ratelslop.studio')) throw new Error('Proxy unavailable');
    bodySignal = options.signal;
    return { ok: true, json: () => stalledUntilAbort(options.signal) };
  }, { acceleratedTimeouts: true });
  assert.equal(await page.api.fetchGitHubRepos(), null);
  assert.equal(bodySignal.aborted, true);
  assert.equal(page.now(), 6000);
  assert.equal(page.calls.length, 2);
  assert.equal(page.timers.size, 0);
});

test('Homepage fallback has one total deadline and retains public projects when optional fetches stall', async () => {
  const page = pageHarness((url, options) => {
    if (url.includes('api.ratelslop.studio')) throw new Error('Proxy unavailable');
    if (url.endsWith('/languages')) return stalledUntilAbort(options.signal);
    return json(Array.from({ length: 10 }, (_, index) => ({
      name: 'project-' + index, private: false, language: 'CSS',
    })));
  }, { acceleratedTimeouts: true });
  const result = plain(await page.api.fetchGitHubRepos());
  assert.equal(result.length, 10);
  assert.ok(result.every(repo => repo.languages.length === 1 && repo.languages[0] === 'CSS'));
  assert.equal(page.calls.filter(call => call.url.endsWith('/languages')).length, 4);
  assert.equal(page.now(), 6000);
  assertPrivateRequests(page.calls);
  assert.equal(page.timers.size, 0);
});

test('Homepage stops fallback language requests after forbidden or throttled responses and cancels their bodies', async () => {
  for (const status of [403, 429]) {
    let cancelled = false;
    const page = pageHarness(url => {
      if (url.includes('api.ratelslop.studio')) throw new Error('Proxy unavailable');
      if (url.endsWith('/languages')) return {
        ok: false, status,
        body: { cancel: async () => { cancelled = true; } },
      };
      return json([
        { name: 'one', private: false, language: 'CSS' },
        { name: 'two', private: false, language: 'JavaScript' },
      ]);
    });
    const result = plain(await page.api.fetchGitHubRepos());
    assert.deepEqual(result.map(repo => repo.languages), [['CSS'], ['JavaScript']]);
    assert.equal(page.calls.length, 3, String(status));
    assert.equal(cancelled, true);
    assertPrivateRequests(page.calls);
    assert.equal(page.timers.size, 0);
  }
});
