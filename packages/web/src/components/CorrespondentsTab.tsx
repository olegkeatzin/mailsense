import { useEffect, useState } from "react";
import { Button, Form, Input, Modal, Select, Space, Switch, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { api } from "../api";
import type { CorrespondentRecord } from "../types";
import { humanError } from "../utils/humanError";

/**
 * Справочник корреспондентов.
 *
 * Почтовые ящики, закреплённые здесь, позволяют системе автоматически
 * определять корреспондента при регистрации письма.
 */
export function CorrespondentsTab() {
  const [rows, setRows] = useState<CorrespondentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<CorrespondentRecord | null>(null);
  const [form] = Form.useForm();

  async function load() {
    setLoading(true);
    try {
      setRows(await api.correspondents());
    } catch (e) {
      message.error("Не удалось загрузить корреспондентов: " + humanError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function edit(row: CorrespondentRecord | null) {
    setEditing(row);
    form.setFieldsValue(
      row
        ? {
            name: row.name,
            shortName: row.shortName,
            inn: row.inn,
            isActive: row.isActive,
            emails: row.emails
          }
        : { name: "", shortName: "", inn: "", isActive: true, emails: [] }
    );
    setOpen(true);
  }

  async function save() {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api.saveCorrespondent({
        id: editing?.id,
        name: String(v.name ?? "").trim(),
        shortName: v.shortName ?? "",
        inn: v.inn ?? "",
        isActive: v.isActive !== false,
        emails: Array.isArray(v.emails) ? v.emails : []
      });
      message.success(editing ? "Корреспондент сохранён" : "Корреспондент добавлен");
      setOpen(false);
      await load();
    } catch (e) {
      message.error(humanError(e));
    } finally {
      setSaving(false);
    }
  }

  const columns: ColumnsType<CorrespondentRecord> = [
    { title: "Наименование", dataIndex: "name", render: (v: string) => <b>{v}</b> },
    { title: "Кратко", dataIndex: "shortName", width: 180 },
    { title: "ИНН", dataIndex: "inn", width: 140 },
    {
      title: "Почтовые ящики",
      dataIndex: "emails",
      render: (v: string[]) =>
        v.length ? (
          <Space wrap size={2}>
            {v.map((e) => (
              <Tag key={e}>{e}</Tag>
            ))}
          </Space>
        ) : (
          <span style={{ color: "#767676" }}>не закреплены</span>
        )
    },
    {
      title: "Активен",
      dataIndex: "isActive",
      width: 90,
      render: (v: boolean) => <Tag color={v ? "green" : "default"}>{v ? "да" : "нет"}</Tag>
    },
    {
      title: "",
      key: "actions",
      width: 90,
      render: (_v, r) => (
        <Button size="small" type="link" onClick={() => edit(r)}>
          Изменить
        </Button>
      )
    }
  ];

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" onClick={() => edit(null)}>
          Добавить корреспондента
        </Button>
        <Typography.Text type="secondary">
          Письма с закреплённых ящиков автоматически связываются с корреспондентом при регистрации.
        </Typography.Text>
      </Space>
      <Table<CorrespondentRecord>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        columns={columns}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        locale={{ emptyText: "Корреспондентов пока нет" }}
      />
      <Modal
        open={open}
        title={editing ? "Изменить корреспондента" : "Новый корреспондент"}
        okText="Сохранить"
        cancelText="Отмена"
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
        onOk={() => void save()}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="Наименование" name="name" rules={[{ required: true, message: "Укажите наименование" }]}>
            <Input placeholder="АО «Рога и копыта»" />
          </Form.Item>
          <Form.Item label="Краткое наименование" name="shortName">
            <Input />
          </Form.Item>
          <Form.Item label="ИНН" name="inn">
            <Input />
          </Form.Item>
          <Form.Item
            label="Почтовые ящики"
            name="emails"
            extra="Письма с этих адресов будут считаться письмами корреспондента."
          >
            <Select
              mode="tags"
              tokenSeparators={[",", ";", " "]}
              placeholder="info@example.ru"
            />
          </Form.Item>
          <Form.Item label="Активен" name="isActive" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
