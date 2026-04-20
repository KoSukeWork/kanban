import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { lockedFileSystem } from "../fs/locked-file-system";
import { INTERNAL_TOKEN_ENV } from "../security/passcode-manager";
import {
	type RuntimeTlsConfig,
	resetKanbanRuntimeFetchCache,
	setKanbanRuntimeHost,
	setKanbanRuntimeHttpsState,
	setKanbanRuntimePort,
} from "./runtime-endpoint";

const SERVICE_STATE_FILENAME = "service-process.json";
const SERVICE_STARTUP_ERROR_FILENAME = "service-process.startup-error.json";
const SERVICE_STATE_VERSION = 1;

const kanbanServiceStateSchema = z.object({
	version: z.literal(SERVICE_STATE_VERSION),
	pid: z.number().int().positive(),
	host: z.string().min(1),
	port: z.number().int().min(1).max(65535),
	https: z.boolean(),
	tlsCa: z.string().nullable(),
	internalAuthToken: z.string().min(1),
	startedAt: z.number(),
	cwd: z.string().min(1),
	skipShutdownCleanup: z.boolean(),
	certPath: z.string().nullable(),
	keyPath: z.string().nullable(),
	noPasscode: z.boolean(),
});

const kanbanServiceStartupErrorSchema = z.object({
	version: z.literal(SERVICE_STATE_VERSION),
	message: z.string().min(1),
	createdAt: z.number(),
});

export type KanbanServiceState = z.infer<typeof kanbanServiceStateSchema>;
export type KanbanServiceStartupError = z.infer<typeof kanbanServiceStartupErrorSchema>;

interface RuntimeHomeProvider {
	getRuntimeHomePath: () => string;
}

function defaultRuntimeHomeProvider(): RuntimeHomeProvider {
	return {
		getRuntimeHomePath: () => join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".cline", "kanban"),
	};
}

function getRuntimeHomePath(provider?: RuntimeHomeProvider): string {
	return (provider ?? defaultRuntimeHomeProvider()).getRuntimeHomePath();
}

function parseJsonFile<T>(filePath: string, raw: string, schema: z.ZodType<T>): T {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Malformed JSON in ${filePath}. ${message}`);
	}
	const result = schema.safeParse(parsed);
	if (!result.success) {
		const details = result.error.issues
			.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid JSON in ${filePath}. ${details}`);
	}
	return result.data;
}

async function readOptionalJsonFile<T>(filePath: string, schema: z.ZodType<T>): Promise<T | null> {
	try {
		const raw = await readFile(filePath, "utf8");
		return parseJsonFile(filePath, raw, schema);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

export function getKanbanServiceStatePath(provider?: RuntimeHomeProvider): string {
	return join(getRuntimeHomePath(provider), SERVICE_STATE_FILENAME);
}

export function getKanbanServiceStartupErrorPath(provider?: RuntimeHomeProvider): string {
	return join(getRuntimeHomePath(provider), SERVICE_STARTUP_ERROR_FILENAME);
}

export async function loadKanbanServiceState(provider?: RuntimeHomeProvider): Promise<KanbanServiceState | null> {
	return await readOptionalJsonFile(getKanbanServiceStatePath(provider), kanbanServiceStateSchema);
}

export async function writeKanbanServiceState(
	state: Omit<KanbanServiceState, "version">,
	provider?: RuntimeHomeProvider,
): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(
		getKanbanServiceStatePath(provider),
		{
			version: SERVICE_STATE_VERSION,
			...state,
		} satisfies KanbanServiceState,
		{
			lock: null,
		},
	);
}

export async function clearKanbanServiceState(
	options: { onlyIfPid?: number; provider?: RuntimeHomeProvider } = {},
): Promise<void> {
	const provider = options.provider;
	const path = getKanbanServiceStatePath(provider);
	if (typeof options.onlyIfPid === "number") {
		const current = await loadKanbanServiceState(provider);
		if (!current || current.pid !== options.onlyIfPid) {
			return;
		}
	}
	await rm(path, {
		force: true,
	});
}

export async function loadKanbanServiceStartupError(
	provider?: RuntimeHomeProvider,
): Promise<KanbanServiceStartupError | null> {
	return await readOptionalJsonFile(getKanbanServiceStartupErrorPath(provider), kanbanServiceStartupErrorSchema);
}

export async function writeKanbanServiceStartupError(message: string, provider?: RuntimeHomeProvider): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(
		getKanbanServiceStartupErrorPath(provider),
		{
			version: SERVICE_STATE_VERSION,
			message,
			createdAt: Date.now(),
		} satisfies KanbanServiceStartupError,
		{
			lock: null,
		},
	);
}

export async function clearKanbanServiceStartupError(provider?: RuntimeHomeProvider): Promise<void> {
	const path = getKanbanServiceStartupErrorPath(provider);
	await rm(path, {
		force: true,
	});
}

export function applyKanbanServiceStateToRuntime(state: KanbanServiceState): void {
	setKanbanRuntimeHost(state.host);
	setKanbanRuntimePort(state.port);
	setKanbanRuntimeHttpsState({
		enabled: state.https,
		ca: state.tlsCa,
	});
	process.env[INTERNAL_TOKEN_ENV] = state.internalAuthToken;
	resetKanbanRuntimeFetchCache();
}

export function createKanbanServiceState(input: {
	pid: number;
	host: string;
	port: number;
	tls: RuntimeTlsConfig | null;
	internalAuthToken: string;
	cwd: string;
	skipShutdownCleanup: boolean;
	certPath: string | null;
	keyPath: string | null;
	noPasscode: boolean;
}): KanbanServiceState {
	return {
		version: SERVICE_STATE_VERSION,
		pid: input.pid,
		host: input.host,
		port: input.port,
		https: input.tls !== null,
		tlsCa: input.tls?.ca?.trim() || null,
		internalAuthToken: input.internalAuthToken,
		startedAt: Date.now(),
		cwd: input.cwd,
		skipShutdownCleanup: input.skipShutdownCleanup,
		certPath: input.certPath,
		keyPath: input.keyPath,
		noPasscode: input.noPasscode,
	};
}
