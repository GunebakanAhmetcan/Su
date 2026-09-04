import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(resolve(root, "index.html"), "utf8");
const app = await readFile(resolve(root, "src/app.js"), "utf8");
const worker = await readFile(resolve(root, "sw.js"), "utf8");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.webmanifest"), "utf8"));

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) throw new Error("Tekrarlanan HTML id: " + duplicates.join(", "));

const combined = html + "\n" + app;
const requiredIds = [...app.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]);
const missingIds = [...new Set(requiredIds)].filter((id) => !combined.includes('id="' + id + '"'));
if (missingIds.length) throw new Error("Eksik HTML id: " + missingIds.join(", "));

for (const icon of manifest.icons || []) {
  await access(resolve(root, icon.src.replace(/^\//, "")));
}

for (const required of ["config.js", "app.js", "styles.css"]) {
  if (!html.includes('src="/' + required + '"') && !html.includes('href="/' + required + '"')) {
    throw new Error("index.html dosyasında eksik varlık: " + required);
  }
}

if (!worker.includes('self.addEventListener("push"')) {
  throw new Error("Service worker push dinleyicisi eksik.");
}
if (/powered by netlify/i.test(html + app)) {
  throw new Error("İstenmeyen Netlify rozeti bulundu.");
}

console.log("Kaynak doğrulaması başarılı.");
