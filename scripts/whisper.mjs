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
  console.log("\nWhisper setup completed. The model downloads on first use.");
} else if (action === "start" || action === "transcribe") {
  if (!existsSync(venvPython)) {
    console.error("Local Whisper is not installed. Run `pnpm whisper:setup` first.");
    process.exit(1);
  }
  const isTranscription = action === "transcribe";
  const entry = join(root, "services", "whisper", isTranscription ? "transcribe.py" : "server.py");
  const child = spawn(venvPython, [entry, ...process.argv.slice(3)], {
    cwd: isTranscription ? process.cwd() : root,
    env: process.env,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(`Could not start Python: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => process.exitCode = signal ? 1 : (code ?? 1));
} else {
  console.error("Usage: node scripts/whisper.mjs <setup|start|transcribe>");
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
