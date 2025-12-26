/**
 * CTIP2 Protocol Implementation
 * 
 * This module provides packet generation and parsing for the CTIP2 protocol
 * used to communicate with Copper PDF servers.
 */

/** Protocol message types */
export const MSG = {
    // Request types
    REQ_PROPERTY: 0x01,
    REQ_START_MAIN: 0x02,
    REQ_SERVER_MAIN: 0x03,
    REQ_CLIENT_RESOURCE: 0x04,
    REQ_CONTINUOUS: 0x05,
    REQ_DATA: 0x11,
    REQ_START_RESOURCE: 0x21,
    REQ_MISSING_RESOURCE: 0x22,
    REQ_EOF: 0x31,
    REQ_ABORT: 0x32,
    REQ_JOIN: 0x33,
    REQ_RESET: 0x41,
    REQ_CLOSE: 0x42,
    REQ_SERVER_INFO: 0x51,

    // Response types
    RES_START_DATA: 0x01,
    RES_BLOCK_DATA: 0x11,
    RES_ADD_BLOCK: 0x12,
    RES_INSERT_BLOCK: 0x13,
    RES_MESSAGE: 0x14,
    RES_MAIN_LENGTH: 0x15,
    RES_MAIN_READ: 0x16,
    RES_DATA: 0x17,
    RES_CLOSE_BLOCK: 0x18,
    RES_RESOURCE_REQUEST: 0x21,
    RES_EOF: 0x31,
    RES_ABORT: 0x32,
    RES_NEXT: 0x33,

    CTI_BUFFER_SIZE: 8192
} as const;

/** Response packet interface */
export interface Packet {
    type: number;
    uri?: string;
    mime_type?: string;
    encoding?: string;
    length?: number;
    block_id?: number;
    code?: number;
    message?: string;
    args?: string[];
    bytes?: Buffer;
    mode?: number;
}

// --- Write Helpers ---

function writeInt(buf: Buffer, offset: number, value: number): number {
    buf.writeUInt32BE(value, offset);
    return offset + 4;
}

function writeShort(buf: Buffer, offset: number, value: number): number {
    buf.writeUInt16BE(value, offset);
    return offset + 2;
}

function writeByte(buf: Buffer, offset: number, value: number): number {
    buf.writeUInt8(value, offset);
    return offset + 1;
}

function writeBytes(buf: Buffer, offset: number, strOrBuf: Buffer | string): number {
    const b = Buffer.isBuffer(strOrBuf) ? strOrBuf : Buffer.from(strOrBuf, 'utf8');
    offset = writeShort(buf, offset, b.length);
    b.copy(buf, offset);
    return offset + b.length;
}

function writeLong(buf: Buffer, offset: number, value: number): number {
    const bigVal = BigInt(value);
    buf.writeBigInt64BE(bigVal, offset);
    return offset + 8;
}

// --- Request Generators ---

/** Generate server info request packet */
export function req_server_info(uri: string): Buffer {
    const uriBuf = Buffer.from(uri, 'utf8');
    const payloadSize = 1 + 2 + uriBuf.length;
    const buf = Buffer.alloc(4 + payloadSize);

    let off = 0;
    off = writeInt(buf, off, payloadSize);
    off = writeByte(buf, off, MSG.REQ_SERVER_INFO);
    writeBytes(buf, off, uriBuf);
    return buf;
}

/** Generate client resource mode request packet */
export function req_client_resource(mode: boolean): Buffer {
    const payloadSize = 2;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    off = writeByte(buf, off, MSG.REQ_CLIENT_RESOURCE);
    writeByte(buf, off, mode ? 1 : 0);
    return buf;
}

/** Generate continuous mode request packet */
export function req_continuous(mode: boolean): Buffer {
    const payloadSize = 2;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    off = writeByte(buf, off, MSG.REQ_CONTINUOUS);
    writeByte(buf, off, mode ? 1 : 0);
    return buf;
}

/** Generate missing resource notification packet */
export function req_missing_resource(uri: string): Buffer {
    const uriBuf = Buffer.from(uri, 'utf8');
    const payloadSize = 1 + 2 + uriBuf.length;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    off = writeByte(buf, off, MSG.REQ_MISSING_RESOURCE);
    writeBytes(buf, off, uriBuf);
    return buf;
}

/** Generate reset request packet */
export function req_reset(): Buffer {
    const payloadSize = 1;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    writeByte(buf, off, MSG.REQ_RESET);
    return buf;
}

/** Generate abort request packet */
export function req_abort(mode: number): Buffer {
    const payloadSize = 2;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    off = writeByte(buf, off, MSG.REQ_ABORT);
    writeByte(buf, off, mode);
    return buf;
}

/** Generate join request packet */
export function req_join(): Buffer {
    const payloadSize = 1;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    writeByte(buf, off, MSG.REQ_JOIN);
    return buf;
}

/** Generate EOF request packet */
export function req_eof(): Buffer {
    const payloadSize = 1;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    writeByte(buf, off, MSG.REQ_EOF);
    return buf;
}

/** Generate property request packet */
export function req_property(name: string, value: string): Buffer {
    const nameBuf = Buffer.from(name, 'utf8');
    const valBuf = Buffer.from(value, 'utf8');
    const payloadSize = 5 + nameBuf.length + valBuf.length;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    off = writeByte(buf, off, MSG.REQ_PROPERTY);
    off = writeBytes(buf, off, nameBuf);
    writeBytes(buf, off, valBuf);
    return buf;
}

/** Generate server main request packet */
export function req_server_main(uri: string): Buffer {
    const uriBuf = Buffer.from(uri, 'utf8');
    const payloadSize = 1 + 2 + uriBuf.length;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    off = writeByte(buf, off, MSG.REQ_SERVER_MAIN);
    writeBytes(buf, off, uriBuf);
    return buf;
}

/** Generate start resource request packet */
export function req_start_resource(
    uri: string,
    mimeType: string = 'text/css',
    encoding: string = '',
    length: number = -1
): Buffer {
    const uriBuf = Buffer.from(uri, 'utf8');
    const mimeBuf = Buffer.from(mimeType, 'utf8');
    const encBuf = Buffer.from(encoding, 'utf8');
    const payloadSize = 1 + 2 + uriBuf.length + 2 + mimeBuf.length + 2 + encBuf.length + 8;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    off = writeByte(buf, off, MSG.REQ_START_RESOURCE);
    off = writeBytes(buf, off, uriBuf);
    off = writeBytes(buf, off, mimeBuf);
    off = writeBytes(buf, off, encBuf);
    writeLong(buf, off, length);
    return buf;
}

/** Generate start main request packet */
export function req_start_main(
    uri: string,
    mimeType: string = 'text/html',
    encoding: string = '',
    length: number = -1
): Buffer {
    const uriBuf = Buffer.from(uri, 'utf8');
    const mimeBuf = Buffer.from(mimeType, 'utf8');
    const encBuf = Buffer.from(encoding, 'utf8');
    const payloadSize = 1 + 2 + uriBuf.length + 2 + mimeBuf.length + 2 + encBuf.length + 8;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    off = writeByte(buf, off, MSG.REQ_START_MAIN);
    off = writeBytes(buf, off, uriBuf);
    off = writeBytes(buf, off, mimeBuf);
    off = writeBytes(buf, off, encBuf);
    writeLong(buf, off, length);
    return buf;
}

/** Generate data request packet */
export function req_data(data: Buffer | string): Buffer {
    const dBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const payloadSize = 1 + dBuf.length;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    off = writeByte(buf, off, MSG.REQ_DATA);
    dBuf.copy(buf, off);
    return buf;
}

/** Generate close request packet */
export function req_close(): Buffer {
    return req_simple(MSG.REQ_CLOSE);
}

function req_simple(type: number): Buffer {
    const payloadSize = 1;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    writeByte(buf, off, type);
    return buf;
}

// --- Packet Parsing ---

/** Buffer reader helper class */
class BufferReader {
    private buffer: Buffer;
    public offset: number = 0;

    constructor(buffer: Buffer) {
        this.buffer = buffer;
    }

    readByte(): number {
        const v = this.buffer.readUInt8(this.offset);
        this.offset += 1;
        return v;
    }

    readShort(): number {
        const v = this.buffer.readUInt16BE(this.offset);
        this.offset += 2;
        return v;
    }

    readInt(): number {
        const v = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return v;
    }

    readLong(): number {
        const v = this.buffer.readBigInt64BE(this.offset);
        this.offset += 8;
        return Number(v);
    }

    readBytes(): Buffer {
        const len = this.readShort();
        const b = this.buffer.subarray(this.offset, this.offset + len);
        this.offset += len;
        return b;
    }

    readString(): string {
        return this.readBytes().toString('utf8');
    }

    readRaw(len: number): Buffer {
        const b = this.buffer.subarray(this.offset, this.offset + len);
        this.offset += len;
        return b;
    }

    get remaining(): number {
        return this.buffer.length - this.offset;
    }
}

/** Packet parser for CTIP2 protocol responses */
export class PacketParser {
    private buffer: Buffer = Buffer.alloc(0);

    /** Append data to the internal buffer */
    append(data: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, data]);
    }

    /** Parse and return the next available packet, or null if incomplete */
    next(): Packet | null {
        if (this.buffer.length < 4) {
            return null;
        }

        const payloadSize = this.buffer.readUInt32BE(0);
        const totalSize = 4 + payloadSize;

        if (this.buffer.length < totalSize) {
            return null;
        }

        const payloadBuf = this.buffer.subarray(4, totalSize);
        this.buffer = this.buffer.subarray(totalSize);

        return this.parsePacket(payloadBuf, payloadSize);
    }

    private parsePacket(buf: Buffer, len: number): Packet {
        const reader = new BufferReader(buf);
        const type = reader.readByte();
        const res: Packet = { type };

        switch (type) {
            case MSG.RES_ADD_BLOCK:
            case MSG.RES_EOF:
            case MSG.RES_NEXT:
                break;

            case MSG.RES_START_DATA:
                res.uri = reader.readString();
                res.mime_type = reader.readString();
                res.encoding = reader.readString();
                res.length = reader.readLong();
                break;

            case MSG.RES_MAIN_LENGTH:
            case MSG.RES_MAIN_READ:
                res.length = reader.readLong();
                break;

            case MSG.RES_INSERT_BLOCK:
            case MSG.RES_CLOSE_BLOCK:
                res.block_id = reader.readInt();
                break;

            case MSG.RES_MESSAGE:
                res.code = reader.readShort();
                res.message = reader.readString();
                res.args = [];
                while (reader.remaining > 0) {
                    res.args.push(reader.readString());
                }
                break;

            case MSG.RES_BLOCK_DATA: {
                const dataLen = len - 5;
                res.block_id = reader.readInt();
                res.bytes = reader.readRaw(dataLen);
                break;
            }

            case MSG.RES_DATA: {
                const dataLen = len - 1;
                res.bytes = reader.readRaw(dataLen);
                break;
            }

            case MSG.RES_RESOURCE_REQUEST:
                res.uri = reader.readString();
                break;

            case MSG.RES_ABORT:
                res.mode = reader.readByte();
                res.code = reader.readShort();
                res.message = reader.readString();
                res.args = [];
                while (reader.remaining > 0) {
                    res.args.push(reader.readString());
                }
                break;

            default:
                throw new Error(`Unknown response type: ${type}`);
        }

        return res;
    }
}
