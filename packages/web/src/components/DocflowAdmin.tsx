import { useCallback, useEffect, useState } from "react";
import { EdmsMailAllowanceModal } from "./EdmsMailAllowanceModal";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message
} from "antd";
import { PlusOutlined, ReloadOutlined, SyncOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api";
import { useStore } from "../store";
import { READY_STYLE, SOON_STYLE } from "./notifications/colors";
import type { AuthStatus, Role, User } from "../types";
import { humanError } from "../utils/humanError";
import { sourceTitle } from "./docflow/labels";



const SOURCE_COLOR: Record<string, string> = {
  ldap: "blue",
  local: "orange",
  manual: "default"
};

/** Вкладка «Пользователи и роли» — ТЗ п. 6. */
export function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  /** Кому сейчас выдаём ящики для СЭД (T57). */
  const [mailUser, setMailUser] = useState<User | null>(null);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [u, r] = await Promise.all([api.users({ q, includeInactive }), api.roles()]);
      setUsers(u);
      setRoles(r);
    } catch (err) {
      message.error(humanError(err));
    } finally {
      setLoading(false);
    }
  }, [q, includeInactive]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeRoles = async (user: User, roleIds: string[]) => {
    try {
      await api.setUserRoles(user.id, roleIds);
      message.success("Роли обновлены");
      await load();
    } catch (err) {
      message.error(humanError(err));
    }
  };

  const toggleBlocked = async (user: User) => {
    try {
      // ⚠️ Меняем ИМЕННО blocked: isActive — признак каталога (уволен), и раньше кнопка
      // «Заблокировать» переключала не то поле, из-за чего человек выглядел уволенным.
      await api.updateUser(user.id, { blocked: !user.blocked });
      message.success(user.blocked ? "Доступ восстановлен" : "Пользователь заблокирован");
      await load();
    } catch (err) {
      message.error(humanError(err));
    }
  };

  const restoreUser = async (user: User) => {
    try {
      // Ошибочную деактивацию синхронизацией надо уметь исправить из интерфейса:
      // раньше у «Уволен (AD)» кнопки были недоступны, и вернуть человека было нечем.
      await api.updateUser(user.id, { isActive: true });
      message.success("Пользователь возвращён в работу");
      await load();
    } catch (err) {
      message.error(humanError(err));
    }
  };

  const sync = async () => {
    setLoading(true);
    try {
      const r = await api.syncUsers();
      message.success(
        `Синхронизация: всего ${r.total}, добавлено ${r.created}, обновлено ${r.updated}, уволено ${r.deactivated}`
      );
      await load();
    } catch (err) {
      message.error(humanError(err));
    } finally {
      setLoading(false);
    }
  };

  const create = async () => {
    try {
      const v = await form.validateFields();
      await api.createUser({
        email: v.email,
        fullName: v.fullName,
        department: v.department,
        position: v.position,
        phone: v.phone,
        roleIds: v.roleIds ?? []
      });
      message.success("Пользователь добавлен");
      setCreateOpen(false);
      form.resetFields();
      await load();
    } catch (err) {
      if ((err as { errorFields?: unknown }).errorFields) return;
      message.error(humanError(err));
    }
  };

  return (
    <div>
      <Space style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <Input.Search
          placeholder="ФИО, email, отдел, логин"
          allowClear
          style={{ width: 260 }}
          onSearch={setQ}
        />
        <Space size={4}>
          <Switch size="small" checked={includeInactive} onChange={setIncludeInactive} />
          <Typography.Text style={{ fontSize: 12 }}>показывать уволенных</Typography.Text>
        </Space>
        <Button icon={<SyncOutlined />} onClick={() => void sync()} loading={loading}>
          Синхронизировать с каталогом
        </Button>
        <Button icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          Добавить
        </Button>
        <Button icon={<ReloadOutlined />} aria-label="Обновить список пользователей" title="Обновить" onClick={() => void load()} />
      </Space>

      <Table<User>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={users}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        scroll={{ x: 900 }}
        columns={[
          {
            title: "ФИО",
            dataIndex: "fullName",
            width: 220,
            render: (v: string, u) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{v || "—"}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {u.email || u.ldapUid || ""}
                </Typography.Text>
              </Space>
            )
          },
          {
            title: "Отдел / должность",
            width: 200,
            render: (_v, u) => (
              <Space direction="vertical" size={0}>
                <span>{u.department || "—"}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {u.position || ""}
                </Typography.Text>
              </Space>
            )
          },
          {
            title: "Роли",
            width: 280,
            render: (_v, u) => (
              <Select
                mode="multiple"
                size="small"
                style={{ width: "100%" }}
                placeholder="Роль не назначена"
                value={u.roles}
                options={roles.map((r) => ({ value: r.id, label: r.name }))}
                onChange={(v) => void changeRoles(u, v as string[])}
                disabled={!u.isActive || u.blocked}
              />
            )
          },
          {
            title: "Источник",
            dataIndex: "source",
            width: 110,
            render: (v: string) => <Tag color={SOURCE_COLOR[v] ?? "default"}>{sourceTitle(v)}</Tag>
          },
          {
            title: "Вход",
            dataIndex: "lastLoginAt",
            width: 140,
            render: (v: string | null) => (v ? dayjs(v).format("DD.MM.YYYY HH:mm") : "—")
          },
          {
            title: "Статус",
            width: 130,
            render: (_v, u) => {
              if (!u.isActive) return <Tag color="red">Уволен (AD)</Tag>;
              // Пресеты orange/green норму AA не проходят (3.34 / 3.37) — свои стили.
              if (u.blocked) return <Tag style={SOON_STYLE}>Заблокирован</Tag>;
              return <Tag style={READY_STYLE}>Активен</Tag>;
            }
          },
          {
            title: "Почта для СЭД",
            width: 130,
            render: (_v, u) => (
              <Button size="small" type="link" onClick={() => setMailUser(u)}>
                Настроить
              </Button>
            )
          },
          {
            title: "",
            width: 130,
            render: (_v, u) =>
              !u.isActive ? (
                <Popconfirm
                  title="Вернуть пользователя в работу?"
                  description="Сотрудник снова сможет войти. Если в каталоге он всё ещё уволен, следующая синхронизация деактивирует его снова."
                  okText="Да"
                  cancelText="Нет"
                  onConfirm={() => void restoreUser(u)}
                >
                  <Button size="small">Вернуть в работу</Button>
                </Popconfirm>
              ) : (
              <Popconfirm
                title={u.blocked ? "Восстановить доступ?" : "Заблокировать пользователя?"}
                description={
                  u.blocked
                    ? "Пользователь снова сможет войти в систему."
                    : "Все активные сессии будут разорваны немедленно."
                }
                okText="Да"
                cancelText="Нет"
                onConfirm={() => void toggleBlocked(u)}
              >
                <Button size="small" danger={!u.blocked}>
                  {u.blocked ? "Разблокировать" : "Заблокировать"}
                </Button>
              </Popconfirm>
              )
          }
        ]}
      />

      <EdmsMailAllowanceModal user={mailUser} onClose={() => setMailUser(null)} />

      <Modal
        open={createOpen}
        title="Новый пользователь"
        onCancel={() => setCreateOpen(false)}
        onOk={() => void create()}
        okText="Создать"
        cancelText="Отмена"
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Для внешних контрагентов"
          description="Такая учётная запись нужна как справочная: войти в систему под ней нельзя."
        />
        <Form form={form} layout="vertical">
          <Form.Item name="email" label="Email" rules={[{ required: true, message: "Укажите email" }]}>
            <Input placeholder="contractor@example.com" />
          </Form.Item>
          <Form.Item name="fullName" label="ФИО / организация">
            <Input />
          </Form.Item>
          <Form.Item name="department" label="Отдел">
            <Input />
          </Form.Item>
          <Form.Item name="position" label="Должность">
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="Телефон">
            <Input />
          </Form.Item>
          <Form.Item name="roleIds" label="Роли">
            <Select mode="multiple" options={roles.map((r) => ({ value: r.id, label: r.name }))} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/** Вкладка «документооборот» — включение модуля и параметры сессий. */
export function DocflowTab() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirStatus, setDirStatus] = useState<{ loggedIn: boolean; login: string | null; contacts: number } | null>(
    null
  );

  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([api.authStatus(), api.directoryStatus()]);
      setStatus(s);
      setDirStatus(d);
    } catch (err) {
      message.error(humanError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: { enabled?: boolean; localLoginEnabled?: boolean }) => {
    setBusy(true);
    try {
      setStatus(await api.saveDocflowSettings(patch));
      message.success("Сохранено");
      // Включение/выключение документооборот меняет требования к входу — перечитываем сессию.
      await useStore.getState().loadAuth();
    } catch (err) {
      message.error(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="middle">
      <Card size="small" title="Модуль документооборот">
        <Space direction="vertical" style={{ width: "100%" }} size="small">
          <Space>
            <Switch
              checked={status.docflowEnabled}
              loading={busy}
              onChange={(v) => void save({ enabled: v })}
            />
            <Typography.Text>Включить электронный документооборот</Typography.Text>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Пока модуль выключен, приложение работает как обычный почтовый клиент и не требует входа.
            При включении весь API требует аутентификации, а почтовые ящики и настройки становятся доступны
            только администратору.
          </Typography.Text>
          {status.docflowEnabled && !status.ldapConfigured ? (
            <Alert
              type="warning"
              showIcon
              message="Каталог не настроен"
              description="Заполните «Каталог (LDAP)»: без него войти в систему невозможно."
            />
          ) : null}
          {status.docflowEnabled && !status.hasAdmin ? (
            <Alert
              type="warning"
              showIcon
              message={status.adminConfigured ? "Администратор ещё не входил" : "Администратор не назначен"}
              description={
                status.adminConfigured
                  ? "Список администраторов задан: роль выдаётся при первом входе указанного логина."
                  : "Никто не сможет управлять пользователями. Задайте на сервере MAILSENSE_ADMIN_LOGINS " +
                    "(доменные логины через запятую) и перезапустите его."
              }
            />
          ) : null}
        </Space>
      </Card>

      <Card size="small" title="Каталог сотрудников">
        <Descriptions size="small" column={1}>
          <Descriptions.Item label="Подключение к каталогу">
            {dirStatus?.loggedIn ? <Tag style={READY_STYLE}>выполнен вход: {dirStatus.login}</Tag> : <Tag>не выполнен</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="Контактов в кэше">{dirStatus?.contacts ?? 0}</Descriptions.Item>
          <Descriptions.Item label="Справочник пользователей">
            {status.needsBootstrap ? "пуст — войдите или выполните синхронизацию" : "синхронизируется из каталога"}
          </Descriptions.Item>
        </Descriptions>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Синхронизация выполняется на вкладке «Пользователи и роли». Кадровые данные (ФИО, отдел, должность,
          руководитель) всегда берутся из каталога; роли хранятся локально.
        </Typography.Text>
      </Card>

      <Card size="small" title="Аварийный локальный вход">
        <Space direction="vertical" style={{ width: "100%" }} size="small">
          <Space>
            <Switch
              checked={status.localLoginEnabled}
              loading={busy}
              onChange={(v) => void save({ localLoginEnabled: v })}
            />
            <Typography.Text>Разрешить вход локальным учётным записям</Typography.Text>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Нужен на случай недоступности контроллера домена. Локальная учётная запись создаётся при запуске
            сервера переменными окружения MAILSENSE_ADMIN_LOGIN и MAILSENSE_ADMIN_PASSWORD и получает роль
            администратора. Пароль хранится в виде scrypt-хэша.
          </Typography.Text>
        </Space>
      </Card>
    </Space>
  );
}
