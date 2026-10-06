/**
 * Забирает пакеты тестовой обвязки с зеркала и раскладывает их ПЛОСКО в packages/web/node_modules.
 *
 * Почему не pnpm: в песочнице запрещены симлинки, а линковка pnpm (и isolated, и hoisted)
 * падает с переполнением стека. Граф зависимостей берём из pnpm-lock.yaml (его pnpm
 * считает без линковки), архивы распаковываем сами — без дочерних процессов.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");

const harness = __dirname;
const target = path.join(harness, "..", "packages", "web", "node_modules");
const lock = fs.readFileSync(path.join(harness, "pnpm-lock.yaml"), "utf8");

const pairs = [...lock.matchAll(/^ {2}([@a-zA-Z0-9._/-]+?)@(\d+\.\d+\.\d+[^:(\s]*):/gm)].map((m) => ({ name: m[1], version: m[2] }));
const uniq = [...new Map(pairs.map((p) => [p.name + "@" + p.version, p])).values()];
console.log("в lockfile:", uniq.length, "пакетов");

function download(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(res.headers.location, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** Минимальный разбор tar: npm-архивы простые, длинные имена — через prefix. */
function untar(buf, destDir, strip = 1) {
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    const nameEnd = header.indexOf(0);
    const rawName = header.subarray(0, nameEnd === -1 ? 100 : Math.min(nameEnd, 100)).toString("utf8");
    if (!rawName) break;
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156]);
    const prefixEnd = header.subarray(345, 500).indexOf(0);
    const prefix = header.subarray(345, prefixEnd === -1 ? 500 : 345 + prefixEnd).toString("utf8");
    const full = (prefix ? prefix + "/" : "") + rawName;
    const parts = full.split("/").slice(strip);
    const rel = parts.join("/");
    const dataStart = offset + 512;
    if (rel && type !== "5") {
      const file = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf.subarray(dataStart, dataStart + size));
    } else if (rel && type === "5") {
      fs.mkdirSync(path.join(destDir, rel), { recursive: true });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
}

async function fetchOne({ name, version }) {
  const leaf = name.split("/").pop();
  const dest = path.join(target, name);
  if (fs.existsSync(path.join(dest, "package.json"))) return "skip";
  const urls = [
    "https://registry.npmmirror.com/" + name + "/-/" + leaf + "-" + version + ".tgz",
    "https://registry.npmjs.org/" + name + "/-/" + leaf + "-" + version + ".tgz"
  ];
  let lastErr = null;
  for (const url of urls) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const gz = await download(url);
        untar(zlib.gunzipSync(gz), dest);
        if (!fs.existsSync(path.join(dest, "package.json"))) throw new Error("нет package.json после распаковки");
        return "ok";
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw new Error(name + "@" + version + ": " + (lastErr && lastErr.message));
}

(async () => {
  let ok = 0;
  let skip = 0;
  const failed = [];
  for (const pkg of uniq) {
    try {
      const res = await fetchOne(pkg);
      if (res === "ok") {
        ok++;
        if (ok % 20 === 0) console.log("скачано:", ok);
      } else skip++;
    } catch (err) {
      failed.push(err.message);
      console.log("ОШИБКА:", err.message);
    }
  }
  console.log("итог: скачано", ok, "| уже было", skip, "| ошибок", failed.length);
  if (failed.length) console.log(failed.join("\n"));
})();
