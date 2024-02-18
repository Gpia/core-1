import { BinaryWriter } from '@furyjs/fury/dist/lib/writer';

import { readUInt32LE, Emitter } from '@opensumi/ide-core-common';

import { Buffers } from '../../buffers/buffers';

const writer = BinaryWriter({});

/**
 * You can use `Buffer.from('\r\n\r\n')` to get this indicator.
 */
export const indicator = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);

/**
 * sticky packet unpacking problems are generally problems at the transport layer.
 * we use a length field to represent the length of the data, and then read the data according to the length
 */
export function prependLengthField(content: Uint8Array) {
  writer.reset();
  writer.buffer(indicator);
  writer.uint32(content.byteLength);
  writer.buffer(content);
  return writer.dump();
}

export class LengthFieldBasedFrameDecoder {
  protected dataEmitter = new Emitter<Uint8Array>();
  onData = this.dataEmitter.event;

  protected buffers = new Buffers();
  protected cursor = this.buffers.cursor();

  protected contentLength = -1;

  protected state = 0;

  /**
   * The number of bytes in the length field.
   *
   * How many bytes are used to represent data length.
   *
   * For example, if the length field is 4 bytes, then the maximum length of the data is 2^32 = 4GB
   */
  lengthFieldLength = 4;

  reset() {
    this.contentLength = -1;
    this.state = 0;
    this.cursor.reset();
  }

  push(chunk: Uint8Array): void {
    this.buffers.push(chunk);
    let done = false;

    while (!done) {
      done = this.readFrame();
    }
  }

  protected readFrame(): boolean {
    const found = this.readLengthField();

    if (found) {
      const start = this.cursor.offset;
      const end = start + this.contentLength;

      const binary = this.buffers.slice(start, end);

      this.dataEmitter.fire(binary);

      if (this.buffers.byteLength > end) {
        this.contentLength = -1;
        this.state = 0;
        this.cursor.moveTo(end);
        // has more data, continue to parse
        return false;
      }

      // delete used buffers
      this.buffers.splice(0, end);
      this.reset();
    }

    return true;
  }

  protected readLengthField() {
    const bufferLength = this.buffers.byteLength;

    if (this.state !== 4) {
      if (this.cursor.offset + indicator.length > bufferLength) {
        // Not enough data yet, wait for more data
        return false;
      }

      this.readIndicator();
    }

    if (this.state !== 4) {
      // Not a complete indicator yet, wait for more data
      return false;
    }

    if (this.contentLength === -1) {
      if (this.cursor.offset + this.lengthFieldLength > bufferLength) {
        // Not enough data yet, wait for more data
        return false;
      }

      // read the content length
      const buf = this.cursor.read(this.lengthFieldLength);
      // fury writer use little endian
      this.contentLength = readUInt32LE(buf, 0);
    }

    if (this.cursor.offset + this.contentLength > bufferLength) {
      // Not enough data yet, wait for more data
      return false;
    }

    return true;
  }

  protected readIndicator() {
    const iter = this.cursor.iterator();

    let result = iter.next();
    while (!result.done) {
      switch (result.value) {
        case 0x0d:
          switch (this.state) {
            case 0:
              this.state = 1;
              break;
            case 2:
              this.state = 3;
              break;
            default:
              this.state = 0;
              break;
          }
          break;
        case 0x0a:
          switch (this.state) {
            case 1:
              this.state = 2;
              break;
            case 3:
              this.state = 4;
              iter.return();
              break;
            default:
              this.state = 0;
              break;
          }
          break;
        default:
          this.state = 0;
          break;
      }
      result = iter.next();
    }
  }

  dispose() {
    this.dataEmitter.dispose();
    this.buffers.dispose();
  }
}
