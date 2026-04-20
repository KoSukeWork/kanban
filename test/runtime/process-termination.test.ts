import { describe, expect, it, vi } from "vitest";

import { isProcessRunning, terminateProcessForTimeout, terminateProcessId } from "../../src/server/process-termination";

describe("terminateProcessForTimeout", () => {
	it("uses SIGTERM on non-windows platforms", () => {
		const kill = vi.fn(() => true);
		const killProcessTree = vi.fn();

		terminateProcessForTimeout(
			{
				pid: 123,
				kill,
			},
			{
				platform: "linux",
				killProcessTree,
			},
		);

		expect(kill).toHaveBeenCalledWith("SIGTERM");
		expect(killProcessTree).not.toHaveBeenCalled();
	});

	it("uses default kill and taskkill tree on windows", () => {
		const kill = vi.fn(() => true);
		const killProcessTree = vi.fn();

		terminateProcessForTimeout(
			{
				pid: 456,
				kill,
			},
			{
				platform: "win32",
				killProcessTree,
			},
		);

		expect(kill).toHaveBeenCalledWith();
		expect(killProcessTree).toHaveBeenCalledWith(456, "SIGTERM", expect.any(Function));
	});

	it("skips taskkill tree when pid is missing on windows", () => {
		const kill = vi.fn(() => true);
		const killProcessTree = vi.fn();

		terminateProcessForTimeout(
			{
				kill,
			},
			{
				platform: "win32",
				killProcessTree,
			},
		);

		expect(kill).toHaveBeenCalledWith();
		expect(killProcessTree).not.toHaveBeenCalled();
	});
});

describe("isProcessRunning", () => {
	it("returns true when kill(pid, 0) succeeds", () => {
		const killByPid = vi.fn(() => true);
		expect(isProcessRunning(123, killByPid)).toBe(true);
		expect(killByPid).toHaveBeenCalledWith(123, 0);
	});

	it("returns false when the process no longer exists", () => {
		const killByPid = vi.fn(() => {
			const error = new Error("missing") as NodeJS.ErrnoException;
			error.code = "ESRCH";
			throw error;
		});
		expect(isProcessRunning(123, killByPid)).toBe(false);
	});

	it("treats EPERM as a running process", () => {
		const killByPid = vi.fn(() => {
			const error = new Error("denied") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		expect(isProcessRunning(123, killByPid)).toBe(true);
	});
});

describe("terminateProcessId", () => {
	it("uses SIGTERM for pid shutdown on non-windows platforms", () => {
		const killByPid = vi.fn(() => true);
		const killProcessTree = vi.fn();

		terminateProcessId(123, {
			platform: "linux",
			killByPid,
			killProcessTree,
		});

		expect(killByPid).toHaveBeenCalledWith(123, "SIGTERM");
		expect(killProcessTree).not.toHaveBeenCalled();
	});

	it("uses taskkill tree for pid shutdown on windows", () => {
		const killByPid = vi.fn(() => true);
		const killProcessTree = vi.fn();

		terminateProcessId(456, {
			platform: "win32",
			killByPid,
			killProcessTree,
		});

		expect(killByPid).toHaveBeenCalledWith(456);
		expect(killProcessTree).toHaveBeenCalledWith(456, "SIGTERM", expect.any(Function));
	});
});
