import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const requireFromHere = createRequire(import.meta.url);

function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
	const checkout = spawnSync("git", ["checkout", "-B", "main"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (checkout.status !== 0) {
		throw new Error(`Failed to create main branch at ${path}`);
	}
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function commitAll(cwd: string, message: string): string {
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			resolveListen();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
	if (!port) {
		throw new Error("Could not allocate a test port.");
	}
	return port;
}

function spawnSourceCli(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	return spawn(process.execPath, ["--import", resolveTsxLoaderImportSpecifier(), cliEntrypoint, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function waitForExit(process: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
	if (process.exitCode !== null) {
		return true;
	}

	return await new Promise<boolean>((resolveExit) => {
		const handleExit = () => {
			clearTimeout(timeoutId);
			resolveExit(true);
		};
		const timeoutId = setTimeout(() => {
			process.removeListener("exit", handleExit);
			resolveExit(false);
		}, timeoutMs);
		process.once("exit", handleExit);
	});
}

async function runCliCommandAndCollectOutput(options: {
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; didExit: boolean }> {
	const process = spawnSourceCli(options.args, {
		cwd: options.cwd,
		env: options.env,
	});

	let stdout = "";
	let stderr = "";
	process.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	process.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	const didExit = await waitForExit(process, options.timeoutMs ?? 20_000);
	if (!didExit) {
		process.kill("SIGKILL");
	}

	return {
		stdout,
		stderr,
		exitCode: process.exitCode,
		didExit,
	};
}

describe.sequential("service process CLI", () => {
	it("starts, reports status, serves task commands, and stops the managed background service", async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-service-home-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-service-project-");
		let port = "3891";

		try {
			initGitRepository(projectPath);
			runGit(projectPath, ["config", "user.name", "Test User"]);
			runGit(projectPath, ["config", "user.email", "test@example.com"]);
			writeFileSync(join(projectPath, "README.md"), "# Service Test\n", "utf8");
			commitAll(projectPath, "init");
			port = String(await getAvailablePort());

			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const started = await runCliCommandAndCollectOutput({
				args: ["start"],
				cwd: projectPath,
				env,
			});
			expect(
				started.didExit,
				`start did not exit in time.\nstdout:\n${started.stdout}\nstderr:\n${started.stderr}`,
			).toBe(true);
			expect(started.exitCode).toBe(0);
			expect(started.stdout).toContain(`Kanban service running at http://127.0.0.1:${port}`);

			const status = await runCliCommandAndCollectOutput({
				args: ["status"],
				cwd: projectPath,
				env,
			});
			expect(status.didExit).toBe(true);
			expect(status.exitCode).toBe(0);
			expect(status.stdout).toContain("Kanban service status: running");
			expect(status.stdout).toContain(`URL: http://127.0.0.1:${port}`);

			const created = await runCliCommandAndCollectOutput({
				args: [
					"task",
					"create",
					"--prompt",
					"Add a service-process regression test card",
					"--project-path",
					projectPath,
				],
				cwd: projectPath,
				env,
			});
			expect(
				created.didExit,
				`task create did not exit in time.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
			).toBe(true);
			expect(created.exitCode).toBe(0);
			expect(created.stdout).toContain('"ok": true');

			const stopped = await runCliCommandAndCollectOutput({
				args: ["stop"],
				cwd: projectPath,
				env,
			});
			expect(stopped.didExit).toBe(true);
			expect(stopped.exitCode).toBe(0);
			expect(stopped.stdout).toContain(`Stopped Kanban service at http://127.0.0.1:${port}`);

			const stoppedStatus = await runCliCommandAndCollectOutput({
				args: ["status"],
				cwd: projectPath,
				env,
			});
			expect(stoppedStatus.didExit).toBe(true);
			expect(stoppedStatus.exitCode).toBe(0);
			expect(stoppedStatus.stdout).toContain("Kanban service is not running.");
		} finally {
			await runCliCommandAndCollectOutput({
				args: ["stop"],
				cwd: projectPath,
				env: createGitTestEnv({
					HOME: homeDir,
					USERPROFILE: homeDir,
					KANBAN_RUNTIME_PORT: port,
				}),
				timeoutMs: 10_000,
			}).catch(() => {});
			cleanupProject();
			cleanupHome();
		}
	}, 90_000);
});
