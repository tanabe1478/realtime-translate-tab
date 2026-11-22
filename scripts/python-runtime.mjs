import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function isSupportedPython(version) {
  return /^3\.(?:10|11|12)(?:\.|$)/.test(version ?? "");
}

/** Do not accidentally select Ubuntu's default Python 3.14. Never replace an existing venv. */
export function findSupportedPython({
  platform = process.platform,
  venvPython,
  configuredPython,
  exists = existsSync,
  probe = probeVersion,
}) {
  let candidates;
  if (venvPython && exists(venvPython)) {
    candidates = [{ command: venvPython, args: [] }];
  } else if (configuredPython) {
    candidates = [{ command: configuredPython, args: [] }];
  } else {
    candidates = platform === "win32"
      ? [
          ...["3.12", "3.11", "3.10"].map((version) => ({ command: "py", args: [`-${version}`] })),
          { command: "python", args: [] },
        ]
      : ["python3.12", "python3.11", "python3.10", "python3", "python"].map((command) => ({ command, args: [] }));
  }
  for (const candidate of candidates) {
    const version = probe(candidate);
    if (isSupportedPython(version)) return { ...candidate, version };
  }
  throw new Error("Python 3.10–3.12 is required. Install a supported version or set WHISPER_PYTHON in .env. An existing incompatible .venv-whisper must be replaced explicitly; it will not be deleted automatically.");
}

function probeVersion(candidate) {
  const result = spawnSync(candidate.command, [...candidate.args, "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], {
    encoding: "utf8", timeout: 5_000,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
