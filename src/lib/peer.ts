// NannyCam peer wrapper — canonical perfect negotiation over the relay's
// opaque `signal` payload. Camera = impolite, viewer = polite.
//
// NO STUN, NO TURN, EVER: `iceServers: []` is the spec's structural guarantee
// that no third party touches the connection — host candidates only (LAN IPs
// + Tailscale 100.x). There is deliberately NO config surface to add servers.
//
// Signal payload wire shape (validated structurally in handleSignal; anything
// else — relay payloads are untrusted — is silently ignored):
//   { kind: 'description', description: RTCSessionDescriptionInit }
//   { kind: 'candidate',   candidate: RTCIceCandidateInit | null }

export type PeerRole = 'camera' | 'viewer';

export interface PeerOptions {
  role: PeerRole;
  remotePeerId: string;
  /** Session wraps into {type:'signal', to: remotePeerId, payload}. */
  sendSignal: (payload: unknown) => void;
  /** Injectable seam for future tests. Defaults to `new RTCPeerConnection`. */
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isDescription = (v: unknown): v is RTCSessionDescriptionInit =>
  isRecord(v) &&
  (v.type === 'offer' || v.type === 'answer') &&
  (v.sdp === undefined || typeof v.sdp === 'string');

const isCandidate = (v: unknown): v is RTCIceCandidateInit | null =>
  v === null || isRecord(v);

export class Peer {
  readonly remotePeerId: string;
  private readonly pc: RTCPeerConnection;
  private readonly polite: boolean;
  private readonly sendSignal: (payload: unknown) => void;
  private channel: RTCDataChannel | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  /** One automatic restartIce() per failure episode; reset on 'connected'. */
  private restarted = false;
  private warned = false;
  private closed = false;
  private stateCbs: Array<(s: RTCPeerConnectionState) => void> = [];
  private trackCbs: Array<(ev: RTCTrackEvent) => void> = [];
  private dataCbs: Array<(text: string) => void> = [];
  private openCbs: Array<() => void> = [];

  constructor(opts: PeerOptions) {
    this.remotePeerId = opts.remotePeerId;
    this.polite = opts.role === 'viewer'; // perfect negotiation: viewer yields
    this.sendSignal = opts.sendSignal;
    const create = opts.createPeerConnection ?? ((c) => new RTCPeerConnection(c));
    this.pc = create({ iceServers: [] }); // empty by design — see file header

    // Adding tracks/transceivers fires negotiationneeded, which drives offers.
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        this.sendLocalDescription();
      } catch (err) {
        this.warnOnce(err);
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.onicecandidate = (ev) =>
      this.sendSignal({ kind: 'candidate', candidate: ev.candidate?.toJSON() ?? null });

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'connected') this.restarted = false;
      if (s === 'failed' && !this.restarted) {
        // At most one automatic recovery attempt per failure episode; repeated
        // failures beyond this are the session layer's job (rung 2/3).
        this.restarted = true;
        this.pc.restartIce();
      }
      for (const cb of this.stateCbs) cb(s);
    };

    this.pc.ontrack = (ev) => { for (const cb of this.trackCbs) cb(ev); };

    if (opts.role === 'camera') {
      // Created in the constructor so the channel rides the first offer.
      this.attachChannel(this.pc.createDataChannel('nannycam'));
    } else {
      this.pc.ondatachannel = (ev) => this.attachChannel(ev.channel);
    }
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
    return this.pc.addTrack(track, stream);
  }

  addTransceiver(kind: 'audio' | 'video', init?: RTCRtpTransceiverInit): RTCRtpTransceiver {
    return this.pc.addTransceiver(kind, init);
  }

  /**
   * Feed one inbound relay payload. Canonical perfect-negotiation receive side:
   * impolite peer ignores colliding offers, polite peer rolls back (implicitly,
   * via setRemoteDescription). Garbage is ignored silently; never rejects.
   */
  async handleSignal(payload: unknown): Promise<void> {
    if (this.closed || !isRecord(payload)) return;
    try {
      if (payload.kind === 'description' && isDescription(payload.description)) {
        const description = payload.description;
        const collision =
          description.type === 'offer' &&
          (this.makingOffer || this.pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await this.pc.setLocalDescription();
          this.sendLocalDescription();
        }
      } else if (payload.kind === 'candidate' && isCandidate(payload.candidate)) {
        try {
          await this.pc.addIceCandidate(payload.candidate ?? undefined);
        } catch (err) {
          // Candidate errors while ignoring an offer are expected (canonical).
          if (!this.ignoreOffer) throw err;
        }
      }
      // Unknown kind / malformed shape: silently ignored (untrusted input).
    } catch (err) {
      this.warnOnce(err);
    }
  }

  /** Send a text frame over the data channel; false if not open. */
  sendData(text: string): boolean {
    if (this.channel === null || this.channel.readyState !== 'open') return false;
    try {
      this.channel.send(text);
      return true;
    } catch {
      return false; // channel died between the readyState check and the send
    }
  }

  /** Idempotent: closes the data channel and the connection. Nothing else. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.channel?.close(); this.pc.close(); } catch { /* already closed */ }
  }

  onConnectionState(cb: (s: RTCPeerConnectionState) => void): () => void {
    return subscribe(this.stateCbs, cb);
  }

  onTrack(cb: (ev: RTCTrackEvent) => void): () => void {
    return subscribe(this.trackCbs, cb);
  }

  onDataMessage(cb: (text: string) => void): () => void {
    return subscribe(this.dataCbs, cb);
  }

  onDataOpen(cb: () => void): () => void {
    return subscribe(this.openCbs, cb);
  }

  private attachChannel(ch: RTCDataChannel): void {
    this.channel = ch;
    ch.onopen = () => { for (const cb of this.openCbs) cb(); };
    ch.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return; // text frames only
      for (const cb of this.dataCbs) cb(ev.data);
    };
  }

  private sendLocalDescription(): void {
    const d = this.pc.localDescription;
    if (d === null) return;
    this.sendSignal({ kind: 'description', description: { type: d.type, sdp: d.sdp } });
  }

  /** Log internal errors once per peer — not spammed per message. */
  private warnOnce(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[peer ${this.remotePeerId}]`, err);
  }
}

function subscribe<T>(list: T[], cb: T): () => void {
  list.push(cb);
  return () => { const i = list.indexOf(cb); if (i !== -1) list.splice(i, 1); };
}
