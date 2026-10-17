import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findSupportedPython } from "./python-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const venv = join(root, ".venv-whisper");
const isWindows = process.platform === "win32";
const venvPython = isWindows ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
const action = process.argv[2] || "start";
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));

if (action === "setup") {
  const python = findSupportedPython({ venvPython, configuredPython: process.env.WHISPER_PYTHON });
  console.log(`Using Python ${python.version}: ${python.command} ${python.args.join(" ")}`);
  if (!existsSync(venvPython)) run(python.command, [...python.args, "-m", "venv", venv]);
  run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
  run(venvPython, ["-m", "pip", "install", "-r", join(root, "services", "whisper", "requirements.txt")]);
  console.log("\nWhisper setup completed. The model downloads on the first `pnpm whisper:start`.");
} else if (action === "start") {
  if (!existsSync(venvPython)) {
    console.error("Local Whisper is not installed. Run `pnpm whisper:setup` first.");
    process.exit(1);
  }
  const child = spawn(venvPython, [join(root, "services", "whisper", "server.py")], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exitCode = signal ? 1 : (code ?? 1));
} else {
  console.error("Usage: node scripts/whisper.mjs <setup|start>");
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
