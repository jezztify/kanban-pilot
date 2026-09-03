"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startWorkspaceRegistry = startWorkspaceRegistry;
const node_http_1 = require("node:http");
const node_crypto_1 = require("node:crypto");
const registryStore_1 = require("./registryStore");
function send(response, status, value) {
    response.statusCode = status;
    response.setHeader('cache-control', 'no-store');
    if (value === undefined) {
        response.end();
        return;
    }
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(value));
}
function authorized(request, credential) {
    const value = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const actual = Buffer.from(value);
    const expected = Buffer.from(credential);
    return actual.length === expected.length && (0, node_crypto_1.timingSafeEqual)(actual, expected);
}
async function body(request) {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.byteLength;
        if (length > 16 * 1024) {
            throw new Error('Request body is too large.');
        }
        chunks.push(bytes);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new Error('Request body must be valid JSON.');
    }
}
function page() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kanban Pilot workspaces</title><style>body{font:16px system-ui,sans-serif;max-width:720px;margin:4rem auto;padding:0 1rem;color:#202124}li{margin:.5rem 0}button{font:inherit;padding:.5rem .75rem;cursor:pointer}.status{color:#137333}</style></head><body><main><h1>Choose a workspace</h1><p>Select an available Kanban Pilot workspace to open its existing board.</p><p id="status" role="status">Loading workspaces…</p><ul id="workspaces"></ul></main><script>const status=document.getElementById('status'),list=document.getElementById('workspaces');fetch('/api/workspaces').then(r=>r.ok?r.json():Promise.reject()).then(({workspaces})=>{status.textContent=workspaces.length?'Available workspaces:':'No workspaces are currently available.';workspaces.forEach(w=>{const item=document.createElement('li'),button=document.createElement('button');button.textContent=w.name+' — available';button.addEventListener('click',()=>location.assign(w.boardUrl));item.append(button);list.append(item);});}).catch(()=>{status.textContent='Workspace list is temporarily unavailable.';});</script></body></html>`;
}
/** Starts the standalone discovery service; it never proxies or reads any board state. */
async function startWorkspaceRegistry(options) {
    if (!options.credential.trim()) {
        throw new Error('Registry credential cannot be blank.');
    }
    const store = new registryStore_1.RegistryStore(options.dataFile);
    const ttlMs = options.ttlMs ?? 90_000;
    const server = (0, node_http_1.createServer)(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://registry.local');
        try {
            if (request.method === 'GET' && url.pathname === '/') {
                response.statusCode = 200;
                response.setHeader('content-type', 'text/html; charset=utf-8');
                response.setHeader('cache-control', 'no-store');
                response.end(page());
                return;
            }
            if (request.method === 'GET' && url.pathname === '/health') {
                send(response, 200, { ok: true, service: 'kanban-pilot-workspace-registry' });
                return;
            }
            if (request.method === 'GET' && url.pathname === '/api/workspaces') {
                send(response, 200, { workspaces: await store.list(ttlMs) });
                return;
            }
            if (request.method === 'PUT' && url.pathname === '/api/workspaces') {
                if (!authorized(request, options.credential)) {
                    send(response, 401, { error: 'Authentication required.' });
                    return;
                }
                await store.upsert(await body(request));
                send(response, 204);
                return;
            }
            const removal = /^\/api\/workspaces\/([^/]+)$/.exec(url.pathname);
            if (request.method === 'DELETE' && removal) {
                if (!authorized(request, options.credential)) {
                    send(response, 401, { error: 'Authentication required.' });
                    return;
                }
                await store.remove(decodeURIComponent(removal[1]));
                send(response, 204);
                return;
            }
            send(response, 404, { error: 'Not found.' });
        }
        catch (error) {
            send(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 8080, options.bindAddress ?? '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('Registry did not expose a TCP port.');
    }
    return { port: address.port, dispose: () => server.close() };
}
if (require.main === module) {
    const credential = process.env.KANBAN_PILOT_REGISTRY_CREDENTIAL ?? '';
    const dataFile = process.env.KANBAN_PILOT_REGISTRY_DATA ?? 'workspaces.json';
    void startWorkspaceRegistry({ credential, dataFile, port: Number(process.env.PORT ?? 8080), bindAddress: process.env.HOST ?? '0.0.0.0' }).then((service) => console.log(`Kanban Pilot workspace registry listening on ${service.port}`));
}
//# sourceMappingURL=server.js.map