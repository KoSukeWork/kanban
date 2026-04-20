import { afterEach, describe, expect, it } from "vitest";
import {
	clearKanbanRuntimeTls,
	getKanbanRuntimeHost,
	getKanbanRuntimePort,
	isKanbanRuntimeHttps,
	setKanbanRuntimeHost,
	setKanbanRuntimePort,
} from "../../src/core/runtime-endpoint";
import {
	applyKanbanServiceStateToRuntime,
	clearKanbanServiceState,
	createKanbanServiceState,
	loadKanbanServiceState,
	writeKanbanServiceState,
} from "../../src/core/service-state";
import { INTERNAL_TOKEN_ENV } from "../../src/security/passcode-manager";
import { createTempDir } from "../utilities/temp-dir";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalToken = process.env[INTERNAL_TOKEN_ENV];
const originalRuntimeHost = getKanbanRuntimeHost();
const originalRuntimePort = getKanbanRuntimePort();

afterEach(async () => {
	await clearKanbanServiceState().catch(() => {});
	clearKanbanRuntimeTls();
	setKanbanRuntimeHost(originalRuntimeHost);
	setKanbanRuntimePort(originalRuntimePort);
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = originalUserProfile;
	}
	if (originalToken === undefined) {
		delete process.env[INTERNAL_TOKEN_ENV];
	} else {
		process.env[INTERNAL_TOKEN_ENV] = originalToken;
	}
});

describe("service-state", () => {
	it("writes and reloads the persisted service state", async () => {
		const { path: homeDir, cleanup } = createTempDir("kanban-service-state-home-");

		try {
			process.env.HOME = homeDir;
			process.env.USERPROFILE = homeDir;

			const state = createKanbanServiceState({
				pid: 4242,
				host: "127.0.0.1",
				port: 3900,
				tls: null,
				internalAuthToken: "token-123",
				cwd: "C:/repo",
				skipShutdownCleanup: true,
				certPath: null,
				keyPath: null,
				noPasscode: true,
			});

			await writeKanbanServiceState(state);
			const loaded = await loadKanbanServiceState();

			expect(loaded).toMatchObject({
				pid: 4242,
				host: "127.0.0.1",
				port: 3900,
				https: false,
				internalAuthToken: "token-123",
				cwd: "C:/repo",
				skipShutdownCleanup: true,
				noPasscode: true,
			});
		} finally {
			cleanup();
		}
	});

	it("applies persisted endpoint settings and internal auth token to the current process", () => {
		const state = createKanbanServiceState({
			pid: 111,
			host: "localhost",
			port: 9443,
			tls: {
				cert: "cert",
				key: "key",
				ca: "ca-cert",
			},
			internalAuthToken: "persisted-token",
			cwd: "C:/repo",
			skipShutdownCleanup: false,
			certPath: "C:/tls/cert.pem",
			keyPath: "C:/tls/key.pem",
			noPasscode: false,
		});

		applyKanbanServiceStateToRuntime(state);

		expect(getKanbanRuntimeHost()).toBe("localhost");
		expect(getKanbanRuntimePort()).toBe(9443);
		expect(isKanbanRuntimeHttps()).toBe(true);
		expect(process.env[INTERNAL_TOKEN_ENV]).toBe("persisted-token");
	});
});
