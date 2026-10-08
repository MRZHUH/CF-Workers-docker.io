// Docker pull mirror: all routing decisions and upstream budgets are per request.
const DEFAULT_REGISTRY = 'registry-1.docker.io';
const AUTH_ORIGIN = 'https://auth.docker.io';
const ROUTES = Object.freeze({
    quay: 'quay.io', gcr: 'gcr.io', 'k8s-gcr': 'k8s.gcr.io',
    k8s: 'registry.k8s.io', ghcr: 'ghcr.io',
    cloudsmith: 'docker.cloudsmith.io', nvcr: 'nvcr.io', test: DEFAULT_REGISTRY,
});
const REGISTRIES = new Set([DEFAULT_REGISTRY, ...Object.values(ROUTES)]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 4;
const MAX_URL_LENGTH = 8192;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_IP = 300;
const MAX_IPS = 4096;
// Best-effort abuse brake only: isolate memory is neither a global quota nor a cost cap.
const clients = new Map();
let lastCleanup = 0;

function admit(request) {
    const now = Date.now();
    if (now - lastCleanup >= WINDOW_MS) {
        for (const [ip, state] of clients) {
            if (now - state.start >= WINDOW_MS) clients.delete(ip);
        }
        lastCleanup = now;
    }
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    let state = clients.get(ip);
    if (!state || now - state.start >= WINDOW_MS) {
        if (!state && clients.size >= MAX_IPS) return false;
        state = { start: now, count: 0 };
        clients.set(ip, state);
    }
    return ++state.count <= MAX_REQUESTS_PER_IP;
}

function reject(message, status, headers = {}) {
    return new Response(message, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function registryFor(url) {
    if (url.searchParams.getAll('ns').length > 1 || url.searchParams.getAll('hubhost').length > 1) return null;
    const ns = url.searchParams.get('ns');
    const hubhost = url.searchParams.get('hubhost');
    if (ns !== null) {
        const registry = ns === 'docker.io' ? DEFAULT_REGISTRY : ns;
        if (!REGISTRIES.has(registry)) return null;
        // Do not let a second routing parameter conceal an invalid value.
        if (hubhost !== null && !REGISTRIES.has(hubhost) && !Object.hasOwn(ROUTES, hubhost)) return null;
        return registry;
    }
    if (hubhost !== null) {
        if (hubhost === 'docker.io') return DEFAULT_REGISTRY;
        if (REGISTRIES.has(hubhost)) return hubhost;
        return Object.hasOwn(ROUTES, hubhost) ? ROUTES[hubhost] : null;
    }
    const prefix = url.hostname.split('.')[0];
    return Object.hasOwn(ROUTES, prefix) ? ROUTES[prefix] : DEFAULT_REGISTRY;
}

function allowedTarget(url, originHost, registry) {
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hostname === originHost) return false;
    if (url.hostname === registry) return true;
    // CDN destinations are reached only through a validated registry response, never client input.
    const host = url.hostname;
    if (registry === DEFAULT_REGISTRY) {
        return host === 'production.cloudflare.docker.com' || host === 'production.cloudfront.docker.com';
    }
    if (['gcr.io', 'k8s.gcr.io', 'registry.k8s.io'].includes(registry)) {
        return host === 'registry.k8s.io' || host === 'gcr.io' || host === 'k8s.gcr.io' ||
            host === 'storage.googleapis.com' || /^[a-z0-9-]+-docker\.pkg\.dev$/.test(host);
    }
    if (registry === 'ghcr.io') return host === 'pkg-containers.githubusercontent.com';
    if (registry === 'quay.io') return /^[a-z0-9-]+\.quay\.io$/.test(host);
    return false;
}

function upstreamHeaders(request) {
    const headers = new Headers();
    for (const name of ['User-Agent', 'Accept', 'Accept-Language', 'Accept-Encoding',
        'Authorization', 'Range', 'If-Range', 'If-None-Match', 'If-Modified-Since']) {
        if (request.headers.has(name)) headers.set(name, request.headers.get(name));
    }
    headers.set('X-Docker-Proxy-Hop', '1');
    return headers;
}

async function upstream(request, target, registry, originHost) {
    const headers = upstreamHeaders(request);
    const visited = new Set();
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (target.href.length > MAX_URL_LENGTH || !allowedTarget(target, originHost, registry) || visited.has(target.href)) {
            return reject('Unsafe upstream redirect', 502);
        }
        visited.add(target.href);
        let response;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
            // Timeout applies to connection/response headers. Blob bodies stay streaming.
            response = await fetch(target, {
                method: request.method, headers, redirect: 'manual',
                signal: controller.signal,
            });
        } catch {
            return reject('Upstream unavailable', 502);
        } finally {
            clearTimeout(timeout);
        }
        const location = response.headers.get('Location');
        if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
        await response.body?.cancel();
        if (hop === MAX_REDIRECTS) return reject('Upstream redirect limit exceeded', 502);
        let next;
        try { next = new URL(location, target); } catch { return reject('Invalid upstream redirect', 502); }
        if (next.origin !== target.origin) headers.delete('Authorization');
        target = next;
    }
}

async function nginx() {
	const text = `
	<!DOCTYPE html>
	<html>
	<head>
	<title>Welcome to nginx!</title>
	<style>
		body {
			width: 35em;
			margin: 0 auto;
			font-family: Tahoma, Verdana, Arial, sans-serif;
		}
	</style>
	</head>
	<body>
	<h1>Welcome to nginx!</h1>
	<p>If you see this page, the nginx web server is successfully installed and
	working. Further configuration is required.</p>
	
	<p>For online documentation and support please refer to
	<a href="http://nginx.org/">nginx.org</a>.<br/>
	Commercial support is available at
	<a href="http://nginx.com/">nginx.com</a>.</p>
	
	<p><em>Thank you for using nginx.</em></p>
	</body>
	</html>
	`
	return text;
}

async function searchInterface() {
	const html = `
	<!DOCTYPE html>
	<html>
	<head>
		<title>Docker Hub 镜像搜索</title>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<style>
		:root {
			--github-color: rgb(27,86,198);
			--github-bg-color: #ffffff;
			--primary-color: #0066ff;
			--primary-dark: #0052cc;
			--gradient-start: #1a90ff;
			--gradient-end: #003eb3;
			--text-color: #ffffff;
			--shadow-color: rgba(0,0,0,0.1);
			--transition-time: 0.3s;
		}
		
		* {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
			display: flex;
			flex-direction: column;
			justify-content: center;
			align-items: center;
			min-height: 100vh;
			margin: 0;
			background: linear-gradient(135deg, var(--gradient-start) 0%, var(--gradient-end) 100%);
			padding: 20px;
			color: var(--text-color);
			overflow-x: hidden;
		}

		.container {
			text-align: center;
			width: 100%;
			max-width: 800px;
			padding: 20px;
			margin: 0 auto;
			display: flex;
			flex-direction: column;
			justify-content: center;
			min-height: 60vh;
			animation: fadeIn 0.8s ease-out;
		}

		@keyframes fadeIn {
			from { opacity: 0; transform: translateY(20px); }
			to { opacity: 1; transform: translateY(0); }
		}

		.github-corner {
			position: fixed;
			top: 0;
			right: 0;
			z-index: 999;
			transition: transform var(--transition-time) ease;
		}
		
		.github-corner:hover {
			transform: scale(1.08);
		}

		.github-corner svg {
			fill: var(--github-bg-color);
			color: var(--github-color);
			position: absolute;
			top: 0;
			border: 0;
			right: 0;
			width: 80px;
			height: 80px;
			filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.2));
		}

		.logo {
			margin-bottom: 20px;
			transition: transform var(--transition-time) ease;
			animation: float 6s ease-in-out infinite;
		}
		
		@keyframes float {
			0%, 100% { transform: translateY(0); }
			50% { transform: translateY(-10px); }
		}
		
		.logo:hover {
			transform: scale(1.08) rotate(5deg);
		}
		
		.logo svg {
			filter: drop-shadow(0 5px 15px rgba(0, 0, 0, 0.2));
		}
		
		.title {
			color: var(--text-color);
			font-size: 2.3em;
			margin-bottom: 10px;
			text-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
			font-weight: 700;
			letter-spacing: -0.5px;
			animation: slideInFromTop 0.5s ease-out 0.2s both;
		}
		
		@keyframes slideInFromTop {
			from { opacity: 0; transform: translateY(-20px); }
			to { opacity: 1; transform: translateY(0); }
		}
		
		.subtitle {
			color: rgba(255, 255, 255, 0.9);
			font-size: 1.1em;
			margin-bottom: 25px;
			max-width: 600px;
			margin-left: auto;
			margin-right: auto;
			line-height: 1.4;
			animation: slideInFromTop 0.5s ease-out 0.4s both;
		}
		
		.search-container {
			display: flex;
			align-items: stretch;
			width: 100%;
			max-width: 600px;
			margin: 0 auto;
			height: 55px;
			position: relative;
			animation: slideInFromBottom 0.5s ease-out 0.6s both;
			box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
			border-radius: 12px;
			overflow: hidden;
		}
		
		@keyframes slideInFromBottom {
			from { opacity: 0; transform: translateY(20px); }
			to { opacity: 1; transform: translateY(0); }
		}
		
		#search-input {
			flex: 1;
			padding: 0 20px;
			font-size: 16px;
			border: none;
			outline: none;
			transition: all var(--transition-time) ease;
			height: 100%;
		}
		
		#search-input:focus {
			padding-left: 25px;
		}
		
		#search-button {
			width: 60px;
			background-color: var(--primary-color);
			border: none;
			cursor: pointer;
			transition: all var(--transition-time) ease;
			height: 100%;
			display: flex;
			align-items: center;
			justify-content: center;
			position: relative;
		}
		
		#search-button svg {
			transition: transform 0.3s ease;
			stroke: white;
		}
		
		#search-button:hover {
			background-color: var(--primary-dark);
		}
		
		#search-button:hover svg {
			transform: translateX(2px);
		}
		
		#search-button:active svg {
			transform: translateX(4px);
		}
		
		.tips {
			color: rgba(255, 255, 255, 0.8);
			margin-top: 20px;
			font-size: 0.9em;
			animation: fadeIn 0.5s ease-out 0.8s both;
			transition: transform var(--transition-time) ease;
		}
		
		.tips:hover {
			transform: translateY(-2px);
		}
		
		@media (max-width: 768px) {
			.container {
				padding: 20px 15px;
				min-height: 60vh;
			}
			
			.title {
				font-size: 2em;
			}
			
			.subtitle {
				font-size: 1em;
				margin-bottom: 20px;
			}
			
			.search-container {
				height: 50px;
			}
		}
		
		@media (max-width: 480px) {
			.container {
				padding: 15px 10px;
				min-height: 60vh;
			}
			
			.github-corner svg {
				width: 60px;
				height: 60px;
			}
			
			.search-container {
				height: 45px;
			}
			
			#search-input {
				padding: 0 15px;
			}
			
			#search-button {
				width: 50px;
			}
			
			#search-button svg {
				width: 18px;
				height: 18px;
			}
			
			.title {
				font-size: 1.7em;
				margin-bottom: 8px;
			}
			
			.subtitle {
				font-size: 0.95em;
				margin-bottom: 18px;
			}
		}
		</style>
	</head>
	<body>
		<a href="https://github.com/cmliu/CF-Workers-docker.io" target="_blank" class="github-corner" aria-label="View source on Github">
			<svg viewBox="0 0 250 250" aria-hidden="true">
				<path d="M0,0 L115,115 L130,115 L142,142 L250,250 L250,0 Z"></path>
				<path d="M128.3,109.0 C113.8,99.7 119.0,89.6 119.0,89.6 C122.0,82.7 120.5,78.6 120.5,78.6 C119.2,72.0 123.4,76.3 123.4,76.3 C127.3,80.9 125.5,87.3 125.5,87.3 C122.9,97.6 130.6,101.9 134.4,103.2" fill="currentColor" style="transform-origin: 130px 106px;" class="octo-arm"></path>
				<path d="M115.0,115.0 C114.9,115.1 118.7,116.5 119.8,115.4 L133.7,101.6 C136.9,99.2 139.9,98.4 142.2,98.6 C133.8,88.0 127.5,74.4 143.8,58.0 C148.5,53.4 154.0,51.2 159.7,51.0 C160.3,49.4 163.2,43.6 171.4,40.1 C171.4,40.1 176.1,42.5 178.8,56.2 C183.1,58.6 187.2,61.8 190.9,65.4 C194.5,69.0 197.7,73.2 200.1,77.6 C213.8,80.2 216.3,84.9 216.3,84.9 C212.7,93.1 206.9,96.0 205.4,96.6 C205.1,102.4 203.0,107.8 198.3,112.5 C181.9,128.9 168.3,122.5 157.7,114.1 C157.9,116.9 156.7,120.9 152.7,124.9 L141.0,136.5 C139.8,137.7 141.6,141.9 141.8,141.8 Z" fill="currentColor" class="octo-body"></path>
			</svg>
		</a>
		<div class="container">
			<div class="logo">
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 18" fill="#ffffff" width="110" height="85">
					<path d="M23.763 6.886c-.065-.053-.673-.512-1.954-.512-.32 0-.659.03-1.01.087-.248-1.703-1.651-2.533-1.716-2.57l-.345-.2-.227.328a4.596 4.596 0 0 0-.611 1.433c-.23.972-.09 1.884.403 2.666-.596.331-1.546.418-1.744.42H.752a.753.753 0 0 0-.75.749c-.007 1.456.233 2.864.692 4.07.545 1.43 1.355 2.483 2.409 3.13 1.181.725 3.104 1.14 5.276 1.14 1.016 0 2.03-.092 2.93-.266 1.417-.273 2.705-.742 3.826-1.391a10.497 10.497 0 0 0 2.61-2.14c1.252-1.42 1.998-3.005 2.553-4.408.075.003.148.005.221.005 1.371 0 2.215-.55 2.68-1.01.505-.5.685-.998.704-1.053L24 7.076l-.237-.19Z"></path>
					<path d="M2.216 8.075h2.119a.186.186 0 0 0 .185-.186V6a.186.186 0 0 0-.185-.186H2.216A.186.186 0 0 0 2.031 6v1.89c0 .103.083.186.185.186Zm2.92 0h2.118a.185.185 0 0 0 .185-.186V6a.185.185 0 0 0-.185-.186H5.136A.185.185 0 0 0 4.95 6v1.89c0 .103.083.186.186.186Zm2.964 0h2.118a.186.186 0 0 0 .185-.186V6a.186.186 0 0 0-.185-.186H8.1A.185.185 0 0 0 7.914 6v1.89c0 .103.083.186.186.186Zm2.928 0h2.119a.185.185 0 0 0 .185-.186V6a.185.185 0 0 0-.185-.186h-2.119a.186.186 0 0 0-.185.186v1.89c0 .103.083.186.185.186Zm-5.892-2.72h2.118a.185.185 0 0 0 .185-.186V3.28a.186.186 0 0 0-.185-.186H5.136a.186.186 0 0 0-.186.186v1.89c0 .103.083.186.186.186Zm2.964 0h2.118a.186.186 0 0 0 .185-.186V3.28a.186.186 0 0 0-.185-.186H8.1a.186.186 0 0 0-.186.186v1.89c0 .103.083.186.186.186Zm2.928 0h2.119a.185.185 0 0 0 .185-.186V3.28a.186.186 0 0 0-.185-.186h-2.119a.186.186 0 0 0-.185.186v1.89c0 .103.083.186.185.186Zm0-2.72h2.119a.186.186 0 0 0 .185-.186V.56a.185.185 0 0 0-.185-.186h-2.119a.186.186 0 0 0-.185.186v1.89c0 .103.083.186.185.186Zm2.955 5.44h2.118a.185.185 0 0 0 .186-.186V6a.185.185 0 0 0-.186-.186h-2.118a.185.185 0 0 0-.185.186v1.89c0 .103.083.186.185.186Z"></path>
				</svg>
			</div>
			<h1 class="title">Docker Hub 镜像搜索</h1>
			<p class="subtitle">快速查找、下载和部署 Docker 容器镜像</p>
			<div class="search-container">
				<input type="text" id="search-input" placeholder="输入关键词搜索镜像，如: nginx, mysql, redis...">
				<button id="search-button" title="搜索">
					<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
						<path d="M13 5l7 7-7 7M5 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round"></path>
					</svg>
				</button>
			</div>
			<p class="tips">基于 Cloudflare Workers / Pages 构建，利用全球边缘网络实现毫秒级响应。</p>
		</div>
		<script>
		function performSearch() {
			const query = document.getElementById('search-input').value;
			if (query) {
				window.location.href = '/search?q=' + encodeURIComponent(query);
			}
		}
	
		document.getElementById('search-button').addEventListener('click', performSearch);
		document.getElementById('search-input').addEventListener('keypress', function(event) {
			if (event.key === 'Enter') {
				performSearch();
			}
		});

		// 添加焦点在搜索框
		window.addEventListener('load', function() {
			document.getElementById('search-input').focus();
		});
		</script>
	</body>
	</html>
	`;
	return html;
}

export default {
    async fetch(request, env = {}) {
        if (request.headers.has('X-Docker-Proxy-Hop')) return reject('Recursive proxy request', 508);
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
            return reject('This mirror supports pulls only; push directly to your registry', 405, { Allow: 'GET, HEAD, OPTIONS' });
        }
        if (request.body || (request.headers.has('Content-Length') && request.headers.get('Content-Length') !== '0') || request.headers.has('Transfer-Encoding')) {
            return reject('Request bodies are not supported', 400);
        }
        if (request.url.length > MAX_URL_LENGTH) return reject('Request URL too long', 414);
        const url = new URL(request.url);
        const originHost = url.hostname;
        const registry = registryFor(url);
        if (!registry) return reject('Unsupported registry', 400);
        if (!admit(request)) return reject('Too many requests', 429, { 'Retry-After': '60' });
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Accept, Range, If-Range, If-None-Match, If-Modified-Since',
                'Access-Control-Max-Age': '600',
            } });
        }
        // Routing parameters belong to this proxy, not the upstream API.
        url.searchParams.delete('ns');
        url.searchParams.delete('hubhost');
        let targetRegistry = registry;
        if (url.pathname === '/') {
            const blockedAgents = ['netcraft', ...(env.UA ? env.UA.split(/[\s,]+/).filter(Boolean) : [])];
            const ua = (request.headers.get('User-Agent') || '').toLowerCase();
            if (env.URL302) return Response.redirect(env.URL302, 302);
            // Remote homepage fetches are disabled so configuration cannot introduce a self-fetch.
            if (env.URL && env.URL.toLowerCase() !== 'nginx') return reject('Remote homepage proxy disabled', 503);
            const html = env.URL || blockedAgents.some(agent => ua.includes(agent.toLowerCase())) ? await nginx() : await searchInterface();
            return new Response(request.method === 'HEAD' ? null : html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
        }
        if (url.pathname === '/token') {
            if (registry !== DEFAULT_REGISTRY ||
                url.searchParams.getAll('service').some(service => service !== 'registry.docker.io') ||
                url.searchParams.getAll('scope').some(scope => !/^repository:[a-z0-9._/-]+:pull$/.test(scope))) {
                return reject('Only Docker Hub pull tokens are supported', 400);
            }
            url.searchParams.set('service', 'registry.docker.io');
            targetRegistry = new URL(AUTH_ORIGIN).hostname;
        } else if (registry === DEFAULT_REGISTRY && (url.pathname === '/search' || /^\/v2\/repositories\//.test(url.pathname))) {
            targetRegistry = 'hub.docker.com';
        } else if (url.pathname.startsWith('/v2/')) {
            if (/(?:^|\/)uploads(?:\/|$)/.test(url.pathname)) return reject('Uploads are not supported', 405, { Allow: 'GET, HEAD, OPTIONS' });
            // Direct shorthand /v2/nginx/manifests/latest => Docker's library/nginx.
            if (registry === DEFAULT_REGISTRY && /^\/v2\/[^/]+\/(?:manifests|blobs|tags)\//.test(url.pathname)) {
                url.pathname = '/v2/library/' + url.pathname.slice('/v2/'.length);
            }
        } else if (registry === DEFAULT_REGISTRY && /^\/v1\/(?:search|repositories)(?:\/|$)/.test(url.pathname)) {
            targetRegistry = 'index.docker.io';
            const q = url.searchParams.get('q');
            if (q?.startsWith('library/') && q !== 'library/') url.searchParams.set('q', q.slice('library/'.length));
        } else {
            return reject('Unsupported proxy path', 404);
        }
        url.protocol = 'https:';
        url.hostname = targetRegistry;
        url.port = '';
        const response = await upstream(request, url, targetRegistry, originHost);
        const headers = new Headers(response.headers);
        const challenge = headers.get('Www-Authenticate');
        if (registry === DEFAULT_REGISTRY && challenge) {
            headers.set('Www-Authenticate', challenge.replace('realm="' + AUTH_ORIGIN + '/token"', 'realm="https://' + originHost + '/token"'));
        }
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Expose-Headers', '*');
        // Credentials and tokens must never become shared cache entries.
        if (request.headers.has('Authorization') || url.pathname === '/token') headers.set('Cache-Control', 'private, no-store');
        return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
    },
};
