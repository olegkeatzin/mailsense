import { useEffect, useState } from "react";
import {
  AutoComplete,
  Button,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
  message
} from "antd";
import { DeleteOutlined, SyncOutlined } from "@ant-design/icons";
import { useStore } from "../store";
import { api } from "../api";
import type { Account, AccountInput, AiConfig } from "../types";

const PROTOCOL_OPTIONS = [
  { value: "imap", label: "IMAP" },
  { value: "pop3", label: "POP3" }
];
const TLS_OPTIONS = [
  { value: "none", label: "Нет" },
  { value: "ssl", label: "SSL/TLS" },
  { value: "starttls", label: "STARTTLS" }
];
const AUTH_OPTIONS = [
  { value: "login", label: "LOGIN" },
  { value: "plain", label: "PLAIN" },
  { value: "oauth2", label: "OAuth2" }
];

function AccountTab() {
  const accounts = useStore((s) => s.accounts);
  const loadAccounts = useStore((s) => s.loadAccounts);
  const [form] = Form.useForm();
  const [testing, setTesting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const valuesToInput = (v: Record<string, unknown>): AccountInput => ({
    protocol: v.protocol as AccountInput["protocol"],
    host: String(v.host ?? ""),
    port: Number(v.port ?? 0),
    tls: v.tls as AccountInput["tls"],
    username: String(v.username ?? ""),
    password: v.password ? String(v.password) : undefined,
    authType: v.authType as AccountInput["authType"]
  });

  const closeEdit = () => {
    setEditOpen(false);
    setEditingId(null);
    form.resetFields();
  };

  const openAdd = () => {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue({ protocol: "imap", port: 993, tls: "ssl", authType: "login" });
    setEditOpen(true);
  };

  const submitAccount = async (v: Record<string, unknown>) => {
    try {
      if (editingId) {
        await api.updateAccount(editingId, valuesToInput(v));
        message.success("Аккаунт обновлён");
      } else {
        await api.createAccount(valuesToInput(v));
        message.success("Аккаунт добавлен");
      }
      closeEdit();
      await loadAccounts();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const startEdit = (a: Account) => {
    setEditingId(a.id);
    form.setFieldsValue({
      protocol: a.protocol,
      host: a.host,
      port: a.port,
      tls: a.tls,
      username: a.username,
      authType: a.authType,
      password: ""
    });
    setEditOpen(true);
  };

  const testAccount = async () => {
    const v = form.getFieldsValue();
    if (!v.host || !v.username || !v.password) {
      message.warning("Заполните сервер, логин и пароль");
      return;
    }
    setTesting(true);
    try {
      const r = await api.testAccount(valuesToInput(v));
      if (r.ok) message.success("Подключение успешно");
      else message.error(r.error || "Ошибка подключения");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const delAccount = async (id: string) => {
    await api.deleteAccount(id);
    await loadAccounts();
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Аккаунты
        </Typography.Title>
        <Button type="primary" size="small" onClick={openAdd}>
          Добавить аккаунт
        </Button>
      </div>
      <List
        dataSource={accounts}
        locale={{ emptyText: "Нет аккаунтов" }}
        renderItem={(a) => (
          <List.Item
            actions={[
              <Button key="edit" size="small" onClick={() => startEdit(a)}>
                Редактировать
              </Button>,
              <Button
                key="fetch"
                size="small"
                icon={<SyncOutlined />}
                onClick={() => void api.fetchAccount(a.id).then(() => message.success("Проверено"))}
              >
                Проверить
              </Button>,
              <Popconfirm key="del" title="Удалить аккаунт?" onConfirm={() => void delAccount(a.id)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ]}
          >
            <List.Item.Meta
              title={a.username}
              description={a.protocol.toUpperCase() + " · " + a.host + ":" + a.port + " · " + a.tls}
            />
          </List.Item>
        )}
      />

      <Modal
        open={editOpen}
        onCancel={closeEdit}
        footer={null}
        title={editingId ? "Редактировать аккаунт" : "Добавить аккаунт"}
        width={620}
      >
      <Form form={form} layout="vertical" onFinish={submitAccount}>
        <Space wrap>
          <Form.Item name="protocol" label="Протокол" style={{ minWidth: 120 }}>
            <Select options={PROTOCOL_OPTIONS} />
          </Form.Item>
          <Form.Item name="host" label="Сервер" rules={[{ required: true }]}>
            <Input placeholder="127.0.0.1" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="port" label="Порт" rules={[{ required: true }]}>
            <InputNumber min={1} max={65535} />
          </Form.Item>
          <Form.Item name="tls" label="Шифрование">
            <Select options={TLS_OPTIONS} style={{ width: 130 }} />
          </Form.Item>
        </Space>
        <Space wrap>
          <Form.Item name="username" label="Логин" rules={[{ required: true }]}>
            <Input placeholder="user@mail.test" style={{ width: 220 }} />
          </Form.Item>
          <Form.Item name="password" label="Пароль" rules={editingId ? [] : [{ required: true }]}>
            <Input.Password placeholder={editingId ? "пусто = не менять" : undefined} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item name="authType" label="Аутентификация">
            <Select options={AUTH_OPTIONS} style={{ width: 130 }} />
          </Form.Item>
        </Space>
        <Space>
          <Button type="primary" htmlType="submit">
            {editingId ? "Сохранить" : "Добавить"}
          </Button>
          <Button loading={testing} onClick={() => void testAccount()}>
            Проверить подключение
          </Button>
          <Button onClick={closeEdit}>Отмена</Button>
        </Space>
      </Form>
      </Modal>
    </div>
  );
}

function AiTab() {
  const aiConfig = useStore((s) => s.aiConfig);
  const loadAiConfig = useStore((s) => s.loadAiConfig);
  const [form] = Form.useForm();
  const [prompts, setPrompts] = useState<{ system: string; userTemplate: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (aiConfig) form.setFieldsValue(aiConfig);
  }, [aiConfig, form]);

  useEffect(() => {
    void api.promptConfig().then(setPrompts);
  }, []);

  const save = async (v: Partial<AiConfig>) => {
    try {
      await api.saveAiConfig(v);
      message.success("Настройки ИИ сохранены");
      await loadAiConfig();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const savePrompts = async () => {
    if (!prompts) return;
    try {
      await api.savePromptConfig(prompts);
      message.success("Промпты сохранены");
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const testAi = async (loadModels: boolean) => {
    const v = form.getFieldsValue();
    if (!v.baseUrl) {
      message.warning("Укажите базовый URL");
      return;
    }
    setChecking(true);
    try {
      const r = await api.testAi({
        baseUrl: String(v.baseUrl ?? ""),
        apiKey: String(v.apiKey ?? "")
      });
      if (r.ok) {
        const list = r.models ?? [];
        if (list.length) setModels(list);
        if (loadModels) {
          message.success(list.length ? "Загружено моделей: " + list.length : "Подключение успешно, но моделей не найдено");
        } else {
          message.success("Подключение успешно");
        }
      } else {
        message.error(r.error || "Ошибка подключения");
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div>
    <Form form={form} layout="vertical" onFinish={save} initialValues={aiConfig ?? {}}>
      <Form.Item name="baseUrl" label="Базовый URL (OpenAI-совместимый)">
        <Input placeholder="http://localhost:8080/v1" />
      </Form.Item>
      <Form.Item name="apiKey" label="API-ключ">
        <Input placeholder="not-needed" />
      </Form.Item>
      <Form.Item name="model" label="Модель">
        <AutoComplete
          options={models.map((m) => ({ value: m }))}
          placeholder="выберите или введите имя модели"
          filterOption={(input, option) =>
            String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())
          }
        />
      </Form.Item>
      <Form.Item name="multimodal" label="Мультимодальная модель (vision)" valuePropName="checked">
        <Switch />
      </Form.Item>
      <Form.Item name="ocrModel" label="OCR-модель (чтение PDF/изображений)">
        <AutoComplete
          options={models.map((m) => ({ value: m }))}
          placeholder="например glm-ocr (пусто = основная модель)"
          filterOption={(input, option) =>
            String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())
          }
        />
      </Form.Item>
      <Form.Item name="ocrBaseUrl" label="OCR base URL (пусто = основной)">
        <Input placeholder="пусто = основной URL" />
      </Form.Item>
      <Form.Item name="concurrency" label="Параллельность summary-модели (запросов одновременно)">
        <InputNumber min={1} max={16} style={{ width: 120 }} />
      </Form.Item>
      <Form.Item name="ocrConcurrency" label="Параллельность OCR-модели (запросов одновременно)">
        <InputNumber min={1} max={16} style={{ width: 120 }} />
      </Form.Item>
      <Space>
        <Button type="primary" htmlType="submit">
          Сохранить
        </Button>
        <Button loading={checking} onClick={() => void testAi(false)}>
          Проверить подключение
        </Button>
        <Button onClick={() => void testAi(true)}>
          Загрузить модели
        </Button>
      </Space>
    </Form>

    <Typography.Title level={5} style={{ marginTop: 24 }}>
      Промпты
    </Typography.Title>
    <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>
      Системная инструкция (правила и схема JSON):
    </Typography.Text>
    <Input.TextArea
      rows={8}
      value={prompts?.system ?? ""}
      onChange={(e) => setPrompts((p) => ({ ...(p ?? { system: "", userTemplate: "" }), system: e.target.value }))}
      style={{ marginTop: 4, fontFamily: "monospace" }}
    />
    <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 12 }}>
      Шаблон сообщения пользователя (плейсхолдеры: {"{{from}} {{subject}} {{date}} {{body}} {{attachments}} {{notes}}"}):
    </Typography.Text>
    <Input.TextArea
      rows={8}
      value={prompts?.userTemplate ?? ""}
      onChange={(e) => setPrompts((p) => ({ ...(p ?? { system: "", userTemplate: "" }), userTemplate: e.target.value }))}
      style={{ marginTop: 4, fontFamily: "monospace" }}
    />
    <Button style={{ marginTop: 12 }} onClick={() => void savePrompts()}>
      Сохранить промпты
    </Button>
    </div>
  );
}

function GeneralTab() {
  const [settings, setSettings] = useState<Record<string, string>>({});

  useEffect(() => {
    void api.settings().then(setSettings);
  }, []);

  const save = async (k: string, v: string | number | boolean) => {
    await api.saveSetting(k, String(v));
    setSettings(await api.settings());
    message.success("Сохранено");
  };

  return (
    <div>
      <Space direction="vertical" size="large">
        <div>
          <Typography.Text>Автоматический анализ новых писем</Typography.Text>
          <br />
          <Switch
            checked={settings["auto_analyze"] !== "false"}
            onChange={(v) => void save("auto_analyze", v)}
          />
        </div>
        <div>
          <Typography.Text>Интервал проверки почты (сек)</Typography.Text>
          <br />
          <InputNumber
            min={10}
            max={3600}
            value={Number(settings["pollIntervalSeconds"] || 60)}
            onChange={(v) => void save("pollIntervalSeconds", v ?? 60)}
            style={{ marginTop: 8 }}
          />
        </div>
      </Space>
    </div>
  );
}

export default function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);

  return (
    <Modal open={open} onCancel={() => setOpen(false)} footer={null} width={760} title="Настройки">
      <Tabs
        items={[
          { key: "mail", label: "Почта", children: <AccountTab /> },
          { key: "ai", label: "ИИ", children: <AiTab /> },
          { key: "general", label: "Общие", children: <GeneralTab /> }
        ]}
      />
    </Modal>
  );
}
