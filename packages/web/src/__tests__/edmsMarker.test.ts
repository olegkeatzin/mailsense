import { edmsMarkerHeader } from "../utils/edmsMarker";

/**
 * Метка СЭД в письме: заказчик попросил техническую информацию, по которой система
 * на другом конце понимает, что это за письмо. Заголовок не виден человеку и переживает
 * пересылку — в отличие от строки в теме.
 */
describe("метка письма СЭД", () => {
  it("несёт документ, поручение и вид письма", () => {
    expect(edmsMarkerHeader({ documentId: "doc-7", resolutionId: "res-3", kind: "dispatch" })).toEqual({
      "X-MailSense-EDMS": "doc=doc-7; res=res-3; kind=dispatch; v=1"
    });
  });

  it("без поручения ставит прочерк, а не пустоту", () => {
    expect(edmsMarkerHeader({ documentId: "doc-7" })["X-MailSense-EDMS"]).toBe(
      "doc=doc-7; res=-; kind=forward; v=1"
    );
  });

  it("полностью пустой вход не ломает заголовок", () => {
    expect(edmsMarkerHeader({})["X-MailSense-EDMS"]).toBe("doc=-; res=-; kind=forward; v=1");
  });
});
