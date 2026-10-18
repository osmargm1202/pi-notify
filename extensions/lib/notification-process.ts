import { spawn, type ChildProcess } from "node:child_process";

export type NotificationSpawn = (command: string, args: string[], signal?: AbortSignal) => void;

// Notification clients should submit immediately, not outlive a cancelled turn or session.
const PROCESS_TIMEOUT_MS = 5_000;

export function createNotificationProcesses() {
	const pending = new Map<ChildProcess, () => void>();
	let closed = false;

	const start: NotificationSpawn = (command, args, signal) => {
		if (closed || signal?.aborted) return;
		const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			child.removeListener("close", cleanup);
			pending.delete(child);
		};
		const cancel = () => {
			cleanup();
			try {
				child.kill("SIGKILL");
			} catch {
				// A client may already have exited. Notification failures are non-fatal.
			}
		};
		const timer = setTimeout(cancel, PROCESS_TIMEOUT_MS);
		timer.unref();
		pending.set(child, cancel);
		// Keep the error listener even after cancellation: spawn can fail asynchronously.
		child.once("error", cleanup);
		child.once("close", cleanup);
		signal?.addEventListener("abort", cancel, { once: true });
		child.unref();
		if (signal?.aborted) cancel();
	};

	return {
		spawn: start,
		shutdown() {
			closed = true;
			for (const cancel of pending.values()) cancel();
		},
	};
}
