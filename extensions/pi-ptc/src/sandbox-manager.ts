import { spawn, exec, execSync } from "child_process";
import { promisify } from "util";
import type { SandboxManager } from "./types";

const execAsync = promisify(exec);

const EXECUTION_TIMEOUT = 270_000; // 4.5 minutes in milliseconds

/**
 * Subprocess-based sandbox implementation
 * Executes Python code in a local subprocess
 */
class SubprocessSandbox implements SandboxManager {
  spawn(code: string, cwd: string): import("child_process").ChildProcess {
    // Spawn Python process with unbuffered output
    return spawn("python3", ["-u", "-c", code], {
      cwd,
      env: { ...process.env },
    });
  }

  async cleanup(): Promise<void> {
    // No persistent resources to clean up
  }
}

/**
 * Docker-based sandbox implementation
 * Executes Python code in an isolated Docker container
 */
class DockerSandbox implements SandboxManager {
  private containerId: string | null = null;
  private lastUsed: number = 0;
  private readonly sessionId: string;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.startCleanupTimer();
  }

  private startCleanupTimer() {
    // Check every 60 seconds for expired containers
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 60_000);
  }

  private async cleanupExpired() {
    if (this.containerId && Date.now() - this.lastUsed > EXECUTION_TIMEOUT) {
      await this.stopContainer();
    }
  }


  private async stopContainer() {
    if (!this.containerId) return;

    try {
      await execAsync(`docker stop ${this.containerId}`);
    } catch (error) {
      // Container might already be stopped
      console.error(`Failed to stop container ${this.containerId}:`, error);
    }

    this.containerId = null;
  }

  spawn(code: string, cwd: string): import("child_process").ChildProcess {
    try {
      // Check if we need to create a new container
      if (!this.containerId || Date.now() - this.lastUsed > EXECUTION_TIMEOUT) {
        // Stop old container if it exists
        if (this.containerId) {
          try {
            execSync(`docker stop ${this.containerId}`, { stdio: "ignore" });
          } catch {
            // Container might already be stopped
          }
          this.containerId = null;
        }

        // Create new container
        const containerName = `pi-ptc-${this.sessionId}-${Date.now()}`;
        const output = execSync(
          `docker run -d --rm --network none --name ${containerName} ` +
          `-v "${cwd}:/workspace:ro" ` +
          `--memory 512m --cpus 1.0 ` +
          `python:3.12-slim tail -f /dev/null`,
          { encoding: "utf-8" }
        );
        this.containerId = output.trim();
      }

      this.lastUsed = Date.now();

      // Execute Python code in container
      return spawn("docker", ["exec", "-i", this.containerId, "python3", "-u", "-c", code], {
        cwd,
      });
    } catch (error) {
      throw new Error(
        `Failed to create/use Docker container: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    await this.stopContainer();
  }
}

/**
 * Check if Docker is available on the system
 */
async function isDockerAvailable(): Promise<boolean> {
  try {
    await execAsync("docker --version");
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a sandbox manager (uses subprocess by default, Docker opt-in via PTC_USE_DOCKER=true)
 */
export async function createSandbox(): Promise<SandboxManager> {
  const sessionId = Math.random().toString(36).substring(7);
  const useDocker = process.env.PTC_USE_DOCKER === "true";

  if (useDocker) {
    const dockerAvailable = await isDockerAvailable();
    if (dockerAvailable) {
      console.log("[PTC] Using Docker sandbox (PTC_USE_DOCKER=true)");
      return new DockerSandbox(sessionId);
    } else {
      console.log("[PTC] Docker requested but not available, falling back to subprocess sandbox");
      return new SubprocessSandbox();
    }
  } else {
    console.log("[PTC] Using subprocess sandbox (default)");
    return new SubprocessSandbox();
  }
}
