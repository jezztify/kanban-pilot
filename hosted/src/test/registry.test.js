"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const server_1 = require("../server");
const temporaryDirectories = [];
(0, node_test_1.afterEach)(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => (0, promises_1.rm)(directory, { recursive: true, force: true })));
});
async function registry() {
    const directory = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'kanban-pilot-registry-'));
    temporaryDirectories.push(directory);
    return (0, server_1.startWorkspaceRegistry)({ port: 0, credential: 'registry-secret', dataFile: (0, node_path_1.join)(directory, 'workspaces.json'), ttlMs: 100 });
}
async function request(port, pathname, init = {}) {
    return fetch(`http://127.0.0.1:${port}${pathname}`, init);
}
function authenticated(method, body) {
    return {
        method,
        headers: { authorization: 'Bearer registry-secret', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
}
(0, node_test_1.test)('upserts sanitized registrations and exposes only safe live records', async () => {
    const service = await registry();
    try {
        const first = await request(service.port, '/api/workspaces', authenticated('PUT', {
            id: 'workspace-a', name: 'Workspace A', boardUrl: 'https://pilot.example.test/board?token=secret#fragment',
        }));
        strict_1.default.equal(first.status, 204);
        const second = await request(service.port, '/api/workspaces', authenticated('PUT', {
            id: 'workspace-a', name: 'Renamed workspace', boardUrl: 'https://pilot.example.test/board?token=replaced',
        }));
        strict_1.default.equal(second.status, 204);
        const listing = await (await request(service.port, '/api/workspaces')).json();
        strict_1.default.deepEqual(listing.workspaces, [{ id: 'workspace-a', name: 'Renamed workspace', boardUrl: 'https://pilot.example.test/board', available: true }]);
        strict_1.default.doesNotMatch(JSON.stringify(listing), /secret|replaced|token/i);
    }
    finally {
        service.dispose();
    }
});
(0, node_test_1.test)('requires credentials and rejects invalid registrations without changing stored records', async () => {
    const service = await registry();
    try {
        strict_1.default.equal((await request(service.port, '/api/workspaces', { method: 'PUT' })).status, 401);
        const invalid = await request(service.port, '/api/workspaces', authenticated('PUT', {
            id: 'bad id', name: 'Invalid', boardUrl: 'ftp://pilot.example.test/',
        }));
        strict_1.default.equal(invalid.status, 400);
        const listing = await (await request(service.port, '/api/workspaces')).json();
        strict_1.default.deepEqual(listing.workspaces, []);
    }
    finally {
        service.dispose();
    }
});
(0, node_test_1.test)('removes records explicitly and hides expired records', async () => {
    const service = await registry();
    try {
        await request(service.port, '/api/workspaces', authenticated('PUT', { id: 'one', name: 'One', boardUrl: 'https://one.test/' }));
        strict_1.default.equal((await request(service.port, '/api/workspaces/one', authenticated('DELETE'))).status, 204);
        strict_1.default.deepEqual((await (await request(service.port, '/api/workspaces')).json()).workspaces, []);
        await request(service.port, '/api/workspaces', authenticated('PUT', { id: 'two', name: 'Two', boardUrl: 'https://two.test/' }));
        await new Promise((resolve) => setTimeout(resolve, 125));
        strict_1.default.deepEqual((await (await request(service.port, '/api/workspaces')).json()).workspaces, []);
    }
    finally {
        service.dispose();
    }
});
(0, node_test_1.test)('serves a visitor landing page and health endpoint without board content', async () => {
    const service = await registry();
    try {
        const health = await request(service.port, '/health');
        strict_1.default.deepEqual(await health.json(), { ok: true, service: 'kanban-pilot-workspace-registry' });
        const page = await request(service.port, '/');
        const markup = await page.text();
        strict_1.default.equal(page.status, 200);
        strict_1.default.match(markup, /Choose a workspace/);
        strict_1.default.match(markup, /fetch\('\/api\/workspaces'\)/);
        strict_1.default.doesNotMatch(markup, /task data|board snapshot/i);
    }
    finally {
        service.dispose();
    }
});
//# sourceMappingURL=registry.test.js.map