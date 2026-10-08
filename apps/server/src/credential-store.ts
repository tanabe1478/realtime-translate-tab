import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

interface CredentialFile {
  version: 1;
  credentials: Record<string, Credential>;
}

const EMPTY_FILE: CredentialFile = { version: 1, credentials: {} };

export class JsonCredentialStore implements CredentialStore {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    throwIfAborted(options?.signal);
    return (await this.readAll()).credentials[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    throwIfAborted(options?.signal);
    const file = await this.readAll();
    return Object.entries(file.credentials).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.serialized(async () => this.withFileLock(async () => {
      throwIfAborted(options?.signal);
      const file = await this.readAll();
      const current = file.credentials[providerId];
      const next = await update(current);
      throwIfAborted(options?.signal);
      if (next !== undefined) {
        file.credentials[providerId] = next;
        await this.writeAll(file);
        return next;
      }
      return current;
    }, options?.signal));
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.serialized(async () => this.withFileLock(async () => {
      throwIfAborted(options?.signal);
      const file = await this.readAll();
      if (!(providerId in file.credentials)) return;
      delete file.credentials[providerId];
      await this.writeAll(file);
    }, options?.signal));
  }

  private async readAll(): Promise<CredentialFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("Credential file must contain an object");
      const value = parsed as { version?: unknown; credentials?: unknown };
      if (value.version !== 1 || !value.credentials || typeof value.credentials !== "object") {
        throw new Error("Unsupported credential file format");
      }
      const credentials: Record<string, Credential> = {};
      for (const [providerId, credential] of Object.entries(value.credentials as Record<string, unknown>)) {
        if (isCredential(credential)) credentials[providerId] = credential;
      }
      return { version: 1, credentials };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_FILE, credentials: {} };
      throw error;
    }
  }

  private async writeAll(value: CredentialFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await rename(temporaryPath, this.path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async withFileLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lockPath = `${this.path}.lock`;
    await mkdir(dirname(lockPath), { recursive: true });
    const startedAt = Date.now();
    while (true) {
      throwIfAborted(signal);
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${process.pid}\n`);
          return await operation();
        } finally {
          await handle.close();
          await unlink(lockPath).catch(() => undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lockAge = await stat(lockPath).then((value) => Date.now() - value.mtimeMs).catch(() => 0);
        if (lockAge > 60_000) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() - startedAt > 30_000) throw new Error("Timed out waiting for the credential store lock");
        await sleep(75, signal);
      }
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "api_key" || type === "oauth";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
    }, { once: true });
  });
}
