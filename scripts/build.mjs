import { build } from "esbuild";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(projectRoot, "dist");
const staticFiles = [
  "index.html",
  "styles.css",
  "sw.js",
  "manifest.webmanifest",
  "favicon.svg",
  "apple-touch-icon.png"
];

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

await Promise.all(
  staticFiles.map((file) => copyFile(resolve(projectRoot, file), resolve(outputDir, file)))
);

const publicConfig = {
  supabaseUrl: process.env.PUBLIC_SUPABASE_URL || "",
  supabaseAnonKey: process.env.PUBLIC_SUPABASE_ANON_KEY || "",
  vapidPublicKey: process.env.PUBLIC_VAPID_KEY || ""
};
const serializedConfig = JSON.stringify(publicConfig).replaceAll("<", "\\u003c");
await writeFile(
  resolve(outputDir, "config.js"),
  "window.SU_CONFIG = Object.freeze(" + serializedConfig + ");\n",
  "utf8"
);

await build({
  entryPoints: [resolve(projectRoot, "src/app.js")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020"],
  outfile: resolve(outputDir, "app.js"),
  legalComments: "none"
});

console.log("Su PWA build hazır.");
