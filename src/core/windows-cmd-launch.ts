import { accessSync, constants } from "node:fs";
import { extname, join } from "node:path";

const WINDOWS_CMD_META_CHARS_REGEXP = /([()\][%!^"`<>&|;, *?])/g;
const WINDOWS_CMD_EXTENSIONS = new Set([".cmd", ".bat"]);
const WINDOWS_DIRECT_EXTENSIONS = new Set([".exe", ".com"]);
const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

export interface ResolvedWindowsBinary {
	path: string;
	extension: string;
}

export interface WindowsLaunchDecision {
	useWindowsShellLaunch: boolean;
	resolvedBinary: ResolvedWindowsBinary | null;
}

// `process.env` behaves case-insensitively on Windows, but once we copy env into a
// plain object for child-process merging we need to preserve that behavior ourselves.
function getWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const directValue = env[key];
	if (typeof directValue === "string") {
		return directValue;
	}

	const normalizedKey = key.toLowerCase();
	for (const [entryKey, entryValue] of Object.entries(env)) {
		if (entryKey.toLowerCase() !== normalizedKey) {
			continue;
		}
		if (typeof entryValue === "string") {
			return entryValue;
		}
	}

	return undefined;
}

function canAccessPath(path: string): boolean {
	try {
		accessSync(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeWindowsPathExtension(extension: string): string {
	if (!extension) {
		return extension;
	}
	return extension.startsWith(".") ? extension : `.${extension}`;
}

function getWindowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
	const configured = getWindowsEnvValue(env, "PATHEXT")
		?.split(";")
		.map((entry) => normalizeWindowsPathExtension(entry.trim()))
		.filter(Boolean);
	if (!configured || configured.length === 0) {
		return DEFAULT_WINDOWS_PATHEXT;
	}
	return configured;
}

export function resolveWindowsBinary(
	binary: string,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedWindowsBinary | null {
	const trimmed = binary.trim();
	if (!trimmed) {
		return null;
	}

	const extension = extname(trimmed);
	const pathExtensions = getWindowsPathExtensions(env);
	const hasDirectorySeparators = trimmed.includes("\\") || trimmed.includes("/");
	if (hasDirectorySeparators) {
		if (extension && canAccessPath(trimmed)) {
			return {
				path: trimmed,
				extension: extension.toLowerCase(),
			};
		}
		if (extension) {
			return null;
		}
		for (const pathExtension of pathExtensions) {
			const candidate = `${trimmed}${pathExtension}`;
			if (canAccessPath(candidate)) {
				return {
					path: candidate,
					extension: pathExtension.toLowerCase(),
				};
			}
		}
		return null;
	}

	const pathEntries = (getWindowsEnvValue(env, "PATH") ?? "")
		.split(";")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (pathEntries.length === 0) {
		return null;
	}

	for (const pathEntry of pathEntries) {
		const candidates = extension ? [trimmed] : pathExtensions.map((pathExtension) => `${trimmed}${pathExtension}`);
		for (const candidateName of candidates) {
			const candidate = join(pathEntry, candidateName);
			if (canAccessPath(candidate)) {
				return {
					path: candidate,
					extension: extname(candidate).toLowerCase(),
				};
			}
		}
	}
	return null;
}

function normalizeWindowsCmdArgument(value: string): string {
	return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\n", "\\n");
}

function escapeWindowsCommand(value: string): string {
	return value.replace(WINDOWS_CMD_META_CHARS_REGEXP, "^$1");
}

function escapeWindowsArgument(value: string): string {
	let escaped = normalizeWindowsCmdArgument(`${value}`);
	escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
	escaped = escaped.replace(/(?=(\\+?)?)\1$/g, "$1$1");
	escaped = `"${escaped}"`;
	escaped = escaped.replace(WINDOWS_CMD_META_CHARS_REGEXP, "^$1");
	return escaped;
}

export function resolveWindowsComSpec(env: NodeJS.ProcessEnv = process.env): string {
	const comSpec = getWindowsEnvValue(env, "ComSpec")?.trim();
	return comSpec || "cmd.exe";
}

export function buildWindowsCmdArgsCommandLine(binary: string, args: string[]): string {
	const escapedCommand = escapeWindowsCommand(binary);
	const escapedArgs = args.map((part) => escapeWindowsArgument(part));
	const shellCommand = [escapedCommand, ...escapedArgs].join(" ");
	return `/d /s /c "${shellCommand}"`;
}

export function buildWindowsCmdArgsArray(binary: string, args: string[]): string[] {
	const escapedCommand = escapeWindowsCommand(binary);
	const escapedArgs = args.map((part) => escapeWindowsArgument(part));
	const shellCommand = [escapedCommand, ...escapedArgs].join(" ");
	return ["/d", "/s", "/c", `"${shellCommand}"`];
}

export function resolveWindowsLaunchDecision(
	binary: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): WindowsLaunchDecision {
	if (platform !== "win32") {
		return {
			useWindowsShellLaunch: false,
			resolvedBinary: null,
		};
	}

	const normalized = binary.trim().toLowerCase();
	if (!normalized) {
		return {
			useWindowsShellLaunch: false,
			resolvedBinary: null,
		};
	}
	if (normalized === "cmd" || normalized === "cmd.exe") {
		return {
			useWindowsShellLaunch: false,
			resolvedBinary: null,
		};
	}
	if (normalized === resolveWindowsComSpec(env).toLowerCase()) {
		return {
			useWindowsShellLaunch: false,
			resolvedBinary: null,
		};
	}

	const explicitExtension = extname(normalized).toLowerCase();
	if (WINDOWS_CMD_EXTENSIONS.has(explicitExtension)) {
		return {
			useWindowsShellLaunch: true,
			resolvedBinary: null,
		};
	}
	if (WINDOWS_DIRECT_EXTENSIONS.has(explicitExtension)) {
		return {
			useWindowsShellLaunch: false,
			resolvedBinary: null,
		};
	}

	const resolvedBinary = resolveWindowsBinary(binary, env);
	if (resolvedBinary && WINDOWS_DIRECT_EXTENSIONS.has(resolvedBinary.extension)) {
		return {
			useWindowsShellLaunch: false,
			resolvedBinary,
		};
	}
	if (resolvedBinary && WINDOWS_CMD_EXTENSIONS.has(resolvedBinary.extension)) {
		return {
			useWindowsShellLaunch: true,
			resolvedBinary: null,
		};
	}

	return {
		useWindowsShellLaunch: true,
		resolvedBinary: null,
	};
}

export function shouldUseWindowsCmdLaunch(
	binary: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return resolveWindowsLaunchDecision(binary, platform, env).useWindowsShellLaunch;
}
