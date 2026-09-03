"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegistryStore = void 0;
exports.normalizeRegistration = normalizeRegistration;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const MAX_NAME_LENGTH = 80;
function normalizeRegistration(value) {
    if (!value || typeof value !== 'object') {
        throw new Error('Registration must be an object.');
    }
    const input = value;
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!WORKSPACE_ID.test(id)) {
        throw new Error('Workspace id must use 1–80 letters, numbers, hyphens, or underscores.');
    }
    const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) {
        throw new Error('Workspace name must contain 1–80 characters.');
    }
    if (typeof input.boardUrl !== 'string') {
        throw new Error('Board URL is required.');
    }
    let url;
    try {
        url = new URL(input.boardUrl);
    }
    catch {
        throw new Error('Board URL must be absolute.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
        throw new Error('Board URL must be a credential-free absolute HTTP(S) URL.');
    }
    url.search = '';
    url.hash = '';
    return { id, name, boardUrl: url.toString().replace(/\/$/, '') };
}
/** Durable JSON-backed registry storing only sanitized workspace discovery metadata. */
class RegistryStore {
    dataFile;
    now;
    document = { version: 1, workspaces: [] };
    loaded = false;
    mutationTail = Promise.resolve();
    constructor(dataFile, now = () => new Date()) {
        this.dataFile = dataFile;
        this.now = now;
    }
    async load() {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        try {
            const parsed = JSON.parse(await (0, promises_1.readFile)(this.dataFile, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.workspaces)) {
                return;
            }
            this.document.workspaces = parsed.workspaces.flatMap((record) => {
                try {
                    const normalized = normalizeRegistration(record);
                    return typeof record.lastSeenAt === 'string' && !Number.isNaN(Date.parse(record.lastSeenAt))
                        ? [{ ...normalized, lastSeenAt: record.lastSeenAt }] : [];
                }
                catch {
                    return [];
                }
            });
        }
        catch { /* First start or corrupt data starts with an empty, safe registry. */ }
    }
    async persist() {
        await (0, promises_1.mkdir)((0, node_path_1.dirname)(this.dataFile), { recursive: true });
        const temporary = `${this.dataFile}.tmp`;
        await (0, promises_1.writeFile)(temporary, `${JSON.stringify(this.document, null, 2)}\n`, 'utf8');
        await (0, promises_1.rename)(temporary, this.dataFile);
    }
    async mutate(operation) {
        const previous = this.mutationTail;
        let release;
        this.mutationTail = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await this.load();
            await operation();
            await this.persist();
        }
        finally {
            release();
        }
    }
    async upsert(value) {
        const registration = normalizeRegistration(value);
        await this.mutate(async () => {
            const record = { ...registration, lastSeenAt: this.now().toISOString() };
            const index = this.document.workspaces.findIndex((candidate) => candidate.id === record.id);
            if (index >= 0) {
                this.document.workspaces[index] = record;
            }
            else {
                this.document.workspaces.push(record);
            }
        });
    }
    async remove(id) {
        if (!WORKSPACE_ID.test(id)) {
            throw new Error('Workspace id is invalid.');
        }
        let removed = false;
        await this.mutate(async () => {
            const before = this.document.workspaces.length;
            this.document.workspaces = this.document.workspaces.filter((candidate) => candidate.id !== id);
            removed = before !== this.document.workspaces.length;
        });
        return removed;
    }
    async list(ttlMs) {
        await this.load();
        const threshold = this.now().getTime() - ttlMs;
        return this.document.workspaces
            .filter((record) => Date.parse(record.lastSeenAt) >= threshold)
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(({ id, name, boardUrl }) => ({ id, name, boardUrl, available: true }));
    }
}
exports.RegistryStore = RegistryStore;
//# sourceMappingURL=registryStore.js.map