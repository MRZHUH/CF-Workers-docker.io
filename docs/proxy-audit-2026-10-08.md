# Docker Pages proxy audit and review handoff

Only `cf-workers-docker-io` was audited or changed. No other deployed project was modified.
No remote branch push, PR, merge, deployment, Cloudflare configuration write, or new storage binding was performed.

## Provenance

- Account: `8916cdfed801ddaed5d19a6576ef392c`.
- Project ID: `5de79805-fb53-4e3a-919d-bc466858a7db`.
- Domains: `docker.funcd.org`, `cf-workers-docker-io-4gy.pages.dev`.
- Canonical/latest production deployment: `ce3a22b2-a0d8-4ff6-afe4-41edef83908b`.
- Deployed: `2025-06-27T01:51:02.452881Z` (successful final stage).
- Git source: https://github.com/MRZHUH/CF-Workers-docker.io .
- Production branch and current repository HEAD: `main`, `059ff30b89e564ca07b56a2958821f02e6371391`.
- `_worker.js` Git blob: `66f64afdac05f55e36e8a3350a9be69d0bfe1adf`.
- Original `_worker.js` SHA-256: `dae1cc28c4e0e470b1bf05c99dd0096a2151a4ae0adecc3eb02aa5298cf389c4`.
- Build command/root/output were all empty: this deploy used the root advanced-mode `_worker.js`.
- Project and deployed environment have no DO/D1/R2/KV/service bindings. The environment settings API returned only `CF_PAGES`, `CF_PAGES_BRANCH=main`, `CF_PAGES_COMMIT_SHA=059ff30b89e564ca07b56a2958821f02e6371391`, and its deployment URL.
- Rechecked canonical deployment and GitHub HEAD on 2026-10-08; neither changed during the audit.

The production deployment receipt, deployed environment commit binding, repository HEAD, and observed behavior agree. **A byte-for-byte comparison of the uploaded Worker bundle was not possible:** Workers script download returned 10007 (script absent), environment content returned 10092, and retained build logs returned "Logs are no longer available for this deployment". Environment settings were readable. This is strong commit/behavior provenance, not a downloaded-bundle hash match. `uses_functions=null` on this older Pages project does not indicate a static site: both live domains return a rewritten registry authentication challenge.

## Confirmed exposure and source defects

At `2026-10-08T06:17:47.244Z` (14:17:47 Asia/Shanghai), a bounded GET to `https://docker.funcd.org/?ns=example.com` returned 200, the title `Example Domain`, and 577 bytes. It was byte-for-byte identical to a direct GET of `https://example.com/`, SHA-256 `25ddf2c883e0d1958ea971d279a7e4f0fd446724ee3db7db19dadabd4a62e484`. This proves an externally usable arbitrary-host proxy. No private-address, write, load, or self-recursion probes were sent to production.

Original source locations at the base commit:

| Finding | Evidence | Impact |
| --- | --- | --- |
| Arbitrary upstream and possible self-fetch | `_worker.js:425-445`, `ns` assigned directly to global `hub_host` | Caller-selected public/private/own host; recursion risk is source-derived and was not exercised live |
| Shared mutable upstream and UA list | globals and `_worker.js:421,431-439` | A request can change subsequent/concurrent routing; UA list grows with requests when configured |
| Automatic unvalidated redirects | original fetch calls and `httpHandler:678` with `redirect: follow` | Redirect destinations and subrequest amplification unchecked by application |
| Response stream tee | `_worker.js:568-569,617-618` | Clone is consumed while original branch is abandoned, potentially retaining a large blob in memory |
| Extra token request for every layer/manifest | `_worker.js:521-587` | Two initial subrequests; supplied private credentials are overwritten with anonymous Docker pull token, including on non-Docker registry paths |
| Write methods forwarded | all methods accepted; preflight lists writes and TRACE | Unnecessary upload/write/body exposure for a repository documented exclusively as a pull mirror |

No application retry loop, storage usage, queue, cron Worker, or persistence was found. Redirect following and recursive invocation are the amplification risks; they are not an observed bill spike.

## Patch

- Keep the existing single-file Pages Worker and local search page.
- Allow only the existing eight registry hosts (plus `docker.io` alias); reject arbitrary `ns`/`hubhost`, duplicate selectors, and strip proxy-only parameters before outbound fetch.
- Make routing and configured UA processing per-request. Browser UA cannot reroute registry API calls.
- Allow GET/HEAD/local OPTIONS only; reject writes, request bodies, upload paths, and Docker token write scopes before upstream work. Push directly to the actual registry. There is no supported authenticated push flow in this project's documented contract; the previous manifest/upload handling requested `:pull` tokens regardless of method.
- Preserve client-driven Docker auth challenges, client-supplied private pull credentials, manifest Accept headers, HEAD, Range and conditional headers. Remove the automatic token fetch; ordinary requests now use one initial upstream fetch.
- Validate HTTPS/default-port/no-userinfo destinations on every hop. Docker CDN hosts are the two named Docker production CDNs; explicit GCR/Kubernetes/GHCR/Quay redirect hosts are scoped to their registry. No broad private IP or generic S3/CDN allowlist.
- Manual redirects, visited-URL cycle detection, four redirects / **five fetches maximum**, no retries, 15-second response-header timeout per fetch. Cancel intermediate redirect bodies. Strip Authorization on cross-origin redirects; never forward cookies/client IP.
- Stream the final body once without clone, JSON, text, or arrayBuffer conversion. Header timeout is cleared when response headers arrive, so long-running Docker layer streams are not cut off after 15 seconds.
- Never shared-cache token responses or requests with Authorization. No token/signed URL logging.
- Best-effort isolate-local brake: 300 accepted requests/IP/minute, at most 4,096 IP records, expired records cleaned up, no eviction that resets an active client's quota. Return 429/Retry-After on excess. This adds no binding or storage operation.
- Remote `URL` homepage fetching is disabled (unused in deployed configuration); `URL=nginx` and client-side `URL302` remain supported.

## Verification

`npm run check` and `npm test`: **47/47 passing**. Tests exercise arbitrary/self/private upstream rejection, method/body/scope limits, routing isolation, all existing explicit registries, challenge rewrite, private credentials, Range/HEAD, CDN authorization stripping, redirect cycles/budget/cancellation, upstream errors without retries, an 8 MiB nonbuffered layer, throttle reset, and bounded IP state.

An opt-in real **workerd** integration smoke test also passed against public Docker `library/hello-world`, using compatibility date `2024-06-14` and the installed Miniflare `5.20260930.0-alpha` with its exported v4-options adapter:

```json
{"runtime":"workerd","challenge":401,"token":200,"index":200,"manifest":200,"head":200,"blob":200,"range":206,"layerBytes":2415,"digestVerified":true}
```

It downloaded one 2,415-byte public layer, verified its SHA-256 against the manifest, and checked a 16-byte Range response. No private credentials were used in this live test; private-pull forwarding is covered by fixtures. The observed Docker blob redirect hostname was `production.cloudfront.docker.com`.

Repeat locally (no deployment):

```sh
npm run check
npm test
MINIFLARE_MODULE=/Users/bond/.nvm/versions/node/v22.23.2/lib/node_modules/cf/node_modules/miniflare/dist/src/index.js npm run test:runtime
```

Alternatively install Miniflare in a separate tooling environment and point `MINIFLARE_MODULE` to its module. There are no package dependencies or framework build in this source repository; successful workerd loading confirms the deployable module resolves. `.wrangler/cache` generated by the local runtime is ignored.

## Parent review and release boundary

Source clone: `/Users/bond/Documents/Codex/2026-10-08/cost-abuse-audit/docker-proxy-source`.
Worktree: `/Users/bond/Documents/Codex/2026-10-08/cost-abuse-audit/docker-proxy-guard`.
Branch: `agent/docker-proxy-cost-guard`, based on the exact production source commit above.

**Do not push before review:** Pages currently has `preview_deployment_setting=all`, so a branch push can create a billable preview deployment. Production deploys from `main` are enabled. The existing upstream sync workflow ID `162358015` is `disabled_inactivity`; leave it disabled. It has a daily writable sync configuration in source, which must not be re-enabled without reviewing how upstream merges preserve these protections.

After the parent reviews and authorizes deployment:

1. Reconfirm canonical deployment/source and ensure no newer code would be overwritten.
2. Publish this branch only when a preview deployment is explicitly authorized. Let the existing Git-integrated Pages flow build that exact branch; no Wrangler migration or new project is needed.
3. Verify preview denies example.com/self namespace and writes before any upstream request, and repeat the public Docker pull/HEAD/Range flow against the deployed preview. Other explicit registries have routing fixtures; their authenticated/CDN flows still need validation if actually used.
4. Merge into `main` only after parent approval. Existing Pages Git integration then deploys production; wait for final stage `success` and verify the exact merge SHA in receipt and `CF_PAGES_COMMIT_SHA`.
5. Smoke-test both production domains for pull flow and rejection behavior. Compare deployment ID and binding SHA, not just an HTTP 200.

Rollback target is `ce3a22b2-a0d8-4ff6-afe4-41edef83908b`, but reverting restores the confirmed open-proxy exposure. Revert this single-repo patch or use the project's Pages rollback endpoint only with parent authorization; no data migration is involved.

## Remaining cost boundary

The patch removes arbitrary egress, recursive fetch, body retention, and hidden per-layer token amplification. It **does not guarantee a global billing ceiling**: an isolate-local limiter resets across cold starts/locations, and rejected requests still invoke a billable Pages Function. Public legitimate image pulls remain possible. The parent should select a pre-invocation control or quota strategy for both custom and pages.dev/preview URLs if a hard cost boundary is required. A WAF rule on `funcd.org` alone would not cover Pages hostnames. No live incident/abuse volume or spend attribution is claimed by this source audit.

Relevant primary documentation:

- https://docs.docker.com/desktop/enterprise/allow-list/ (Docker production CDN domains).
- https://docs.docker.com/docker-hub/image-library/mirror/ (pull mirror behavior).
- https://developers.cloudflare.com/pages/functions/pricing/ (Function invocations count as Workers requests).
- https://developers.cloudflare.com/pages/functions/routing/ (free-plan fail-open/closed behavior; paid Functions have no free daily allowance cap).
