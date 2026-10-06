import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Descriptions, Form, Input, Modal, Select, Space, Tag, message } from "antd";
import { ExportOutlined, SaveOutlined } from "@ant-design/icons";
import { api } from "../api";
import { useStore } from "../store";
import type { NumberingState } from "../types";

/**
 * Настройки нумерации: префикс, шаблон и периодичность сброса счётчика.
 *
 * Здесь же — закрытие года выгрузкой: пока год не выгружен, следующий не открыть.
 */
export default function NumberingTab() {
  const can = useStore((s) => s.can);
  const [state, setState] = useState<NumberingState | null>(null);
  const [prefix, setPrefix] = useState("");
  const [template, setTemplate] = useState("");
  const [reset, setReset] = useState<"year" | "never">("year");
  const [saving, setSaving] = useState(false);
  const [exportYear, setExportYear] = useState(String(new Date().getFullYear()));
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const editable = can("settings.manage");

  const load = useCallback(async () => {
    try {
      const s = await api.numbering();
      setState(s);
      const incoming = s.rules.find((r) => r.stream === "incoming");
      if (incoming) {
        setPrefix(incoming.prefix);
        setTemplate(incoming.template ?? "");
        setReset(incoming.reset);
      }
    } catch (err) {
      message.error("Не удалось загрузить настройки нумерации: " + (err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveNumbering({ stream: "incoming", prefix, reset, template: template || null });
      message.success("Правило нумерации сохранено");
      await load();
    } catch (err) {
      // Смена префикса посреди года запрещена: в журнале оказались бы «вх1» и «ВХ-2».
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const archive = (period: string) => {
    Modal.confirm({
      title: "Выгрузить " + period + " год в архив?",
      content:
        "После выгрузки год считается закрытым, и откроется следующий. Отменить это нельзя — " +
        "именно так журнал защищён от «забыли выгрузить прошлый год».",
      okText: "Выгрузить и закрыть год",
      cancelText: "Отмена",
      onOk: async () => {
        try {
          const res = await api.archivePeriod(period);
          message.success("Год " + res.period + " закрыт, документов: " + res.documentCount);
          await load();
        } catch (err) {
          message.error((err as Error).message);
        }
      }
    });
  };

  /** Год выгрузки: открытый год журнала и текущий календарный. */
  const yearOptions = Array.from(
    new Set([state?.openPeriod, String(new Date().getFullYear())].filter((y): y is string => !!y))
  ).map((y) => ({ value: y, label: y }));

  const exportUrl = api.journalArchiveUrl(exportYear);
  // Текст предупреждения готовит сервер (docflow): при досрочном выходе из обхода
  // сумма — нижняя граница, и там честно написано «не менее».
  const volumeWarning = state?.archiveWarning?.text ?? null;

  const pickImport = (file: File | null) => {
    if (!file) return;
    Modal.confirm({
      title: "Импортировать архив " + file.name + "?",
      content:
        "Операция ПИШЕТ в журнал: недостающие записи (документы, поручения, история шагов, " +
        "следы аудита) будут добавлены. Существующие записи не изменяются и не дублируются. " +
        "Отменить импорт нельзя.",
      okText: "Импортировать",
      cancelText: "Отмена",
      onOk: async () => {
        setImporting(true);
        try {
          const res = await api.importJournalArchive(file);
          message.success(
            "Архив " + res.period + " импортирован: добавлено документов " +
              (res.inserted.documents ?? 0) + ", пропущено существующих " + (res.skipped.documents ?? 0)
          );
          await load();
        } catch (err) {
          message.error("Импорт отклонён: " + (err as Error).message);
        } finally {
          setImporting(false);
          if (fileRef.current) fileRef.current.value = "";
        }
      }
    });
  };

  const example = (template || "{prefix}{n}")
    .split("{prefix}").join(prefix || "вх")
    .split("{year}").join(String(new Date().getFullYear()))
    .split("{n}").join("1");

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      {state?.blockedReason && <Alert type="warning" showIcon message={state.blockedReason} />}

      <Card size="small" title="Правило нумерации входящих">
        <Form layout="vertical" size="small" disabled={!editable}>
          <Space size="middle" align="start" wrap>
            <Form.Item label="Префикс" style={{ width: 160 }}>
              <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="вх" />
            </Form.Item>
            <Form.Item label="Сброс счётчика" style={{ width: 220 }}>
              <Select
                value={reset}
                onChange={setReset}
                options={[
                  { value: "year", label: "Каждый год" },
                  { value: "never", label: "Не сбрасывать" }
                ]}
              />
            </Form.Item>
            <Form.Item
              label="Шаблон номера"
              style={{ width: 260 }}
              tooltip="Доступны подстановки {prefix}, {year}, {n}. Пусто — «{prefix}{n}»."
            >
              <Input value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="{prefix}{n}" />
            </Form.Item>
          </Space>
        </Form>

        <div style={{ marginBottom: 8 }}>
          Следующий документ получит номер: <Tag color="blue">{example}</Tag>
        </div>

        {editable && (
          <Button type="primary" size="small" icon={<SaveOutlined />} loading={saving} onClick={save}>
            Сохранить
          </Button>
        )}
        <div style={{ color: "#595959", marginTop: 8, fontSize: 12 }}>
          Префикс и шаблон нельзя менять, пока в текущем году есть документы: иначе в одном журнале
          окажутся номера разного вида. Периодичность сброса менять можно — она влияет только на будущее.
        </div>
      </Card>

      <Card size="small" title="Архив года одним файлом">
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          <Space wrap>
            <Select style={{ width: 120 }} value={exportYear} onChange={setExportYear} options={yearOptions} />
            {/*
              Скачивание — обычной ссылкой: файл может быть большим, браузер качает его
              потоком и показывает ход сам. Кнопка с href и есть эта ссылка.
            */}
            <Button icon={<ExportOutlined />} href={exportUrl} target="_blank" rel="noreferrer">
              Выгрузить журнал за год
            </Button>
            <Button loading={importing} onClick={() => fileRef.current?.click()}>
              Импортировать архив…
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              style={{ display: "none" }}
              onChange={(e) => pickImport(e.target.files?.[0] ?? null)}
            />
          </Space>

          {volumeWarning && (
            <Alert
              type={state?.archiveWarning?.level === "over" ? "error" : "warning"}
              showIcon
              message="Объём архива года"
              description={volumeWarning}
            />
          )}
          <div style={{ color: "#595959", fontSize: 12 }}>
            Выгрузка идёт потоком: сервер не собирает архив в памяти, а браузер сохраняет файл по готовности —
            для большого года это занимает время. Импорт пишет записи в журнал и требует права архивации.
          </div>
        </Space>
      </Card>

      <Card size="small" title="Годы журнала">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="Открытый год">
            {state?.openPeriod ?? "журнал пуст"}
          </Descriptions.Item>
          <Descriptions.Item label="Выгружены в архив">
            {state?.archivedPeriods.length ? state.archivedPeriods.join(", ") : "нет"}
          </Descriptions.Item>
        </Descriptions>

        {can("journal.archive") && state?.openPeriod && (
          <Space>
            <Button
              size="small"
              icon={<ExportOutlined />}
              href={api.journalExportUrl({ period: state.openPeriod })}
              target="_blank"
            >
              Выгрузить журнал {state.openPeriod} в Excel
            </Button>
            <Button size="small" danger onClick={() => archive(state.openPeriod!)}>
              Выгрузить и закрыть {state.openPeriod} год
            </Button>
          </Space>
        )}
      </Card>
    </Space>
  );
}