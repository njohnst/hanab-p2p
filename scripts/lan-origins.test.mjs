import { describe, expect, it } from "vitest";
import { formatOrigin, lanOrigins } from "./lan-origins.mjs";

const loopback = [
  { address: "127.0.0.1", family: "IPv4", internal: true },
  { address: "::1", family: "IPv6", internal: true },
];

describe("lanOrigins", () => {
  it("lists IPv4 addresses, then IPv6 ones in brackets", () => {
    const interfaces = {
      lo: loopback,
      wlan0: [
        { address: "2001:db8::5", family: "IPv6", internal: false },
        { address: "192.168.1.5", family: "IPv4", internal: false },
      ],
    };

    expect(lanOrigins(interfaces, { port: 3000 })).toEqual(["http://192.168.1.5:3000", "http://[2001:db8::5]:3000"]);
  });

  it("skips link-local addresses", () => {
    const interfaces = {
      Ethernet: [
        { address: "fe80::7b7f:257:cb5f:464d", family: "IPv6", internal: false },
        { address: "169.254.10.20", family: "IPv4", internal: false },
        { address: "192.168.2.14", family: "IPv4", internal: false },
      ],
    };

    expect(lanOrigins(interfaces, { port: 3000 })).toEqual(["http://192.168.2.14:3000"]);
  });

  it("puts virtual interfaces last, then the usual LAN ranges first", () => {
    const interfaces = {
      "vEthernet (WSL)": [{ address: "172.29.112.1", family: "IPv4", internal: false }],
      "docker0": [{ address: "172.17.0.1", family: "IPv4", internal: false }],
      "eth1": [{ address: "100.72.1.2", family: "IPv4", internal: false }],
      "eth0": [{ address: "10.1.2.3", family: "IPv4", internal: false }],
      "Wi-Fi": [{ address: "192.168.43.20", family: "IPv4", internal: false }],
      "en0": [{ address: "172.20.10.2", family: "IPv4", internal: false }],
    };

    expect(lanOrigins(interfaces, { port: 8080 })).toEqual([
      "http://192.168.43.20:8080",
      "http://10.1.2.3:8080",
      "http://172.20.10.2:8080",
      "http://100.72.1.2:8080",
      "http://172.29.112.1:8080",
      "http://172.17.0.1:8080",
    ]);
  });

  it("accepts the numeric families of older Node versions", () => {
    const interfaces = {
      eth0: [
        { address: "192.168.1.5", family: 4, internal: false },
        { address: "2001:db8::5", family: 6, internal: false },
      ],
    };

    expect(lanOrigins(interfaces, { port: 3000 })).toEqual(["http://192.168.1.5:3000", "http://[2001:db8::5]:3000"]);
  });

  it("follows the address the server listens on", () => {
    const interfaces = {
      eth0: [
        { address: "192.168.1.5", family: "IPv4", internal: false },
        { address: "2001:db8::5", family: "IPv6", internal: false },
      ],
    };

    expect(lanOrigins(interfaces, { port: 3000, host: "::" })).toHaveLength(2);
    expect(lanOrigins(interfaces, { port: 3000, host: "0.0.0.0" })).toEqual(["http://192.168.1.5:3000"]);
    expect(lanOrigins(interfaces, { port: 3000, host: "192.168.1.5" })).toEqual(["http://192.168.1.5:3000"]);
    expect(lanOrigins(interfaces, { port: 3000, host: "2001:db8::5" })).toEqual(["http://[2001:db8::5]:3000"]);
    expect(lanOrigins(interfaces, { port: 3000, host: "127.0.0.1" })).toEqual([]);
    expect(lanOrigins(interfaces, { port: 3000, host: "localhost" })).toEqual([]);
    expect(lanOrigins(interfaces, { port: 3000, host: "::1" })).toEqual([]);
  });

  it("uses the server's scheme and port", () => {
    const interfaces = { eth0: [{ address: "192.168.1.5", family: "IPv4", internal: false }] };

    expect(lanOrigins(interfaces, { protocol: "https:", port: 8443 })).toEqual(["https://192.168.1.5:8443"]);
    expect(lanOrigins(interfaces, { protocol: "https:", port: 443 })).toEqual(["https://192.168.1.5"]);
    expect(lanOrigins(interfaces, { protocol: "http:", port: 80 })).toEqual(["http://192.168.1.5"]);
  });

  it("has nothing to offer without a network", () => {
    expect(lanOrigins({ lo: loopback }, { port: 3000 })).toEqual([]);
    expect(lanOrigins({}, { port: 3000 })).toEqual([]);
  });
});

describe("formatOrigin", () => {
  it("brackets IPv6 addresses", () => {
    expect(formatOrigin("http:", "2001:DB8:0:0::5", 3000)).toBe("http://[2001:db8::5]:3000");
    expect(formatOrigin("http:", "[2001:db8::5]", 3000)).toBe("http://[2001:db8::5]:3000");
    expect(formatOrigin("https:", "hanab.lan", 3000)).toBe("https://hanab.lan:3000");
  });
});
