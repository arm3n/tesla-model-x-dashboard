/**
 * Kill a process and its entire process tree (children, grandchildren).
 * On Windows, uses `taskkill /F /T /PID` which kills the tree.
 * On Unix, sends SIGTERM to the process group.
 *
 * This is critical for nodriver scrapers: proc.kill() only kills the
 * Python process, leaving Chrome child processes orphaned.
 */
export function killProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(pid)], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } else {
      // Kill the process group (negative PID)
      try { process.kill(-pid, "SIGTERM"); } catch {}
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  } catch {
    // Best-effort — process may already be dead
  }
}
