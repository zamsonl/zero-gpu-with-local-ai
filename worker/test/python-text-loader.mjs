// Match Wrangler's Text rule when the launcher is imported by plain Node tests.
import { readFile } from "node:fs/promises";

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".py")) return nextLoad(url, context);
  return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(await readFile(new URL(url), "utf8"))};` };
}
