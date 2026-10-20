/**
 * Fake WebRTC for the nearby tests (Node has none): RTCPeerConnection,
 * RTCDataChannel and BroadcastChannel stand-ins on a simulated LAN. Not used
 * by the app.
 *
 * - Each fake connection writes a Chrome-like SDP with its own ICE ufrag,
 *   pwd and DTLS fingerprint, and "gathers" one host candidate (an mDNS
 *   name) shortly after setLocalDescription, as trickled icecandidate events
 *   and in its local description, then reports gathering complete.
 * - Two fakes connect once both have both descriptions and each one's remote
 *   description names the other's ufrag and fingerprint: the SDP the real
 *   codec rebuilt from a QR code must carry them faithfully. The offerer's
 *   data channels then appear on the answerer ("datachannel") and open.
 * - Delivery uses setTimeout (tests drive it with fake timers), in order per
 *   channel. The LAN can make pairs unreachable (ICE fails), stall them
 *   (neither connect nor fail) or silence them (frames lost, nothing closes).
 */
import {
  BroadcastChannelFactory,
  BroadcastChannelLike,
  DataChannelLike,
  IceCandidateLike,
  PeerConnectionFactory,
  PeerConnectionLike,
} from "./links";

function fakeEvent(type: string, fields: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type), fields);
}

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619) >>> 0;
  return value;
}

/** A stable "<uuid>.local" name per tab, like Chrome's mDNS host names. */
export function mdnsNameOf(owner: string): string {
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  const a = hex(hash(owner));
  const b = hex(hash(`${owner}#`));
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-8${a.slice(1, 4)}-${hex(hash(`${owner}!`))}${b.slice(0, 4)}.local`;
}

export class FakeLan {
  /** One-way delay of data channel frames. */
  latencyMs = 2;
  /** From both descriptions set to connected (or failed). */
  connectDelayMs = 30;
  /** From setLocalDescription to the candidate and the end of gathering. */
  gatherDelayMs = 20;
  /** false: gathering never reports completion (the manager stops waiting after ~3s). */
  gatheringCompletes = true;
  /** Whether two tabs reach each other (false: ICE fails). */
  reachable: (a: string, b: string) => boolean = () => true;
  /** Pairs that stay "connecting" forever. */
  stalls: (a: string, b: string) => boolean = () => false;
  /** Host candidates a tab gathers (candidate attribute values). */
  candidatesOf: (owner: string, pc: FakePeerConnection) => string[] = (owner, pc) => [
    `candidate:${hash(owner) % 1e9} 1 udp 2113937151 ${mdnsNameOf(owner)} ${50000 + pc.id} typ host generation 0`,
  ];

  readonly connections: FakePeerConnection[] = [];
  private silenced = new Set<string>();
  private counter = 0;

  /** The RTCPeerConnection factory of one tab. */
  factory(owner: string): PeerConnectionFactory {
    return (config) => {
      const pc = new FakePeerConnection(this, owner, ++this.counter, config);
      this.connections.push(pc);
      return pc;
    };
  }

  connectionsOf(owner: string): FakePeerConnection[] {
    return this.connections.filter((pc) => pc.owner === owner);
  }

  /** Lose every frame between two tabs (both ways), without closing anything. */
  silence(a: string, b: string, silent = true) {
    const key = [a, b].sort().join("|");
    if (silent) {
      this.silenced.add(key);
    } else {
      this.silenced.delete(key);
    }
  }

  isSilenced(a: string, b: string): boolean {
    return this.silenced.has([a, b].sort().join("|"));
  }

  byUfrag(ufrag: string): FakePeerConnection | undefined {
    return this.connections.find((pc) => pc.ufrag === ufrag);
  }
}

export class FakeDataChannel extends EventTarget implements DataChannelLike {
  readyState = "connecting";
  peer: FakeDataChannel | null = null;
  /** Every frame sent, for inspection. */
  readonly sent: string[] = [];

  constructor(private readonly lan: FakeLan, readonly owner: string, readonly label: string) {
    super();
  }

  send(data: string) {
    if (this.readyState !== "open") throw new Error("InvalidStateError: the channel is not open");
    this.sent.push(data);
    const peer = this.peer;
    if (!peer || this.lan.isSilenced(this.owner, peer.owner)) return;
    setTimeout(() => {
      if (peer.readyState === "open") peer.dispatchEvent(fakeEvent("message", { data }));
    }, this.lan.latencyMs);
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    const peer = this.peer;
    if (peer) setTimeout(() => peer.closedRemotely(), this.lan.latencyMs);
  }

  open() {
    if (this.readyState !== "connecting") return;
    this.readyState = "open";
    this.dispatchEvent(fakeEvent("open"));
  }

  private closedRemotely() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(fakeEvent("close"));
  }
}

interface FakeDescription {
  type: "offer" | "answer";
  sdp: string;
}

export class FakePeerConnection extends EventTarget implements PeerConnectionLike {
  readonly ufrag: string;
  readonly pwd: string;
  readonly fingerprint: string;
  connectionState = "new";
  iceConnectionState = "new";
  iceGatheringState = "new";
  remoteDescription: FakeDescription | null = null;
  partner: FakePeerConnection | null = null;
  closed = false;
  offersCreated = 0;
  /** Data channels created here, and those announced by the other side. */
  readonly channels: FakeDataChannel[] = [];
  readonly remoteCandidates: IceCandidateLike[] = [];
  private localType: "offer" | "answer" | null = null;
  private gathered: string[] = [];

  constructor(
    private readonly lan: FakeLan,
    readonly owner: string,
    readonly id: number,
    readonly config: { iceServers: unknown[] }
  ) {
    super();
    this.ufrag = `F${id.toString(36).padStart(3, "0")}`;
    this.pwd = `fakepwd${String(id).padStart(17, "0")}`;
    this.fingerprint = Array.from({ length: 32 }, (_, i) =>
      ((id * 31 + i * 7) & 0xff).toString(16).padStart(2, "0").toUpperCase()
    ).join(":");
  }

  get localDescription(): FakeDescription | null {
    return this.localType ? { type: this.localType, sdp: this.sdp(this.localType) } : null;
  }

  createDataChannel(label: string): FakeDataChannel {
    const channel = new FakeDataChannel(this.lan, this.owner, label);
    this.channels.push(channel);
    return channel;
  }

  async createOffer() {
    if (this.closed) throw new Error("InvalidStateError: closed");
    this.offersCreated++;
    return { type: "offer", sdp: this.sdp("offer") };
  }

  async createAnswer() {
    if (this.closed) throw new Error("InvalidStateError: closed");
    if (this.remoteDescription?.type !== "offer") throw new Error("InvalidStateError: no remote offer");
    return { type: "answer", sdp: this.sdp("answer") };
  }

  async setLocalDescription(description: { type?: string; sdp?: string }) {
    if (this.closed) throw new Error("InvalidStateError: closed");
    if (description.type !== "offer" && description.type !== "answer") throw new Error("TypeError: bad type");
    this.localType = description.type;
    setTimeout(() => this.gather(), this.lan.gatherDelayMs);
    this.tryConnect();
  }

  async setRemoteDescription(description: { type: "offer" | "answer"; sdp: string }) {
    if (this.closed) throw new Error("InvalidStateError: closed");
    if (!/a=ice-ufrag:\S+/.test(description.sdp) || !/a=fingerprint:sha-256 \S+/.test(description.sdp)) {
      throw new Error("OperationError: incomplete description");
    }
    this.remoteDescription = { type: description.type, sdp: description.sdp };
    this.tryConnect();
  }

  async addIceCandidate(candidate: IceCandidateLike) {
    if (!this.remoteDescription) throw new Error("InvalidStateError: no remote description");
    this.remoteCandidates.push(candidate);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = "closed";
    this.iceConnectionState = "closed";
    this.channels.forEach((channel) => channel.close());
  }

  private sdp(type: "offer" | "answer"): string {
    const setup = type === "offer" ? "actpass" : "active";
    return [
      "v=0",
      `o=- ${4000000000 + this.id} 2 IN IP4 127.0.0.1`,
      "s=-",
      "t=0 0",
      "a=group:BUNDLE 0",
      "a=extmap-allow-mixed",
      "a=msid-semantic: WMS",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "c=IN IP4 0.0.0.0",
      ...this.gathered.map((candidate) => `a=${candidate}`),
      `a=ice-ufrag:${this.ufrag}`,
      `a=ice-pwd:${this.pwd}`,
      "a=ice-options:trickle",
      `a=fingerprint:sha-256 ${this.fingerprint}`,
      `a=setup:${setup}`,
      "a=mid:0",
      "a=sctp-port:5000",
      "a=max-message-size:262144",
      "",
    ].join("\r\n");
  }

  private gather() {
    if (this.closed || this.gathered.length) return;
    this.setGathering("gathering");
    this.lan.candidatesOf(this.owner, this).forEach((candidate) => {
      this.gathered.push(candidate);
      this.dispatchEvent(fakeEvent("icecandidate", { candidate: { candidate, sdpMid: "0", sdpMLineIndex: 0 } }));
    });
    if (this.lan.gatheringCompletes) {
      this.setGathering("complete");
      this.dispatchEvent(fakeEvent("icecandidate", { candidate: null }));
    }
  }

  private setGathering(state: string) {
    this.iceGatheringState = state;
    this.dispatchEvent(fakeEvent("icegatheringstatechange"));
  }

  private setState(state: string) {
    if (this.closed || this.connectionState === state) return;
    this.connectionState = state;
    this.iceConnectionState = state;
    this.dispatchEvent(fakeEvent("connectionstatechange"));
  }

  private remoteField(name: string): string | null {
    return new RegExp(`a=${name}:(?:sha-256 )?(\\S+)`).exec(this.remoteDescription?.sdp ?? "")?.[1] ?? null;
  }

  private tryConnect() {
    if (this.closed || this.partner || !this.localType || !this.remoteDescription) return;
    const other = this.lan.byUfrag(this.remoteField("ice-ufrag"));
    if (!other || other === this || other.closed || other.partner) return;
    if (!other.localType || !other.remoteDescription || other.remoteField("ice-ufrag") !== this.ufrag) return;

    this.partner = other;
    other.partner = this;
    this.setState("connecting");
    other.setState("connecting");
    if (this.lan.stalls(this.owner, other.owner)) return;

    setTimeout(() => {
      if (this.closed || other.closed) return;
      // DTLS checks the fingerprints that came with the descriptions.
      const authentic =
        this.remoteField("fingerprint") === other.fingerprint && other.remoteField("fingerprint") === this.fingerprint;
      if (!authentic || !this.lan.reachable(this.owner, other.owner)) {
        this.setState("failed");
        other.setState("failed");
        return;
      }
      this.setState("connected");
      other.setState("connected");
      const offerer = this.localType === "offer" ? this : other;
      const answerer = offerer === this ? other : this;
      offerer.channels.slice().forEach((channel) => {
        const remote = new FakeDataChannel(this.lan, answerer.owner, channel.label);
        channel.peer = remote;
        remote.peer = channel;
        answerer.channels.push(remote);
        remote.readyState = "open";
        answerer.dispatchEvent(fakeEvent("datachannel", { channel: remote }));
        channel.open();
        remote.dispatchEvent(fakeEvent("open"));
      });
    }, this.lan.connectDelayMs);
  }
}

/** BroadcastChannel between the tabs of one simulated browser. */
export class FakeBroadcastHub {
  private channels = new Set<{ name: string; channel: BroadcastChannelLike }>();

  readonly factory: BroadcastChannelFactory = (name: string) => {
    const hub = this.channels;
    let closed = false;
    const channel: BroadcastChannelLike = {
      onmessage: null,
      postMessage(message: unknown) {
        if (closed) throw new Error("InvalidStateError: closed");
        const data = JSON.parse(JSON.stringify(message));
        hub.forEach((other) => {
          if (other.channel === channel || other.name !== name) return;
          setTimeout(() => other.channel.onmessage?.({ data }), 1);
        });
      },
      close() {
        closed = true;
        hub.forEach((entry) => {
          if (entry.channel === channel) hub.delete(entry);
        });
      },
    };
    hub.add({ name, channel });
    return channel;
  };
}
