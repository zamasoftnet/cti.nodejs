/**
 * Session モジュール
 * 
 * このモジュールは、Copper PDFサーバーと通信するためのSessionクラスを提供します。
 */

import { Writable, WritableOptions } from 'stream';
import { Socket } from 'net';
import { TLSSocket } from 'tls';
import {
    MSG,
    PacketParser,
    Packet,
    req_server_info,
    req_client_resource,
    req_continuous,
    req_missing_resource,
    req_reset,
    req_abort,
    req_join,
    req_eof,
    req_property,
    req_server_main,
    req_start_resource,
    req_start_main,
    req_data,
    req_close
} from './ctip2';

import { SingleResult, DirectoryResults, Results } from './results';
import { StreamBuilder, FileBuilder, Builder } from './builder';

/** 無効なセッション状態で操作が試行されたときにスローされるエラー */
export class IllegalStateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'IllegalStateError';
    }
}

/** メッセージコールバック関数の型 */
export type MessageCallback = (code: number, message: string, args: string[]) => void;

/** 進捗コールバック関数の型 */
export type ProgressCallback = (total: number | null, read: number) => void;

/** リゾルバコールバック関数の型 */
export type ResolverCallback = (uri: string, resource: Resource) => void | Promise<void>;

/** セッションオプション インターフェース */
export interface SessionOptions {
    user?: string;
    password?: string;
    encoding?: string;
}

/** リソースオプション インターフェース */
export interface ResourceOptions {
    mime_type?: string;
    encoding?: string;
    length?: number;
}

/** トランスコードオプション インターフェース */
export interface TranscodeOptions {
    mimeType?: string;
    encoding?: string;
    length?: number;
}

/** メインドキュメントコンテンツ用の書き込み可能ストリーム */
class MainOut extends Writable {
    private session: Session;
    private buffer: Buffer;
    private pos: number = 0;

    constructor(session: Session, options?: WritableOptions) {
        super(options);
        this.session = session;
        this.buffer = Buffer.alloc(MSG.CTI_BUFFER_SIZE);
    }

    _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        let srcOff = 0;

        const processChunk = (): void => {
            if (srcOff >= chunk.length) {
                return callback();
            }

            const remaining = MSG.CTI_BUFFER_SIZE - this.pos;
            const copylen = Math.min(remaining, chunk.length - srcOff);
            chunk.copy(this.buffer, this.pos, srcOff, srcOff + copylen);
            this.pos += copylen;
            srcOff += copylen;

            if (this.pos >= MSG.CTI_BUFFER_SIZE) {
                const buf = req_data(this.buffer);
                this.pos = 0;
                if (!this.session.send(buf)) {
                    this.session.socket.once('drain', processChunk);
                    return;
                }
            }
            processChunk();
        };

        try {
            processChunk();
        } catch (err) {
            callback(err as Error);
        }
    }

    _final(callback: (error?: Error | null) => void): void {
        try {
            this.flush();
            this.session.send(req_eof());
            callback();
        } catch (err) {
            callback(err as Error);
        }
    }

    private flush(): void {
        if (this.pos > 0) {
            const slice = this.buffer.subarray(0, this.pos);
            const buf = req_data(slice);
            this.session.send(buf);
            this.pos = 0;
        }
    }
}

/** リソースコンテンツ用の書き込み可能ストリーム */
class ResourceOut extends Writable {
    private session: Session;
    private _closed: boolean = false;
    private buffer: Buffer;
    private pos: number = 0;

    constructor(session: Session, options?: WritableOptions) {
        super(options);
        this.session = session;
        this.buffer = Buffer.alloc(MSG.CTI_BUFFER_SIZE);
    }

    _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        let srcOff = 0;

        const processChunk = (): void => {
            if (srcOff >= chunk.length) {
                return callback();
            }

            const remaining = MSG.CTI_BUFFER_SIZE - this.pos;
            const copylen = Math.min(remaining, chunk.length - srcOff);
            chunk.copy(this.buffer, this.pos, srcOff, srcOff + copylen);
            this.pos += copylen;
            srcOff += copylen;

            if (this.pos >= MSG.CTI_BUFFER_SIZE) {
                const buf = req_data(this.buffer);
                this.pos = 0;
                if (!this.session.send(buf)) {
                    this.session.socket.once('drain', processChunk);
                    return;
                }
            }
            processChunk();
        };

        try {
            processChunk();
        } catch (err) {
            callback(err as Error);
        }
    }

    _final(callback: (error?: Error | null) => void): void {
        if (!this._closed) {
            try {
                this.flush();
                this.session.send(req_eof());
                this._closed = true;
                callback();
            } catch (err) {
                callback(err as Error);
            }
        } else {
            callback();
        }
    }

    private flush(): void {
        if (this.pos > 0) {
            const slice = this.buffer.subarray(0, this.pos);
            const buf = req_data(slice);
            this.session.send(buf);
            this.pos = 0;
        }
    }
}

/** リソースリクエストハンドラ */
export class Resource {
    private session: Session;
    public uri: string;
    public isMissing: boolean = true;
    private out: ResourceOut | null = null;

    constructor(session: Session, uri: string) {
        this.session = session;
        this.uri = uri;
    }

    /** リソースが見つかったことをマークし、出力ストリームを取得する */
    found(opts: ResourceOptions = {}): Writable {
        const mimeType = opts.mime_type || 'text/css';
        const encoding = opts.encoding || '';
        const length = (opts.length !== undefined) ? opts.length : -1;

        this.session.send(req_start_resource(this.uri, mimeType, encoding, length));
        this.isMissing = false;
        this.out = new ResourceOut(this.session);
        return this.out;
    }

    /** リソース送信を終了する */
    finish(): void {
        if (this.out) {
            this.out.end();
        }
    }
}

/** Copper PDFサーバーと通信するためのセッション */
export class Session {
    public socket: Socket | TLSSocket;
    private options: SessionOptions;
    private state: number = 0; // 0: init, 1: auth done, 2: transcoding, 3: closed

    private results: Results;
    private messageFunc: MessageCallback | null;
    private progressFunc: ProgressCallback | null = null;
    private resolverFunc: ResolverCallback | null = null;

    private parser: PacketParser;
    private _handshakeBuffer: Buffer | null = Buffer.alloc(0);
    private _handshakeDone: boolean = false;
    private _sendBuffer: Buffer[] | null = null;
    private _processingPromise: Promise<void> | null = null;

    private mainLength: number | null = null;
    private mainRead: number = 0;
    private builder: Builder | null = null;
    private completionPromise: Promise<void> | null = null;
    private _resolveCompletion: (() => void) | null = null;
    private _rejectCompletion: ((err: Error) => void) | null = null;
    private continuous: boolean = false;
    private _serverInfoCollect: Buffer[] | null = null;
    private _serverInfoResolve: ((info: string) => void) | null = null;

    /**
     * 新しいセッションを作成
     * @param socket - 接続されたソケット
     * @param options - セッションオプション
     */
    constructor(socket: Socket | TLSSocket, options: SessionOptions = {}) {
        this.socket = socket;
        this.options = options;

        this.results = new SingleResult(new StreamBuilder(process.stdout));
        this.messageFunc = (code, msg, args) => {
            console.error(`Message [${code}]: ${msg}`, args);
        };

        this.parser = new PacketParser();

        this._initConnection();

        this.socket.on('data', (data: Buffer) => this._onData(data));
        this.socket.on('error', (err: Error) => this._onError(err));
        this.socket.on('close', () => this._onClose());
    }

    private _initConnection(): void {
        const encoding = this.options.encoding || 'UTF-8';
        const user = this.options.user || '';
        const password = this.options.password || '';

        this.socket.write(`CTIP/2.0 ${encoding}\n`);
        const authLine = `PLAIN: ${user} ${password}\n`;
        this.socket.write(authLine);

        this._handshakeBuffer = Buffer.alloc(0);
        this._handshakeDone = false;
    }

    private _onData(data: Buffer): void {
        if (!this._handshakeDone) {
            this._handshakeBuffer = Buffer.concat([this._handshakeBuffer!, data]);

            if (this._handshakeBuffer.length < 3) return;

            const head = this._handshakeBuffer.subarray(0, 4).toString('utf8');
            if (head === 'OK \n') {
                this._handshakeDone = true;
                const rest = this._handshakeBuffer.subarray(4);
                this._handshakeBuffer = null;

                this._flushSendBuffer();

                if (rest.length > 0) {
                    this.parser.append(rest);
                    this._processPackets();
                }
            } else if (this._handshakeBuffer.toString('utf8').startsWith('NG ')) {
                const msg = this._handshakeBuffer.toString('utf8');
                this._onError(new Error('Authentication failure: ' + JSON.stringify(msg)));
                this.socket.end();
            } else {
                if (this._handshakeBuffer.length > 100) {
                    this._onError(new Error('Invalid handshake response'));
                    this.socket.end();
                }
            }
            return;
        }

        this.parser.append(data);
        this._enqueueProcessPackets();
    }

    private _enqueueProcessPackets(): void {
        if (!this._processingPromise) {
            this._processingPromise = Promise.resolve();
        }
        this._processingPromise = this._processingPromise.then(() => this._processPackets());
    }

    private async _processPackets(): Promise<void> {
        let pkt: Packet | null;
        while ((pkt = this.parser.next())) {
            await this._handlePacket(pkt);
        }
    }

    private async _handlePacket(res: Packet): Promise<void> {
        const type = res.type;

        switch (type) {
            case MSG.RES_START_DATA:
                if (this.builder) {
                    await this.builder.finish();
                    await this.builder.dispose();
                }
                this.builder = this.results.nextBuilder(res);
                break;

            case MSG.RES_BLOCK_DATA:
                if (this.builder && res.block_id !== undefined && res.bytes) {
                    await this.builder.write(res.block_id, res.bytes);
                }
                break;

            case MSG.RES_ADD_BLOCK:
                if (this.builder) this.builder.addBlock();
                break;

            case MSG.RES_INSERT_BLOCK:
                if (this.builder && res.block_id !== undefined) {
                    this.builder.insertBlockBefore(res.block_id);
                }
                break;

            case MSG.RES_CLOSE_BLOCK:
                if (this.builder && res.block_id !== undefined) {
                    this.builder.closeBlock(res.block_id);
                }
                break;

            case MSG.RES_DATA:
                if (this._serverInfoCollect !== null) {
                    if (res.bytes) this._serverInfoCollect.push(res.bytes);
                } else if (this.builder && res.bytes) {
                    await this.builder.serialWrite(res.bytes);
                }
                break;

            case MSG.RES_MESSAGE:
                if (this.messageFunc && res.code !== undefined && res.message && res.args) {
                    this.messageFunc(res.code, res.message, res.args);
                }
                break;

            case MSG.RES_MAIN_LENGTH:
                this.mainLength = res.length ?? null;
                if (this.progressFunc) this.progressFunc(this.mainLength, this.mainRead);
                break;

            case MSG.RES_MAIN_READ:
                this.mainRead = res.length ?? 0;
                if (this.progressFunc) this.progressFunc(this.mainLength, this.mainRead);
                break;

            case MSG.RES_RESOURCE_REQUEST: {
                const r = new Resource(this, res.uri!);
                if (this.resolverFunc) {
                    await Promise.resolve(this.resolverFunc(res.uri!, r));
                }
                r.finish();
                if (r.isMissing) {
                    this.send(req_missing_resource(res.uri!));
                }
                break;
            }

            case MSG.RES_ABORT:
                if (this.builder) {
                    if (res.mode === 0) await this.builder.finish();
                    await this.builder.dispose();
                    this.builder = null;
                }
                if (this._rejectCompletion) {
                    this._rejectCompletion(new Error(`Transcoding aborted: ${res.message}`));
                }
                this.mainLength = null;
                this.mainRead = 0;
                this.state = 1;
                break;

            case MSG.RES_EOF:
                if (this._serverInfoCollect !== null) {
                    const info = Buffer.concat(this._serverInfoCollect).toString('utf-8');
                    this._serverInfoCollect = null;
                    if (this._serverInfoResolve) {
                        this._serverInfoResolve(info);
                        this._serverInfoResolve = null;
                    }
                } else {
                    if (this.builder) {
                        await this.builder.finish();
                        await this.builder.dispose();
                        this.builder = null;
                    }
                    this._doResolveCompletion();
                    this.mainLength = null;
                    this.mainRead = 0;
                    this.state = 1;
                }
                break;

            case MSG.RES_NEXT:
                this.state = 1;
                this._doResolveCompletion();
                break;
        }
    }

    private _onError(err: Error): void {
        console.error('Session Error:', err);
        if (this._rejectCompletion) {
            this._rejectCompletion(err);
            this._rejectCompletion = null;
            this._resolveCompletion = null;
        }
    }

    private _onClose(): void {
        this.state = 3;
        if (this.builder) {
            this.builder.dispose();
        }
        if (this._rejectCompletion) {
            this._rejectCompletion(new Error('Connection closed unexpectedly during transcoding'));
            this._rejectCompletion = null;
            this._resolveCompletion = null;
        }
    }

    private _doResolveCompletion(): void {
        if (this._resolveCompletion) {
            this._resolveCompletion();
            this._resolveCompletion = null;
            this._rejectCompletion = null;
        }
    }

    /** サーバーにデータを送信 */
    send(data: Buffer): boolean {
        if (this.state >= 3) {
            throw new IllegalStateError("Session is closed");
        }
        if (!this._handshakeDone) {
            if (!this._sendBuffer) this._sendBuffer = [];
            this._sendBuffer.push(data);
            return true;
        }
        return this.socket.write(data);
    }

    private _flushSendBuffer(): void {
        if (this._sendBuffer && this._sendBuffer.length > 0) {
            for (const chunk of this._sendBuffer) {
                this.socket.write(chunk);
            }
            this._sendBuffer = null;
        }
    }

    // --- Public API ---

    /** 結果ハンドラを設定 */
    setResults(results: Results): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.results = results;
    }

    /** 出力をファイルに設定 */
    setOutputAsFile(file: string): void {
        this.setResults(new SingleResult(new FileBuilder(file)));
    }

    /** 出力を番号付きファイルのディレクトリに設定 */
    setOutputAsDirectory(dir: string, prefix: string = '', suffix: string = ''): void {
        this.setResults(new DirectoryResults(dir, prefix, suffix));
    }

    /** 出力をストリームに設定 */
    setOutputAsStream(stream: Writable): void {
        this.setResults(new SingleResult(new StreamBuilder(stream)));
    }

    /** メッセージコールバックを設定 */
    setMessageFunc(func: MessageCallback | null): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.messageFunc = func;
    }

    /** 進捗コールバックを設定 */
    setProgressFunc(func: ProgressCallback | null): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.progressFunc = func;
    }

    /** リソースリゾルバコールバックを設定 */
    setResolverFunc(func: ResolverCallback | null): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.resolverFunc = func;
        this.send(req_client_resource(!!func));
    }

    /** 連続モードを設定 */
    setContinuous(continuous: boolean): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.send(req_continuous(continuous));
    }

    /** プロパティを設定 */
    setProperty(name: string, value: string): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.send(req_property(name, value));
    }

    /** サーバー情報を取得 */
    async getServerInfo(uri: string): Promise<string> {
        return new Promise<string>((resolve) => {
            this._serverInfoCollect = [];
            this._serverInfoResolve = resolve;
            this.send(req_server_info(uri));
        });
    }

    /** リソースを送信 */
    resource(uri: string, opts: ResourceOptions = {}): Writable {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        const mimeType = opts.mime_type || 'text/css';
        const encoding = opts.encoding || '';
        const length = (opts.length !== undefined) ? opts.length : -1;

        this.send(req_start_resource(uri, mimeType, encoding, length));
        return new ResourceOut(this);
    }

    /**
     * トランスコードを開始
     * @param uri - ドキュメントURI
     * @param opts - トランスコードオプション
     * @returns ドキュメントコンテンツ用の書き込み可能ストリーム
     */
    transcode(uri: string = '.', opts: TranscodeOptions = {}): Writable {
        if (this.state >= 3) throw new IllegalStateError("Session is closed");
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        const mimeType = opts.mimeType || 'text/html';
        const encoding = opts.encoding || 'UTF-8';
        const length = (opts.length === undefined) ? -1 : opts.length;

        this.mainLength = null;
        this.mainRead = 0;

        this.completionPromise = new Promise<void>((resolve, reject) => {
            this._resolveCompletion = resolve;
            this._rejectCompletion = reject;
        });

        this.send(req_start_main(uri, mimeType, encoding, length));
        this.state = 2;

        return new MainOut(this);
    }

    /** サーバーURLからコンテンツをトランスコードする */
    transcodeServer(uri: string): void {
        if (this.state >= 3) throw new IllegalStateError("Session is closed");
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.send(req_server_main(uri));
        this.state = 2;
        this.completionPromise = new Promise<void>((resolve, reject) => {
            this._resolveCompletion = resolve;
            this._rejectCompletion = reject;
        });
    }

    /** トランスコードの完了を待機 */
    async waitForCompletion(): Promise<void> {
        if (this.completionPromise) {
            await this.completionPromise;
        }
    }

    /** 現在のトランスコードを中断 */
    abort(mode: number): void {
        if (this.state >= 2) {
            this.send(req_abort(mode));
        }
    }

    /** セッション状態をリセット */
    reset(): void {
        if (this.state >= 3) throw new IllegalStateError("Session is closed");
        if (this.socket) this.send(req_reset());
        this.progressFunc = null;
        this.messageFunc = null;
        this.resolverFunc = null;
        this.builder = null;
        this.mainLength = null;
        this.mainRead = 0;
        this.results = new SingleResult(new StreamBuilder(process.stdout));
        this.state = 1;
        this.completionPromise = null;
    }

    /** 複数のドキュメントを結合 */
    join(): void {
        if (this.state >= 3) throw new IllegalStateError("Session is closed");
        this.send(req_join());
        this.state = 2;
        this.completionPromise = new Promise<void>((resolve, reject) => {
            this._resolveCompletion = resolve;
            this._rejectCompletion = reject;
        });
    }

    /** セッションを閉じる */
    close(): void {
        if (this.state >= 3) return;
        try {
            this.send(req_close());
        } catch (e) {
            // ignore
        }
        this.state = 3;
        this.socket.end();
    }
}
