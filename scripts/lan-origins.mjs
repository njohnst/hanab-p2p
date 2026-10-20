/**
 * The origins other devices on the LAN can open a server at (see ./serve-static.mjs and
 * docs/P2P_DESIGN.md, "Getting the app without internet"): IPv4 addresses first, then IPv6 ones in
 * brackets, e.g. ["http://192.168.1.5:3000", "http://[2001:db8::5]:3000"].
 *
 * - Skipped: internal (loopback) addresses, and link-local ones: 169.254.x.x, which a host gives
 *   itself when nothing answers DHCP, and fe80::/10, whose zone index URLs can't carry.
 * - Best first, as the app puts the first one in invite URLs: physical interfaces before virtual ones
 *   (Docker, WSL, VMs, VPNs: other devices rarely reach them), then the private ranges of home
 *   Wi-Fi, offices and phone hotspots (192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12), then the rest,
 *   each in the system's interface order.
 */

/** Interface names of containers, VMs, VPNs and tunnels (Linux, macOS, Windows). */
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|vethernet|virtualbox|vmware|hyper-v|tailscale|zerotier|zt|utun|tun|tap|wg|hamachi)/i;

function isIPv4(family) {
  return family === "IPv4" || family === 4;
}

function isLinkLocal(address, ipv4) {
  return ipv4 ? address.startsWith("169.254.") : /^fe[89ab][0-9a-f]:/i.test(address);
}

/** 0 for the most likely LAN ranges, 3 for the rest. */
function ipv4Rank(address) {
  const [a, b] = address.split(".").map(Number);
  if (a === 192 && b === 168) {
    return 0;
  }
  if (a === 10) {
    return 1;
  }

  return a === 172 && b >= 16 && b <= 31 ? 2 : 3;
}

/** Whether a host (name or address) is this computer only: localhost, 127.x.x.x, ::1. */
export function isLoopbackAddress(host) {
  const bare = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127\./.test(bare);
}

/** `protocol//host:port` as a URL origin (IPv6 in brackets, no default port). */
export function formatOrigin(protocol, host, port) {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return new URL(`${protocol}//${bracketed}:${port}`).origin;
}

/**
 * The LAN origins of a server listening on `host` (none or a wildcard: every interface, "0.0.0.0"
 * being IPv4 only; a loopback address: none; any other address or name: only it), given the
 * system's interfaces (os.networkInterfaces()).
 */
export function lanOrigins(interfaces, { protocol = "http:", port, host } = {}) {
  if (host && host !== "0.0.0.0" && host !== "::") {
    return isLoopbackAddress(host) ? [] : [formatOrigin(protocol, host, port)];
  }

  const candidates = [];
  Object.entries(interfaces || {}).forEach(([name, addresses]) => {
    (addresses || []).forEach((info) => {
      const ipv4 = isIPv4(info.family);
      if (info.internal || isLinkLocal(info.address, ipv4) || (!ipv4 && host === "0.0.0.0")) {
        return;
      }

      candidates.push({
        origin: formatOrigin(protocol, info.address, port),
        rank: [ipv4 ? 0 : 1, VIRTUAL_INTERFACE.test(name) ? 1 : 0, ipv4 ? ipv4Rank(info.address) : 0],
        order: candidates.length,
      });
    });
  });

  const compare = (a, b) => a.rank.findIndex((value, i) => value !== b.rank[i]);
  candidates.sort((a, b) => {
    const i = compare(a, b);
    return i === -1 ? a.order - b.order : a.rank[i] - b.rank[i];
  });

  return [...new Set(candidates.map((candidate) => candidate.origin))];
}
