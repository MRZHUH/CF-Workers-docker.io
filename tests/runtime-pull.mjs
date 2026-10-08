// Opt-in runtime smoke test. No deployment, push, private credentials, or large images.
// Point MINIFLARE_MODULE to the installed miniflare module (or install miniflare locally).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const modulePath = process.env.MINIFLARE_MODULE;
const runtime = modulePath ? await import(pathToFileURL(modulePath).href) : await import('miniflare');
const options = { modules: true, scriptPath: '_worker.js', compatibilityDate: '2024-06-14' };
const mf = new runtime.Miniflare(runtime.convertV4MiniflareOptions ? runtime.convertV4MiniflareOptions(options) : options);
const origin = 'https://docker.funcd.org';
try {
    assert.equal((await mf.dispatchFetch(origin + '/v2/?ns=example.com')).status, 400);
    assert.equal((await mf.dispatchFetch(origin + '/v2/library/hello-world/manifests/latest', {method:'PUT',body:'blocked'})).status, 405);
    const challenge = await mf.dispatchFetch(origin + '/v2/');
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get('Www-Authenticate'), /realm="https:\/\/docker.funcd.org\/token"/);
    await challenge.body?.cancel();
    const tokenRes = await mf.dispatchFetch(origin + '/token?service=registry.docker.io&scope=repository:library/hello-world:pull');
    assert.equal(tokenRes.status, 200);
    assert.equal(tokenRes.headers.get('Cache-Control'), 'private, no-store');
    const {token} = await tokenRes.json();
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json' };
    const indexRes = await mf.dispatchFetch(origin + '/v2/library/hello-world/manifests/latest', {headers});
    assert.equal(indexRes.status, 200);
    const index = await indexRes.json();
    const digest = index.manifests.find(m => m.platform.os === 'linux' && m.platform.architecture === 'amd64').digest;
    const manifestRes = await mf.dispatchFetch(origin + '/v2/library/hello-world/manifests/' + digest, {headers});
    assert.equal(manifestRes.status, 200);
    const manifest = await manifestRes.json();
    const layer = manifest.layers[0];
    assert.ok(layer.size < 64 * 1024, 'This probe must stay small');
    const path = origin + '/v2/library/hello-world/blobs/' + layer.digest;
    const head = await mf.dispatchFetch(path, {headers,method:'HEAD'});
    assert.equal(head.status, 200); assert.equal(head.body, null);
    const blob = await mf.dispatchFetch(path, {headers});
    assert.equal(blob.status, 200);
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of blob.body) { bytes += chunk.length; hash.update(chunk); }
    assert.equal(bytes, layer.size); assert.equal('sha256:' + hash.digest('hex'), layer.digest);
    const ranged = await mf.dispatchFetch(path, {headers:{...headers, Range:'bytes=0-15'}});
    assert.equal(ranged.status, 206); assert.equal((await ranged.arrayBuffer()).byteLength, 16);
    console.log(JSON.stringify({runtime:'workerd',challenge:challenge.status,token:tokenRes.status,index:indexRes.status,manifest:manifestRes.status,head:head.status,blob:blob.status,range:ranged.status,layerBytes:bytes,digestVerified:true}));
} finally {
    await mf.dispose();
}
