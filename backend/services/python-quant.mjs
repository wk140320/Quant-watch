import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_OUTPUT_LIMIT = 12_000_000;

function createPythonQuantClient(options = {}) {
  const root = options.root;
  if (!root) throw new Error("Python quant client requires an application root.");
  const workerPath = options.workerPath || join(root, "quant_core", "worker.py");
  const localPython = options.localPython || join(root, ".venv", "bin", "python");

  return function runPythonQuantCore(
    operation,
    payload = {},
    timeoutMs = Number(process.env.PYTHON_CORE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  ) {
    return new Promise((resolve, reject) => {
      const python = process.env.PYTHON_BIN || (existsSync(localPython) ? localPython : "python3");
      const child = spawn(python, [workerPath], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          MPLCONFIGDIR: process.env.MPLCONFIGDIR || join(root, ".cache", "matplotlib"),
        },
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`Python quant core timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > Number(options.outputLimit || DEFAULT_OUTPUT_LIMIT)) {
          child.kill("SIGKILL");
          finish(new Error("Python quant core response exceeded the size limit."));
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => finish(new Error(`Unable to start Python quant core: ${error.message}`)));
      child.on("close", (code) => {
        if (settled) return;
        let parsed;
        try {
          parsed = JSON.parse(stdout || "{}");
        } catch {
          finish(new Error(`Python quant core returned invalid JSON. ${stderr.slice(-600)}`));
          return;
        }
        if (code !== 0 || parsed.ok !== true) {
          finish(new Error(parsed.error || stderr.slice(-600) || `Python quant core exited with code ${code}.`));
          return;
        }
        finish(null, parsed.result);
      });
      child.stdin.end(JSON.stringify({ operation, ...payload }));
    });
  };
}

export { createPythonQuantClient };
