import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppDatabase } from "./database.js";
import { createApplication } from "./app.js";
import { createProviders } from "./providers/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: resolve(repositoryRoot, ".env"), quiet: true });
const dataRoot = resolve(repositoryRoot, "data");
const webRoot = resolve(repositoryRoot, "apps/web/dist");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const database = new AppDatabase(join(dataRoot, "realtime-translate.sqlite"));
const providers = await createProviders(process.env, dataRoot);
const application = createApplication({ database, providers, audioRoot: join(dataRoot, "audio"), webRoot });

application.server.listen(port, host, () => {
  console.log(`\nRealtime Translate server: http://${host}:${port}`);
  console.log(`ASR: ${providers.recognizer ? `${providers.recognizer.provider}/${providers.recognizer.model}` : "disabled (audio storage only)"}`);
  console.log(`Translation: ${providers.translator ? `${providers.translator.provider}/${providers.translator.model}` : `${providers.translationSelection} disabled: ${providers.translationIssue}`}`);
  if (!existsSync(webRoot)) console.log("Web build not found; use `pnpm dev` for the Vite development server.");
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void application.close().then(() => process.exit(0), (error: unknown) => {
    console.error(error);
    process.exit(1);
  });
});
