import { useEffect } from "react";
import { Button, DatePicker, Form, Modal, Select, Space } from "antd";
import dayjs from "dayjs";
import type { Dayjs } from "dayjs";
import { useStore } from "../store";

export default function FilterModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const from = useStore((s) => s.from);
  const to = useStore((s) => s.to);
  const externalNumber = useStore((s) => s.externalNumber);
  const dateFrom = useStore((s) => s.dateFrom);
  const dateTo = useStore((s) => s.dateTo);
  const sendDateFrom = useStore((s) => s.sendDateFrom);
  const sendDateTo = useStore((s) => s.sendDateTo);
  const setFilter = useStore((s) => s.setFilter);
  const resetFilters = useStore((s) => s.resetFilters);
  const [form] = Form.useForm();

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      from: from || [],
      to: to || [],
      externalNumber: externalNumber || [],
      dateRange: dateFrom && dateTo ? [dayjs(dateFrom), dayjs(dateTo)] : null,
      sendDateRange: sendDateFrom && sendDateTo ? [dayjs(sendDateFrom), dayjs(sendDateTo)] : null
    });
  }, [open, form, from, to, externalNumber, dateFrom, dateTo, sendDateFrom, sendDateTo]);

  const apply = (v: Record<string, unknown>) => {
    const dr = v.dateRange as [Dayjs, Dayjs] | null | undefined;
    const sdr = v.sendDateRange as [Dayjs, Dayjs] | null | undefined;
    setFilter({
      from: (v.from as string[]) ?? [],
      to: (v.to as string[]) ?? [],
      externalNumber: (v.externalNumber as string[]) ?? [],
      dateFrom: dr ? dr[0].format("YYYY-MM-DD") : "",
      dateTo: dr ? dr[1].format("YYYY-MM-DD") : "",
      sendDateFrom: sdr ? sdr[0].format("YYYY-MM-DD") : "",
      sendDateTo: sdr ? sdr[1].format("YYYY-MM-DD") : ""
    });
    onClose();
  };

  const clear = () => {
    form.resetFields();
    resetFilters();
    onClose();
  };

  return (
    <Modal open={open} onCancel={onClose} footer={null} title="Фильтры" width={560} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={apply}>
        <Form.Item name="from" label="Отправитель (несколько)">
          <Select mode="tags" placeholder="имя или адрес, Enter — добавить" open={false} tokenSeparators={[",", ";"]} />
        </Form.Item>
        <Form.Item name="to" label="Получатель (несколько)">
          <Select mode="tags" placeholder="имя или адрес, Enter — добавить" open={false} tokenSeparators={[",", ";"]} />
        </Form.Item>
        <Form.Item name="externalNumber" label="Внешний номер (несколько)">
          <Select mode="tags" placeholder="например 3175, Enter — добавить" open={false} tokenSeparators={[",", ";"]} />
        </Form.Item>
        <Form.Item name="dateRange" label="Дата получения (период)">
          <DatePicker.RangePicker style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="sendDateRange" label="Дата отправки (период)">
          <DatePicker.RangePicker style={{ width: "100%" }} />
        </Form.Item>
        <Space>
          <Button type="primary" htmlType="submit">
            Применить
          </Button>
          <Button onClick={clear}>Сбросить</Button>
        </Space>
      </Form>
    </Modal>
  );
}
