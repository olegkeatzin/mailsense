/**
 * Потоковый ZIP: запись и чтение без сборки архива в память.
 *
 * Зачем свой, а не библиотека: в проекте есть только jszip (core, electron), а он
 * собирает архив ЦЕЛИКОМ в памяти. Для журнала за год это неприемлемо: выгрузка
 * обязана собираться потоком, не занимая столько же памяти, сколько весит архив.
 * Модуль использует только node:zlib и потоки.
 *
 * Поддержано: method 8 (deflate) и method 0 (stored), data descriptor (размеры
 * заранее неизвестны — иначе потока не выйдет), UTF-8 имена.
 * НЕ поддержан Zip64: каждый файл и архив целиком должны быть меньше 4 ГБ.
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
/** data descriptor (3) + UTF-8 имена (11) */
const FLAGS = 0x0808;

export interface ZipEntryStat {
  name: string;
  size: number;
  sha256: string;
  crc: number;
}

interface WrittenEntry extends ZipEntryStat {
  offset: number;
  compressedSize: number;
}

/** Пишет ZIP потоком в приёмник. Файлы добавляются по одному, память не копится. */
export class ZipWriter {
  private readonly out: Writable;
  private readonly entries: WrittenEntry[] = [];
  private offset = 0;
  private closed = false;

  constructor(out: Writable) {
    this.out = out;
  }

  private async put(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;
    if (!this.out.write(chunk)) await once(this.out, "drain");
  }

  /** Добавляет файл: source — буфер или поток. Возвращает размер и sha256 (для манифеста). */
  async add(name: string, source: Buffer | Readable): Promise<ZipEntryStat> {
    if (this.closed) throw new Error("ZIP уже закрыт");
    const nameBuf = Buffer.from(name, "utf8");
    const offset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(20, 4); // версия, нужная для распаковки
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(8, 8); // deflate
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
    await pipeline(input, meter, createDeflateRaw(), counter, sink);

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.put(descriptor);

    this.entries.push({ name, size, sha256: hash.digest("hex"), crc: crc >>> 0, offset, compressedSize });
    return { name, size, sha256: this.entries[this.entries.length - 1].sha256, crc: crc >>> 0 };
  }

  /** Пишет центральный каталог и закрывает поток. */
  async finish(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const cdStart = this.offset;

    for (const e of this.entries) {
      const nameBuf = Buffer.from(e.name, "utf8");
      const rec = Buffer.alloc(46);
      rec.writeUInt32LE(SIG_CENTRAL, 0);
      rec.writeUInt16LE(20, 4); // version made by
      rec.writeUInt16LE(20, 6); // version needed
      rec.writeUInt16LE(FLAGS, 8);
      rec.writeUInt16LE(8, 10); // deflate
      rec.writeUInt16LE(0, 12);
      rec.writeUInt16LE(0x21, 14);
      rec.writeUInt32LE(e.crc, 16);
      rec.writeUInt32LE(e.compressedSize, 20);
      rec.writeUInt32LE(e.size, 24);
      rec.writeUInt16LE(nameBuf.length, 28);
      rec.writeUInt16LE(0, 30); // extra
      rec.writeUInt16LE(0, 32); // comment
      rec.writeUInt16LE(0, 34); // disk
      rec.writeUInt16LE(0, 36); // internal attrs
      rec.writeUInt32LE(0, 38); // external attrs
      rec.writeUInt32LE(e.offset, 42);
      await this.put(rec);
      await this.put(nameBuf);
    }

    const cdSize = this.offset - cdStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
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
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
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
      const compressedSize = cd.readUInt32LE(p + 20);
      const size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      list.push({ name, method, crc, size, compressedSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
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
