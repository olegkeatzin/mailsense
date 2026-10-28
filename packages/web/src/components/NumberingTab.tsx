import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Descriptions, Form, Input, Modal, Select, Space, Tag, message } from "antd";
import { ExportOutlined, SaveOutlined } from "@ant-design/icons";
import { api, saveBlob } from "../api";
import { useStore } from "../store";
import type { NumberingState } from "../types";
import { humanError } from "../utils/humanError";

/**
 * Настройки нумерации: префикс, шаблон и периодичность сброса счётчика.
 *
 * Здесь же — закрытие года выгрузкой: пока год не выгружен, следующий не открыть.
 */
/**
 * Единственный поток, которым управляет экран (Р22).
 *
 * Журнал — только входящие: ТЗ просит цифровизацию бумажной книги входящих, а поток
 * «исходящие» процессом 0.1.4 не используется. Настраивать поток, которого нет, нельзя,
 * поэтому правило берём и сохраняем ТОЛЬКО по этому имени, а чужие потоки из ответа
 * сервера экран не показывает. Данные и правило «исх» в базе при этом не трогаем.
 */
const MANAGED_STREAM = "incoming";

export default function NumberingTab() {
  const can = useStore((s) => s.can);
  const [state, setState] = useState<NumberingState | null>(null);
  const [prefix, setPrefix] = useState("");
  const [template, setTemplate] = useState("");
  const [reset, setReset] = useState<"year" | "never">("year");
  const [saving, setSaving] = useState(false);
  const [exportYear, setExportYear] = useState(String(new Date().getFullYear()));
  const [importing, setImporting] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Закрытие года: подтверждение вводом года + текст отказа от сервера.
  const [closeOpen, setCloseOpen] = useState(false);
  const [closePeriod, setClosePeriod] = useState<string | null>(null);
  const [closeConfirm, setCloseConfirm] = useState("");
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  // Отмена закрытия: причина обязательна, доступна только администратору.
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenYear, setReopenYear] = useState<string>("");
  const [reopenConfirm, setReopenConfirm] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);

  const editable = can("settings.manage");

  const load = useCallback(async () => {
    try {
      const s = await api.numbering();
      setState(s);
      const incoming = s.rules.find((r) => r.stream === MANAGED_STREAM);
      if (incoming) {
        setPrefix(incoming.prefix);
        setTemplate(incoming.template ?? "");
        setReset(incoming.reset);
      }
    } catch (err) {
      message.error("Не удалось загрузить настройки нумерации: " + humanError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveNumbering({ stream: MANAGED_STREAM, prefix, reset, template: template || null });
      message.success("Правило нумерации сохранено");
      await load();
    } catch (err) {
      // Смена префикса посреди года запрещена: в журнале оказались бы «вх1» и «ВХ-2».
      message.error(humanError(err));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Закрытие года: подтверждение ВВОДОМ ГОДА, а не «ОК».
   * «ОК» нажимают не глядя, а чтобы вписать год, надо прочитать, что именно закрываешь.
   */
  const openClose = (period: string) => {
    setClosePeriod(period);
    setCloseConfirm("");
    setCloseError(null);
    setCloseOpen(true);
  };

  const confirmClose = async () => {
    if (!closePeriod || closeConfirm !== closePeriod) return;
    setClosing(true);
    setCloseError(null);
    try {
      const res = await api.archivePeriod(closePeriod, closeConfirm);
      message.success("Год " + res.period + " закрыт, документов: " + res.documentCount);
      setCloseOpen(false);
      await load();
    } catch (err) {
      // Показываем ОТВЕТ СЕРВЕРА как есть: он говорит «год НЕ закрыт» и называет причину.
      // Собирать формулировку в клиенте нельзя — разойдётся с сервером.
      setCloseError(humanError(err));
    } finally {
      setClosing(false);
    }
  };

  const openReopen = (period: string) => {
    setReopenYear(period);
    setReopenConfirm("");
    setReopenReason("");
    setReopenError(null);
    setReopenOpen(true);
  };

  const confirmReopen = async () => {
    if (!reopenYear || reopenConfirm !== reopenYear || !reopenReason.trim()) return;
    setReopening(true);
    setReopenError(null);
    try {
      const res = await api.reopenPeriod(reopenYear, reopenConfirm, reopenReason.trim());
      message.success("Закрытие " + res.period + " года отменено — год снова открыт");
      setReopenOpen(false);
      await load();
    } catch (err) {
      setReopenError(humanError(err));
    } finally {
      setReopening(false);
    }
  };

  /** Год выгрузки: открытый год журнала и текущий календарный. */
  const yearOptions = Array.from(
    new Set([state?.openPeriod, String(new Date().getFullYear())].filter((y): y is string => !!y))
  ).map((y) => ({ value: y, label: y }));



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
          message.error("Импорт отклонён: " + humanError(err));
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
          {/* Это ПРИМЕР по настройкам формы, а не номер из базы: обещать факт нельзя — база
              выдаёт свой счётчик, и он не зависит от того, что набрано здесь. */}
          Пример номера по этим настройкам: <Tag color="blue">{example}</Tag>. Настоящий номер присваивается
          при регистрации документа.
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
              Скачиваем через fetch с сессией: обычная ссылка открывала системный браузер,
              где cookie документооборота нет и сервер отвечал «Требуется вход».
            */}
            <Button
              icon={<ExportOutlined />}
              loading={archiving}
              onClick={() => {
                setArchiving(true);
                void api
                  .journalArchiveDownload(exportYear)
                  .then((file) => saveBlob(file.blob, file.filename))
                  .catch((e) => message.error("Не удалось выгрузить архив: " + humanError(e)))
                  .finally(() => setArchiving(false));
              }}
            >
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
              loading={exportingExcel}
              onClick={() => {
                setExportingExcel(true);
                void api
                  .journalExport({ period: state.openPeriod! })
                  .then((file) => saveBlob(file.blob, file.filename))
                  .catch((e) => message.error("Не удалось выгрузить журнал: " + humanError(e)))
                  .finally(() => setExportingExcel(false));
              }}
            >
              Выгрузить журнал {state.openPeriod} в Excel
            </Button>
            <Button size="small" danger onClick={() => openClose(state.openPeriod!)}>
              Выгрузить и закрыть {state.openPeriod} год
            </Button>
          </Space>
        )}
      </Card>

      {/*
        Отмена закрытия года — не «откат ошибки», а штатный путь для случая «поздно принесли
        письмо за прошлый год»: закрытый год документов не принимает.
        Право отдельное (journal.reopen): кто действует и кто отменяет — разные люди.
      */}
      {can("journal.reopen") && state && state.archivedPeriods.length > 0 && (
        <Card size="small" title="Отмена закрытия года">
          <Space direction="vertical" size="small" style={{ width: "100%" }}>
            {state.reopenablePeriods.length === 0 ? (
              <Alert
                type="info"
                showIcon
                message="Отмена недоступна"
                description={
                  "В году после закрытого уже зарегистрированы документы: номера выданы, откатить нумерацию " +
                  "нельзя. Отмена возможна только до первого документа нового года."
                }
              />
            ) : (
              <Space wrap>
                <Select
                  style={{ width: 120 }}
                  value={reopenYear || state.reopenablePeriods[0]}
                  onChange={setReopenYear}
                  options={state.reopenablePeriods.map((y) => ({ value: y, label: y }))}
                />
                {/* Многоточие как у «Импортировать архив…»: кнопка открывает диалог,
                    а не выполняет действие сразу — и не путается с кнопкой подтверждения. */}
                <Button
                  size="small"
                  danger
                  onClick={() => openReopen(reopenYear || state.reopenablePeriods[0])}
                >
                  Отменить закрытие…
                </Button>
                <span style={{ color: "#595959", fontSize: 12 }}>
                  Год снова начнёт принимать документы; закрыть его заново можно после повторной выгрузки.
                </span>
              </Space>
            )}
          </Space>
        </Card>
      )}

      {/* Закрытие года: подтверждение вводом года. */}
      <Modal
        open={closeOpen}
        title={closePeriod ? "Закрыть " + closePeriod + " год?" : "Закрыть год?"}
        okText="Закрыть год"
        cancelText="Отмена"
        confirmLoading={closing}
        okButtonProps={{ disabled: !closePeriod || closeConfirm !== closePeriod }}
        onOk={confirmClose}
        onCancel={() => setCloseOpen(false)}
      >
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          {closeError && <Alert type="error" showIcon message={closeError} />}
          <div>
            Сначала будет сделан снимок года (архив одним файлом). Если снимок не удастся, год НЕ закроется.
            Затем год станет закрытым: новые документы в него не регистрируются, а открыть его заново можно
            только отменой закрытия — и лишь пока в новом году нет документов.
          </div>
          <div>
            Для подтверждения введите год <b>{closePeriod}</b>:
          </div>
          <Input
            value={closeConfirm}
            onChange={(e) => setCloseConfirm(e.target.value)}
            placeholder={closePeriod ?? ""}
            aria-label="Подтверждение года"
          />
        </Space>
      </Modal>

      {/* Отмена закрытия: причина обязательна — отмена не бывает молчаливой. */}
      <Modal
        open={reopenOpen}
        title={reopenYear ? "Отменить закрытие " + reopenYear + " года?" : "Отменить закрытие года?"}
        okText="Отменить закрытие"
        cancelText="Отмена"
        confirmLoading={reopening}
        okButtonProps={{
          disabled: !reopenYear || reopenConfirm !== reopenYear || !reopenReason.trim()
        }}
        onOk={confirmReopen}
        onCancel={() => setReopenOpen(false)}
      >
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          {reopenError && <Alert type="error" showIcon message={reopenError} />}
          <div>
            Год снова станет открытым: в него можно будет зарегистрировать письмо, пришедшее задним числом.
            Повторно закрыть год можно будет после новой выгрузки.
          </div>
          <div>
            Для подтверждения введите год <b>{reopenYear}</b>:
          </div>
          <Input
            value={reopenConfirm}
            onChange={(e) => setReopenConfirm(e.target.value)}
            placeholder={reopenYear}
            aria-label="Подтверждение года отмены"
          />
          <Input.TextArea
            value={reopenReason}
            onChange={(e) => setReopenReason(e.target.value)}
            rows={2}
            placeholder="Почему отменяем закрытие (попадёт в аудит)"
            aria-label="Причина отмены"
          />
        </Space>
      </Modal>
    </Space>
  );
}