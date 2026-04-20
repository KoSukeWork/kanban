import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import ora, { type Ora } from "ora";
import packageJson from "../package.json" with { type: "json" };
import { disposeCliTelemetryService } from "./cline-sdk/cline-telemetry-service.js";
import { registerHooksCommand } from "./commands/hooks";
import { registerTaskCommand } from "./commands/task";
import { loadGlobalRuntimeConfig, loadRuntimeConfig } from "./config/runtime-config";
import type { RuntimeCommandRunResponse } from "./core/api-contract";
import { createGitProcessEnv } from "./core/git-process-env";
import {
	installGracefulShutdownHandlers,
	shouldSuppressImmediateDuplicateShutdownSignals,
} from "./core/graceful-shutdown";
import { buildKanbanCommandParts } from "./core/kanban-command";
import {
	buildKanbanRuntimeUrl,
	clearKanbanRuntimeTls,
	DEFAULT_KANBAN_RUNTIME_PORT,
	getKanbanRuntimeHost,
	getKanbanRuntimeOrigin,
	getKanbanRuntimePort,
	getKanbanRuntimeTls,
	getRuntimeFetch,
	isKanbanRemoteHost,
	parseRuntimePort,
	setKanbanRuntimeHost,
	setKanbanRuntimePort,
	setKanbanRuntimeTls,
} from "./core/runtime-endpoint";
import {
	applyKanbanServiceStateToRuntime,
	clearKanbanServiceStartupError,
	clearKanbanServiceState,
	createKanbanServiceState,
	type KanbanServiceState,
	loadKanbanServiceStartupError,
	loadKanbanServiceState,
	writeKanbanServiceStartupError,
	writeKanbanServiceState,
} from "./core/service-state";
import {
	disablePasscode,
	generateInternalToken,
	generatePasscode,
	getInternalToken,
} from "./security/passcode-manager";
import { isProcessRunning, terminateProcessForTimeout, terminateProcessId } from "./server/process-termination";
import type { RuntimeStateHub } from "./server/runtime-state-hub";
import { captureNodeException, flushNodeTelemetry } from "./telemetry/sentry-node.js";
import type { TerminalSessionManager } from "./terminal/session-manager";
import { runOnDemandUpdate } from "./update/update";

interface CliOptions {
	noOpen: boolean;
	skipShutdownCleanup: boolean;
	host: string | null;
	port: { mode: "fixed"; value: number } | { mode: "auto" } | null;
	https: boolean;
	cert: string | null;
	key: string | null;
	noPasscode: boolean;
}

const KANBAN_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.1.0";

function parseCliPortValue(rawValue: string): { mode: "fixed"; value: number } | { mode: "auto" } {
	const normalized = rawValue.trim().toLowerCase();
	if (!normalized) {
		throw new Error("Missing value for --port.");
	}
	if (normalized === "auto") {
		return { mode: "auto" };
	}
	try {
		return { mode: "fixed", value: parseRuntimePort(normalized) };
	} catch {
		throw new Error(`Invalid port value: ${rawValue}. Expected an integer from 1-65535 or "auto".`);
	}
}

interface RootCommandOptions {
	host?: string;
	port?: { mode: "fixed"; value: number } | { mode: "auto" };
	open?: boolean;
	skipShutdownCleanup?: boolean;
	update?: boolean;
	https?: boolean;
	cert?: string;
	key?: string;
	noPasscode?: boolean;
}

interface ServiceCommandOptions {
	host?: string;
	port?: { mode: "fixed"; value: number } | { mode: "auto" };
	skipShutdownCleanup?: boolean;
	https?: boolean;
	cert?: string;
	key?: string;
	noPasscode?: boolean;
}

type RuntimeLaunchMode = "foreground" | "service";
type ShutdownIndicatorResult = "done" | "interrupted" | "failed";

interface ShutdownIndicator {
	start: () => void;
	stop: (result?: ShutdownIndicatorResult) => void;
}

interface RuntimeLaunchBehavior {
	mode: RuntimeLaunchMode;
	shouldAutoOpenBrowser: boolean;
}

interface ServiceHealthStatus {
	state: KanbanServiceState | null;
	health: "running" | "stopped" | "unhealthy" | "stale";
	processRunning: boolean;
	reachable: boolean;
	origin: string | null;
}

/**
 * Decide whether this CLI invocation should auto-open a browser tab.
 *
 * This uses a positive allowlist for app-launch shapes like `kanban`,
 * `kanban --agent codex`, and `kanban --port 3484`. Any subcommand or
 * unexpected argument is treated as a command-style invocation instead.
 */
function shouldAutoOpenBrowserTabForInvocation(argv: string[]): boolean {
	const launchFlags = new Set(["--open", "--no-open", "--skip-shutdown-cleanup", "--https", "--no-passcode"]);
	const launchOptionsWithValues = new Set(["--host", "--port", "--agent", "--cert", "--key"]);

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) {
			continue;
		}
		if (!arg.startsWith("-")) {
			return false;
		}
		if (launchFlags.has(arg)) {
			continue;
		}
		const optionName = arg.split("=", 1)[0] ?? arg;
		if (!launchOptionsWithValues.has(optionName)) {
			return false;
		}
		if (arg.includes("=")) {
			continue;
		}
		const optionValue = argv[index + 1];
		if (!optionValue) {
			return false;
		}
		index += 1;
	}

	return true;
}

function isServiceRunInvocation(argv: string[]): boolean {
	return argv[0] === "service-run";
}

function shouldKeepRuntimeProcessAliveAfterParse(argv: string[]): boolean {
	return shouldAutoOpenBrowserTabForInvocation(argv) || isServiceRunInvocation(argv);
}

function normalizeRootCliOptions(options: RootCommandOptions): CliOptions {
	return {
		host: options.host ?? null,
		port: options.port ?? null,
		noOpen: options.open === false,
		skipShutdownCleanup: options.skipShutdownCleanup === true,
		https: options.https === true,
		cert: options.cert ?? null,
		key: options.key ?? null,
		noPasscode: options.noPasscode === true,
	};
}

function normalizeServiceCliOptions(options: ServiceCommandOptions): CliOptions {
	return {
		host: options.host ?? null,
		port: options.port ?? null,
		noOpen: true,
		skipShutdownCleanup: options.skipShutdownCleanup === true,
		https: options.https === true,
		cert: options.cert ?? null,
		key: options.key ?? null,
		noPasscode: options.noPasscode === true,
	};
}

function mergeRestartCliOptions(options: CliOptions, previousState: KanbanServiceState | null): CliOptions {
	if (!previousState) {
		return options;
	}
	const cert = options.cert ?? previousState.certPath;
	const key = options.key ?? previousState.keyPath;
	return {
		...options,
		host: options.host ?? previousState.host,
		port: options.port ?? { mode: "fixed", value: previousState.port },
		https: options.https || previousState.https || cert !== null || key !== null,
		cert,
		key,
		noPasscode: options.noPasscode || previousState.noPasscode,
		skipShutdownCleanup: options.skipShutdownCleanup || previousState.skipShutdownCleanup,
	};
}

async function sleep(delayMs: number): Promise<void> {
	await new Promise<void>((resolveDelay) => {
		setTimeout(resolveDelay, delayMs);
	});
}

function formatTimestamp(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

function createShutdownIndicator(stream: NodeJS.WriteStream = process.stderr): ShutdownIndicator {
	let spinner: Ora | null = null;
	let running = false;

	return {
		start() {
			if (running) {
				return;
			}
			running = true;
			if (!stream.isTTY) {
				stream.write("Cleaning up...\n");
				return;
			}
			spinner = ora({
				text: "Cleaning up...",
				stream,
			}).start();
		},
		stop(result = "done") {
			if (!running) {
				return;
			}
			running = false;
			if (spinner) {
				if (result === "done") {
					spinner.succeed("Cleaning up... done");
				} else if (result === "failed") {
					spinner.fail("Cleaning up... failed");
				} else {
					spinner.warn("Cleaning up... interrupted");
				}
				spinner = null;
				return;
			}

			const suffix = result === "done" ? "done" : result === "interrupted" ? "interrupted" : "failed";
			stream.write(`Cleanup ${suffix}.\n`);
		},
	};
}

async function isPortAvailable(port: number): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const probe = createNetServer();
		probe.once("error", () => {
			resolve(false);
		});
		probe.listen(port, getKanbanRuntimeHost(), () => {
			probe.close(() => {
				resolve(true);
			});
		});
	});
}

async function findAvailableRuntimePort(startPort: number): Promise<number> {
	for (let candidate = startPort; candidate <= 65535; candidate += 1) {
		if (await isPortAvailable(candidate)) {
			return candidate;
		}
	}
	throw new Error("No available runtime port found.");
}

async function applyRuntimePortOption(portOption: CliOptions["port"]): Promise<number | null> {
	if (!portOption) {
		return null;
	}
	if (portOption.mode === "fixed") {
		setKanbanRuntimePort(portOption.value);
		return portOption.value;
	}
	const autoPort = await findAvailableRuntimePort(DEFAULT_KANBAN_RUNTIME_PORT);
	setKanbanRuntimePort(autoPort);
	return autoPort;
}

type TlsResult = { enabled: false } | { enabled: true };

async function resolveRuntimeTls(options: CliOptions): Promise<TlsResult> {
	const wantsHttps = options.https || options.cert !== null || options.key !== null;
	if (!wantsHttps) {
		clearKanbanRuntimeTls();
		return { enabled: false };
	}
	if (!options.cert || !options.key) {
		throw new Error("HTTPS requires both --cert and --key. Use plain HTTP if you do not have a TLS certificate.");
	}
	const cert = readFileSync(resolve(options.cert), "utf8");
	const key = readFileSync(resolve(options.key), "utf8");
	// Trust the exact configured cert for Kanban's own subcommands without
	// disabling certificate validation for unrelated HTTPS endpoints.
	setKanbanRuntimeTls({ cert, key, ca: cert });
	return { enabled: true };
}

async function assertPathIsDirectory(path: string): Promise<void> {
	const info = await stat(path);
	if (!info.isDirectory()) {
		throw new Error(`Project path is not a directory: ${path}`);
	}
}

async function pathIsDirectory(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return info.isDirectory();
	} catch {
		return false;
	}
}

function hasGitRepository(path: string): boolean {
	const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd: path,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: createGitProcessEnv(),
	});
	return result.status === 0 && result.stdout.trim() === "true";
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "EADDRINUSE"
	);
}

async function canReachKanbanServer(workspaceId: string | null): Promise<boolean> {
	try {
		const headers: Record<string, string> = {};
		if (workspaceId) {
			headers["x-kanban-workspace-id"] = workspaceId;
		}
		const runtimeFetch = await getRuntimeFetch();
		const response = await runtimeFetch(buildKanbanRuntimeUrl("/api/trpc/projects.list"), {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(1_500),
		});
		if (response.status === 404) {
			return false;
		}
		const payload = (await response.json().catch(() => null)) as {
			result?: { data?: unknown };
			error?: unknown;
		} | null;
		return Boolean(payload && (payload.result || payload.error));
	} catch {
		return false;
	}
}

async function tryOpenExistingServer(options: { noOpen: boolean; shouldAutoOpenBrowser: boolean }): Promise<boolean> {
	let workspaceId: string | null = null;
	if (hasGitRepository(process.cwd())) {
		const { loadWorkspaceContext } = await import("./state/workspace-state.js");
		const context = await loadWorkspaceContext(process.cwd());
		workspaceId = context.workspaceId;
	}
	const running = await canReachKanbanServer(workspaceId);
	if (!running) {
		return false;
	}
	const projectUrl = workspaceId
		? buildKanbanRuntimeUrl(`/${encodeURIComponent(workspaceId)}`)
		: getKanbanRuntimeOrigin();
	console.log(`Kanban already running at ${getKanbanRuntimeOrigin()}`);
	if (!options.noOpen && options.shouldAutoOpenBrowser) {
		try {
			const { openInBrowser } = await import("./server/browser.js");
			openInBrowser(projectUrl, {
				warn: (message) => {
					console.warn(message);
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`Could not open browser automatically: ${message}`);
		}
	}
	console.log(`Project URL: ${projectUrl}`);
	return true;
}

async function hydrateRuntimeFromManagedServiceIfAvailable(): Promise<void> {
	const state = await loadKanbanServiceState().catch(() => null);
	if (!state) {
		return;
	}
	if (!isProcessRunning(state.pid)) {
		await clearKanbanServiceState({ onlyIfPid: state.pid }).catch(() => {});
		return;
	}
	applyKanbanServiceStateToRuntime(state);
}

async function readServiceHealthStatus(): Promise<ServiceHealthStatus> {
	const state = await loadKanbanServiceState();
	if (!state) {
		return {
			state: null,
			health: "stopped",
			processRunning: false,
			reachable: false,
			origin: null,
		};
	}

	const processRunning = isProcessRunning(state.pid);
	applyKanbanServiceStateToRuntime(state);
	const reachable = processRunning ? await canReachKanbanServer(null) : false;
	return {
		state,
		health: reachable ? "running" : processRunning ? "unhealthy" : "stale",
		processRunning,
		reachable,
		origin: getKanbanRuntimeOrigin(),
	};
}

async function waitForProcessExitByPid(pid: number, timeoutMs: number): Promise<boolean> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (!isProcessRunning(pid)) {
			return true;
		}
		await sleep(100);
	}
	return !isProcessRunning(pid);
}

async function requestManagedServiceShutdown(): Promise<void> {
	const runtimeFetch = await getRuntimeFetch();
	const response = await runtimeFetch(buildKanbanRuntimeUrl("/api/service/shutdown"), {
		method: "POST",
		signal: AbortSignal.timeout(3_000),
	});
	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
		const errorMessage =
			payload && typeof payload.error === "string"
				? payload.error
				: `Shutdown request failed with HTTP ${response.status}.`;
		throw new Error(errorMessage);
	}
}

function ensureServiceModeCanStart(options: CliOptions): void {
	const resolvedHost = options.host?.trim();
	if (resolvedHost) {
		setKanbanRuntimeHost(resolvedHost);
	}
	if (isKanbanRemoteHost() && !options.noPasscode) {
		throw new Error(
			'Background service mode does not support auto-generated remote passcodes. Re-run with "--no-passcode" behind your own auth layer, or launch Kanban in the foreground once to read the generated passcode.',
		);
	}
}

function buildServiceRunArgs(options: CliOptions): string[] {
	const args = ["service-run"];
	if (options.host) {
		args.push("--host", options.host);
	}
	if (options.port) {
		args.push("--port", options.port.mode === "auto" ? "auto" : String(options.port.value));
	}
	if (options.skipShutdownCleanup) {
		args.push("--skip-shutdown-cleanup");
	}
	if (options.https) {
		args.push("--https");
	}
	if (options.cert) {
		args.push("--cert", options.cert);
	}
	if (options.key) {
		args.push("--key", options.key);
	}
	if (options.noPasscode) {
		args.push("--no-passcode");
	}
	return args;
}

async function waitForManagedServiceStartup(pid: number, timeoutMs = 15_000): Promise<KanbanServiceState> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const startupError = await loadKanbanServiceStartupError();
		if (startupError) {
			throw new Error(startupError.message);
		}

		const state = await loadKanbanServiceState().catch(() => null);
		if (state && state.pid === pid) {
			applyKanbanServiceStateToRuntime(state);
			if (await canReachKanbanServer(null)) {
				await clearKanbanServiceStartupError().catch(() => {});
				return state;
			}
		}

		if (!isProcessRunning(pid)) {
			break;
		}

		await sleep(150);
	}

	const startupError = await loadKanbanServiceStartupError();
	if (startupError) {
		throw new Error(startupError.message);
	}

	throw new Error("Background service did not become ready before the startup timeout.");
}

async function startManagedService(options: CliOptions): Promise<KanbanServiceState> {
	ensureServiceModeCanStart(options);

	const currentStatus = await readServiceHealthStatus();
	if (currentStatus.health === "running" && currentStatus.state) {
		return currentStatus.state;
	}
	if (currentStatus.health === "unhealthy" && currentStatus.state) {
		throw new Error(
			`Kanban service process ${currentStatus.state.pid} is already running but not responding at ${currentStatus.origin}. Use "kanban restart" to recover it.`,
		);
	}
	if (currentStatus.state) {
		await clearKanbanServiceState({ onlyIfPid: currentStatus.state.pid }).catch(() => {});
	}

	await clearKanbanServiceStartupError().catch(() => {});

	const commandParts = buildKanbanCommandParts(buildServiceRunArgs(options));
	const child = spawn(commandParts[0], commandParts.slice(1), {
		cwd: process.cwd(),
		env: process.env,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});

	if (typeof child.pid !== "number" || child.pid <= 0) {
		throw new Error("Could not determine the background service process ID.");
	}

	child.unref();
	return await waitForManagedServiceStartup(child.pid);
}

async function stopManagedService(): Promise<{
	result: "already_stopped" | "stopped" | "terminated" | "stale";
	state: KanbanServiceState | null;
	origin: string | null;
}> {
	const status = await readServiceHealthStatus();
	if (!status.state) {
		return {
			result: "already_stopped",
			state: null,
			origin: null,
		};
	}

	if (status.health === "running") {
		try {
			await requestManagedServiceShutdown();
		} catch {
			// Fall through to best-effort termination if graceful shutdown cannot be requested.
		}

		const exited = await waitForProcessExitByPid(status.state.pid, 10_000);
		if (exited) {
			await clearKanbanServiceState({ onlyIfPid: status.state.pid }).catch(() => {});
			return {
				result: "stopped",
				state: status.state,
				origin: status.origin,
			};
		}
	}

	if (status.processRunning) {
		terminateProcessId(status.state.pid);
		const terminated = await waitForProcessExitByPid(status.state.pid, 5_000);
		if (!terminated) {
			throw new Error(`Timed out waiting for service process ${status.state.pid} to stop.`);
		}
		await clearKanbanServiceState({ onlyIfPid: status.state.pid }).catch(() => {});
		return {
			result: "terminated",
			state: status.state,
			origin: status.origin,
		};
	}

	await clearKanbanServiceState({ onlyIfPid: status.state.pid }).catch(() => {});
	return {
		result: "stale",
		state: status.state,
		origin: status.origin,
	};
}

async function runScopedCommand(command: string, cwd: string): Promise<RuntimeCommandRunResponse> {
	const startedAt = Date.now();
	const outputLimitBytes = 64 * 1024;

	return await new Promise<RuntimeCommandRunResponse>((resolve, reject) => {
		const child = spawn(command, {
			cwd,
			shell: true,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (!child.stdout || !child.stderr) {
			reject(new Error("Shortcut process did not expose stdout/stderr."));
			return;
		}

		let stdout = "";
		let stderr = "";

		const appendOutput = (current: string, chunk: string): string => {
			const next = current + chunk;
			if (next.length <= outputLimitBytes) {
				return next;
			}
			return next.slice(0, outputLimitBytes);
		};

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout = appendOutput(stdout, String(chunk));
		});

		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr = appendOutput(stderr, String(chunk));
		});

		child.on("error", (error) => {
			reject(error);
		});

		const timeout = setTimeout(() => {
			terminateProcessForTimeout(child);
		}, 60_000);

		child.on("close", (code) => {
			clearTimeout(timeout);
			const exitCode = typeof code === "number" ? code : 1;
			const combinedOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
			resolve({
				exitCode,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				combinedOutput,
				durationMs: Date.now() - startedAt,
			});
		});
	});
}

async function startServer(): Promise<{
	url: string;
	close: () => Promise<void>;
	shutdown: (options?: { skipSessionCleanup?: boolean }) => Promise<void>;
	setShutdownRequestHandler: (handler: (() => void) | null) => void;
}> {
	/*
		Server-only modules are loaded lazily because task-oriented subcommands like
		`kanban task create` and `kanban hooks ingest` do not need the runtime server.

		A regression in 25ba59f showed that eagerly importing the runtime stack here
		could leave the source CLI process alive after the command had already printed
		its JSON result. The issue first appeared after the native Cline SDK runtime
		was added to the server import graph. We have not yet isolated the deepest
		handle creator inside that graph, so we keep command-style subcommands on the
		lightweight path and only load the server stack when we actually start Kanban.
	*/
	const [
		{ resolveProjectInputPath },
		{ pickDirectoryPathFromSystemDialog },
		{ createRuntimeServer },
		{ createRuntimeStateHub },
		{ resolveInteractiveShellCommand },
		{ shutdownRuntimeServer },
		{ collectProjectWorktreeTaskIdsForRemoval, createWorkspaceRegistry },
	] = await Promise.all([
		import("./projects/project-path.js"),
		import("./server/directory-picker.js"),
		import("./server/runtime-server.js"),
		import("./server/runtime-state-hub.js"),
		import("./server/shell.js"),
		import("./server/shutdown-coordinator.js"),
		import("./server/workspace-registry.js"),
	]);
	let runtimeStateHub: RuntimeStateHub | undefined;
	const workspaceRegistry = await createWorkspaceRegistry({
		cwd: process.cwd(),
		loadGlobalRuntimeConfig,
		loadRuntimeConfig,
		hasGitRepository,
		pathIsDirectory,
		onTerminalManagerReady: (workspaceId, manager) => {
			runtimeStateHub?.trackTerminalManager(workspaceId, manager);
		},
	});
	runtimeStateHub = createRuntimeStateHub({
		workspaceRegistry,
	});
	const runtimeHub = runtimeStateHub;
	for (const { workspaceId, terminalManager } of workspaceRegistry.listManagedWorkspaces()) {
		runtimeHub.trackTerminalManager(workspaceId, terminalManager);
	}

	const disposeTrackedWorkspace = (
		workspaceId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	): { terminalManager: TerminalSessionManager | null; workspacePath: string | null } => {
		const disposed = workspaceRegistry.disposeWorkspace(workspaceId, {
			stopTerminalSessions: options?.stopTerminalSessions,
		});
		runtimeHub.disposeWorkspace(workspaceId);
		return disposed;
	};

	let requestRuntimeShutdown: (() => void) | null = null;

	const runtimeServer = await createRuntimeServer({
		workspaceRegistry,
		runtimeStateHub: runtimeHub,
		warn: (message) => {
			console.warn(`[kanban] ${message}`);
		},
		ensureTerminalManagerForWorkspace: workspaceRegistry.ensureTerminalManagerForWorkspace,
		resolveInteractiveShellCommand,
		runCommand: runScopedCommand,
		resolveProjectInputPath,
		assertPathIsDirectory,
		hasGitRepository,
		disposeWorkspace: disposeTrackedWorkspace,
		collectProjectWorktreeTaskIdsForRemoval,
		pickDirectoryPathFromSystemDialog,
		requestRuntimeShutdown: () => {
			requestRuntimeShutdown?.();
		},
	});

	const close = async () => {
		await runtimeServer.close();
	};

	const shutdown = async (options?: { skipSessionCleanup?: boolean }) => {
		await shutdownRuntimeServer({
			workspaceRegistry,
			warn: (message) => {
				console.warn(`[kanban] ${message}`);
			},
			closeRuntimeServer: close,
			skipSessionCleanup: options?.skipSessionCleanup ?? false,
		});
	};

	return {
		url: runtimeServer.url,
		close,
		shutdown,
		setShutdownRequestHandler: (handler) => {
			requestRuntimeShutdown = handler;
		},
	};
}

async function startServerWithAutoPortRetry(options: CliOptions): Promise<Awaited<ReturnType<typeof startServer>>> {
	if (options.port?.mode !== "auto") {
		return await startServer();
	}

	while (true) {
		try {
			return await startServer();
		} catch (error) {
			if (!isAddressInUseError(error)) {
				throw error;
			}
			const currentPort = getKanbanRuntimePort();
			const retryPort = await findAvailableRuntimePort(currentPort + 1);
			setKanbanRuntimePort(retryPort);
			console.warn(`Runtime port ${currentPort} became busy during startup, retrying on ${retryPort}.`);
		}
	}
}

async function runRuntimeCommand(options: CliOptions, behavior: RuntimeLaunchBehavior): Promise<void> {
	if (options.host) {
		setKanbanRuntimeHost(options.host);
		console.log(`Binding to host ${options.host}.`);
	}
	if (behavior.mode === "service") {
		ensureServiceModeCanStart(options);
	}

	const [{ openInBrowser }, { autoUpdateOnStartup, runPendingAutoUpdateOnShutdown }] = await Promise.all([
		import("./server/browser.js"),
		import("./update/update.js"),
	]);

	const selectedPort = await applyRuntimePortOption(options.port);
	if (selectedPort !== null) {
		console.log(`Using runtime port ${selectedPort}.`);
	}

	const tlsResult = await resolveRuntimeTls(options);
	if (tlsResult.enabled) {
		console.log(`HTTPS enabled on ${getKanbanRuntimeOrigin()}`);
	}

	if (behavior.mode === "service") {
		generateInternalToken();
	}

	// Handle passcode generation for remote mode — deferred until after TLS
	// validation so that an invalid --cert/--key fails before a passcode is
	// printed (a passcode for a server that never starts is confusing).
	if (isKanbanRemoteHost()) {
		if (options.noPasscode) {
			disablePasscode();
			console.log("Passcode authentication disabled (--no-passcode). Ensure you have your own auth layer.");
		} else {
			const passcode = generatePasscode();
			generateInternalToken();
			// NOTE: passcode is printed ONLY here and never stored in logs or env.
			console.log(`\n🔐 Remote access passcode: ${passcode}\n\nShare this with users who need access.\n`);
		}
	}

	autoUpdateOnStartup({
		currentVersion: KANBAN_VERSION,
	});

	let runtime: Awaited<ReturnType<typeof startServer>>;
	try {
		runtime = await startServerWithAutoPortRetry(options);
	} catch (error) {
		if (options.port?.mode !== "auto" && isAddressInUseError(error)) {
			if (behavior.mode === "foreground") {
				if (
					await tryOpenExistingServer({
						noOpen: options.noOpen,
						shouldAutoOpenBrowser: behavior.shouldAutoOpenBrowser,
					})
				) {
					return;
				}
			} else if (await canReachKanbanServer(null)) {
				throw new Error(
					`Kanban is already running at ${getKanbanRuntimeOrigin()} but is not managed by this service state file.`,
				);
			}
		}
		throw error;
	}

	if (behavior.mode === "service") {
		const internalAuthToken = getInternalToken();
		if (!internalAuthToken) {
			await runtime.shutdown({
				skipSessionCleanup: options.skipShutdownCleanup,
			});
			throw new Error("Background service did not initialize an internal auth token.");
		}
		try {
			await writeKanbanServiceState(
				createKanbanServiceState({
					pid: process.pid,
					host: getKanbanRuntimeHost(),
					port: getKanbanRuntimePort(),
					tls: getKanbanRuntimeTls(),
					internalAuthToken,
					cwd: process.cwd(),
					skipShutdownCleanup: options.skipShutdownCleanup,
					certPath: options.cert ? resolve(options.cert) : null,
					keyPath: options.key ? resolve(options.key) : null,
					noPasscode: options.noPasscode,
				}),
			);
			await clearKanbanServiceStartupError().catch(() => {});
		} catch (error) {
			await runtime.shutdown({
				skipSessionCleanup: options.skipShutdownCleanup,
			});
			throw error;
		}
	}

	console.log(`Cline Kanban running at ${runtime.url}`);
	if (behavior.mode === "foreground" && !options.noOpen && behavior.shouldAutoOpenBrowser) {
		try {
			openInBrowser(runtime.url, {
				warn: (message) => {
					console.warn(message);
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`Could not open browser automatically: ${message}`);
		}
	}
	if (behavior.mode === "foreground") {
		console.log("Press Ctrl+C to stop.");
	}

	const shutdownIndicator = createShutdownIndicator();
	let shutdownPromise: Promise<void> | null = null;
	const shutdown = async (): Promise<void> => {
		if (shutdownPromise) {
			await shutdownPromise;
			return;
		}
		shutdownPromise = (async () => {
			runPendingAutoUpdateOnShutdown();
			if (options.skipShutdownCleanup) {
				console.warn("Skipping shutdown task cleanup for this instance.");
			}
			await runtime.shutdown({
				skipSessionCleanup: options.skipShutdownCleanup,
			});
			if (behavior.mode === "service") {
				await clearKanbanServiceState({ onlyIfPid: process.pid }).catch(() => {});
			}
			await disposeCliTelemetryService().catch(() => {});
		})();
		await shutdownPromise;
	};

	const requestProcessShutdown = () => {
		void (async () => {
			shutdownIndicator.start();
			try {
				await shutdown();
				shutdownIndicator.stop("done");
				process.exit(0);
			} catch (error) {
				shutdownIndicator.stop("failed");
				captureNodeException(error, { area: "shutdown" });
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Shutdown failed: ${message}`);
				process.exit(1);
			}
		})();
	};

	runtime.setShutdownRequestHandler(behavior.mode === "service" ? requestProcessShutdown : null);

	installGracefulShutdownHandlers({
		process,
		delayMs: 10000,
		exit: (code) => {
			process.exit(code);
		},
		onShutdown: async () => {
			shutdownIndicator.start();
			try {
				await shutdown();
				shutdownIndicator.stop("done");
			} catch (error) {
				shutdownIndicator.stop("failed");
				throw error;
			}
		},
		onShutdownError: (error) => {
			shutdownIndicator.stop("failed");
			captureNodeException(error, { area: "shutdown" });
			const message = error instanceof Error ? error.message : String(error);
			console.error(`Shutdown failed: ${message}`);
		},
		onTimeout: (delayMs) => {
			shutdownIndicator.stop("interrupted");
			console.error(`Forced exit after shutdown timeout (${delayMs}ms).`);
		},
		onSecondSignal: (signal) => {
			shutdownIndicator.stop("interrupted");
			console.error(`Forced exit on second signal: ${signal}`);
		},
		suppressImmediateDuplicateSignals: shouldSuppressImmediateDuplicateShutdownSignals(),
	});
}

async function runUpdateCommand(): Promise<void> {
	const result = await runOnDemandUpdate({
		currentVersion: KANBAN_VERSION,
	});

	if (result.status === "updated" || result.status === "already_up_to_date" || result.status === "cache_refreshed") {
		console.log(result.message);
		return;
	}

	throw new Error(result.message);
}

function applySharedRuntimeLaunchOptions<T extends Command>(command: T): T {
	return command
		.option("--host <ip>", "Host IP to bind the server to (default: 127.0.0.1).")
		.option("--port <number|auto>", "Runtime port (1-65535) or auto.", parseCliPortValue)
		.option("--skip-shutdown-cleanup", "Do not move sessions to trash or delete task worktrees on shutdown.")
		.option("--https", "Enable HTTPS. Requires both --cert and --key.")
		.option("--cert <path>", "Path to a TLS certificate PEM file (implies HTTPS).")
		.option("--key <path>", "Path to a TLS private key PEM file (implies HTTPS).")
		.option(
			"--no-passcode",
			"Disable auto-generated passcode for remote access (for advanced users behind a reverse proxy).",
		);
}

function createProgram(invocationArgs: string[]): Command {
	const shouldAutoOpenBrowser = shouldAutoOpenBrowserTabForInvocation(invocationArgs);
	const program = new Command();
	applySharedRuntimeLaunchOptions(
		program
			.name("kanban")
			.description("Local orchestration board for coding agents.")
			.version(KANBAN_VERSION, "-v, --version", "Output the version number")
			.option("--no-open", "Do not open browser automatically.")
			.option("--update", "Update Kanban to the latest published version and exit.")
			.showHelpAfterError()
			.addHelpText("after", `\nRuntime URL: ${getKanbanRuntimeOrigin()}`),
	);

	program.addOption(new Option("--agent <id>", "Deprecated compatibility flag. Ignored.").hideHelp());

	registerTaskCommand(program);
	registerHooksCommand(program);

	applySharedRuntimeLaunchOptions(
		program
			.command("start")
			.description("Start Kanban as a managed background service.")
			.action(async (options: ServiceCommandOptions) => {
				const state = await startManagedService(normalizeServiceCliOptions(options));
				const origin = `${state.https ? "https" : "http"}://${state.host}:${state.port}`;
				console.log(`Kanban service running at ${origin}`);
				console.log(`PID: ${state.pid}`);
				console.log(`Started: ${formatTimestamp(state.startedAt)}`);
			}),
	);

	program
		.command("stop")
		.description("Stop the managed Kanban background service.")
		.action(async () => {
			const stopped = await stopManagedService();
			if (stopped.result === "already_stopped") {
				console.log("Kanban service is not running.");
				return;
			}
			if (!stopped.state) {
				console.log("Kanban service is not running.");
				return;
			}
			if (stopped.result === "stopped") {
				console.log(`Stopped Kanban service at ${stopped.origin}`);
				return;
			}
			if (stopped.result === "terminated") {
				console.log(`Terminated unresponsive Kanban service process ${stopped.state.pid}.`);
				return;
			}
			console.log(`Removed stale Kanban service state for process ${stopped.state.pid}.`);
		});

	applySharedRuntimeLaunchOptions(
		program
			.command("restart")
			.description("Restart the managed Kanban background service.")
			.action(async (options: ServiceCommandOptions) => {
				const previousState = await loadKanbanServiceState().catch(() => null);
				await stopManagedService();
				const state = await startManagedService(
					mergeRestartCliOptions(normalizeServiceCliOptions(options), previousState),
				);
				const origin = `${state.https ? "https" : "http"}://${state.host}:${state.port}`;
				console.log(`Kanban service running at ${origin}`);
				console.log(`PID: ${state.pid}`);
				console.log(`Started: ${formatTimestamp(state.startedAt)}`);
			}),
	);

	program
		.command("status")
		.description("Show the managed Kanban background service status.")
		.action(async () => {
			const status = await readServiceHealthStatus();
			if (!status.state) {
				console.log("Kanban service is not running.");
				return;
			}
			console.log(`Kanban service status: ${status.health}`);
			if (status.origin) {
				console.log(`URL: ${status.origin}`);
			}
			console.log(`PID: ${status.state.pid}`);
			console.log(`Started: ${formatTimestamp(status.state.startedAt)}`);
			console.log(`Working directory: ${status.state.cwd}`);
			if (status.health === "unhealthy") {
				console.log(
					'The service process is alive but the runtime endpoint is not responding. Run "kanban restart".',
				);
			}
			if (status.health === "stale") {
				console.log('The recorded process no longer exists. Run "kanban start" or "kanban restart".');
			}
		});

	program
		.command("mcp")
		.description("Deprecated compatibility command.")
		.action(() => {
			console.warn("Deprecated. Please uninstall Kanban MCP.");
		});

	program
		.command("update")
		.description("Update Kanban to the latest published version.")
		.action(async () => {
			await runUpdateCommand();
		});

	applySharedRuntimeLaunchOptions(
		program
			.command("service-run")
			.description("Internal background service entrypoint.")
			.action(async (options: ServiceCommandOptions) => {
				await runRuntimeCommand(normalizeServiceCliOptions(options), {
					mode: "service",
					shouldAutoOpenBrowser: false,
				});
			}),
	);

	program.action(async (options: RootCommandOptions) => {
		if (options.update === true) {
			await runUpdateCommand();
			return;
		}
		await runRuntimeCommand(normalizeRootCliOptions(options), {
			mode: "foreground",
			shouldAutoOpenBrowser,
		});
	});

	return program;
}

async function run(): Promise<void> {
	const argv = process.argv.slice(2);
	await hydrateRuntimeFromManagedServiceIfAvailable();
	const program = createProgram(argv);
	await program.parseAsync(argv, { from: "user" });
	if (!shouldKeepRuntimeProcessAliveAfterParse(argv)) {
		await Promise.allSettled([disposeCliTelemetryService(), flushNodeTelemetry()]);
		process.exitCode = process.exitCode ?? 0;
	}
}

void run().catch(async (error) => {
	if (isServiceRunInvocation(process.argv.slice(2))) {
		const message = error instanceof Error ? error.message : String(error);
		await clearKanbanServiceState({ onlyIfPid: process.pid }).catch(() => {});
		await writeKanbanServiceStartupError(message).catch(() => {});
	}
	captureNodeException(error, { area: "startup" });
	await Promise.allSettled([disposeCliTelemetryService(), flushNodeTelemetry()]);
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Failed to start Kanban: ${message}`);
	process.exit(1);
});
