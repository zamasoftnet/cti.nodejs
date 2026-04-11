/**
 * CTIP2 プロトコル実装
 * 
 * このモジュールは、Copper PDFサーバーとの通信に使用されるCTIP2プロトコルの
 * パケット生成および解析機能を提供します。
 */

/** プロトコルメッセージタイプ */
export const MSG = {
    // リクエストタイプ
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

    // レスポンスタイプ
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

/** サーバーから受信した CTIP2 レスポンスパケットを表すインターフェース */
export interface Packet {
    /** レスポンスタイプ (`MSG.RES_*` 定数のいずれか) */
    type: number;
    /** ドキュメントまたはリソースの URI */
    uri?: string;
    /** コンテンツの MIME タイプ (例: `text/html`, `text/css`) */
    mime_type?: string;
    /** コンテンツのエンコーディング (例: `UTF-8`) */
    encoding?: string;
    /** コンテンツの全体バイト長。不明の場合は -1 */
    length?: number;
    /** ブロック操作の対象ブロック ID */
    block_id?: number;
    /** メッセージまたは中断コード */
    code?: number;
    /** メッセージ本文 */
    message?: string;
    /** メッセージの追加引数 */
    args?: string[];
    /** ブロックデータまたはシリアルデータのバイナリペイロード */
    bytes?: Buffer;
    /** 中断モード (`RES_ABORT` のみ: 0 = 出力フラッシュ後中断、それ以外 = 即時中断) */
    mode?: number;
}

// --- 書き込みヘルパー ---

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

// --- リクエスト生成 ---

/**
 * サーバー情報取得リクエストパケットを生成する。
 * @param uri - 情報取得対象の URI。空文字列でサーバー機能一覧を要求できる
 * @returns エンコード済みの `REQ_SERVER_INFO` フレーム
 */
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

/**
 * クライアントサイドリソース解決の有効/無効をサーバーに通知するパケットを生成する。
 * `Session.setResolverFunc()` が呼ばれたときに内部から使用される。
 * @param mode - `true` でクライアントリソースモードを有効化
 * @returns エンコード済みの `REQ_CLIENT_RESOURCE` フレーム
 */
export function req_client_resource(mode: boolean): Buffer {
    const payloadSize = 2;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    off = writeByte(buf, off, MSG.REQ_CLIENT_RESOURCE);
    writeByte(buf, off, mode ? 1 : 0);
    return buf;
}

/**
 * 連続トランスコードモードの有効/無効をサーバーに通知するパケットを生成する。
 * 有効にすると、同一セッションで複数回の `transcode()` が可能になる。
 * @param mode - `true` で連続モードを有効化
 * @returns エンコード済みの `REQ_CONTINUOUS` フレーム
 */
export function req_continuous(mode: boolean): Buffer {
    const payloadSize = 2;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    off = writeByte(buf, off, MSG.REQ_CONTINUOUS);
    writeByte(buf, off, mode ? 1 : 0);
    return buf;
}

/**
 * 指定 URI のリソースが存在しないことをサーバーに通知するパケットを生成する。
 * `ResolverCallback` でリソースが見つからなかった場合に自動的に送信される。
 * @param uri - 見つからなかったリソースの URI
 * @returns エンコード済みの `REQ_MISSING_RESOURCE` フレーム
 */
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

/**
 * セッション状態をリセットするパケットを生成する。
 * 連続モード中に次のトランスコードへ移行する前に送信される。
 * @returns エンコード済みの `REQ_RESET` フレーム
 */
export function req_reset(): Buffer {
    const payloadSize = 1;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    writeByte(buf, off, MSG.REQ_RESET);
    return buf;
}

/**
 * 進行中のトランスコードを中断するパケットを生成する。
 * @param mode - 中断モード。`0` = 現在の出力をフラッシュして中断、それ以外 = 即時中断
 * @returns エンコード済みの `REQ_ABORT` フレーム
 */
export function req_abort(mode: number): Buffer {
    const payloadSize = 2;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    off = writeByte(buf, off, MSG.REQ_ABORT);
    writeByte(buf, off, mode);
    return buf;
}

/**
 * 連続モードで送信済みの複数ドキュメントをサーバー側で結合するパケットを生成する。
 * @returns エンコード済みの `REQ_JOIN` フレーム
 */
export function req_join(): Buffer {
    const payloadSize = 1;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    writeByte(buf, off, MSG.REQ_JOIN);
    return buf;
}

/**
 * 現在送信中のコンテンツ (メインまたはリソース) の終端を通知するパケットを生成する。
 * @returns エンコード済みの `REQ_EOF` フレーム
 */
export function req_eof(): Buffer {
    const payloadSize = 1;
    const buf = Buffer.alloc(4 + payloadSize);
    let off = 0;
    off = writeInt(buf, off, payloadSize);
    writeByte(buf, off, MSG.REQ_EOF);
    return buf;
}

/**
 * トランスコード制御プロパティをサーバーに送信するパケットを生成する。
 * @param name - プロパティ名 (エンコーディングは UTF-8)
 * @param value - プロパティ値 (エンコーディングは UTF-8)
 * @returns エンコード済みの `REQ_PROPERTY` フレーム
 */
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

/**
 * サーバー内の URI を直接メインドキュメントとして指定するパケットを生成する。
 * クライアントからコンテンツを送信せず、サーバー側でコンテンツを取得する。
 * @param uri - サーバー内ドキュメントの URI
 * @returns エンコード済みの `REQ_SERVER_MAIN` フレーム
 */
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

/**
 * リソースデータ送信開始を通知するパケットを生成する。
 * このパケット送信後、`req_data()` でコンテンツを送り、`req_eof()` で終端を通知する。
 * @param uri - リソースの URI
 * @param mimeType - コンテンツの MIME タイプ (デフォルト: `text/css`)
 * @param encoding - コンテンツのエンコーディング (デフォルト: 空文字列)
 * @param length - コンテンツのバイト長。不明の場合は `-1`
 * @returns エンコード済みの `REQ_START_RESOURCE` フレーム
 */
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

/**
 * メインドキュメントのトランスコード開始を通知するパケットを生成する。
 * このパケット送信後、`req_data()` でコンテンツを送り、`req_eof()` で終端を通知する。
 * @param uri - ドキュメントの URI (ベース URI として使用される)
 * @param mimeType - コンテンツの MIME タイプ (デフォルト: `text/html`)
 * @param encoding - コンテンツのエンコーディング (デフォルト: `UTF-8`)
 * @param length - コンテンツのバイト長。不明の場合は `-1`
 * @returns エンコード済みの `REQ_START_MAIN` フレーム
 */
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

/**
 * コンテンツチャンクを運ぶデータパケットを生成する。
 * `req_start_main()` または `req_start_resource()` 後に繰り返し呼び出す。
 * @param data - 送信するバイナリデータまたは文字列 (文字列の場合は UTF-8 エンコード)
 * @returns エンコード済みの `REQ_DATA` フレーム
 */
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

/**
 * セッションを終了してサーバーとの接続を閉じるパケットを生成する。
 * @returns エンコード済みの `REQ_CLOSE` フレーム
 */
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

// --- パケット解析 ---

/**
 * バイナリバッファを順番に読み進めるためのヘルパークラス。
 * CTIP2 パケットのデシリアライズに内部的に使用される。
 */
class BufferReader {
    private buffer: Buffer;
    /** 現在の読み取りオフセット (バイト単位) */
    public offset: number = 0;

    /**
     * @param buffer - 読み取り元のバッファ
     */
    constructor(buffer: Buffer) {
        this.buffer = buffer;
    }

    /**
     * 現在位置から 1 バイトを符号なし整数として読み取り、オフセットを進める。
     * @returns 読み取った 0〜255 の値
     */
    readByte(): number {
        const v = this.buffer.readUInt8(this.offset);
        this.offset += 1;
        return v;
    }

    /**
     * 現在位置から 2 バイトをビッグエンディアン符号なし整数として読み取る。
     * @returns 読み取った 0〜65535 の値
     */
    readShort(): number {
        const v = this.buffer.readUInt16BE(this.offset);
        this.offset += 2;
        return v;
    }

    /**
     * 現在位置から 4 バイトをビッグエンディアン符号なし整数として読み取る。
     * @returns 読み取った 32bit 非負整数
     */
    readInt(): number {
        const v = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return v;
    }

    /**
     * 現在位置から 8 バイトをビッグエンディアン符号付き整数として読み取る。
     * JavaScript の `number` 精度の範囲内で返す。
     * @returns 読み取った 64bit 整数 (number に変換済み)
     */
    readLong(): number {
        const v = this.buffer.readBigInt64BE(this.offset);
        this.offset += 8;
        return Number(v);
    }

    /**
     * 現在位置から 2 バイトの長さプレフィックスを読み取り、その長さ分のバイト列を返す。
     * @returns 読み取ったバイト列
     */
    readBytes(): Buffer {
        const len = this.readShort();
        const b = this.buffer.subarray(this.offset, this.offset + len);
        this.offset += len;
        return b;
    }

    /**
     * 長さプレフィックス付きバイト列を UTF-8 文字列として読み取る。
     * @returns デコードされた文字列
     */
    readString(): string {
        return this.readBytes().toString('utf8');
    }

    /**
     * 現在位置から指定バイト数を生バイト列として読み取る。
     * @param len - 読み取るバイト数
     * @returns 読み取ったバイト列
     */
    readRaw(len: number): Buffer {
        const b = this.buffer.subarray(this.offset, this.offset + len);
        this.offset += len;
        return b;
    }

    /**
     * バッファ末尾までの残りバイト数を返す。
     */
    get remaining(): number {
        return this.buffer.length - this.offset;
    }
}

/**
 * CTIP2 プロトコルレスポンスのストリーミングパケットパーサー。
 * ソケットから断片的に届くバイナリデータを内部バッファに蓄積し、
 * 完全なパケットが揃ったタイミングで `next()` から取り出せる。
 */
export class PacketParser {
    private buffer: Buffer = Buffer.alloc(0);

    /**
     * 受信したバイナリデータを内部バッファに追記する。
     * ソケットの `data` イベントハンドラから呼び出す。
     * @param data - ソケットから受信したバイナリチャンク
     */
    append(data: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, data]);
    }

    /**
     * 内部バッファから次の完全なパケットを取り出して解析する。
     * パケットが揃っていない場合は `null` を返す。
     * 複数のパケットが蓄積されている場合は繰り返し呼び出すこと。
     * @returns 解析済みの `Packet`、またはデータ不足の場合は `null`
     */
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
