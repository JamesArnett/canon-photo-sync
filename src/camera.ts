import { Readable } from 'node:stream';

export class CameraProtocolError extends Error {}
export class CameraBusy extends Error {}

export type Identity = { serial: string; model: string; battery?: number; free?: number };
export type Media = {
  key: string; storage: string; path: string; name: string;
  size?: number; captured?: string; modified?: string; sha256?: string;
};
export interface CameraAdapter {
  identify(signal: AbortSignal): Promise<Identity>;
  list(signal: AbortSignal): AsyncIterable<Media>;
  open(media: Media, signal: AbortSignal): Promise<Readable>;
  thumbnail?(media: Media, signal: AbortSignal): Promise<Uint8Array | undefined>;
}

export class SimulatedCamera implements CameraAdapter {
  online = true;
  interrupted = false;
  constructor(readonly serial: string, readonly media: Media[]) {}
  async identify() {
    if (!this.online) throw Error('Camera unavailable');
    return { serial: this.serial, model: 'Simulated EOS', battery: 90 };
  }
  async *list(signal: AbortSignal) {
    await this.identify();
    for (const item of this.media) { signal.throwIfAborted(); yield item; }
  }
  async open(media: Media, signal: AbortSignal) {
    await this.identify();
    const interrupted = this.interrupted;
    return Readable.from((async function* () {
      const chunk = Buffer.alloc(64 * 1024, Number.parseInt(media.key, 10) || 1);
      for (let left = media.size ?? 10; left > 0; left -= chunk.length) {
        signal.throwIfAborted();
        yield chunk.subarray(0, Math.min(left, chunk.length));
        if (interrupted) throw Error('Simulated interruption');
      }
    })());
  }
}
