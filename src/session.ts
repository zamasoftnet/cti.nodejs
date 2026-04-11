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

/**
 * セッションが想定外の状態にあるときに操作を試みた場合にスローされるエラー。
 *
 * 例:
 * - トランスコード送信済みのセッションに対して `transcode()` を再度呼ぶ
 * - クローズ済みセッションに `send()` を呼ぶ
 */
export class IllegalStateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'IllegalStateError';
    }
}

/**
 * サーバーから送信されたメッセージを受け取るコールバック関数の型。
 * トランスコード中の警告や情報メッセージが通知される。
 * @param code - メッセージコード (サーバー定義の整数)
 * @param message - メッセージ本文
 * @param args - メッセージに付随する追加引数の配列
 */
export type MessageCallback = (code: number, message: string, args: string[]) => void;

/**
 * トランスコード対象コンテンツの読み込み進捗を受け取るコールバック関数の型。
 * @param total - コンテンツの全バイト数。まだ不明の場合は `null`
 * @param read - これまでに読み込んだバイト数
 */
export type ProgressCallback = (total: number | null, read: number) => void;

/**
 * サーバーからのリソース取得要求を処理するコールバック関数の型。
 * HTML 内の CSS や画像などの外部リソースが必要になるたびに呼ばれる。
 * `resource.found()` でストリームを取得してデータを書き込むか、
 * 何もしないことで `isMissing = true` のままリソースなしを通知する。
 * @param uri - サーバーが要求しているリソースの URI
 * @param resource - リソース応答を行うための `Resource` オブジェクト
 */
export type ResolverCallback = (uri: string, resource: Resource) => void | Promise<void>;

/** セッション接続時の認証・文字エンコーディング設定 */
export interface SessionOptions {
    /** PLAIN 認証のユーザー名 (省略時は空文字) */
    user?: string;
    /** PLAIN 認証のパスワード (省略時は空文字) */
    password?: string;
    /** プロトコルのテキストエンコーディング (デフォルト: `UTF-8`) */
    encoding?: string;
}

/** `resource()` / `Resource.found()` にリソースのメタ情報を渡すためのオプション */
export interface ResourceOptions {
    /** リソースの MIME タイプ (デフォルト: `text/css`) */
    mime_type?: string;
    /** リソースのエンコーディング (デフォルト: 空文字) */
    encoding?: string;
    /** リソースの全バイト長。不明の場合は省略 (省略時は `-1` として送信) */
    length?: number;
}

/** `transcode()` でメインドキュメントのメタ情報を指定するためのオプション */
export interface TranscodeOptions {
    /** ドキュメントの MIME タイプ (デフォルト: `text/html`) */
    mimeType?: string;
    /** ドキュメントのエンコーディング (デフォルト: `UTF-8`) */
    encoding?: string;
    /** ドキュメントの全バイト長。不明の場合は省略 (省略時は `-1` として送信) */
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

/**
 * サーバーからのリソース取得要求を表すクラス。
 *
 * `ResolverCallback` の引数として渡される。
 * コールバック内で `found()` を呼び出してリソースデータを送信するか、
 * 何もしないことでリソースが存在しない (`isMissing = true`) ことをサーバーに通知する。
 */
export class Resource {
    private session: Session;
    public uri: string;
    public isMissing: boolean = true;
    private out: ResourceOut | null = null;

    constructor(session: Session, uri: string) {
        this.session = session;
        this.uri = uri;
    }

    /**
     * リソースが見つかったことをマークし、コンテンツを書き込むための書き込み可能ストリームを返す。
     * 返されたストリームへリソースデータをパイプすることで、コンテンツがサーバーに送信される。
     * このメソッドを呼び出さなかった場合、`isMissing` を `true` のままにしておくことでリソースなしを再現できる。
     * @param opts - MIMEタイプ、エンコーディング、コンテンツ長さなどを指定するオプション
     * @returns リソースデータを書き込むための書き込み可能ストリーム
     */
    found(opts: ResourceOptions = {}): Writable {
        const mimeType = opts.mime_type || 'text/css';
        const encoding = opts.encoding || '';
        const length = (opts.length !== undefined) ? opts.length : -1;

        this.session.send(req_start_resource(this.uri, mimeType, encoding, length));
        this.isMissing = false;
        this.out = new ResourceOut(this.session);
        return this.out;
    }

    /**
     * リソースデータの送信を完了する。
     * `found()` で取得したストリームへの書き込み完了後に必ず呼び出すこと。
     */
    finish(): void {
        if (this.out) {
            this.out.end();
        }
    }
}

/**
 * Copper PDF サーバーとの 1 対 1 通信セッションを管理するクラス。
 *
 * CTIP/2.0 プロトコルを介してドキュメントを PDF にトランスコードし、
 * 結果をストリーム・ファイル・ディレクトリのいずれかに出力する。
 *
 * 基本的な使い方:
 * 1. `setOutput*()` で出力先を設定する
 * 2. 必要に応じて `resource()` でリソースを事前送信する
 * 3. `transcode()` で返ったストリームにドキュメントを書き込み、`end()` する
 * 4. `waitForCompletion()` でトランスコード完了を待機する
 * 5. 連続モードの場合は `reset()` してステップ 1 から繰り返す
 * 6. 最後に `close()` で接続を切断する
 */
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

    /**
     * サーバーにバイナリデータを送信する。
     * ハンドシェイク完了前の場合はバッファに迏えて後送信する。
     * @param data - 送信するバイナリフレーム
     * @returns ソケットの内部バッファがフラッシュされたかどうか (`socket.write` の戻り値と同じ)
     * @throws {IllegalStateError} セッションが閉じている場合
     */
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

    /**
     * 出力先の結果ハンドラを設定する。
     * `transcode()` 呼び出し前に設定する必要がある。
     * @param results - 使用する `Results` 実装
     * @throws {IllegalStateError} トランスコード済みの場合
     */
    setResults(results: Results): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.results = results;
    }

    /**
     * PDF出力先ファイルパスを指定するショートカットメソッド。
     * 内部で `FileBuilder` を使用する。
     * @param file - 出力先ファイルのパス
     * @throws {IllegalStateError} トランスコード済みの場合
     */
    setOutputAsFile(file: string): void {
        this.setResults(new SingleResult(new FileBuilder(file)));
    }

    /**
     * PDF出力先ディレクトリを指定するショートカットメソッド。
     * トランスコードごとに `{prefix}{n}{suffix}` 形式のファイルが生成される。
     * @param dir - 出力先ディレクトリのパス
     * @param prefix - ファイル名のプレフィックス (デフォルト: 空文字列)
     * @param suffix - ファイル名のサフィックス (デフォルト: 空文字列)
     * @throws {IllegalStateError} トランスコード済みの場合
     */
    setOutputAsDirectory(dir: string, prefix: string = '', suffix: string = ''): void {
        this.setResults(new DirectoryResults(dir, prefix, suffix));
    }

    /**
     * PDF出力先ストリームを指定するショートカットメソッド。
     * HTTPレスポンスのストリームなど任意の `Writable` を指定できる。
     * @param stream - 出力先の書き込み可能ストリーム
     * @throws {IllegalStateError} トランスコード済みの場合
     */
    setOutputAsStream(stream: Writable): void {
        this.setResults(new SingleResult(new StreamBuilder(stream)));
    }

    /**
     * サーバーからのメッセージを受け取るコールバックを設定する。
     * `null` を渡すことでメッセージ機能を無効化できる。
     * @param func - メッセージコード、メッセージ、引数配列を受け取るコールバック、または `null`
     * @throws {IllegalStateError} トランスコード済みの場合
     */
    setMessageFunc(func: MessageCallback | null): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.messageFunc = func;
    }

    /**
     * トランスコードの進捗を受け取るコールバックを設定する。
     * 法剆コンテンツの全体バイト数 (`total`) と読み込み完了バイト数 (`read`) が渡される。
     * `total` が `null` の場合はまだ全体さが不明。
     * @param func - 進捗情報を受け取るコールバック、または `null`
     * @throws {IllegalStateError} トランスコード済みの場合
     */
    setProgressFunc(func: ProgressCallback | null): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.progressFunc = func;
    }

    /**
     * リソースリゾルバコールバックを設定する。
     * コールバックが設定されている場合、CSS画像などの外部リソースの取得要求時に呼び出される。
     * `null` を渡すとクライアントリソース機能が無効化される。
     * @param func - URI と `Resource` オブジェクトを受け取るコールバック、または `null`
     * @throws {IllegalStateError} トランスコード済みの場合
     */
    setResolverFunc(func: ResolverCallback | null): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.resolverFunc = func;
        this.send(req_client_resource(!!func));
    }

    /**
     * 連続トランスコードモードを有効/無効に設定する。
     * 連続モードを有効にすると、複数のトランスコードを同一セッションで実行できる。
     * @param continuous - `true` の場合は連続モードを有効にする
     * @throws {IllegalStateError} トランスコード済みの場合
     */
    setContinuous(continuous: boolean): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.send(req_continuous(continuous));
    }

    /**
     * トランスコードプロパティを設定する。
     * サーバー側で認識される各種制御パラメータを指定するために使用する。
     * @param name - プロパティ名
     * @param value - プロパティ値
     * @throws {IllegalStateError} トランスコード済みの場合
     */
    setProperty(name: string, value: string): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.send(req_property(name, value));
    }

    /**
     * 指定した URI に対するサーバー情報を取得する。
     * サーバーのバージョン情報や属性などを確認する際に利用する。
     * @param uri - 情報取得対象の URI。空文字列の場合はサーバー機能一覧を返すことが多い
     * @returns サーバーから返された UTF-8 文字列の情報
     */
    async getServerInfo(uri: string): Promise<string> {
        return new Promise<string>((resolve) => {
            this._serverInfoCollect = [];
            this._serverInfoResolve = resolve;
            this.send(req_server_info(uri));
        });
    }

    /**
     * リソースデータをサーバーに送信するための書き込み先ストリームを返す。
     * `transcode()` 呼び出し前に使用する。返されたストリームへデータをパイプすることでリソースが送信される。
     * @param uri - リソースの URI
     * @param opts - MIMEタイプ、エンコーディング、コンテンツ長さなどを指定するオプション
     * @returns リソースデータを書き込むための書き込み可能ストリーム
     * @throws {IllegalStateError} トランスコード済みの場合
     */
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

    /** 
     * サーバー内URLのドキュメントをトランスコードする。
     * コンテンツはサーバー側から直接取得されるため、クライアントからデータを送信する必要はない。
     * 完了を待機するには `waitForCompletion()` を呼び出すこと。
     * @param uri - サーバー内ドキュメントの URI
     * @throws {IllegalStateError} セッションが閉じているか、トランスコード済みの場合
     */
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

    /**
     * 現在進行中のトランスコードまたは結合処理の完了を待機する。
     * `transcode()`、`transcodeServer()`、`join()` の後に呼び出すこと。
     * トランスコードが失敗した場合はエラーで reject される。
     */
    async waitForCompletion(): Promise<void> {
        if (this.completionPromise) {
            await this.completionPromise;
        }
    }

    /**
     * 現在進行中のトランスコードを中断する。
     * @param mode - 中断モード。`0` の場合は現在の出力をフラッシュして中断。それ以外は即座中断
     */
    abort(mode: number): void {
        if (this.state >= 2) {
            this.send(req_abort(mode));
        }
    }

    /**
     * セッションの各種設定を初期化して再利用可能な状態に戻す。
     * 連続モードで複数ドキュメントを変換する際、各巣終処理と次回引数のリセットに使用する。
     * コールバックやビルダーはクリアされるため、次回の `transcode()` 前に再設定する必要がある。
     * @throws {IllegalStateError} セッションが閉じている場合
     */
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

    /**
     * `join` トランスコードを開始する。
     * 連続モードで送信済みの複数ドキュメントをサーバー側で結合する。
     * 完了を待機するには `waitForCompletion()` を呼び出すこと。
     * @throws {IllegalStateError} セッションが閉じている場合
     */
    join(): void {
        if (this.state >= 3) throw new IllegalStateError("Session is closed");
        this.send(req_join());
        this.state = 2;
        this.completionPromise = new Promise<void>((resolve, reject) => {
            this._resolveCompletion = resolve;
            this._rejectCompletion = reject;
        });
    }

    /**
     * セッションを閉じてサーバーとの接続を切断する。
     * 既に閃じている場合は何も行わない。
     * このメソッドを呼び出した後はセッションの回復不可。次回は新しいセッションを作成すること。
     */
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
