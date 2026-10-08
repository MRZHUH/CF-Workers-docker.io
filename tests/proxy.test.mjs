import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

const realFetch = globalThis.fetch;
const realNow = Date.now;
let version = 0;
afterEach(() => { globalThis.fetch = realFetch; Date.now = realNow; });
const worker = async () => (await import(`../_worker.js?test=${version++}`)).default;
const req = (path = '/v2/', init = {}) => new Request(`https://docker.funcd.org${path}`, init);
function stub(handler = () => new Response('ok')) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: new URL(url), ...init, headers: new Headers(init.headers) });
        return handler(calls.at(-1), calls.length);
    };
    return calls;
}

for (const ns of ['example.com', 'localhost', '127.0.0.1', '169.254.169.254', '[::1]',
    'docker.funcd.org', 'cf-workers-docker-io-4gy.pages.dev', 'ce3a22b2.cf-workers-docker-io-4gy.pages.dev',
    'registry-1.docker.io.evil.test', 'registry-1.docker.io:8443', 'user@registry-1.docker.io',
    'https://registry-1.docker.io', '__proto__', 'constructor', '']) {
    test(`reject namespace ${ns} before any fetch`, async () => {
        const calls = stub(); const w = await worker();
        assert.equal((await w.fetch(req(`/?ns=${encodeURIComponent(ns)}`))).status, 400);
        assert.equal(calls.length, 0);
    });
}
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'TRACE']) {
    test(`reject write method ${method} without reading its body`, async () => {
        const calls = stub(); const w = await worker();
        // Node's Request disallows TRACE, but the Workers handler still must reject it.
        const request = method === 'TRACE' ? { method, headers: new Headers() } : req('/v2/acme/image/blobs/uploads/', { method, body: 'upload' });
        const res = await w.fetch(request);
        assert.equal(res.status, 405); assert.match(res.headers.get('Allow'), /GET, HEAD, OPTIONS/);
        assert.equal(calls.length, 0);
        if (request.body) assert.equal(request.bodyUsed, false);
    });
}
test('reject duplicate selectors, invalid hubhost, GET bodies, oversized URLs and recursive marker', async () => {
    const calls = stub(); const w = await worker();
    for (const path of ['/v2/?ns=docker.io&ns=ghcr.io', '/v2/?hubhost=test&hubhost=quay',
        '/v2/?hubhost=example.com', '/v2/?ns=docker.io&hubhost=evil.test']) {
        assert.equal((await w.fetch(req(path))).status, 400);
    }
    assert.equal((await w.fetch(req('/v2/', { headers: { 'Content-Length': '2' } }))).status, 400);
    assert.equal((await w.fetch(req('/v2/?q=' + 'x'.repeat(8192)))).status, 414);
    assert.equal((await w.fetch(req('/v2/', { headers: { 'X-Docker-Proxy-Hop': '1' } }))).status, 508);
    assert.equal(calls.length, 0);
});
test('OPTIONS is local and advertises read methods only', async () => {
    const calls = stub(); const w = await worker();
    const res = await w.fetch(req('/v2/', { method: 'OPTIONS' }));
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
    assert.equal(calls.length, 0);
});
test('valid namespace is stripped and never changes subsequent routing', async () => {
    const calls = stub(); const w = await worker();
    await w.fetch(req('/v2/acme/image/manifests/latest?ns=ghcr.io'));
    await w.fetch(req('/v2/library/nginx/manifests/latest'));
    assert.equal(calls[0].url.hostname, 'ghcr.io');
    assert.equal(calls[1].url.hostname, 'registry-1.docker.io');
    assert.equal(calls[0].url.search, '');
    assert.equal(calls.length, 2); // No server-side token fetch per manifest.
});
test('supports the existing explicit registry routes', async () => {
    const calls = stub(); const w = await worker();
    for (const ns of ['docker.io', 'quay.io', 'gcr.io', 'k8s.gcr.io', 'registry.k8s.io',
        'ghcr.io', 'docker.cloudsmith.io', 'nvcr.io']) {
        await w.fetch(req(`/v2/acme/image/manifests/latest?ns=${ns}`));
        assert.equal(calls.at(-1).url.hostname, ns === 'docker.io' ? 'registry-1.docker.io' : ns);
    }
    await w.fetch(req('/v2/?hubhost=ghcr'));
    assert.equal(calls.at(-1).url.hostname, 'ghcr.io');
});
test('challenge, authenticated pull, shorthand, HEAD and Range remain intact', async () => {
    const calls = stub(() => new Response(null, { status: 401, headers: {
        'Www-Authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"',
        'Docker-Distribution-Api-Version': 'registry/2.0',
    } })); const w = await worker();
    const res = await w.fetch(req('/v2/nginx/manifests/latest', { method: 'HEAD', headers: {
        Authorization: 'Bearer private-pull', Range: 'bytes=0-100', 'If-Range': 'etag', Cookie: 'secret', 'CF-Connecting-IP': '192.0.2.1',
    } }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, '/v2/library/nginx/manifests/latest');
    assert.equal(calls[0].method, 'HEAD'); assert.equal(calls[0].redirect, 'manual');
    assert.equal(calls[0].headers.get('Authorization'), 'Bearer private-pull');
    assert.equal(calls[0].headers.get('Range'), 'bytes=0-100');
    assert.equal(calls[0].headers.get('If-Range'), 'etag');
    assert.equal(calls[0].headers.get('Cookie'), null);
    assert.equal(calls[0].headers.get('CF-Connecting-IP'), null);
    assert.equal(res.body, null);
    assert.match(res.headers.get('Www-Authenticate'), /realm="https:\/\/docker.funcd.org\/token"/);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
});
test('Docker token GET forwards private credentials, preserves scope, and is not cached', async () => {
    const calls = stub(() => new Response('{"token":"fixture"}')); const w = await worker();
    const scope = 'repository:acme/private:pull';
    const res = await w.fetch(req('/token?scope=' + encodeURIComponent(scope), { headers: { Authorization: 'Basic fixture' } }));
    assert.equal(calls[0].url.hostname, 'auth.docker.io');
    assert.equal(calls[0].url.searchParams.get('scope'), scope);
    assert.equal(calls[0].url.searchParams.get('service'), 'registry.docker.io');
    assert.equal(calls[0].headers.get('Authorization'), 'Basic fixture');
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
});
test('reject write token scopes, upload reads and unknown proxy paths', async () => {
    const calls = stub(); const w = await worker();
    for (const path of ['/token?scope=repository:a/b:pull,push', '/token?scope=registry:catalog:*',
        '/token?scope=repository:a/b:pull&scope=repository:a/b:push', '/token?service=evil', '/token?ns=ghcr.io']) {
        assert.equal((await w.fetch(req(path))).status, 400);
    }
    assert.equal((await w.fetch(req('/v2/a/b/blobs/uploads/'))).status, 405);
    assert.equal((await w.fetch(req('/arbitrary/file'))).status, 404);
    assert.equal(calls.length, 0);
});
test('root search UI is local; custom remote homepage cannot fetch recursively', async () => {
    const calls = stub(); const w = await worker();
    assert.match(await (await w.fetch(req('/'))).text(), /Docker Hub/);
    assert.equal((await w.fetch(req('/'), { URL: 'https://docker.funcd.org/' })).status, 503);
    assert.equal(calls.length, 0);
});
test('browser UA cannot reroute a manifest; search and Synology APIs keep fixed hosts', async () => {
    const calls = stub(); const w = await worker();
    for (const [path, host] of [['/v2/library/nginx/manifests/latest', 'registry-1.docker.io'],
        ['/search?q=nginx', 'hub.docker.com'], ['/v2/repositories/library/nginx/tags/', 'hub.docker.com'],
        ['/v1/search?q=library/nginx', 'index.docker.io']]) {
        await w.fetch(req(path, { headers: { 'User-Agent': 'Mozilla/5.0' } }));
        assert.equal(calls.at(-1).url.hostname, host);
    }
    assert.equal(calls.at(-1).url.searchParams.get('q'), 'nginx');
});
for (const location of ['https://docker.funcd.org/v2/', 'https://cf-workers-docker-io-4gy.pages.dev/v2/',
    'https://ce3a22b2.cf-workers-docker-io-4gy.pages.dev/v2/', 'https://169.254.169.254/',
    'https://127.0.0.1/', 'https://evil.test/', 'http://production.cloudfront.docker.com/x',
    'https://production.cloudfront.docker.com.evil.test/x', 'https://production.cloudfront.docker.com:8443/x',
    'https://user:pass@production.cloudfront.docker.com/x']) {
    test(`redirect blocks ${location}`, async () => {
        const calls = stub(() => new Response(null, { status: 307, headers: { Location: location } })); const w = await worker();
        assert.equal((await w.fetch(req('/v2/library/nginx/blobs/sha256:abc'))).status, 502);
        assert.equal(calls.length, 1);
    });
}
test('signed Docker CDN redirect strips authorization and preserves Range and signed query', async () => {
    const calls = stub((call, n) => n === 1 ? new Response(null, { status: 307, headers: {
        Location: 'https://production.cloudfront.docker.com/blob?Signature=fixture&Expires=123',
    } }) : new Response('part', { status: 206, headers: { 'Content-Range': 'bytes 0-3/10' } })); const w = await worker();
    const res = await w.fetch(req('/v2/library/nginx/blobs/sha256:abc', { headers: { Authorization: 'Bearer secret', Range: 'bytes=0-3' } }));
    assert.equal(res.status, 206); assert.equal(await res.text(), 'part');
    assert.equal(calls.length, 2); assert.equal(calls[1].headers.get('Authorization'), null);
    assert.equal(calls[1].headers.get('Range'), 'bytes=0-3');
    assert.equal(calls[1].url.searchParams.get('Signature'), 'fixture');
});
test('relative redirects retain credentials only on the same origin', async () => {
    const calls = stub((call, n) => n === 1 ? new Response(null, { status: 307, headers: { Location: '/v2/library/nginx/blobs/sha256:def' } }) : new Response('blob')); const w = await worker();
    assert.equal((await w.fetch(req('/v2/library/nginx/blobs/sha256:abc', { headers: { Authorization: 'Bearer fixture' } }))).status, 200);
    assert.equal(calls[1].headers.get('Authorization'), 'Bearer fixture');
});
test('redirect chains have a five-fetch ceiling, cancel bodies, and never retry', async () => {
    let canceled = 0;
    const calls = stub((call, n) => new Response(new ReadableStream({ cancel() { canceled++; } }), {
        status: 307, headers: { Location: `/v2/library/nginx/blobs/sha256:hop${n}` },
    })); const w = await worker();
    assert.equal((await w.fetch(req('/v2/library/nginx/blobs/sha256:abc'))).status, 502);
    assert.equal(calls.length, 5); assert.equal(canceled, 5);
});
test('a redirect cycle is stopped before a repeated fetch', async () => {
    const calls = stub(() => new Response(null, { status: 307, headers: { Location: '/v2/' } })); const w = await worker();
    assert.equal((await w.fetch(req())).status, 502); assert.equal(calls.length, 1);
});
test('an upstream failure is returned once; nonredirect Location is not followed', async () => {
    let calls = stub(() => { throw new Error('network'); }); const w = await worker();
    assert.equal((await w.fetch(req())).status, 502); assert.equal(calls.length, 1);
    calls = stub(() => new Response('ok', { status: 200, headers: { Location: '/v2/' } }));
    assert.equal((await w.fetch(req())).status, 200); assert.equal(calls.length, 1);
});
test('large layer remains a single streaming body without clone or buffering', async () => {
    let chunks = 0;
    const response = new Response(new ReadableStream({ pull(c) {
        if (chunks++ < 128) c.enqueue(new Uint8Array(64 * 1024)); else c.close();
    } }), { headers: { 'Content-Length': String(8 * 1024 * 1024) } });
    response.clone = response.text = response.arrayBuffer = response.json = () => { throw new Error('body buffering/tee forbidden'); };
    const calls = stub(() => response); const w = await worker();
    const res = await w.fetch(req('/v2/library/nginx/blobs/sha256:abc'));
    assert.equal(calls.length, 1); assert.ok(chunks <= 1);
    assert.equal(res.body, response.body);
    assert.equal(calls[0].signal.aborted, false);
    let bytes = 0; for await (const chunk of res.body) bytes += chunk.length;
    assert.equal(bytes, 8 * 1024 * 1024);
});
test('isolate throttle rejects 301st request, resets after a minute, and keeps clients independent', async () => {
    let now = 1_800_000_000_000; Date.now = () => now;
    const calls = stub(); const w = await worker();
    const a = req('/v2/', { headers: { 'CF-Connecting-IP': '192.0.2.1' } });
    for (let i = 0; i < 300; i++) assert.equal((await w.fetch(a)).status, 200);
    const res = await w.fetch(a); assert.equal(res.status, 429); assert.equal(res.headers.get('Retry-After'), '60');
    assert.equal(calls.length, 300);
    assert.equal((await w.fetch(req('/v2/', { headers: { 'CF-Connecting-IP': '192.0.2.2' } }))).status, 200);
    now += 60_000; assert.equal((await w.fetch(a)).status, 200);
});
test('IP table is bounded and does not evict identities to reset their limits', async () => {
    let now = 1_800_000_000_000; Date.now = () => now;
    const calls = stub(); const w = await worker();
    for (let i = 0; i < 4096; i++) assert.equal((await w.fetch(req('/', { headers: { 'CF-Connecting-IP': `192.0.${i >> 8}.${i % 256}` } }))).status, 200);
    assert.equal((await w.fetch(req('/v2/', { headers: { 'CF-Connecting-IP': '2001:db8::1' } }))).status, 429);
    assert.equal(calls.length, 0);
    now += 60_000;
    assert.equal((await w.fetch(req('/v2/', { headers: { 'CF-Connecting-IP': '2001:db8::1' } }))).status, 200);
});
