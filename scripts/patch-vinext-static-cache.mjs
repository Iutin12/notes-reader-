import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Vinext 0.0.50 stores static-cache keys with path.relative(). On Windows this
// creates `assets\\file.css`, while browser URLs always request
// `/assets/file.css`, so styles and client scripts are returned as 404.
const target = fileURLToPath(
  new URL("../node_modules/vinext/dist/server/static-file-cache.js", import.meta.url),
);
const original = "relativePath: path.relative(base, batch[j]),";
const patched = "relativePath: path.relative(base, batch[j]).split(path.sep).join(\"/\"),";

if (!existsSync(target)) process.exit(0);
const source = readFileSync(target, "utf8");
if (source.includes(patched)) process.exit(0);
if (!source.includes(original)) {
  throw new Error("Не удалось применить Windows-патч Vinext: изменилась структура static-file-cache.js.");
}
writeFileSync(target, source.replace(original, patched));
