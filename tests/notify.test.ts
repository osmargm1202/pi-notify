import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import notifyExtension from "../extensions/notify.ts";
import { mergeAgentModelsConfig } from "../extensions/lib/orgm-config.ts";
import { KNOWN_ORGM_EXTENSION_FEATURES } from "../extensions/lib/orgm-extension-config.ts";

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;
class FakeChild extends EventEmitter {
	kills: unknown[] = [];
	unrefed = false;
	kill(signal: unknown) { this.kills.push(signal); return true; }
	unref() { this.unrefed = true; }
}

type SpawnCall = { command: string; args: string[]; options: SpawnOptions; child: FakeChild };
const environmentKeys = [
	"HOME", "container", "DISTROBOX_ENTER_PATH", "DISTROBOX_HOST_HOME", "WSL_DISTRO_NAME", "WSL_INTEROP",
	"KITTY_PID", "KITTY_WINDOW_ID", "KITTY_LISTEN_ON", "TERM", "TERM_PROGRAM", "TERMINAL",
	"PI_PDD_SUBAGENT", "PI_SUBAGENT_RUNTIME_ID", "PI_SUBAGENT_RUNTIME_DEPTH",
];
let savedEnv: Record<string, string | undefined>;
let home: string;
let available: Set<string>;
let hostAvailable: boolean;
let calls: SpawnCall[];
let probes: { command: string; args: string[]; timeout?: number }[];
let platform: NodeJS.Platform;
let spawnThrows: boolean;
let probeThrows: boolean;
let fixtures: { shutdown: () => Promise<void> }[];

function harness() {
	const handlers = new Map<string, Handler[]>();
	notifyExtension({
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
	} as unknown as ExtensionAPI);
	const emit = async (event: ExtensionEvent, ctx: Partial<ExtensionContext> = {}) => {
		for (const handler of handlers.get(event.type) ?? []) {
			assert.equal(await handler(event, { cwd: "/tmp/project", ...ctx } as ExtensionContext), undefined);
		}
	};
	const fixture = {
		handlers, emit,
		question: (input: unknown = { question: "Continue?" }, ctx: Partial<ExtensionContext> = {}) =>
			emit({ type: "tool_call", toolCallId: "q1", toolName: "ask_user_question", input } as ToolCallEvent, ctx),
		done: (aborted = false, ctx: Partial<ExtensionContext> = {}) => emit({ type: "agent_settled", aborted }, ctx),
		shutdown: () => emit({ type: "session_shutdown", reason: "reload" }),
	};
	fixtures.push(fixture);
	return fixture;
}

beforeEach(() => {
	savedEnv = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
	for (const key of environmentKeys) delete process.env[key];
	home = mkdtempSync(join(os.tmpdir(), "pi-notify-test-"));
	process.env.HOME = home;
	platform = "linux";
	available = new Set(["notify-send"]);
	hostAvailable = true;
	spawnThrows = false;
	probeThrows = false;
	calls = [];
	probes = [];
	fixtures = [];
	mock.method(os, "platform", () => platform);
	mock.method(childProcess, "spawnSync", (command: string, args: string[], options: { timeout?: number }) => {
		if (probeThrows) throw new Error("probe failed");
		probes.push({ command, args, timeout: options.timeout });
		const name = command === "where.exe" ? args[0] : args.at(-1)?.match(/^command -v (\S+)/)?.[1];
		return { status: command === "distrobox-host-exec" ? (hostAvailable ? 0 : 1) : (available.has(name ?? "") ? 0 : 1) };
	});
	mock.method(childProcess, "spawn", (command: string, args: string[], options: SpawnOptions) => {
		if (spawnThrows) throw new Error("spawn failed");
		const child = new FakeChild();
		calls.push({ command, args, options, child });
		return child as unknown as ChildProcess;
	});
	syncBuiltinESMExports();
});

afterEach(async () => {
	for (const fixture of fixtures) await fixture.shutdown();
	mock.restoreAll();
	syncBuiltinESMExports();
	for (const key of environmentKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	rmSync(home, { recursive: true, force: true });
});

function payload(call = calls.at(-1)!) {
	return call.args.slice(call.args.indexOf("--") + 1);
}
function windowsScript(call = calls.at(-1)!) {
	assert.equal(call.args.at(-2), "-EncodedCommand");
	return Buffer.from(call.args.at(-1)!, "base64").toString("utf16le");
}

test("factory registers only; no resource acquisition during discovery", () => {
	const app = harness();
	assert.equal(calls.length, 0);
	assert.equal(probes.length, 0);
	assert.deepEqual([...app.handlers.keys()].sort(), ["agent_settled", "session_shutdown", "session_start", "tool_call"]);
});

test("multiple low-level agent_end events stay silent until final settlement", async () => {
	const app = harness();
	for (let i = 0; i < 3; i++) await app.emit({ type: "agent_end", messages: [] });
	assert.equal(calls.length, 0, "retry/compaction/queued continuation must not notify early");
	await app.done();
	assert.equal(calls.length, 1);
	assert.deepEqual(payload(), ["Pi done · project", "project · done · Ready for input."]);
});

test("aborted settlement and already-aborted operation signals do not probe or notify", async () => {
	const app = harness();
	await app.done(true);
	const signal = AbortSignal.abort();
	await app.question(undefined, { signal });
	await app.done(false, { signal });
	assert.equal(calls.length, 0);
	assert.equal(probes.length, 0);
});

test("subagent completion stays quiet, but an interactive question can notify", async () => {
	const app = harness();
	for (const [key, value] of [
		["PI_PDD_SUBAGENT", "1"], ["PI_SUBAGENT_RUNTIME_ID", "runtime-123"], ["PI_SUBAGENT_RUNTIME_DEPTH", "2"],
	]) {
		process.env[key] = value;
		await app.done();
		delete process.env[key];
	}
	assert.equal(calls.length, 0);
	process.env.PI_PDD_SUBAGENT = "1";
	await app.question();
	assert.equal(calls.length, 1);
});

test("Linux sends discrete argv, normal transient 8s notifications and valid Kitty hints", async () => {
	process.env.KITTY_PID = " 12345 ";
	const app = harness();
	await app.question({ question: 'Allow "edit"; $(touch /bad) & <x>?' });
	const call = calls[0];
	assert.equal(call.command, "notify-send");
	assert.deepEqual(call.args.slice(0, -2), [
		"-a", "Pi", "-u", "normal", "-e", "-t", "8000",
		"-h", "int:pi-focus-pid:12345", "-h", "string:desktop-entry:kitty", "--",
	]);
	assert.equal(payload()[1], 'project · question · Allow "edit"; $(touch /bad) & <x>?');
	assert.deepEqual(call.options, { stdio: "ignore", windowsHide: true });
	assert.equal(call.child.unrefed, true);
	assert.equal(probes[0].args[0], "-c", "do not reset PATH via a login shell");
});

test("invalid Kitty PID never becomes an integer hint", async () => {
	process.env.KITTY_PID = "123;bad";
	await harness().done();
	assert.ok(!calls[0].args.some((arg) => arg.startsWith("int:pi-focus-pid:")));
	assert.ok(calls[0].args.includes("string:desktop-entry:kitty"));
});

test("Distrobox prefers host notify-send, with bounded detection", async () => {
	process.env.container = "podman";
	available.add("distrobox-host-exec");
	await harness().done();
	assert.equal(calls[0].command, "distrobox-host-exec");
	assert.equal(calls[0].args[0], "notify-send");
	assert.deepEqual(probes.map((probe) => probe.timeout), [500, 1000]);
});

test("unavailable Distrobox host falls back to local notify-send", async () => {
	process.env.DISTROBOX_ENTER_PATH = "/bin/distrobox";
	available.add("distrobox-host-exec");
	hostAvailable = false;
	await harness().done();
	assert.equal(calls[0].command, "notify-send");
});

test("macOS escapes AppleScript backslashes/quotes and collapses newlines", async () => {
	platform = "darwin";
	available = new Set(["osascript"]);
	await harness().question({ question: 'Say "yes" \\ then\ncontinue' }, { cwd: '/tmp/my "repo"' });
	assert.equal(calls[0].command, "osascript");
	assert.deepEqual(calls[0].args, ["-e", 'display notification "my \\"repo\\" · question · Say \\"yes\\" \\\\ then continue" with title "Pi question · my \\"repo\\""']);
});

for (const backend of ["wsl", "win32"] as const) {
	test(`${backend} uses Unicode-safe encoded PowerShell and escapes XML/single quotes`, async () => {
		if (backend === "wsl") process.env.WSL_DISTRO_NAME = "Ubuntu";
		else platform = "win32";
		available = new Set(["powershell.exe"]);
		await harness().question({ question: "It's <safe> & café 🐱" }, { cwd: "C:\\work\\repo\\" });
		assert.equal(calls[0].command, "powershell.exe");
		assert.deepEqual(calls[0].args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden"]);
		const script = windowsScript();
		assert.ok(script.includes("<text>Pi question · repo</text>"));
		assert.ok(script.includes("It''s &lt;safe&gt; &amp; café 🐱"));
		assert.ok(script.includes("CreateToastNotifier('Pi')"));
		if (backend === "win32") {
			assert.equal(probes[0].command, "where.exe", "native Windows must not require sh");
			assert.deepEqual(probes[0].args, ["powershell.exe"]);
		}
	});
}

test("missing backends are silent, cached per session, and re-detected after session start", async () => {
	available.clear();
	const app = harness();
	await app.done();
	await app.done();
	assert.equal(calls.length, 0);
	assert.equal(probes.length, 1);
	available.add("notify-send");
	await app.emit({ type: "session_start", reason: "new" });
	await app.done();
	assert.equal(calls.length, 1);
	assert.equal(probes.length, 2);
});

test("platform-specific backend absence stays silent rather than using an incompatible fallback", async () => {
	for (const backend of ["darwin", "win32", "wsl"] as const) {
		platform = backend === "wsl" ? "linux" : backend;
		if (backend === "wsl") process.env.WSL_INTEROP = "/run/WSL/interop";
		await harness().done();
		delete process.env.WSL_INTEROP;
	}
	assert.equal(calls.length, 0, "only notify-send is available, which is not the selected native backend");
});

test("desktop notifications remain independent of TUI/RPC/JSON/print rendering", async () => {
	const app = harness();
	for (const mode of ["tui", "rpc", "json", "print"] as const) {
		await app.done(false, { mode, hasUI: mode === "tui" || mode === "rpc" });
	}
	assert.equal(calls.length, 4);
	assert.ok(calls.every((call) => call.options.stdio === "ignore"));
});

test("question aliases, multi-question extraction, permission aliases and unrelated tools", async () => {
	const app = harness();
	await app.emit({ type: "tool_call", toolCallId: "q", toolName: "question", input: {
		questions: [null, { header: "First" }, { title: "Second" }, { label: "Third" }],
	} });
	assert.equal(payload()[1], "project · question · 3 questions: First · Second");
	for (const toolName of ["ask_user_permission", "request_permission", "permission_request", " CONFIRM_PERMISSION "]) {
		await app.emit({ type: "tool_call", toolCallId: "p", toolName, input: { prompt: "Allow?" } });
		assert.equal(payload()[1], "project · permission · Allow?");
	}
	await app.emit({ type: "tool_call", toolCallId: "b", toolName: "bash", input: { command: "secret" } });
	assert.equal(calls.length, 5);
});

test("malformed question input has a fallback; long bodies are normalized and capped", async () => {
	const app = harness();
	for (const input of [null, "text", {}, { questions: [false, {}] }]) {
		await app.question(input);
		assert.equal(payload()[1], "project · question · Pi is waiting for your answer.");
	}
	await app.question({ text: "\n" + "very long  ".repeat(100) });
	assert.equal(payload()[1].length, 220);
	assert.ok(payload()[1].endsWith("…"));
	assert.ok(!payload()[1].includes("\n"));
});

test("abort kills a pending notification client once and removes its signal listener", async () => {
	const app = harness();
	const controller = new AbortController();
	await app.question(undefined, { signal: controller.signal });
	assert.equal(getEventListeners(controller.signal, "abort").length, 1);
	controller.abort();
	assert.deepEqual(calls[0].child.kills, ["SIGKILL"]);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	await app.shutdown();
	assert.equal(calls[0].child.kills.length, 1);
	// Late spawn errors after abort must be consumed, not crash Pi.
	calls[0].child.emit("error", new Error("late ENOENT"));
});

test("normal child exit/error removes listeners/timers and shutdown does not kill finished clients", async () => {
	const app = harness();
	for (const event of ["close", "error"]) {
		const controller = new AbortController();
		await app.question(undefined, { signal: controller.signal });
		const child = calls.at(-1)!.child;
		child.emit(event, event === "error" ? new Error("ENOENT") : 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal(child.listenerCount("close"), 0);
		controller.abort();
		assert.deepEqual(child.kills, []);
	}
	await app.shutdown();
	assert.ok(calls.every((call) => call.child.kills.length === 0));
});

test("hung notification clients are killed after 5s; completed clients have no remaining timer", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const app = harness();
	await app.done();
	await app.question();
	calls[1].child.emit("close", 0);
	t.mock.timers.tick(4_999);
	assert.equal(calls[0].child.kills.length, 0);
	t.mock.timers.tick(1);
	assert.deepEqual(calls[0].child.kills, ["SIGKILL"]);
	assert.deepEqual(calls[1].child.kills, []);
});

test("shutdown is idempotent, cancels every pending client, blocks stale work; session_start reopens", async () => {
	const app = harness();
	await app.done();
	await app.question();
	await app.shutdown();
	await app.shutdown();
	assert.ok(calls.every((call) => call.child.kills.length === 1));
	await app.done();
	assert.equal(calls.length, 2);
	await app.emit({ type: "session_start", reason: "reload" });
	await app.done();
	assert.equal(calls.length, 3);
});

test("session replacement also cleans old clients when no shutdown preceded session_start", async () => {
	const app = harness();
	await app.done();
	await app.emit({ type: "session_start", reason: "resume", previousSessionFile: "/tmp/old.jsonl" });
	assert.deepEqual(calls[0].child.kills, ["SIGKILL"]);
	await app.done();
	assert.equal(calls.length, 2);
});

test("probe, synchronous spawn, asynchronous spawn and kill failures cannot break Pi handlers", async () => {
	probeThrows = true;
	await harness().done();
	assert.equal(calls.length, 0);
	probeThrows = false;
	spawnThrows = true;
	const app = harness();
	await app.done();
	spawnThrows = false;
	await app.done();
	calls[0].child.emit("error", new Error("ENOENT"));
	await app.done();
	calls[1].child.kill = () => { throw new Error("already exited"); };
	await app.shutdown();
});

test("runtime instances do not share backend caches or process ownership", async () => {
	const first = harness();
	await first.done();
	platform = "darwin";
	available = new Set(["osascript"]);
	const second = harness();
	await second.done();
	assert.deepEqual(calls.map((call) => call.command), ["notify-send", "osascript"]);
	await first.shutdown();
	assert.equal(calls[0].child.kills.length, 1);
	assert.equal(calls[1].child.kills.length, 0);
});

test("disabled ORGM notify config registers nothing", () => {
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "orgm.json"), JSON.stringify({ extensions: { notify: { enabled: false } } }));
	assert.equal(harness().handlers.size, 0);
	assert.equal(probes.length, 0);
	assert.equal(calls.length, 0);
});

test("typed config cleanup preserves valid model mapping and feature aliases", () => {
	assert.deepEqual(mergeAgentModelsConfig({ " builder ": " provider/model ", bad: 1, empty: " " }), { builder: "provider/model" });
	assert.deepEqual(KNOWN_ORGM_EXTENSION_FEATURES.ask_user_question, ["questions"]);
	assert.deepEqual(KNOWN_ORGM_EXTENSION_FEATURES.ask_user_permission, ["permissions"]);
});

test("Pi 1.3.0's actual extension loader accepts the package without starting notifications", async () => {
	const { discoverAndLoadExtensions } = await import("@earendil-works/pi-coding-agent");
	const result = await discoverAndLoadExtensions([resolve("extensions/notify.ts")], home, join(home, "agent"));
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	assert.ok(result.extensions[0].handlers.has("agent_settled"));
	assert.ok(!result.extensions[0].handlers.has("agent_end"));
	assert.equal(probes.length, 0);
	assert.equal(calls.length, 0);
});
