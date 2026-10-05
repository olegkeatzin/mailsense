import { useCallback, useEffect, useState } from "react";
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
        <div style={{ color: "#888", marginTop: 8, fontSize: 12 }}>
          Префикс и шаблон нельзя менять, пока в текущем году есть документы: иначе в одном журнале
          окажутся номера разного вида. Периодичность сброса менять можно — она влияет только на будущее.
        </div>
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