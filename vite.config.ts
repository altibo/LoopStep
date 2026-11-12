import { defineConfig } from "vite";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
export default defineConfig({
  base: "./",
  build: { sourcemap: false },
  plugins: [
    {
      name: "loopstep-offline-shell",
      apply: "build",
      closeBundle() {
        const assets = readdirSync("dist/assets").map((f) => `assets/${f}`);
        const shell = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "recorder-worklet.js", ...assets];
        const hash = createHash("sha256");
        for (const f of shell.filter((f) => f !== "./")) hash.update(f).update(readFileSync(`dist/${f}`));
        const id = hash.digest("hex").slice(0, 12);
        const sw = readFileSync("dist/sw.js", "utf8")
          .replace('"__SHELL__"', shell.map((f) => JSON.stringify(f === "./" ? f : `./${f}`)).join(", "))
          .replace("__BUILD_ID__", id);
        writeFileSync("dist/sw.js", sw);
        writeFileSync("dist/version.json", JSON.stringify({ build: id }));
      },
    },
  ],
});
