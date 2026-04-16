import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCodexWrapperChildArgs, buildCodexWrapperSpawn } from "../../src/commands/hooks";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories) {
		rmSync(directory, { recursive: true, force: true });
	}
	tempDirectories.length = 0;
});

describe("buildCodexWrapperChildArgs", () => {
	it("injects notify config", () => {
		const args = buildCodexWrapperChildArgs(["exec", "fix the bug"]);

		expect(args[0]).toBe("-c");
		expect(args[1]).toContain("notify=");
		expect(args[1]).toContain("hooks");
		expect(args[1]).toContain("to_review");
		expect(args.slice(2)).toEqual(["exec", "fix the bug"]);
	});

	it("does not override an explicit notify config", () => {
		expect(buildCodexWrapperChildArgs(["-c", 'notify=["echo","custom"]', "exec", "fix the bug"])).toEqual([
			"-c",
			'notify=["echo","custom"]',
			"exec",
			"fix the bug",
		]);
	});

	it("uses ComSpec on Windows for npm shim binaries", () => {
		const launch = buildCodexWrapperSpawn("codex", ["exec", "fix the bug"], "win32", {
			ComSpec: "C:\\Windows\\System32\\cmd.exe",
		});

		expect(launch.binary).toBe("C:\\Windows\\System32\\cmd.exe");
		expect(launch.args[0]).toBe("/d");
		expect(launch.args[1]).toBe("/s");
		expect(launch.args[2]).toBe("/c");
		expect(launch.args[3]).toContain("codex");
		expect(launch.args[3]).toContain("exec");
		expect(launch.windowsVerbatimArguments).toBe(true);
	});

	it("does not wrap cmd itself on Windows and still applies notify fallback args", () => {
		const launch = buildCodexWrapperSpawn("cmd.exe", ["/c", "echo hi"], "win32", {
			ComSpec: "C:\\Windows\\System32\\cmd.exe",
		});

		expect(launch.binary).toBe("cmd.exe");
		expect(launch.args[0]).toBe("-c");
		expect(launch.args[1]).toContain("notify=");
		expect(launch.args.slice(2)).toEqual(["/c", "echo hi"]);
		expect(launch.windowsVerbatimArguments).toBeUndefined();
	});

	it.skipIf(process.platform !== "win32")("launches npm cmd shims without quote mangling", () => {
		const shimDirectory = mkdtempSync(join(tmpdir(), "kanban-codex-wrapper-"));
		tempDirectories.push(shimDirectory);
		writeFileSync(join(shimDirectory, "codex.cmd"), "@echo off\r\necho fake-codex-ok\r\nexit /b 0\r\n");

		const env: NodeJS.ProcessEnv = {
			...process.env,
			ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe",
			PATH: `${shimDirectory};${process.env.PATH ?? ""}`,
			PATHEXT: ".COM;.EXE;.BAT;.CMD",
		};
		const launch = buildCodexWrapperSpawn("codex", ["--version"], "win32", env);
		const result = spawnSync(launch.binary, launch.args, {
			encoding: "utf8",
			env,
			windowsVerbatimArguments: launch.windowsVerbatimArguments,
		});

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("fake-codex-ok");
		expect(result.stderr).toBe("");
	});
});
