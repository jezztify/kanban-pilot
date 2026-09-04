import * as vscode from 'vscode';
import type { Task } from '../model/task';
import {
	CompactionOptions,
	CompactionResult,
	Executor,
} from './executor';
import { sessionIdForTaskBinding } from './sessionUri';

/** Copilot's experimental native background-compaction setting. */
export const NATIVE_COMPACTION_ENABLED = 'github.copilot.chat.summarizeAgentConversationHistory.enabled';
/** Copilot's experimental native context-window ratio setting. */
export const NATIVE_COMPACTION_THRESHOLD = 'github.copilot.chat.summarizeAgentConversationHistoryThreshold';

export interface WorkspaceConfigurationInspection<T> {
	key: string;
	defaultValue?: T;
	globalValue?: T;
	workspaceValue?: T;
	workspaceFolderValue?: T;
	defaultLanguageValue?: T;
	globalLanguageValue?: T;
	workspaceLanguageValue?: T;
	workspaceFolderLanguageValue?: T;
}

export interface WorkspaceConfigurationLike {
	get<T>(section: string, defaultValue?: T): T;
	inspect<T>(section: string): WorkspaceConfigurationInspection<T> | undefined;
	update(
		section: string,
		value: unknown,
		configurationTarget?: vscode.ConfigurationTarget | boolean | null,
	): Thenable<void>;
}

export interface ContextCompactionRequest {
	enabled: unknown;
	threshold: unknown;
	mode: string;
	sessionPrefix: string;
}

export interface ContextCompactionEnvironment {
	/** The Copilot version, when the host exposes its extension metadata. */
	copilotVersion?: string;
	/** Test/host override for builds known not to support the experimental setting. */
	nativeSettingsSupported?: boolean;
}

/** Narrow dependency contract used by RunManager so lifecycle tests stay deterministic. */
export interface ContextCompactionAdapter {
	prepare(request: ContextCompactionRequest): Promise<ContextCompactionResult>;
	request(task: Task, request: ContextCompactionRequest): Promise<ContextCompactionResult>;
}

export type ContextCompactionResult =
	| {
			kind: 'disabled';
		}
	| {
			kind: 'invalid';
			reason: 'invalid-threshold';
		}
	| {
			kind: 'ready';
			threshold: number;
			experimental: true;
			copilotVersion?: string;
		}
	| {
			kind: 'unsupported';
			reason:
				| 'native-settings-unavailable'
				| 'experimental-incompatible'
				| 'compact-command-unavailable'
				| 'session-uri-unavailable'
				| 'session-target-unavailable';
			experimental: true;
			copilotVersion?: string;
		}
	| {
			kind: 'unavailable';
			reason:
				| 'configuration-read-failed'
				| 'configuration-update-failed'
				| 'adapter-failed'
				| 'service-disposed';
			experimental: true;
			copilotVersion?: string;
		}
	| {
			kind: 'conflict';
			setting: 'enabled' | 'threshold';
			threshold: number;
			experimental: true;
			copilotVersion?: string;
		}
	| {
			kind: 'duplicate';
			taskSetId: string;
			taskId: string;
			sessionId: string;
		}
	| {
			kind: 'success';
			threshold: number;
			targeting: 'session';
			experimental: true;
			copilotVersion?: string;
		}
	| {
			kind: 'failed';
			reason: 'compact-command-failed';
			message: 'Copilot native compaction failed; task execution remains usable.';
			threshold: number;
			experimental: true;
			copilotVersion?: string;
		};

type ConfigurationFactory = () => WorkspaceConfigurationLike;

interface NativeSettingState<T> {
	registered: boolean;
	effective: T | undefined;
	explicit: T | undefined;
}

const EXPLICIT_VALUE_FIELDS = [
	'workspaceFolderLanguageValue',
	'workspaceLanguageValue',
	'globalLanguageValue',
	'workspaceFolderValue',
	'workspaceValue',
	'globalValue',
] as const;

function explicitValue<T>(inspection: ReturnType<WorkspaceConfigurationLike['inspect']>): T | undefined {
	if (!inspection) {
		return undefined;
	}
	for (const field of EXPLICIT_VALUE_FIELDS) {
		const value = inspection[field] as T | undefined;
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

function validThreshold(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
}

function copilotVersionFromHost(): string | undefined {
	for (const id of ['GitHub.copilot-chat', 'GitHub.copilot']) {
		const extension = vscode.extensions.getExtension(id);
		const version = extension?.packageJSON?.version;
		if (typeof version === 'string' && version.trim()) {
			return version.trim();
		}
	}
	return undefined;
}

/**
 * Configuration and command adapter for Copilot's native compaction.
 *
 * This service deliberately has no transcript, token, hook, or turn counter.
 * Copilot owns the threshold decision. The optional explicit request exists
 * only for a supported task-session target API; it is not used to infer
 * threshold crossings. The current focus-only command is reported unsupported.
 */
export class ContextCompactionService {
	private readonly inFlight = new Map<string, Promise<ContextCompactionResult>>();
	private disposed = false;
	private configurationRevision = 0;

	constructor(
		private readonly executor: Pick<Executor, 'compact'>,
		private readonly configuration: ConfigurationFactory = () => vscode.workspace.getConfiguration(),
		private readonly environment: ContextCompactionEnvironment = {},
	) {}

	get revision(): number {
		return this.configurationRevision;
	}

	/** Invalidates host-side configuration observations without interrupting a run. */
	invalidate(): void {
		this.configurationRevision += 1;
	}

	/**
	 * Applies the non-destructive native-setting policy. Explicit native values
	 * are never overwritten; missing values are written to workspace settings
	 * only after the Kanban opt-in is enabled.
	 */
	async prepare(request: ContextCompactionRequest): Promise<ContextCompactionResult> {
		if (this.disposed) {
			return this.unavailable('service-disposed');
		}
		if (request.enabled !== true) {
			return { kind: 'disabled' };
		}
		if (!validThreshold(request.threshold)) {
			return { kind: 'invalid', reason: 'invalid-threshold' };
		}

		const threshold = request.threshold;
		const copilotVersion = this.environment.copilotVersion ?? copilotVersionFromHost();
		if (this.environment.nativeSettingsSupported === false) {
			return {
				kind: 'unsupported',
				reason: 'experimental-incompatible',
				experimental: true,
				...(copilotVersion ? { copilotVersion } : {}),
			};
		}

		let config: WorkspaceConfigurationLike;
		let enabled: NativeSettingState<boolean>;
		let nativeThreshold: NativeSettingState<number | null>;
		try {
			config = this.configuration();
			enabled = this.settingState(config, NATIVE_COMPACTION_ENABLED);
			nativeThreshold = this.settingState(config, NATIVE_COMPACTION_THRESHOLD);
		} catch {
			return this.unavailable('configuration-read-failed', copilotVersion);
		}
		if (!enabled.registered || !nativeThreshold.registered) {
			return {
				kind: 'unsupported',
				reason: 'native-settings-unavailable',
				experimental: true,
				...(copilotVersion ? { copilotVersion } : {}),
			};
		}
		if (typeof enabled.effective !== 'boolean') {
			return this.unavailable('configuration-read-failed', copilotVersion);
		}
		if (enabled.explicit !== undefined && typeof enabled.explicit !== 'boolean') {
			return this.unavailable('configuration-read-failed', copilotVersion);
		}
		if (nativeThreshold.explicit !== undefined && !validThreshold(nativeThreshold.explicit)) {
			return this.conflict('threshold', threshold, copilotVersion);
		}
		// Copilot declares this optional threshold with no default (and permits
		// null to mean unset). An unset native value is compatible: the Kanban
		// ratio is written below. A non-ratio effective value is either a
		// Copilot absolute-token configuration or a malformed default; do not
		// silently replace it.
		if (
			nativeThreshold.effective !== undefined &&
			nativeThreshold.effective !== null &&
			!validThreshold(nativeThreshold.effective)
		) {
			return this.unavailable('configuration-read-failed', copilotVersion);
		}
		if (enabled.explicit !== undefined && enabled.explicit !== true) {
			return this.conflict('enabled', threshold, copilotVersion);
		}
		if (nativeThreshold.explicit !== undefined && nativeThreshold.explicit !== threshold) {
			return this.conflict('threshold', threshold, copilotVersion);
		}

		const updates: [string, unknown][] = [];
		if (enabled.explicit === undefined && enabled.effective !== true) {
			updates.push([NATIVE_COMPACTION_ENABLED, true]);
		}
		if (nativeThreshold.explicit === undefined && nativeThreshold.effective !== threshold) {
			updates.push([NATIVE_COMPACTION_THRESHOLD, threshold]);
		}
		try {
			for (const [key, value] of updates) {
				await config.update(key, value, vscode.ConfigurationTarget.Workspace);
			}
		} catch {
			return this.unavailable('configuration-update-failed', copilotVersion);
		}
		return {
			kind: 'ready',
			threshold,
			experimental: true,
			...(copilotVersion ? { copilotVersion } : {}),
		};
	}

	/**
	 * Requests one task-bound explicit compaction. Calls for the same
	 * task-set, task, and deterministic local session are deduplicated while the
	 * first request is in flight. Automatic threshold timing remains owned by
	 * Copilot's native background-compaction setting.
	 */
	async request(task: Task, request: ContextCompactionRequest): Promise<ContextCompactionResult> {
		if (this.disposed) {
			return this.unavailable('service-disposed');
		}
		if (request.enabled !== true || !validThreshold(request.threshold)) {
			return this.prepare(request);
		}
		const sessionId = sessionIdForTaskBinding(task, request.sessionPrefix, task.setId);
		const key = `${task.setId}\u0000${task.id}\u0000${sessionId}`;
		const existing = this.inFlight.get(key);
		if (existing) {
			return {
				kind: 'duplicate',
				taskSetId: task.setId,
				taskId: task.id,
				sessionId,
			};
		}

		const operation = (async (): Promise<ContextCompactionResult> => {
			const prepared = await this.prepare(request);
			if (prepared.kind !== 'ready') {
				return prepared;
			}
			if (!this.executor.compact) {
				return {
					kind: 'unsupported',
					reason: 'compact-command-unavailable',
					experimental: true,
					...(prepared.copilotVersion ? { copilotVersion: prepared.copilotVersion } : {}),
				};
			}

			let compacted: CompactionResult;
			try {
				const options: CompactionOptions = {
					mode: request.mode,
					sessionPrefix: request.sessionPrefix,
				};
				compacted = await this.executor.compact(task, options);
			} catch {
				return this.failed(prepared.threshold, prepared.copilotVersion);
			}
			if (compacted.kind === 'success') {
				return {
					kind: 'success',
					threshold: prepared.threshold,
					targeting: compacted.targeting,
					experimental: true,
					...(prepared.copilotVersion ? { copilotVersion: prepared.copilotVersion } : {}),
				};
			}
			if (compacted.kind === 'unsupported') {
				return {
					kind: 'unsupported',
					reason: compacted.diagnostic.code === 'unsupported-chat-session-uri'
						? 'session-uri-unavailable'
						: compacted.diagnostic.code === 'unsupported-compact-session-target'
							? 'session-target-unavailable'
						: 'compact-command-unavailable',
					experimental: true,
					...(prepared.copilotVersion ? { copilotVersion: prepared.copilotVersion } : {}),
				};
			}
			return this.failed(prepared.threshold, prepared.copilotVersion);
		})();
		this.inFlight.set(key, operation);
		try {
			return await operation;
		} finally {
			if (this.inFlight.get(key) === operation) {
				this.inFlight.delete(key);
			}
		}
	}

	/** Synchronizes native settings from the current Kanban configuration. */
	async synchronize(): Promise<ContextCompactionResult> {
		const config = vscode.workspace.getConfiguration('kanbanPilot');
		return this.prepare({
			enabled: config.get<unknown>('chat.autoCompact', false),
			threshold: config.get<unknown>('chat.autoCompactThreshold', 0.8),
			mode: config.get<string>('chat.mode', 'agent'),
			sessionPrefix: config.get<string>('chat.sessionPrefix', 'kanban-pilot-'),
		});
	}

	dispose(): void {
		this.disposed = true;
		this.inFlight.clear();
	}

	private settingState<T>(config: WorkspaceConfigurationLike, key: string): NativeSettingState<T> {
		const inspection = config.inspect<T>(key);
		return {
			registered: inspection !== undefined,
			effective: inspection ? config.get<T>(key, inspection.defaultValue as T) : undefined,
			explicit: explicitValue<T>(inspection),
		};
	}

	private unavailable(
		reason: 'configuration-read-failed' | 'configuration-update-failed' | 'adapter-failed' | 'service-disposed',
		copilotVersion = this.environment.copilotVersion ?? copilotVersionFromHost(),
	): ContextCompactionResult {
		return {
			kind: 'unavailable',
			reason,
			experimental: true,
			...(copilotVersion ? { copilotVersion } : {}),
		};
	}

	private conflict(
		setting: 'enabled' | 'threshold',
		threshold: number,
		copilotVersion = this.environment.copilotVersion ?? copilotVersionFromHost(),
	): ContextCompactionResult {
		return {
			kind: 'conflict',
			setting,
			threshold,
			experimental: true,
			...(copilotVersion ? { copilotVersion } : {}),
		};
	}

	private failed(
		threshold: number,
		copilotVersion = this.environment.copilotVersion ?? copilotVersionFromHost(),
	): ContextCompactionResult {
		return {
			kind: 'failed',
			reason: 'compact-command-failed',
			message: 'Copilot native compaction failed; task execution remains usable.',
			threshold,
			experimental: true,
			...(copilotVersion ? { copilotVersion } : {}),
		};
	}
}
