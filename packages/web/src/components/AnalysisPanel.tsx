import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  DatePicker,
  Input,
  Select,
  Slider,
  Space,
  Switch,
  Tag,
  Typography,
  message
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { useStore } from "../store";
import type { Category, EmailView } from "../types";
import { categoryLabel, formatDate, priorityColor, priorityLabel } from "../utils";

const CATEGORY_OPTIONS = [
  { value: "work", label: "Рабочее" },
  { value: "personal", label: "Личное" },
  { value: "spam", label: "Спам" }
];

export default function AnalysisPanel({ view }: { view: EmailView }) {
  const updateAnalysis = useStore((s) => s.updateAnalysis);
  const a = view.analysis;

  const [summary, setSummary] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [priority, setPriority] = useState(3);
  const [urgent, setUrgent] = useState(false);
  const [eventDate, setEventDate] = useState("");
  const [category, setCategory] = useState<Category>("personal");
  const [inputTag, setInputTag] = useState("");

  useEffect(() => {
    setSummary(a?.summary ?? "");
    setTags(a?.tags ?? []);
    setPriority(a?.priority ?? 3);
    setUrgent(a?.urgent ?? false);
    setEventDate(a?.eventDate ?? "");
    setCategory(a?.category ?? "personal");
  }, [view.id, a?.updatedAt]);

  if (!a) {
    if (view.analysisStatus === "processing") {
      return <Alert type="info" message="Анализ выполняется…" showIcon />;
    }
    if (view.analysisStatus === "error") {
      return (
        <Alert
          type="error"
          message="Ошибка анализа"
          description="Нажмите «Анализировать», чтобы повторить."
          showIcon
        />
      );
    }
    return (
      <Alert
        type="warning"
        message="Анализ ещё не выполнен"
        description="Нажмите «Анализировать», чтобы получить сводку, теги и приоритет."
        showIcon
      />
    );
  }

  const save = async () => {
    try {
      await updateAnalysis({
        summary,
        tags,
        priority,
        urgent,
        eventDate: eventDate || null,
        category
      });
      message.success("Сохранено");
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const addTag = () => {
    const t = inputTag.trim();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setInputTag("");
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ marginBottom: 16, fontSize: 12, color: "#888" }}>
        Модель: {a.modelUsed || "—"} · обновлено {formatDate(a.updatedAt)}
      </div>

      <Typography.Title level={5} style={{ marginTop: 0 }}>
        Краткая суть
      </Typography.Title>
      <Input.TextArea
        rows={4}
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder="Краткая суть письма"
      />

      <Typography.Title level={5} style={{ marginTop: 16 }}>
        Теги
      </Typography.Title>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {tags.map((t) => (
          <Tag
            key={t}
            closable
            onClose={() => setTags(tags.filter((x) => x !== t))}
            style={{ marginRight: 0 }}
          >
            {t}
          </Tag>
        ))}
        <div style={{ display: "flex", gap: 4 }}>
          <Input
            size="small"
            style={{ width: 150 }}
            value={inputTag}
            onChange={(e) => setInputTag(e.target.value)}
            onPressEnter={addTag}
            placeholder="Добавить тег"
          />
          <Button size="small" icon={<PlusOutlined />} onClick={addTag}>
            Добавить
          </Button>
        </div>
      </div>

      <Typography.Title level={5} style={{ marginTop: 16 }}>
        Категория
      </Typography.Title>
      <Select
        value={category}
        onChange={(v) => setCategory(v)}
        options={CATEGORY_OPTIONS}
        style={{ width: 180 }}
      />

      <Typography.Title level={5} style={{ marginTop: 16 }}>
        Приоритет: {priority} ({priorityLabel(priority)})
      </Typography.Title>
      <Slider
        min={1}
        max={5}
        value={priority}
        onChange={setPriority}
        style={{ maxWidth: 320 }}
        trackStyle={{ background: priorityColor(priority) }}
      />

      <div style={{ marginTop: 8 }}>
        <Space>
          <Typography.Text>Требует немедленного ответа:</Typography.Text>
          <Switch checked={urgent} onChange={setUrgent} />
        </Space>
      </div>

      <Typography.Title level={5} style={{ marginTop: 16 }}>
        Дата события
      </Typography.Title>
      <DatePicker
        value={eventDate ? dayjs(eventDate) : null}
        onChange={(d) => setEventDate(d ? d.format("YYYY-MM-DD") : "")}
        placeholder="Выберите дату"
        format="YYYY-MM-DD"
        style={{ width: 220 }}
      />

      <div style={{ marginTop: 24 }}>
        <Button type="primary" onClick={() => void save()}>
          Сохранить изменения
        </Button>
      </div>
    </div>
  );
}
