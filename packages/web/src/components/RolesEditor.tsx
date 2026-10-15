import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Checkbox, Form, Input, Modal, Space, Table, Tag, Typography, message } from "antd";
import { api } from "../api";
import { humanError } from "../utils/humanError";
import type { Permission, PermissionInfo, Role } from "../types";

/**
 * Конструктор ролей: администратор заводит роли сам и расставляет права галочками.
 *
 * ⚠️ Права действуют СРАЗУ после сохранения (сервер перечитывает реестр ролей) — перезапуск
 * не нужен. Роль «Администратор» неизменяема: она всегда даёт все права, иначе систему
 * некому было бы настроить.
 */
export function RolesEditor() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<PermissionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Role | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const [list, permissions] = await Promise.all([api.roles(), api.permissionCatalog()]);
      setRoles(list);
      setCatalog(permissions);
      setError("");
    } catch (e) {
      setError(humanError(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /** Права по группам: так галочки читаются, а не идут одной простыней. */
  const groups = useMemo(() => {
    const map = new Map<string, PermissionInfo[]>();
    for (const p of catalog) {
      const list = map.get(p.group) ?? [];
      list.push(p);
      map.set(p.group, list);
    }
    return [...map.entries()];
  }, [catalog]);

  const titleOf = useMemo(() => new Map(catalog.map((p) => [p.id, p.title])), [catalog]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ name: "", description: "", permissions: [] });
    setOpen(true);
  };

  const openEdit = (role: Role) => {
    setEditing(role);
    form.setFieldsValue({ name: role.name, description: role.description, permissions: role.permissions });
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setEditing(null);
    form.resetFields();
  };

  const save = async () => {
    const values = (await form.validateFields()) as {
      name: string;
      description?: string;
      permissions?: Permission[];
    };
    setSaving(true);
    try {
      if (editing) {
        await api.updateRole(editing.id, {
          name: values.name,
          description: values.description ?? "",
          permissions: values.permissions ?? []
        });
        message.success("Роль обновлена");
      } else {
        await api.createRole({
          name: values.name,
          description: values.description ?? "",
          permissions: values.permissions ?? []
        });
        message.success("Роль создана");
      }
      close();
      await load();
    } catch (e) {
      message.error(humanError(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = (role: Role) => {
    Modal.confirm({
      title: "Удалить роль «" + role.name + "»?",
      content:
        "Роль исчезнет из списка. Если она назначена работникам, сервер откажет — сначала снимите её в списке пользователей.",
      okText: "Удалить",
      cancelText: "Отмена",
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteRole(role.id);
          message.success("Роль удалена");
          await load();
        } catch (e) {
          message.error(humanError(e));
        }
      }
    });
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Роли
        </Typography.Title>
        <Button type="primary" size="small" onClick={openCreate}>
          Добавить роль
        </Button>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
        Роли заводите вы: отметьте галочками, что роли разрешено. Права действуют сразу, перезапуск не нужен.
      </Typography.Text>

      {error ? (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message="Не удалось загрузить роли" description={error} />
      ) : null}

      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={roles}
        pagination={false}
        columns={[
          {
            title: "Название",
            dataIndex: "name",
            render: (name: string, role: Role) => (
              <Space direction="vertical" size={0}>
                <span>{name}</span>
                {role.description ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {role.description}
                  </Typography.Text>
                ) : null}
              </Space>
            )
          },
          {
            title: "Права",
            dataIndex: "permissions",
            render: (list: Permission[]) =>
              list.length ? (
                <Space wrap size={[4, 4]}>
                  {list.map((p) => (
                    <Tag key={p}>{titleOf.get(p) ?? p}</Tag>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">Прав нет</Typography.Text>
              )
          },
          {
            title: "",
            key: "actions",
            render: (_: unknown, role: Role) =>
              role.id === "admin" ? (
                <Typography.Text type="secondary">Не изменяется</Typography.Text>
              ) : (
                <Space>
                  <Button size="small" onClick={() => openEdit(role)}>
                    Изменить
                  </Button>
                  <Button size="small" danger onClick={() => remove(role)}>
                    Удалить
                  </Button>
                </Space>
              )
          }
        ]}
      />

      <Modal
        open={open}
        title={editing ? "Роль: " + editing.name : "Новая роль"}
        onCancel={close}
        onOk={() => void save()}
        okText="Сохранить"
        cancelText="Отмена"
        confirmLoading={saving}
        width={640}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Название" rules={[{ required: true, message: "Укажите название роли" }]}>
            <Input placeholder="Например, Делопроизводитель" />
          </Form.Item>
          <Form.Item name="description" label="Описание">
            <Input placeholder="Кому и зачем эта роль" />
          </Form.Item>
          <Form.Item name="permissions" label="Права">
            <Checkbox.Group style={{ width: "100%" }}>
              {groups.map(([group, list]) => (
                <div key={group} style={{ marginBottom: 12 }}>
                  <Typography.Text strong style={{ display: "block", marginBottom: 4 }}>
                    {group}
                  </Typography.Text>
                  <Space direction="vertical" size={2}>
                    {list.map((p) => (
                      <Checkbox key={p.id} value={p.id}>
                        {p.title}
                      </Checkbox>
                    ))}
                  </Space>
                </div>
              ))}
            </Checkbox.Group>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
