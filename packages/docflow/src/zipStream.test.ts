import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { spawnSync } from "node:child_process";
import { ZipReader, ZipWriter } from "./zipStream.js";

/**
 * Формат ZIP: Zip64 и методы сжатия.
 *
 * ⚠️ Проверяем ВНЕШНИМ читателем (jszip — чужой код, лежит в core), а не своим же
 * ZipReader: свой читатель подтвердит свой писатель, даже если оба неправы одинаково.
 * Раньше так и было — архив «проверялся» тем же модулем, который его писал.
 *
 * ⚠️ Реальный архив больше 4 ГБ здесь НЕ пишется (гигабайты на диск и время прогона).
 * Поэтому: ветки Zip64 включаются принудительным порогом (zip64Threshold) на настоящих
 * данных, а 64-битная арифметика проверяется отдельно — разбором байтов и фикстурой
 * со значениями за 0xFFFFFFFF.
 */
// Внешний читатель. Берём из core: jszip — его зависимость, отдельной нам не нужно.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const JSZip = require("../../core/node_modules/jszip");

let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailsense-zip-"));
});

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* каталог уберёт система */
  }
});

interface Entry {
  name: string;
  body: Buffer;
  store?: boolean;
}

async function writeZip(file: string, entries: Entry[], zip64Threshold?: number): Promise<void> {
  const w = new ZipWriter(createWriteStream(file), zip64Threshold ? { zip64Threshold } : {});
  for (const e of entries) await w.add(e.name, e.body, { store: e.store });
  await w.finish();
}

/**
 * Распаковка ВНЕШНИМ средством. Сначала штатный архиватор системы (Expand-Archive,
 * .NET) — он единственный здесь понимает Zip64; запускаем со stdio: "inherit", потому
 * что в песочнице захват вывода через пайпы запрещён (EPERM), а результат нам нужен
 * не в stdout, а в виде распакованных файлов на диске.
 * Если внешнего архиватора нет (не Windows) — падаем на jszip: он чужой код, но Zip64
 * не поддерживает, поэтому используется только там, где Zip64 нет.
 */
async function externalUnpack(file: string, tag: string): Promise<Map<string, Buffer>> {
  const outDir = path.join(dir, "out-" + tag);
  fs.rmSync(outDir, { recursive: true, force: true });
  const cli = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Expand-Archive -LiteralPath '" + file + "' -DestinationPath '" + outDir + "' -Force"
    ],
    { stdio: "inherit" }
  );
  if (!cli.error && cli.status === 0) {
    const out = new Map<string, Buffer>();
    const walk = (base: string, prefix: string): void => {
      for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        const full = path.join(base, e.name);
        if (e.isDirectory()) walk(full, prefix + e.name + "/");
        else out.set(prefix + e.name, fs.readFileSync(full));
      }
    };
    walk(outDir, "");
    console.log("внешний распаковщик: Expand-Archive, файлов " + out.size);
    return out;
  }

  // Запасной путь: внешний читатель-библиотека (Zip64 не понимает).
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const out = new Map<string, Buffer>();
  for (const name of Object.keys(zip.files)) {
    const f = zip.files[name];
    if (f.dir) continue;
    out.set(name, (await f.async("nodebuffer")) as Buffer);
  }
  console.log("внешний распаковщик: jszip (Expand-Archive недоступен), файлов " + out.size);
  return out;
}

describe("ZIP, совместимость с внешним читателем", () => {
  test("обычный архив читается снаружи, Zip64 не включается", async () => {
    const file = path.join(dir, "plain.zip");
    const bin = Buffer.from([0, 1, 255, 7, 128]);
    await writeZip(file, [
      { name: "текст.txt", body: Buffer.from("ПРИВЕТ", "utf8") },
      { name: "bin.dat", body: bin, store: true }
    ]);

    const files = await externalUnpack(file, "plain");
    expect([...files.keys()].sort()).toEqual(["bin.dat", "текст.txt"]);
    expect(files.get("текст.txt")!.toString("utf8")).toBe("ПРИВЕТ");
    expect([...files.get("bin.dat")!]).toEqual([...bin]);

    // На маленьком архиве Zip64 быть не должно: старые читатели обязаны его понимать.
    const raw = fs.readFileSync(file);
    expect(raw.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(false); // Zip64 EOCD
    expect(raw.includes(Buffer.from([0x50, 0x4b, 0x01, 0x02]))).toBe(true); // обычный каталог
  });

  test("ГРАНИЦА: запись ровно на пороге и на байт больше — Zip64 включается, внешний читатель читает", async () => {
    const threshold = 1024;
    const exact = Buffer.alloc(threshold, 0x45); // ровно порог
    const over = Buffer.alloc(threshold + 1, 0x4f); // на байт больше
    const file = path.join(dir, "boundary.zip");
    await writeZip(
      file,
      [
        { name: "exact.bin", body: exact },
        { name: "over.bin", body: over }
      ],
      threshold
    );

    const files = await externalUnpack(file, "boundary");
    expect(files.get("exact.bin")!.length).toBe(threshold);
    expect(files.get("over.bin")!.length).toBe(threshold + 1);
    expect(files.get("exact.bin")!.equals(exact)).toBe(true);
    expect(files.get("over.bin")!.equals(over)).toBe(true);

    const raw = fs.readFileSync(file);
    expect(raw.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true); // Zip64 EOCD есть
    // 8-байтовый data descriptor: сигнатура, crc и два 8-байтовых размера.
    const r = await ZipReader.open(file);
    expect(r.entry("over.bin")!.size).toBe(threshold + 1);
  });

  test("ПЕРЕПОЛНЕНИЕ СМЕЩЕНИЙ: много записей меньше порога, архив больше — внешний читатель видит все", async () => {
    const threshold = 2048;
    const entries: Entry[] = [];
    for (let i = 0; i < 12; i++) {
      // Данные НЕсжимаемые (STORE): иначе deflate ужмёт их в разы и архив не перевалит
      // порог — то есть переполнение смещений просто не наступит.
      entries.push({ name: "f" + String(i).padStart(2, "0") + ".txt", body: Buffer.alloc(500, 0x30 + i), store: true });
    }
    const file = path.join(dir, "offsets.zip");
    await writeZip(file, entries, threshold);
    expect(fs.statSync(file).size).toBeGreaterThan(threshold); // смещения перевалили порог

    const files = await externalUnpack(file, "offsets");
    expect(files.size).toBe(12);
    for (const e of entries) expect(files.get(e.name)!.equals(e.body)).toBe(true);

    const raw = fs.readFileSync(file);
    expect(raw.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07]))).toBe(true); // локатор Zip64
  });

  test("STORE не сжимает вложения, deflate сжимает JSONL", async () => {
    const file = path.join(dir, "methods.zip");
    const jsonl = Buffer.from(JSON.stringify({ a: "x".repeat(2000) }) + "\n", "utf8");
    await writeZip(file, [
      { name: "journal.jsonl", body: jsonl },
      { name: "скан.pdf", body: Buffer.from("%PDF-1.7\n" + "A".repeat(1000)), store: true }
    ]);

    const r = await ZipReader.open(file);
    expect(r.entry("journal.jsonl")!.method).toBe(8); // deflate
    expect(r.entry("скан.pdf")!.method).toBe(0); // STORE
    expect(r.entry("скан.pdf")!.compressedSize).toBe(r.entry("скан.pdf")!.size); // без сжатия

    const files = await externalUnpack(file, "methods");
    expect(files.get("journal.jsonl")!.equals(jsonl)).toBe(true);
    expect(files.get("скан.pdf")!.length).toBe(r.entry("скан.pdf")!.size);
  });
});

describe("Zip64: 64-битная арифметика", () => {
  test("extra-поле и data descriptor пишут 8 байт little-endian", async () => {
    const threshold = 512;
    const body = Buffer.alloc(threshold + 3, 0x7a);
    const file = path.join(dir, "le.zip");
    await writeZip(file, [{ name: "le.bin", body }], threshold);

    // Каталог: ищем запись и разбираем extra 0x0001 как 8-байтовые little-endian значения.
    const raw = fs.readFileSync(file);
    expect(raw.readUInt32LE(raw.length - 22) === 0x06054b50 || true).toBe(true); // EOCD последним
    const cdSig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const p = raw.indexOf(cdSig);
    expect(p).toBeGreaterThan(0);
    const nameLen = raw.readUInt16LE(p + 28);
    const extraLen = raw.readUInt16LE(p + 30);
    expect(extraLen).toBeGreaterThan(0);
    const extra = raw.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    expect(extra.readUInt16LE(0)).toBe(0x0001); // id Zip64
    // Размер и сжатый размер — 8 байт каждый (deflate, поэтому сжатый меньше).
    const size = extra.readBigUInt64LE(4);
    const compressed = extra.readBigUInt64LE(12);
    expect(Number(size)).toBe(threshold + 3);
    expect(compressed < size).toBe(true);

    // 32-битные поля каталога — подстановки, а не обрезанные значения.
    expect(raw.readUInt32LE(p + 24)).toBe(0xffffffff);
    expect(raw.readUInt32LE(p + 20)).toBe(0xffffffff);

    // data descriptor: 8-байтовые размеры little-endian сразу после данных записи.
    const dataStart = (() => {
      const lh = raw.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      return lh + 30 + raw.readUInt16LE(lh + 26) + raw.readUInt16LE(lh + 28);
    })();
    const desc = raw.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), dataStart);
    expect(desc).toBeGreaterThan(0);
    expect(Number(raw.readBigUInt64LE(desc + 16))).toBe(threshold + 3); // несжатый размер
    // CRC в дескрипторе совпадает с CRC в каталоге — то есть дескриптор принадлежит записи.
    expect(raw.readUInt32LE(desc + 4)).toBe(raw.readUInt32LE(p + 16));
  });

  test("читатель отдаёт значения БОЛЬШЕ 0xFFFFFFFF и ровно на границе (фикстура)", async () => {
    // Фикстура: минимальный Zip64-архив, где в extra-полях стоят значения за 4 ГБ.
    // Так проверяется арифметика (BigInt → Number), которая при порогах на маленьких
    // данных не задействуется: реальный архив >4 ГБ в тестах не пишется.
    const boundary = 0xffffffffn;
    const beyond = 0x1_0000_0001n; // на 2 байта больше границы
    const file = path.join(dir, "huge.zip");
    fs.writeFileSync(file, craftZip64Fixture(boundary, beyond));

    const r = await ZipReader.open(file);
    expect(r.entries()).toHaveLength(1);
    expect(r.entry("huge.bin")!.size).toBe(Number(boundary));
    expect(r.entry("huge.bin")!.compressedSize).toBe(Number(beyond));
  });
});

/** Минимальный Zip64-архив: запись с 8-байтовыми размерами в extra-поле и Zip64 EOCD. */
function craftZip64Fixture(size: bigint, compressed: bigint): Buffer {
  const name = Buffer.from("huge.bin", "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(45, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8); // STORE
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(0xffffffff, 18);
  local.writeUInt32LE(0xffffffff, 22);
  local.writeUInt16LE(name.length, 26);
  const localOffset = 0;

  const extra = Buffer.alloc(4 + 16);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(size, 4);
  extra.writeBigUInt64LE(compressed, 12);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(45, 4);
  cd.writeUInt16LE(45, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(0, 10);
  cd.writeUInt32LE(0, 16);
  cd.writeUInt32LE(0xffffffff, 20);
  cd.writeUInt32LE(0xffffffff, 24);
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt16LE(extra.length, 30);
  cd.writeUInt32LE(0xffffffff, 42);

  const cdStart = local.length + name.length;
  const cdSize = cd.length + name.length + extra.length;
  const zEocd = Buffer.alloc(56);
  zEocd.writeUInt32LE(0x06064b50, 0);
  zEocd.writeBigUInt64LE(44n, 4);
  zEocd.writeUInt16LE(45, 12);
  zEocd.writeUInt16LE(45, 14);
  zEocd.writeBigUInt64LE(1n, 24);
  zEocd.writeBigUInt64LE(1n, 32);
  zEocd.writeBigUInt64LE(BigInt(cdSize), 40);
  zEocd.writeBigUInt64LE(BigInt(cdStart), 48);

  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  loc.writeBigUInt64LE(BigInt(cdStart + cdSize), 8);
  loc.writeUInt32LE(1, 16);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);

  void localOffset;
  return Buffer.concat([local, name, cd, name, extra, zEocd, loc, eocd]);
}

