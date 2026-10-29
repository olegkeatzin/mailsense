/**
 * Техническая метка письма СЭД.
 *
 * Заказчик: «в письме стоит ставить что-то вроде технической информации, по которой наша
 * система на другом конце сможет понять, что это за письмо». Метка уходит обычным
 * заголовком: она не видна человеку, переживает пересылку и сохраняется у получателя.
 */
export function edmsMarkerHeader(input: {
  documentId?: string | null;
  resolutionId?: string | null;
  kind?: "forward" | "dispatch" | "report" | null;
}): Record<string, string> {
  const value =
    "doc=" +
    (input.documentId || "-") +
    "; res=" +
    (input.resolutionId || "-") +
    "; kind=" +
    (input.kind || "forward") +
    "; v=1";
  return { "X-MailSense-EDMS": value };
}
