import assert from "node:assert/strict";
import { test } from "node:test";
import { findSupportedPython, isSupportedPython } from "./python-runtime.mjs";

const options = { platform: "linux", exists: () => false };

test("only Python 3.10–3.12 is supported", () => {
  for (const version of ["3.10.16", "3.11.11", "3.12.15"]) assert.ok(isSupportedPython(version));
  for (const version of ["3.9.21", "3.13.0", "3.14.4", "2.7.18", undefined, "3.120.0"]) assert.ok(!isSupportedPython(version));
});
test("prefers a supported Python over the system default", () => {
  const selected = findSupportedPython({ ...options, probe: ({ command }) => command === "python3.12" ? "3.12.15" : "3.14.4" });
  assert.equal(selected.command, "python3.12");
});
test("can find another supported version if 3.12 is absent", () => {
  const selected = findSupportedPython({ ...options, probe: ({ command }) => command === "python3.11" ? "3.11.11" : undefined });
  assert.equal(selected.command, "python3.11");
});
test("reuses the existing project's Python rather than system Python", () => {
  const selected = findSupportedPython({ ...options, venvPython: "/project/.venv/bin/python", exists: () => true, probe: ({ command }) => command.startsWith("/project/") ? "3.12.15" : "3.14.4" });
  assert.equal(selected.command, "/project/.venv/bin/python");
});
test("respects an explicit executable path, including spaces", () => {
  const selected = findSupportedPython({ ...options, configuredPython: "/my python/python", probe: ({ command }) => command === "/my python/python" ? "3.12.15" : undefined });
  assert.equal(selected.command, "/my python/python");
  assert.deepEqual(selected.args, []);
});
test("does not silently replace an invalid explicit Python or existing venv", () => {
  assert.throws(() => findSupportedPython({ ...options, configuredPython: "/wrong/python", probe: () => "3.14.4" }), /Python 3.10–3.12/);
  assert.throws(() => findSupportedPython({ ...options, venvPython: "/project/old/python", exists: () => true, probe: () => "3.14.4" }), /will not be deleted/);
});
test("tries the Windows launcher with supported versions", () => {
  const selected = findSupportedPython({ ...options, platform: "win32", probe: ({ command, args }) => command === "py" && args[0] === "-3.11" ? "3.11.11" : undefined });
  assert.equal(selected.command, "py");
  assert.deepEqual(selected.args, ["-3.11"]);
});
