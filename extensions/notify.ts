import { spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";
import { isOrgmExtensionEnabled } from "./lib/orgm-extension-config.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

const QUESTION_TOOL_NAMES = new Set(["ask_user_question", "question"]);
const PERMISSION_TOOL_NAMES = new Set([
	"ask_user_permission",
	"request_permission",
	"permission_request",
	"confirm_permission",
]);
const AUTO_DISMISS_TIMEOUT_MS = 8_000;
const MAX_BODY_LENGTH = 220;
const FOCUS_PID_HINT = "pi-focus-pid";
const KITTY_DESKTOP_ENTRY = "kitty";

type NotificationType = "question" | "permission" | "done";

type NotifyFn = (title: string, body: string, hints: string[]) => void;

let notifyFnCache: NotifyFn | null | undefined;

export function _resetCache(): void {
	notifyFnCache = undefined;
}

// Override process.platform in tests (e.g. "_NOTIFY_PLATFORM=darwin").
function currentPlatform(): string {
	return process.env._NOTIFY_PLATFORM ?? process.platform;
}

function isMacOS(): boolean {
	return currentPlatform() === "darwin";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function cleanText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength = MAX_BODY_LENGTH): string {
	const clean = cleanText(text);
	if (clean.length <= maxLength) return clean;
	return `${clean.slice(0, Math.max(0, maxLength - 1))}…`;
}

function folderName(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	return basename(trimmed) || trimmed || ".";
}

function isPositiveInteger(value: string | undefined): value is string {
	return typeof value === "string" && /^[1-9]\d*$/.test(value.trim());
}

function getKittyPid(): string | undefined {
	const value = process.env.KITTY_PID?.trim();
	return isPositiveInteger(value) ? value : undefined;
}

function includesKitty(value: string | undefined): boolean {
	return typeof value === "string" && value.toLowerCase().includes("kitty");
}

function isKittyRuntime(): boolean {
	return Boolean(
		process.env.KITTY_PID ||
			process.env.KITTY_WINDOW_ID ||
			process.env.KITTY_LISTEN_ON ||
			includesKitty(process.env.TERM) ||
			includesKitty(process.env.TERM_PROGRAM) ||
			includesKitty(process.env.TERMINAL),
	);
}

function getNotificationHints(): string[] {
	const hints: string[] = [];
	const kittyPid = getKittyPid();

	if (kittyPid) {
		hints.push("-h", `int:${FOCUS_PID_HINT}:${kittyPid}`);
	}

	if (kittyPid || isKittyRuntime()) {
		hints.push("-h", `string:desktop-entry:${KITTY_DESKTOP_ENTRY}`);
	}

	return hints;
}

function isDistroboxRuntime(): boolean {
	return Boolean(
		process.env.DISTROBOX_ENTER_PATH ||
			process.env.DISTROBOX_HOST_HOME ||
			process.env.container === "distrobox" ||
			process.env.container === "podman" ||
			process.env.container === "docker",
	);
}

function isWSLRuntime(): boolean {
	return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function isSubagentRuntime(): boolean {
	if (process.env.PI_PDD_SUBAGENT === "1") return true;
	if (process.env.PI_SUBAGENT_RUNTIME_ID?.trim()) return true;

	const runtimeDepth = Number.parseInt(
		process.env.PI_SUBAGENT_RUNTIME_DEPTH || "0",
		10,
	);
	return Number.isFinite(runtimeDepth) && runtimeDepth > 0;
}

function commandExists(command: string): boolean {
	try {
		return (
			spawnSync("sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], {
				stdio: "ignore",
				timeout: 500,
			}).status === 0
		);
	} catch {
		return false;
	}
}

function hostNotifySendExists(): boolean {
	try {
		return (
			spawnSync(
				"distrobox-host-exec",
				["sh", "-lc", "command -v notify-send >/dev/null 2>&1"],
				{ stdio: "ignore", timeout: 1000 },
			).status === 0
		);
	} catch {
		return false;
	}
}

function spawnFire(command: string, args: string[]): void {
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.on("error", () => undefined);
	child.unref();
}

function makeNotifySendFn(command: string, prefix: string[]): NotifyFn {
	return (title, body, hints) => {
		spawnFire(command, [
			...prefix,
			"-a", "Pi",
			"-u", "normal",
			"-e",
			"-t", String(AUTO_DISMISS_TIMEOUT_MS),
			...hints,
			title,
			body,
		]);
	};
}

function makeOsascriptFn(): NotifyFn {
	return (title, body) => {
		const safeTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const safeBody = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		spawnFire("osascript", [
			"-e",
			`display notification "${safeBody}" with title "${safeTitle}"`,
		]);
	};
}

function xmlEscape(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function psEscape(text: string): string {
	return text.replace(/'/g, "''");
}

function makeWSLFn(): NotifyFn {
	return (title, body) => {
		const safeTitle = psEscape(xmlEscape(title));
		const safeBody = psEscape(xmlEscape(body));
		const xml = `<toast><visual><binding template="ToastGeneric"><text>${safeTitle}</text><text>${safeBody}</text></binding></visual></toast>`;
		const script = [
			"$ErrorActionPreference = 'SilentlyContinue'",
			"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
			"$t = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Pi')",
			"$x = New-Object Windows.Data.Xml.Dom.XmlDocument",
			`$x.LoadXml('${xml}')`,
			"$t.Show([Windows.UI.Notifications.ToastNotification]::new($x))",
		].join("; ");
		spawnFire("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-WindowStyle", "Hidden",
			"-Command", script,
		]);
	};
}

function resolveNotifyFn(): NotifyFn | null {
	if (notifyFnCache !== undefined) return notifyFnCache;

	if (isMacOS()) {
		notifyFnCache = commandExists("osascript") ? makeOsascriptFn() : null;
		return notifyFnCache;
	}

	if (isWSLRuntime()) {
		notifyFnCache = commandExists("powershell.exe") ? makeWSLFn() : null;
		return notifyFnCache;
	}

	if (
		isDistroboxRuntime() &&
		commandExists("distrobox-host-exec") &&
		hostNotifySendExists()
	) {
		notifyFnCache = makeNotifySendFn("distrobox-host-exec", ["notify-send"]);
		return notifyFnCache;
	}

	if (commandExists("notify-send")) {
		notifyFnCache = makeNotifySendFn("notify-send", []);
		return notifyFnCache;
	}

	notifyFnCache = null;
	return notifyFnCache;
}

function notify(
	type: NotificationType,
	ctx: ExtensionContext,
	text: string,
): void {
	try {
		const notifyFn = resolveNotifyFn();
		if (!notifyFn) return;

		const folder = folderName(ctx.cwd);
		const title = `Pi ${type} · ${folder}`;
		const body = truncate(`${folder} · ${type} · ${text}`);
		notifyFn(title, body, getNotificationHints());
	} catch {
		// Notifications must never affect Pi tool execution.
	}
}

function getStringField(
	input: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function isPermissionToolName(toolName: string): boolean {
	const normalized = toolName.trim().toLowerCase();
	return PERMISSION_TOOL_NAMES.has(normalized);
}

function getQuestionText(event: ToolCallEvent): string {
	const fallback = "Pi is waiting for your answer.";
	if (!isRecord(event.input)) return fallback;

	const direct = getStringField(event.input, [
		"question",
		"prompt",
		"message",
		"text",
	]);
	if (direct) return direct;

	const questions = event.input.questions;
	if (!Array.isArray(questions)) return fallback;

	const labels = questions
		.map((question) => {
			if (!isRecord(question)) return undefined;
			return getStringField(question, ["question", "header", "title", "label"]);
		})
		.filter((question): question is string => Boolean(question));

	if (labels.length === 0) return fallback;
	if (labels.length === 1) return labels[0]!;
	return `${labels.length} questions: ${labels.slice(0, 2).join(" · ")}`;
}

export default function (pi: ExtensionAPI) {
	if (!isOrgmExtensionEnabled("notify")) return;

	pi.on("tool_call", (event, ctx) => {
		if (QUESTION_TOOL_NAMES.has(event.toolName)) {
			notify("question", ctx, getQuestionText(event));
			return undefined;
		}

		if (isPermissionToolName(event.toolName)) {
			notify("permission", ctx, getQuestionText(event));
			return undefined;
		}

		return undefined;
	});

	pi.on("agent_end", (_event, ctx) => {
		if (isSubagentRuntime()) return undefined;
		notify("done", ctx, "Work complete.");
		return undefined;
	});
}
