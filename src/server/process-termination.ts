import treeKill from "tree-kill";

interface TimeoutTerminatedChildProcess {
	pid?: number;
	kill: (signal?: NodeJS.Signals | number) => boolean;
}

type KillProcessTree = (pid: number, signal?: string, callback?: (error?: Error) => void) => void;

interface TerminateProcessForTimeoutOptions {
	platform?: NodeJS.Platform;
	killProcessTree?: KillProcessTree;
}

export function terminateProcessForTimeout(
	child: TimeoutTerminatedChildProcess,
	options: TerminateProcessForTimeoutOptions = {},
): void {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") {
		child.kill();
		const pid = typeof child.pid === "number" ? child.pid : 0;
		if (pid > 0) {
			try {
				(options.killProcessTree ?? treeKill)(pid, "SIGTERM", () => {
					// Best effort only.
				});
			} catch {
				// Best effort only.
			}
		}
		return;
	}

	child.kill("SIGTERM");
}

type KillByPid = (pid: number, signal?: NodeJS.Signals | number) => boolean;

export function isProcessRunning(pid: number, killByPid: KillByPid = process.kill.bind(process)): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		killByPid(pid, 0);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error) {
			const code = (error as { code?: unknown }).code;
			if (code === "EPERM") {
				return true;
			}
			if (code === "ESRCH") {
				return false;
			}
		}
		return false;
	}
}

export function terminateProcessId(
	pid: number,
	options: TerminateProcessForTimeoutOptions & { killByPid?: KillByPid } = {},
): void {
	if (!Number.isInteger(pid) || pid <= 0) {
		return;
	}

	const platform = options.platform ?? process.platform;
	const killByPid = options.killByPid ?? process.kill.bind(process);

	if (platform === "win32") {
		try {
			killByPid(pid);
		} catch {
			// Best effort only.
		}
		try {
			(options.killProcessTree ?? treeKill)(pid, "SIGTERM", () => {
				// Best effort only.
			});
		} catch {
			// Best effort only.
		}
		return;
	}

	try {
		killByPid(pid, "SIGTERM");
	} catch {
		// Best effort only.
	}
}
