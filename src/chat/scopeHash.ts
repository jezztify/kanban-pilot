import { createHash } from 'crypto';

/**
 * Hash of `## Scope` as the refine stage wrote it (§6.3, §6.8 layer 2).
 * Compared against the live scope at develop time — a mismatch means a human
 * edited it after refinement, which is exactly the case the develop prompt
 * needs to be told about explicitly.
 */
export function hashScope(scope: string): string {
	return createHash('sha256').update(scope.trim()).digest('hex').slice(0, 7);
}
