import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import {
  analyzeAllPending,
  analyzeEmail,
  analyzeEmails,
  analyzeRange,
  cancelAnalysis,
  classifyKind,
  createAccount,
  deleteEmails,
  decryptPassword,
  fetchEmails,
  getAccountById,
  getAccounts,
  getAiConfig,
  getEmailView,
  getProgress,
  getPromptSettings,
  importEmails,
  listAttachments,
  listEmailsWithAnalysis,
  removeAccount,
  renderPreviewImage,
  setAiConfig,
  setEmailFolder,
  setEmailsFolder,
  setExternalNumber,
  setPromptSettings,
  setSettingValue,
  getSettingValue,
  stopAnalysis,
  testAiConnection,
  testConnection,
  updateAccountById,
  upsertAnalysis,
  getAllSettings,
  type AccountInput,
  type AnalysisStatus,
  type Category
} from "@mailsense/core";
import { logger } from "@mailsense/core";

function asyncHandler(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

function accountDto(a: {
  id: string;
  protocol: string;
  host: string;
  port: number;
  tls: string;
  username: string;
  authType: string;
  settings: unknown;
}) {
  return {
    id: a.id,
    protocol: a.protocol,
    host: a.host,
    port: a.port,
    tls: a.tls,
    username: a.username,
    authType: a.authType,
    settings: a.settings
  };
}

/** Экранирует спецсимволы для iCalendar (RFC 5545). */
function escapeIcs(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

export function createApp(options: { webDist?: string } = {}): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "100mb" }));

  // -------- health / settings --------
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "mailsense", time: new Date().toISOString() });
  });

  app.get("/api/settings", (_req, res) => {
    res.json(getAllSettings());
  });

  app.put("/api/settings", (req, res) => {
    const body = req.body ?? {};
    if (body && typeof body === "object") {
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === "string") setSettingValue(k, v);
      }
    }
    res.json(getAllSettings());
  });

  app.get("/api/ai/config", (_req, res) => {
    res.json(getAiConfig());
  });

  app.put("/api/ai/config", (req, res) => {
    setAiConfig(req.body ?? {});
    res.json(getAiConfig());
  });

  app.get("/api/ai/prompt", (_req, res) => {
    res.json(getPromptSettings());
  });

  app.put("/api/ai/prompt", (req, res) => {
    setPromptSettings(req.body ?? {});
    res.json(getPromptSettings());
  });

  app.post(
    "/api/ai/test",
    asyncHandler(async (req, res) => {
      const cfg = getAiConfig();
      const baseUrl = (req.body?.baseUrl as string) || cfg.baseUrl;
      const apiKey = (req.body?.apiKey as string) ?? cfg.apiKey;
      const result = await testAiConnection({ baseUrl, apiKey, timeoutMs: cfg.timeoutMs });
      res.json(result);
    })
  );

  app.get("/api/analysis/progress", (_req, res) => {
    res.json(getProgress());
  });

  // -------- accounts --------
  app.get("/api/accounts", (_req, res) => {
    res.json(getAccounts().map(accountDto));
  });

  app.post("/api/accounts", (req, res) => {
    const input = req.body as AccountInput;
    const account = createAccount(input);
    res.status(201).json(accountDto(account));
  });

  app.put("/api/accounts/:id", (req, res) => {
    const input = req.body as AccountInput;
    const updated = updateAccountById(req.params.id, input);
    if (!updated) return res.status(404).json({ error: "Аккаунт не найден" });
    res.json(accountDto(updated));
  });

  app.delete("/api/accounts/:id", (req, res) => {
    removeAccount(req.params.id);
    res.json({ ok: true });
  });

  app.post(
    "/api/accounts/test",
    asyncHandler(async (req, res) => {
      const result = await testConnection(req.body as AccountInput);
      res.json(result);
    })
  );

  app.post(
    "/api/accounts/:id/fetch",
    asyncHandler(async (req, res) => {
      const result = await fetchEmails(req.params.id, {
        since: (req.body?.since as string) || undefined,
        until: (req.body?.until as string) || undefined
      });
      res.json(result);
    })
  );

  app.post(
    "/api/import",
    asyncHandler(async (req, res) => {
      const accountId = (req.body?.accountId as string) || "";
      const folder = (req.body?.folder as string) || "INBOX";
      const rawFiles = (req.body?.files as unknown[]) ?? [];
      if (!accountId || rawFiles.length === 0) {
        return res.status(400).json({ error: "Укажите accountId и файлы" });
      }
      const files = rawFiles
        .filter((f) => f && typeof (f as Record<string, unknown>).filename === "string" && typeof (f as Record<string, unknown>).data === "string")
        .map((f) => {
          const o = f as Record<string, unknown>;
          return { filename: o.filename as string, data: Buffer.from(o.data as string, "base64") };
        });
      const result = await importEmails(accountId, folder, files);
      res.json(result);
    })
  );

  // -------- emails --------
  app.get("/api/emails", (req, res) => {
    const q = req.query;
    res.json(
      listEmailsWithAnalysis({
        folder: (q.folder as string) || undefined,
        accountId: (q.accountId as string) || undefined,
        categories:
          typeof q.categories === "string" && q.categories
            ? (q.categories.split(",").filter(Boolean) as Category[])
            : undefined,
        minPriority: q.minPriority ? Number(q.minPriority) : undefined,
        tag: (q.tag as string) || undefined,
        hasEvent: q.hasEvent === "1",
        status: (q.status as AnalysisStatus) || undefined,
        q: (q.q as string) || undefined,
        sortBy: (q.sortBy as "date" | "priority") || undefined,
        sortDir: (q.sortDir as "asc" | "desc") || undefined
      })
    );
  });

  app.post("/api/emails/bulk/analyze", (req, res) => {
    const n = analyzeEmails((req.body?.ids as string[]) ?? []);
    res.json({ queued: n });
  });

  app.get("/api/emails/:id", (req, res) => {
    const view = getEmailView(req.params.id);
    if (!view) return res.status(404).json({ error: "Письмо не найдено" });
    res.json(view);
  });

  app.patch("/api/emails/:id/folder", (req, res) => {
    const folder = (req.body?.folder as string) ?? "INBOX";
    setEmailFolder(req.params.id, folder);
    res.json({ ok: true });
  });

  app.patch("/api/emails/:id/external-number", (req, res) => {
    const value = typeof req.body?.externalNumber === "string" ? req.body.externalNumber.trim() || null : null;
    setExternalNumber(req.params.id, value);
    res.json({ ok: true, externalNumber: value });
  });

  app.get("/api/emails/:id/ics", (req, res) => {
    const view = getEmailView(req.params.id);
    if (!view) return res.status(404).json({ error: "Письмо не найдено" });
    const eventDate = view.analysis?.eventDate ?? null;
    if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return res.status(400).json({ error: "У письма нет даты события" });
    }

    const summary = view.subject || "(без темы)";
    const parts = [view.analysis?.summary || ""];
    if (view.externalNumber) parts.push("Внешний номер: " + view.externalNumber);
    if (view.from) parts.push("От: " + (view.from.name || view.from.address));
    const description = parts.filter(Boolean).join("\n");

    const dtstart = eventDate.replace(/-/g, "");
    const end = new Date(eventDate + "T00:00:00Z");
    end.setUTCDate(end.getUTCDate() + 1);
    const dtend = end.toISOString().slice(0, 10).replace(/-/g, "");

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//MailSense//MailSense//RU",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      "UID:" + view.id + "@mailsense",
      "DTSTAMP:" + new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z",
      "DTSTART;VALUE=DATE:" + dtstart,
      "DTEND;VALUE=DATE:" + dtend,
      "SUMMARY:" + escapeIcs(summary),
      "DESCRIPTION:" + escapeIcs(description),
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename*=UTF-8''" + encodeURIComponent("event-" + dtstart + ".ics")
    );
    res.send(ics);
  });

  app.post("/api/emails/:id/analyze", (req, res) => {
    analyzeEmail(req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/emails/analyze-all", (req, res) => {
    const n = analyzeAllPending();
    res.json({ queued: n });
  });

  app.post("/api/emails/analyze-range", (req, res) => {
    const n = analyzeRange(
      (req.body?.since as string) || undefined,
      (req.body?.until as string) || undefined,
      (req.body?.accountIds as string[]) || undefined
    );
    res.json({ queued: n });
  });

  app.post("/api/emails/analyze-stop", (_req, res) => {
    const cleared = stopAnalysis();
    res.json({ cleared });
  });

  app.post("/api/emails/bulk/folder", (req, res) => {
    const ids = (req.body?.ids as string[]) ?? [];
    const folder = (req.body?.folder as string) ?? "INBOX";
    setEmailsFolder(ids, folder);
    res.json({ ok: true });
  });

  app.post(
    "/api/emails/bulk/delete",
    asyncHandler(async (req, res) => {
      const ids = (req.body?.ids as string[]) ?? [];
      cancelAnalysis(ids);
      const files: string[] = [];
      for (const id of ids) {
        for (const att of listAttachments(id)) {
          if (att.storagePath && fs.existsSync(att.storagePath)) files.push(att.storagePath);
        }
      }
      const deleted = deleteEmails(ids);
      for (const f of files) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
      res.json({ deleted });
    })
  );

  app.patch("/api/analysis/:emailId", (req, res) => {
    const view = getEmailView(req.params.emailId);
    if (!view) return res.status(404).json({ error: "Письмо не найдено" });
    const body = req.body ?? {};
    const current = view.analysis;
    const category = (body.category as Category) ?? current?.category ?? "personal";
    const result = upsertAnalysis({
      emailId: req.params.emailId,
      summary: body.summary ?? current?.summary ?? "",
      tags: body.tags ?? current?.tags ?? [],
      priority: body.priority ?? current?.priority ?? 3,
      urgent: body.urgent ?? current?.urgent ?? false,
      eventDate: body.eventDate ?? current?.eventDate ?? null,
      category,
      rawResponse: current?.rawResponse ?? "",
      modelUsed: current?.modelUsed ?? "",
      attachments: current?.attachments ?? []
    });
    // Категория «спам» → папка «Спам»; перевыбор в другую категорию → «Входящие».
    if (body.category !== undefined && body.category !== current?.category) {
      setEmailFolder(req.params.emailId, category === "spam" ? "SPAM" : "INBOX");
    }
    res.json(result);
  });

  // -------- attachments --------
  app.get(
    "/api/emails/:id/attachments/:attId/file",
    asyncHandler(async (req, res) => {
      const atts = listAttachments(req.params.id);
      const att = atts.find((a) => a.id === req.params.attId);
      if (!att || !att.storagePath || !fs.existsSync(att.storagePath)) {
        return res.status(404).json({ error: "Файл не найден" });
      }
      const inline = req.query.inline === "1" || /^image\//.test(att.mimeType);
      res.setHeader("Content-Type", att.mimeType);
      if (inline) {
        res.setHeader("Content-Disposition", "inline; filename*=UTF-8''" + encodeURIComponent(att.filename));
      } else {
        res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(att.filename));
      }
      fs.createReadStream(att.storagePath).pipe(res);
    })
  );

  app.get(
    "/api/emails/:id/attachments/:attId/preview",
    asyncHandler(async (req, res) => {
      const atts = listAttachments(req.params.id);
      const att = atts.find((a) => a.id === req.params.attId);
      if (!att || !att.storagePath || !fs.existsSync(att.storagePath)) {
        return res.status(404).json({ error: "Вложение не найдено" });
      }
      const kind = classifyKind(att.mimeType, att.filename);
      const page = Number(req.query.page) || 1;
      const content = fs.readFileSync(att.storagePath);
      const buf = await renderPreviewImage(kind, content, page);
      if (!buf) return res.status(415).json({ error: "Предпросмотр недоступен для этого типа" });
      res.setHeader("Content-Type", kind === "pdf" ? "image/png" : att.mimeType);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(buf);
    })
  );

  // -------- static SPA (собранный web) --------
  const webDist = options.webDist;
  if (webDist && fs.existsSync(path.join(webDist, "index.html"))) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  // -------- error handler --------
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error({ err: err.message }, "Ошибка API");
      res.status(500).json({ error: err.message });
    }
  );

  return app;
}

export { decryptPassword };
