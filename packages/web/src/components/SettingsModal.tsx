import { useEffect, useState } from "react";
import {
  AutoComplete,
  Button,
  Collapse,
  Divider,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Tabs,
  Typography,
  message
} from "antd";
import { DeleteOutlined, PlusOutlined, SyncOutlined } from "@ant-design/icons";
import { useStore } from "../store";
import RichTextEditor from "./RichTextEditor";
import { escapeHtml, htmlToPlainText } from "../utils/text";
import { api } from "../api";
import type { Account, AccountInput, AiConfig, DirectoryStatus, LdapSettings, Template } from "../types";

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
  const [testingSmtp, setTestingSmtp] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const editingAccount = accounts.find((a) => a.id === editingId) ?? null;

  const valuesToInput = (v: Record<string, unknown>): AccountInput => ({
    protocol: v.protocol as AccountInput["protocol"],
    host: String(v.host ?? ""),
    port: Number(v.port ?? 0),
    tls: v.tls as AccountInput["tls"],
    username: String(v.username ?? ""),
    password: v.password ? String(v.password) : undefined,
    authType: v.authType as AccountInput["authType"],
    // Сохраняем прежние settings (rejectUnauthorized и т.п.) и дописываем настройки отправки.
    settings: {
      ...(editingAccount?.settings ?? {}),
      displayName: v.displayName ? String(v.displayName) : "",
      // Подпись редактируется визуальным редактором; plain-текст храним как фолбэк для text/plain.
      signatureHtml: v.signatureHtml ? String(v.signatureHtml) : null,
      signature: v.signatureHtml ? htmlToPlainText(String(v.signatureHtml)) : "",
      signatureEnabled: v.signatureEnabled !== false,
      signaturePosition: v.signaturePosition === "above" ? "above" : "below",
      signatureDelimiter: v.signatureDelimiter !== false,
      replyQuote: v.replyQuote !== false,
      replyAttribution: v.replyAttribution === "en" ? "en" : "ru",
      forwardAttachments: v.forwardAttachments !== false
    },
    smtpHost: v.smtpHost ? String(v.smtpHost) : null,
    smtpPort: v.smtpPort ? Number(v.smtpPort) : null,
    smtpTls: (v.smtpTls as AccountInput["smtpTls"]) ?? null,
    smtpUsername: v.smtpUsername ? String(v.smtpUsername) : null,
    smtpPassword: v.smtpPassword ? String(v.smtpPassword) : null,
    smtpAuthType: (v.smtpAuthType as AccountInput["smtpAuthType"]) ?? null
  });

  const closeEdit = () => {
    setEditOpen(false);
    setEditingId(null);
    form.resetFields();
  };

  const openAdd = () => {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue({
      protocol: "imap",
      port: 993,
      tls: "ssl",
      authType: "login",
      smtpPort: 587,
      smtpTls: "starttls",
      smtpAuthType: "login",
      displayName: "",
      signature: "",
      signatureHtml: "",
      signatureEnabled: true,
      signaturePosition: "below",
      signatureDelimiter: true,
      replyQuote: true,
      replyAttribution: "ru",
      forwardAttachments: true
    });
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
      password: "",
      smtpHost: a.smtpHost ?? "",
      smtpPort: a.smtpPort ?? 587,
      smtpTls: a.smtpTls ?? "starttls",
      smtpUsername: a.smtpUsername ?? "",
      smtpAuthType: a.smtpAuthType ?? "login",
      smtpPassword: "",
      displayName: (a.settings.displayName as string) ?? "",
      signature: (a.settings.signature as string) ?? "",
      signatureHtml:
        (a.settings.signatureHtml as string) ||
        (a.settings.signature ? "<p>" + escapeHtml(String(a.settings.signature)).replace(/\n/g, "<br>") + "</p>" : ""),
      signatureEnabled: a.settings.signatureEnabled !== false,
      signaturePosition: (a.settings.signaturePosition as string) ?? "below",
      signatureDelimiter: a.settings.signatureDelimiter !== false,
      replyQuote: a.settings.replyQuote !== false,
      replyAttribution: (a.settings.replyAttribution as string) ?? "ru",
      forwardAttachments: a.settings.forwardAttachments !== false
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

  const testSmtp = async () => {
    if (!editingId) return;
    setTestingSmtp(true);
    try {
      const r = await api.testSmtp(editingId);
      if (r.ok) message.success("SMTP: подключение успешно");
      else message.error(r.error || "Ошибка SMTP");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setTestingSmtp(false);
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
        <Divider plain style={{ fontSize: 13, margin: "12px 0" }}>
          SMTP (отправка)
        </Divider>
        <Space wrap>
          <Form.Item name="smtpHost" label="SMTP-сервер">
            <Input placeholder="пусто = сервер IMAP" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="smtpPort" label="Порт">
            <InputNumber min={1} max={65535} />
          </Form.Item>
          <Form.Item name="smtpTls" label="Шифрование">
            <Select options={TLS_OPTIONS} style={{ width: 130 }} />
          </Form.Item>
        </Space>
        <Space wrap>
          <Form.Item name="smtpUsername" label="Логин SMTP">
            <Input placeholder="пусто = логин IMAP" style={{ width: 220 }} />
          </Form.Item>
          <Form.Item name="smtpPassword" label="Пароль SMTP">
            <Input.Password placeholder="пусто = пароль IMAP" style={{ width: 200 }} />
          </Form.Item>
          <Form.Item name="smtpAuthType" label="Аутентификация">
            <Select options={AUTH_OPTIONS} style={{ width: 130 }} />
          </Form.Item>
        </Space>
        <Divider plain style={{ fontSize: 13, margin: "12px 0" }}>
          Отправка и подпись
        </Divider>
        <Space wrap>
          <Form.Item name="displayName" label="Отображаемое имя (From)">
            <Input placeholder="Иванов И.И." style={{ width: 220 }} />
          </Form.Item>
          <Form.Item name="replyAttribution" label="Строка ответа">
            <Select
              style={{ width: 150 }}
              options={[
                { value: "ru", label: "«… пишет:»" },
                { value: "en", label: "«On … wrote:»" }
              ]}
            />
          </Form.Item>
        </Space>
        <Form.Item name="signatureHtml" label="Подпись (можно форматировать)">
          <RichTextEditor placeholder="С уважением, Иванов И.И." />
        </Form.Item>
        <Space wrap>
          <Form.Item name="signatureEnabled" label="Подпись включена" valuePropName="checked">
            <Switch size="small" />
          </Form.Item>
          <Form.Item name="signaturePosition" label="Положение подписи">
            <Select
              style={{ width: 160 }}
              options={[
                { value: "below", label: "под цитатой" },
                { value: "above", label: "над цитатой" }
              ]}
            />
          </Form.Item>
          <Form.Item name="signatureDelimiter" label="Разделитель «-- »" valuePropName="checked">
            <Switch size="small" />
          </Form.Item>
          <Form.Item name="replyQuote" label="Цитировать оригинал" valuePropName="checked">
            <Switch size="small" />
          </Form.Item>
          <Form.Item name="forwardAttachments" label="Вложения при пересылке" valuePropName="checked">
            <Switch size="small" />
          </Form.Item>
        </Space>
        <Space>
          <Button type="primary" htmlType="submit">
            {editingId ? "Сохранить" : "Добавить"}
          </Button>
          <Button loading={testing} onClick={() => void testAccount()}>
            Проверить подключение
          </Button>
          {editingId && (
            <Button loading={testingSmtp} onClick={() => void testSmtp()}>
              Проверить SMTP
            </Button>
          )}
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
  // Список OCR-моделей храним вместе с URL, с которого он получен: иначе при смене
  // OCR base URL в выпадающем списке оставались модели основного эндпоинта.
  const [ocrModels, setOcrModels] = useState<{ url: string; list: string[] }>({ url: "", list: [] });
  const [checking, setChecking] = useState(false);
  const [checkingOcr, setCheckingOcr] = useState(false);
  const ocrBaseUrl = Form.useWatch("ocrBaseUrl", form);
  const baseUrl = Form.useWatch("baseUrl", form);

  const currentBaseUrl = String(baseUrl || "").trim();
  const currentOcrUrl = String(ocrBaseUrl || baseUrl || "").trim();
  const ocrList = ocrModels.url === currentOcrUrl ? ocrModels.list : [];
  // Если OCR-эндпоинт отличается от основного, не подмешиваем модели основного —
  // иначе в списке снова окажутся чужие модели (исходный баг).
  const ocrUsesOwnUrl = !!currentOcrUrl && currentOcrUrl !== currentBaseUrl;
  const ocrOptions = ocrUsesOwnUrl ? ocrList : ocrList.length ? ocrList : models;

  useEffect(() => {
    if (aiConfig) form.setFieldsValue(aiConfig);
  }, [aiConfig, form]);

  useEffect(() => {
    void api.promptConfig().then(setPrompts);
  }, []);

  const loadModelList = async (url: string, apiKey: string): Promise<string[]> => {
    if (!url) return [];
    const r = await api.testAi({ baseUrl: url, apiKey });
    return r.ok ? r.models ?? [] : [];
  };

  // Подтягиваем списки моделей для основного и OCR-эндпоинтов при открытии настроек.
  useEffect(() => {
    if (!aiConfig?.baseUrl) return;
    let alive = true;
    void loadModelList(aiConfig.baseUrl, aiConfig.apiKey).then((l) => {
      if (alive && l.length) setModels(l);
    });
    if (aiConfig.ocrBaseUrl) {
      const url = aiConfig.ocrBaseUrl;
      void loadModelList(url, aiConfig.apiKey).then((l) => {
        if (alive && l.length) setOcrModels({ url, list: l });
      });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiConfig?.baseUrl, aiConfig?.ocrBaseUrl, aiConfig?.apiKey]);

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

  /** Загружает модели именно с OCR-эндпоинта (может отличаться от основного). */
  const testOcr = async () => {
    const v = form.getFieldsValue();
    const url = String(v.ocrBaseUrl ?? "") || String(v.baseUrl ?? "");
    if (!url) {
      message.warning("Укажите OCR base URL или базовый URL");
      return;
    }
    setCheckingOcr(true);
    try {
      const r = await api.testAi({ baseUrl: url, apiKey: String(v.apiKey ?? "") });
      if (r.ok) {
        const list = r.models ?? [];
        setOcrModels({ url, list });
        message.success(list.length ? "OCR-моделей загружено: " + list.length : "Подключение успешно, но моделей не найдено");
      } else {
        message.error(r.error || "Ошибка подключения к OCR-эндпоинту");
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCheckingOcr(false);
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
      <Form.Item name="ocrBaseUrl" label="OCR base URL (пусто = основной)">
        <Input placeholder="пусто = основной URL" />
      </Form.Item>
      <Form.Item
        name="ocrModel"
        label="OCR-модель (чтение PDF/изображений)"
        extra={
          <Space size={8} style={{ marginTop: 4 }}>
            <Button size="small" loading={checkingOcr} onClick={() => void testOcr()}>
              Загрузить модели OCR
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {ocrList.length
                ? "Список с OCR URL · " + ocrList.length
                : ocrUsesOwnUrl
                  ? "Нажмите «Загрузить модели OCR»"
                  : "Список с основного URL · " + models.length}
            </Typography.Text>
          </Space>
        }
      >
        <AutoComplete
          options={ocrOptions.map((m) => ({ value: m }))}
          placeholder="например glm-ocr (пусто = основная модель)"
          filterOption={(input, option) =>
            String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())
          }
        />
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
          <Typography.Text>Автоматическая проверка новой почты</Typography.Text>
          <br />
          <Switch
            checked={settings["auto_fetch"] !== "false"}
            onChange={(v) => void save("auto_fetch", v)}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>
            Забирает только письма после последней синхронизации. Первичный скан ящика — кнопкой «Скан»
            (при необходимости с диапазоном дат).
          </Typography.Text>
        </div>
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

function LdapTab() {
  const [status, setStatus] = useState<DirectoryStatus | null>(null);
  const [form] = Form.useForm();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const st = await api.directoryStatus();
      setStatus(st);
      setLogin(st.login ?? "");
      form.setFieldsValue({
        enabled: st.settings.enabled !== false,
        url: st.settings.url ?? "",
        baseDn: st.settings.baseDn ?? "",
        loginFormat: st.settings.loginFormat ?? "upn",
        upnSuffix: st.settings.upnSuffix ?? "",
        netbiosDomain: st.settings.netbiosDomain ?? "",
        userFilter: st.settings.userFilter ?? "",
        attributes: (st.settings.attributes ?? []).join(", "),
        sizeLimit: st.settings.sizeLimit ?? 25,
        rejectUnauthorized: st.settings.rejectUnauthorized === true
      });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveSettings = async (v: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.saveLdapSettings({
        enabled: v.enabled !== false,
        url: String(v.url ?? ""),
        baseDn: String(v.baseDn ?? ""),
        loginFormat: (v.loginFormat as LdapSettings["loginFormat"]) ?? "upn",
        upnSuffix: String(v.upnSuffix ?? ""),
        netbiosDomain: String(v.netbiosDomain ?? ""),
        userFilter: String(v.userFilter ?? ""),
        attributes: String(v.attributes ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        sizeLimit: Number(v.sizeLimit) || 25,
        rejectUnauthorized: v.rejectUnauthorized === true
      });
      message.success("Настройки каталога сохранены");
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doLogin = async () => {
    setBusy(true);
    try {
      await api.directoryLogin(login, password);
      message.success("Вход в каталог выполнен");
      setPassword("");
      await load();
    } catch (e) {
      message.error("Не удалось войти: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doLogout = async () => {
    try {
      await api.directoryLogout();
      setPassword("");
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const doRefresh = async () => {
    setBusy(true);
    try {
      const r = await api.directoryRefresh();
      message.success("Загружено контактов: " + r.synced);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        Каталог (Active Directory) — для автокомплита адресов. Вход опционален: без него почта работает как обычно,
        а подсказки берутся из локального кэша. Логин и пароль AD хранятся зашифрованно локально.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={saveSettings}>
        <Collapse
          defaultActiveKey={["conn"]}
          items={[
            {
              key: "conn",
              label: "Подключение",
              children: (
                <>
        <Space wrap>
          <Form.Item name="enabled" label="Включить каталог" valuePropName="checked">
            <Switch size="small" />
          </Form.Item>
          <Form.Item name="loginFormat" label="Формат логина">
            <Select
              style={{ width: 180 }}
              options={[
                { value: "upn", label: "UPN (user@domain)" },
                { value: "sam", label: "sAMAccountName" },
                { value: "domain", label: "DOMAIN\\user" },
                { value: "dn", label: "Готовый DN" }
              ]}
            />
          </Form.Item>
          <Form.Item name="sizeLimit" label="Лимит выдачи">
            <InputNumber min={1} max={200} style={{ width: 110 }} />
          </Form.Item>
          <Form.Item name="rejectUnauthorized" label="Строгий TLS" valuePropName="checked">
            <Switch size="small" />
          </Form.Item>
        </Space>
        <Form.Item name="url" label="URL (ldaps://… или ldap://…)">
          <Input placeholder="ldaps://srv-dc40.asup.local:636" />
        </Form.Item>
        <Space wrap>
          <Form.Item name="baseDn" label="Base DN" style={{ minWidth: 320 }}>
            <Input placeholder="DC=asup,DC=local" />
          </Form.Item>
          <Form.Item name="upnSuffix" label="UPN-суффикс">
            <Input placeholder="@asup.local" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="netbiosDomain" label="NetBIOS-домен">
            <Input placeholder="ASUP" style={{ width: 140 }} />
          </Form.Item>
        </Space>
                </>
              )
            },
            {
              key: "search",
              label: "Поиск и сопоставление",
              children: (
                <>
        <Form.Item name="userFilter" label="Фильтр пользователей (пусто = стандартный)">
          <Input placeholder="(&(objectCategory=person)(objectClass=user)(mail=*))" />
        </Form.Item>
        <Form.Item name="attributes" label="Атрибуты через запятую">
          <Input placeholder="displayName, mail, sAMAccountName, title, department, telephoneNumber" />
        </Form.Item>
                </>
              )
            }
          ]}
        />
        <Button type="primary" htmlType="submit" loading={busy} style={{ marginTop: 12 }}>
          Сохранить
        </Button>
      </Form>

      <Divider plain style={{ fontSize: 13, margin: "16px 0" }}>
        Вход в каталог
      </Divider>
      <Space wrap>
        <Input placeholder="Логин AD" value={login} onChange={(e) => setLogin(e.target.value)} style={{ width: 220 }} />
        <Input.Password
          placeholder="Пароль AD"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: 220 }}
        />
        <Button type="primary" loading={busy} onClick={() => void doLogin()}>
          Войти
        </Button>
        <Button onClick={() => void doLogout()}>Выйти</Button>
        <Button loading={busy} onClick={() => void doRefresh()}>
          Обновить кэш адресной книги
        </Button>
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
        Статус: {status?.loggedIn ? "вход выполнен (" + (status.login ?? "") + ")" : "не выполнен"} · контактов в кэше:{" "}
        {status?.contacts ?? 0}
      </Typography.Paragraph>
    </div>
  );
}

function TemplatesTab() {
  const accounts = useStore((s) => s.accounts);
  const [items, setItems] = useState<Template[]>([]);
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [bodyHtml, setBodyHtml] = useState("<p></p>");

  const load = async () => {
    try {
      setItems(await api.templates());
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openNew = () => {
    setEditingId(null);
    setBodyHtml("<p></p>");
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (t: Template) => {
    setEditingId(t.id);
    setBodyHtml(
      t.bodyHtml && t.bodyHtml.trim()
        ? t.bodyHtml
        : t.bodyText
          ? "<p>" + escapeHtml(t.bodyText).replace(/\n/g, "<br>") + "</p>"
          : "<p></p>"
    );
    form.setFieldsValue({ accountId: t.accountId ?? undefined, name: t.name, subject: t.subject });
    setOpen(true);
  };

  const submit = async () => {
    let v: Record<string, unknown>;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    const payload = {
      accountId: (v.accountId as string) || null,
      name: String(v.name ?? ""),
      subject: String(v.subject ?? ""),
      bodyHtml: bodyHtml && bodyHtml.trim() ? bodyHtml : null,
      bodyText: htmlToPlainText(bodyHtml)
    };
    try {
      if (editingId) await api.updateTemplate(editingId, payload);
      else await api.createTemplate(payload);
      message.success("Шаблон сохранён");
      setOpen(false);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteTemplate(id);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
          Шаблоны писем: тема + готовый текст с форматированием. Можно привязать к аккаунту или сделать общим.
        </Typography.Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>
          Добавить шаблон
        </Button>
      </div>
      <List
        size="small"
        bordered
        dataSource={items}
        locale={{ emptyText: "Шаблонов пока нет — создайте первый" }}
        renderItem={(t) => (
          <List.Item
            actions={[
              <Button key="e" size="small" type="link" onClick={() => openEdit(t)}>
                Редактировать
              </Button>,
              <Popconfirm key="d" title="Удалить шаблон?" onConfirm={() => void remove(t.id)}>
                <Button size="small" type="link" danger>
                  Удалить
                </Button>
              </Popconfirm>
            ]}
          >
            <List.Item.Meta
              title={
                <Space size={6}>
                  <span>{t.name}</span>
                  <Tag color={t.accountId ? "blue" : "green"}>
                    {t.accountId ? accounts.find((a) => a.id === t.accountId)?.username ?? "аккаунт" : "общий"}
                  </Tag>
                </Space>
              }
              description={
                (t.subject || "(без темы)") +
                " — " +
                (t.bodyText || "")
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean)[0]
                  ?.slice(0, 90)
              }
            />
          </List.Item>
        )}
      />

      <Modal
        open={open}
        title={editingId ? "Редактировать шаблон" : "Новый шаблон"}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="Сохранить"
        cancelText="Отмена"
        width={720}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Space wrap>
            <Form.Item name="accountId" label="Аккаунт" style={{ minWidth: 220 }}>
              <Select allowClear placeholder="Общий для всех" options={accounts.map((a) => ({ value: a.id, label: a.username }))} />
            </Form.Item>
            <Form.Item name="name" label="Название" rules={[{ required: true, message: "Укажите название" }]}>
              <Input style={{ width: 300 }} placeholder="Например: ответ по регламенту" />
            </Form.Item>
          </Space>
          <Form.Item name="subject" label="Тема">
            <Input placeholder="Тема письма" />
          </Form.Item>
          <Form.Item label="Текст шаблона">
            <RichTextEditor value={bodyHtml} onChange={setBodyHtml} placeholder="Уважаемый(ая) …" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const [reloadKey, setReloadKey] = useState(0);

  // Модалка не размонтирует вкладки, поэтому при каждом открытии настроек
  // пересоздаём их: иначе список шаблонов и статус каталога остаются устаревшими.
  useEffect(() => {
    if (open) setReloadKey((k) => k + 1);
  }, [open]);

  return (
    <Modal open={open} onCancel={() => setOpen(false)} footer={null} width={760} title="Настройки">
      <Tabs
        items={[
          { key: "mail", label: "Почта", children: <AccountTab /> },
          { key: "ai", label: "ИИ", children: <AiTab /> },
          { key: "templates", label: "Шаблоны", children: <TemplatesTab key={reloadKey} /> },
          { key: "ldap", label: "Каталог (LDAP)", children: <LdapTab key={reloadKey} /> },
          { key: "general", label: "Общие", children: <GeneralTab /> }
        ]}
      />
    </Modal>
  );
}
