import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import notifyExtension, { _resetCache } from "../extensions/notify.ts";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

type SubagentEnv = {
	PI_PDD_SUBAGENT?: string;
	PI_SUBAGENT_RUNTIME_ID?: string;
	PI_SUBAGENT_RUNTIME_DEPTH?: string;
};

// --- fake binaries: one dir per backend so PATH is controlled per test ---

const originalPATH = process.env.PATH ?? "";

function makeBinDir(name: string, scriptBody: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-notify-${name}-`));
	const binPath = join(dir, name);
	writeFileSync(binPath, `#!/usr/bin/env bash\n${scriptBody}\n`);
	chmodSync(binPath, 0o755);
	return dir;
}

const logPath = join(mkdtempSync(join(tmpdir(), "pi-notify-log-")), "notify.log");
writeFileSync(logPath, "");

function logScript(cmdName: string): string {
	const log = JSON.stringify(logPath);
	const lines = [
		cmdName ? `printf '%s ' ${JSON.stringify(cmdName)} >> ${log}` : "",
		`printf '%q ' "$@" >> ${log}`,
		`printf '\\n' >> ${log}`,
		"exit 0",
	].filter(Boolean);
	return lines.join("\n");
}

// distrobox-host-exec logs its own args (first arg will be "notify-send")
const distroboxDir = makeBinDir("distrobox-host-exec", logScript(""));
// osascript logs itself with prefix
const macosDir = makeBinDir("osascript", logScript("osascript "));
// powershell.exe logs itself with prefix
const wslDir = makeBinDir("powershell.exe", logScript("powershell.exe "));

// --- handler registration (handlers are platform-agnostic) ---

const handlers = new Map<string, Handler[]>();
notifyExtension({
	on(event: string, handler: Handler) {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	},
} as any);

// --- helpers ---

function resetLog(): void {
	writeFileSync(logPath, "");
}

function readLog(): string {
	return readFileSync(logPath, "utf8");
}

function countLines(log: string, prefix: string): number {
	return log
		.trim()
		.split("\n")
		.filter((line) => line.startsWith(prefix)).length;
}

async function waitForLines(prefix: string, expectedCount: number, timeoutMs = 1_500): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let log = readLog();
	while (countLines(log, prefix) < expectedCount && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		log = readLog();
	}
	return log;
}

async function waitForQuiet(settleMs = 150): Promise<string> {
	await new Promise((resolve) => setTimeout(resolve, settleMs));
	return readLog();
}

async function emitToolCalls(): Promise<void> {
	for (const handler of handlers.get("tool_call") ?? []) {
		await handler(
			{ toolName: "ask_user_question", input: { questions: [{ question: "Continue?", header: "Next" }] } },
			{ cwd: "/tmp/project" },
		);
		await handler(
			{ toolName: "ask_user_permission", input: { question: "Allow edit?" } },
			{ cwd: "/tmp/project" },
		);
		await handler(
			{ toolName: "bash", input: { command: "echo noisy" } },
			{ cwd: "/tmp/project" },
		);
	}
}

async function emitAgentEnd(): Promise<void> {
	for (const handler of handlers.get("agent_end") ?? []) {
		await handler(
			{ messages: [{ role: "assistant", content: [{ type: "text", text: "finished" }] }] },
			{ cwd: "/tmp/project" },
		);
	}
}

function setSubagentEnv(env: SubagentEnv): void {
	for (const key of ["PI_PDD_SUBAGENT", "PI_SUBAGENT_RUNTIME_ID", "PI_SUBAGENT_RUNTIME_DEPTH"] as const) {
		const value = env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function setBackend(backend: "distrobox" | "macos" | "wsl"): void {
	// clear all backend env
	delete process.env.container;
	delete process.env.DISTROBOX_ENTER_PATH;
	delete process.env.DISTROBOX_HOST_HOME;
	delete process.env.WSL_DISTRO_NAME;
	delete process.env.WSL_INTEROP;
	delete process.env.KITTY_PID;
	delete process.env.KITTY_WINDOW_ID;
	delete process.env._NOTIFY_PLATFORM;

	if (backend === "distrobox") {
		process.env.container = "podman";
		process.env.KITTY_PID = "12345";
		process.env.PATH = `${distroboxDir}:${originalPATH}`;
	} else if (backend === "macos") {
		// isMacOS() checks _NOTIFY_PLATFORM so platform-specific branches work without relying on PATH tricks.
		process.env._NOTIFY_PLATFORM = "darwin";
		process.env.PATH = `${macosDir}:${originalPATH}`;
	} else if (backend === "wsl") {
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		process.env.PATH = `${wslDir}:${originalPATH}`;
	}

	_resetCache();
}

// --- tests ---

async function testDistroboxLinuxBackend(): Promise<void> {
	setBackend("distrobox");
	resetLog();
	setSubagentEnv({});

	await emitToolCalls();
	await emitAgentEnd();

	const log = await waitForLines("notify-send -a Pi", 3);
	const lines = log.trim().split("\n").filter((l) => l.startsWith("notify-send -a Pi"));
	assert.equal(lines.length, 3, "distrobox: question + permission + done should notify");
	assert.match(log, /-u normal/, "distrobox: urgency must be normal");
	assert.doesNotMatch(log, /-u critical/, "distrobox: must not be critical");
	assert.match(log, /-e/, "distrobox: must be transient");
	assert.match(log, /-t 8000(\s|$)/, "distrobox: must auto-dismiss after 8s");
	assert.match(log, /Pi\\ question/, "distrobox: ask_user_question triggers question notification");
	assert.match(log, /Pi\\ permission/, "distrobox: permission prompt triggers permission notification");
	assert.match(log, /Pi\\ done/, "distrobox: agent_end triggers done notification");
	assert.doesNotMatch(log, /finished/, "distrobox: agent text must not appear");
	assert.doesNotMatch(log, /bash/, "distrobox: plain tool calls must not notify");
}

async function testMacOSBackend(): Promise<void> {
	setBackend("macos");
	resetLog();
	setSubagentEnv({});

	await emitToolCalls();
	await emitAgentEnd();

	const log = await waitForLines("osascript ", 3);
	const lines = log.trim().split("\n").filter((l) => l.startsWith("osascript "));
	assert.equal(lines.length, 3, "macos: question + permission + done should notify via osascript");
	assert.match(log, /osascript/, "macos: must invoke osascript");
	assert.match(log, /-e/, "macos: must pass -e flag to osascript");
	assert.match(log, /display/, "macos: osascript script must contain display");
	assert.match(log, /notification/, "macos: osascript script must contain notification");
	assert.match(log, /title/, "macos: osascript script must contain title");
	assert.match(log, /question/, "macos: ask_user_question triggers notification");
	assert.match(log, /permission/, "macos: permission prompt triggers notification");
	assert.match(log, /done/, "macos: agent_end triggers notification");
	assert.doesNotMatch(log, /finished/, "macos: agent text must not appear");
	assert.doesNotMatch(log, /bash/, "macos: plain tool calls must not notify");
}

async function testWSLBackend(): Promise<void> {
	setBackend("wsl");
	resetLog();
	setSubagentEnv({});

	await emitToolCalls();
	await emitAgentEnd();

	const log = await waitForLines("powershell.exe ", 3);
	const lines = log.trim().split("\n").filter((l) => l.startsWith("powershell.exe "));
	assert.equal(lines.length, 3, "wsl: question + permission + done should notify via powershell.exe");
	assert.match(log, /-NoProfile/, "wsl: must run with -NoProfile");
	assert.match(log, /ToastNotif/, "wsl: must use Windows toast notification API");
	assert.match(log, /question/, "wsl: ask_user_question triggers notification");
	assert.match(log, /permission/, "wsl: permission prompt triggers notification");
	assert.match(log, /done/, "wsl: agent_end triggers notification");
	assert.doesNotMatch(log, /finished/, "wsl: agent text must not appear");
	assert.doesNotMatch(log, /bash/, "wsl: plain tool calls must not notify");
}

async function testSubagentSilence(): Promise<void> {
	setBackend("distrobox");

	for (const env of [
		{ PI_PDD_SUBAGENT: "1" },
		{ PI_SUBAGENT_RUNTIME_ID: "runtime-123" },
		{ PI_SUBAGENT_RUNTIME_DEPTH: "1" },
	]) {
		resetLog();
		setSubagentEnv(env);
		await emitAgentEnd();
		const log = await waitForQuiet();
		assert.equal(
			log.trim().split("\n").filter((l) => l.startsWith("notify-send -a Pi")).length,
			0,
			`subagent: agent_end must stay quiet for ${JSON.stringify(env)}`,
		);
		assert.doesNotMatch(log, /Pi\\ done/, "subagent: done notification must not fire");
		assert.doesNotMatch(log, /finished/, "subagent: agent text must not leak");
	}

	setSubagentEnv({});
}

async function main(): Promise<void> {
	await testDistroboxLinuxBackend();
	await testMacOSBackend();
	await testWSLBackend();
	await testSubagentSilence();
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
