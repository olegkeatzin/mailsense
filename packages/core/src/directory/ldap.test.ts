import { buildBindIdentifier } from "./ldap.js";

describe("buildBindIdentifier", () => {
  test("UPN: суффикс с @ и без @ не дублирует @", () => {
    expect(buildBindIdentifier("test", { loginFormat: "upn", upnSuffix: "@asup.local" })).toBe("test@asup.local");
    expect(buildBindIdentifier("test", { loginFormat: "upn", upnSuffix: "asup.local" })).toBe("test@asup.local");
    expect(buildBindIdentifier("test@asup.local", { loginFormat: "upn", upnSuffix: "@asup.local" })).toBe("test@asup.local");
  });

  test("domain / sam / dn", () => {
    expect(buildBindIdentifier("ivanov", { loginFormat: "domain", netbiosDomain: "ASUP" })).toBe("ASUP\\ivanov");
    expect(buildBindIdentifier("ivanov", { loginFormat: "sam" })).toBe("ivanov");
    expect(buildBindIdentifier("CN=A,DC=x", { loginFormat: "dn" })).toBe("CN=A,DC=x");
  });

  test("по умолчанию UPN", () => {
    expect(buildBindIdentifier("user", { upnSuffix: "@stand.test" })).toBe("user@stand.test");
  });
});
