/**
 * Потоковый ZIP: запись и чтение без сборки архива в память.
 *
 * Зачем свой, а не библиотека: в проекте есть только jszip (core, electron), а он
 * собирает архив ЦЕЛИКОМ в памяти. Архив года с вложениями (сканы, PDF) может оказаться
 * БОЛЬШЕ, чем оперативной памяти, — на таком объёме буферизация просто падает. Поэтому
 * сборка потоковая: память ограничена страницей чтения, а не размером архива.
 * Модуль использует только node:zlib и потоки.
 *
 * ZIP64. Без него архив больше 4 ГБ собрать нельзя, а закрытие года устроено строго:
 * «снимок не собрался → год не закрывается». То есть предел 4 ГБ означал бы, что год
 * нельзя закрыть вообще (≈1000 сканов по 4 МБ — первый же полный год организации).
 * Что добавлено: extra-поле 0x0001 (8-байтовые размеры и смещение), 8-байтовый data
 * descriptor у крупных записей, Zip64 EOCD с локатором.
 *
 * Методы: 8 (deflate) для JSONL и 0 (STORE) для вложений — PDF и сканы уже сжаты.
 * Порог включения Zip64 вынесен в опцию (zip64Threshold): границы перехода проверяются
 * тестами на РЕАЛЬНЫХ архивах, а не писанием 4 ГБ в каждом прогоне.
 */
import { createHash } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import { crc32, createDeflateRaw, createInflateRaw } from "node:zlib";

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
/** data descriptor (3) + UTF-8 имена (11) */
const FLAGS = 0x0808;
/** «Значение не влезло — смотри Zip64»: подстановки в 32- и 16-битных полях. */
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const ZIP64_EXTRA_ID = 0x0001;

export interface ZipWriterOptions {
  /** Порог, с которого включается Zip64. По умолчанию 0xFFFFFFFF — как в спецификации. */
  zip64Threshold?: number;
}

export interface ZipAddOptions {
  /** true — хранить без сжатия (STORE): вложения уже сжаты, deflate им не нужен. */
  store?: boolean;
}

export interface ZipEntryStat {
  name: string;
  size: number;
  sha256: string;
  crc: number;
  method: number;
}

interface WrittenEntry extends ZipEntryStat {
  offset: number;
  compressedSize: number;
  needsZip64: boolean;
}

/** Пишет ZIP потоком в приёмник. Файлы добавляются по одному, память не копится. */
export class ZipWriter {
  private readonly out: Writable;
  private readonly threshold: number;
  private readonly entries: WrittenEntry[] = [];
  private offset = 0;
  private closed = false;

  constructor(out: Writable, opts: ZipWriterOptions = {}) {
    this.out = out;
    this.threshold = Math.max(1, opts.zip64Threshold ?? U32_MAX);
  }

  private async put(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;
    if (!this.out.write(chunk)) await once(this.out, "drain");
  }

  /** Добавляет файл: source — буфер или поток. Возвращает размер и sha256 (для манифеста). */
  async add(name: string, source: Buffer | Readable, opts: ZipAddOptions = {}): Promise<ZipEntryStat> {
    if (this.closed) throw new Error("ZIP уже закрыт");
    const nameBuf = Buffer.from(name, "utf8");
    const offset = this.offset;
    const method = opts.store ? 0 : 8;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(20, 4); // версия, нужная для распаковки
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12); // 1980-01-01
    header.writeUInt32LE(0, 14); // crc — в data descriptor
    header.writeUInt32LE(0, 18);
    header.writeUInt32LE(0, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    await this.put(header);
    await this.put(nameBuf);

    const hash = createHash("sha256");
    let size = 0;
    let crc = 0;
    let compressedSize = 0;

    const meter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        size += chunk.length;
        crc = crc32(chunk, crc);
        hash.update(chunk);
        cb(null, chunk);
      }
    });
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        compressedSize += chunk.length;
        cb(null, chunk);
      }
    });
    const sink = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        this.put(chunk).then(() => cb(), cb);
      }
    });

    const input = Buffer.isBuffer(source) ? Readable.from([source]) : source;
    // STORE — без deflate: вложения (PDF, сканы) уже сжаты, дефлейт только жжёт процессор.
    await (method === 8
      ? pipeline(input, meter, createDeflateRaw(), counter, sink)
      : pipeline(input, meter, counter, sink));

    const needsZip64 = size >= this.threshold || compressedSize >= this.threshold || offset >= this.threshold;
    if (needsZip64) {
      // 8-байтовые размеры: в 32 бита они не влезли (APPNOTE 4.3.9.2, data descriptor).
      const d = Buffer.alloc(24);
      d.writeUInt32LE(SIG_DESCRIPTOR, 0);
      d.writeUInt32LE(crc >>> 0, 4);
      d.writeBigUInt64LE(BigInt(compressedSize), 8);
      d.writeBigUInt64LE(BigInt(size), 16);
      await this.put(d);
    } else {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
      descriptor.writeUInt32LE(crc >>> 0, 4);
      descriptor.writeUInt32LE(compressedSize, 8);
      descriptor.writeUInt32LE(size, 12);
      await this.put(descriptor);
    }

    const sha256 = hash.digest("hex");
    this.entries.push({ name, size, sha256, crc: crc >>> 0, method, offset, compressedSize, needsZip64 });
    return { name, size, sha256, crc: crc >>> 0, method };
  }

  /**
   * Пишет центральный каталог и закрывает поток.
   *
   * Записи, у которых размер или смещение не влезли в 32 бита, получают extra-поле
   * Zip64 (0x0001), а в 32-битных полях остаются подстановки 0xFFFFFFFF. Если не влезли
   * смещение каталога или число записей — добавляются Zip64 EOCD и локатор на него.
   */
  async finish(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const cdStart = this.offset;

    for (const e of this.entries) {
      const nameBuf = Buffer.from(e.name, "utf8");
      const offsetNeeds64 = e.offset >= this.threshold;
      const sizesNeed64 = e.size >= this.threshold || e.compressedSize >= this.threshold;
      const use64 = sizesNeed64 || offsetNeeds64;

      let extra = Buffer.alloc(0);
      if (use64) {
        // Подставленные поля идут в порядке спецификации: размер, сжатый размер,
        // смещение, номер диска — и только те, что действительно не влезли.
        const parts: Buffer[] = [];
        if (sizesNeed64) {
          const b = Buffer.alloc(16);
          b.writeBigUInt64LE(BigInt(e.size), 0);
          b.writeBigUInt64LE(BigInt(e.compressedSize), 8);
          parts.push(b);
        }
        if (offsetNeeds64) {
          const b = Buffer.alloc(8);
          b.writeBigUInt64LE(BigInt(e.offset), 0);
          parts.push(b);
        }
        const body = Buffer.concat(parts);
        extra = Buffer.alloc(4 + body.length);
        extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
        extra.writeUInt16LE(body.length, 2);
        body.copy(extra, 4);
      }

      const rec = Buffer.alloc(46);
      rec.writeUInt32LE(SIG_CENTRAL, 0);
      rec.writeUInt16LE(use64 ? 45 : 20, 4); // version made by
      rec.writeUInt16LE(use64 ? 45 : 20, 6); // version needed
      rec.writeUInt16LE(FLAGS, 8);
      rec.writeUInt16LE(e.method, 10);
      rec.writeUInt16LE(0, 12);
      rec.writeUInt16LE(0x21, 14);
      rec.writeUInt32LE(e.crc, 16);
      rec.writeUInt32LE(sizesNeed64 ? U32_MAX : e.compressedSize, 20);
      rec.writeUInt32LE(sizesNeed64 ? U32_MAX : e.size, 24);
      rec.writeUInt16LE(nameBuf.length, 28);
      rec.writeUInt16LE(extra.length, 30);
      rec.writeUInt16LE(0, 32); // comment
      rec.writeUInt16LE(0, 34); // disk
      rec.writeUInt16LE(0, 36); // internal attrs
      rec.writeUInt32LE(0, 38); // external attrs
      rec.writeUInt32LE(offsetNeeds64 ? U32_MAX : e.offset, 42);
      await this.put(rec);
      await this.put(nameBuf);
      if (extra.length) await this.put(extra);
    }

    const cdSize = this.offset - cdStart;
    const needZip64Eocd =
      this.entries.some((e) => e.needsZip64 || e.offset >= this.threshold) ||
      cdStart >= this.threshold ||
      cdSize >= this.threshold ||
      this.entries.length >= U16_MAX;

    if (needZip64Eocd) {
      const z = Buffer.alloc(56);
      z.writeUInt32LE(SIG_ZIP64_EOCD, 0);
      z.writeBigUInt64LE(BigInt(44), 4); // размер остатка записи
      z.writeUInt16LE(45, 12);
      z.writeUInt16LE(45, 14);
      z.writeUInt32LE(0, 16);
      z.writeUInt32LE(0, 20);
      z.writeBigUInt64LE(BigInt(this.entries.length), 24);
      z.writeBigUInt64LE(BigInt(this.entries.length), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      const zEocdOffset = this.offset;
      await this.put(z);

      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(zEocdOffset), 8);
      loc.writeUInt32LE(1, 16);
      await this.put(loc);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    // Если значения не влезли — по спецификации тут подстановки, а настоящие в Zip64 EOCD.
    eocd.writeUInt16LE(Math.min(this.entries.length, U16_MAX), 8);
    eocd.writeUInt16LE(Math.min(this.entries.length, U16_MAX), 10);
    eocd.writeUInt32LE(Math.min(cdSize, U32_MAX), 12);
    eocd.writeUInt32LE(Math.min(cdStart, U32_MAX), 16);
    eocd.writeUInt16LE(0, 20);
    await this.put(eocd);
    await new Promise<void>((resolve) => this.out.end(resolve));
  }
}

export interface ZipReadEntry {
  name: string;
  method: number;
  crc: number;
  size: number;
  compressedSize: number;
  localOffset: number;
}

/** Читает ZIP с диска: центральный каталог из хвоста файла, содержимое — потоком. */
export class ZipReader {
  private constructor(
    private readonly file: string,
    private readonly list: ZipReadEntry[]
  ) {}

  static async open(file: string): Promise<ZipReader> {
    const stat = await fsp.stat(file);
    const tailSize = Math.min(stat.size, 66_000);
    const handle = await fsp.open(file, "r");
    let tail: Buffer;
    try {
      tail = Buffer.alloc(tailSize);
      await handle.read(tail, 0, tailSize, stat.size - tailSize);
    } finally {
      await handle.close();
    }

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("Это не ZIP-архив: не найден признак конца каталога");
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    // Zip64: в обычном EOCD стоят подстановки 0xFFFF/0xFFFFFFFF, а настоящие значения —
    // в Zip64 EOCD, на который указывает локатор прямо перед обычным EOCD.
    if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
      if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) {
        const zOff = Number(tail.readBigUInt64LE(eocd - 12));
        const zh = await fsp.open(file, "r");
        try {
          const z = Buffer.alloc(56);
          await zh.read(z, 0, 56, zOff);
          if (z.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new Error("ZIP повреждён: нет Zip64-каталога");
          count = Number(z.readBigUInt64LE(32));
          cdSize = Number(z.readBigUInt64LE(40));
          cdOffset = Number(z.readBigUInt64LE(48));
        } finally {
          await zh.close();
        }
      }
    }
    if (cdOffset + cdSize > stat.size) throw new Error("ZIP повреждён: каталог выходит за границы файла");

    const cd = Buffer.alloc(cdSize);
    const h2 = await fsp.open(file, "r");
    try {
      await h2.read(cd, 0, cdSize, cdOffset);
    } finally {
      await h2.close();
    }

    const list: ZipReadEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) {
        throw new Error("ZIP повреждён: каталог читается не до конца");
      }
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");

      // Zip64 extra 0x0001: подставленные поля идут в порядке размер, сжатый размер,
      // смещение — и только те, что в 32 бита не влезли.
      let q = p + 46 + nameLen;
      const extraEnd = q + extraLen;
      while (q + 4 <= extraEnd) {
        const id = cd.readUInt16LE(q);
        const len = cd.readUInt16LE(q + 2);
        const body = q + 4;
        if (id === ZIP64_EXTRA_ID) {
          let r = body;
          if (size === U32_MAX && r + 8 <= body + len) {
            size = Number(cd.readBigUInt64LE(r));
            r += 8;
          }
          if (compressedSize === U32_MAX && r + 8 <= body + len) {
            compressedSize = Number(cd.readBigUInt64LE(r));
            r += 8;
          }
          if (localOffset === U32_MAX && r + 8 <= body + len) {
            localOffset = Number(cd.readBigUInt64LE(r));
            r += 8;
          }
        }
        q = body + len;
      }

      list.push({ name, method, crc, size, compressedSize, localOffset });
      p = extraEnd + commentLen;
    }
    return new ZipReader(file, list);
  }

  entries(): ZipReadEntry[] {
    return [...this.list];
  }

  entry(name: string): ZipReadEntry | null {
    return this.list.find((e) => e.name === name) ?? null;
  }

  /**
   * Поток содержимого записи: локальный заголовок читается на лету, данные идут
   * потоком, размер и CRC проверяются по ходу. Память не зависит от размера файла.
   */
  openRaw(name: string): Readable {
    const e = this.entry(name);
    if (!e) throw new Error("В архиве нет файла " + name);
    return Readable.from(this.pump(name, e));
  }

  private async *pump(name: string, e: ZipReadEntry): AsyncGenerator<Buffer> {
    const handle = await fsp.open(this.file, "r");
    let dataStart: number;
    try {
      const head = Buffer.alloc(30);
      await handle.read(head, 0, 30, e.localOffset);
      if (head.readUInt32LE(0) !== SIG_LOCAL) throw new Error("ZIP повреждён: запись " + name + " без заголовка");
      // Локальный extra может отличаться от каталожного — длину берём из самого заголовка.
      dataStart = e.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    } finally {
      await handle.close();
    }

    const raw = createReadStream(this.file, { start: dataStart, end: dataStart + e.compressedSize - 1 });
    const source = e.method === 8 ? raw.pipe(createInflateRaw()) : raw;
    let size = 0;
    let crc = 0;
    for await (const chunk of source) {
      const buf = chunk as Buffer;
      size += buf.length;
      crc = crc32(buf, crc);
      yield buf;
    }
    if (size !== e.size) throw new Error("Файл " + name + " повреждён: размер не совпал");
    if ((crc >>> 0) !== e.crc) throw new Error("Файл " + name + " повреждён: контрольная сумма не совпала");
  }

  /** Читает запись целиком (для небольших файлов: манифест, JSONL-строка). */
  async readAll(name: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.openRaw(name)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }
}
