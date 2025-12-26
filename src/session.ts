/**
 * Session Module
 * 
 * This module provides the Session class for communicating with Copper PDF servers.
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

/** Error thrown when an operation is attempted in an invalid session state */
export class IllegalStateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'IllegalStateError';
    }
}

/** Message callback function type */
export type MessageCallback = (code: number, message: string, args: string[]) => void;

/** Progress callback function type */
export type ProgressCallback = (total: number | null, read: number) => void;

/** Resolver callback function type */
export type ResolverCallback = (uri: string, resource: Resource) => void | Promise<void>;

/** Session options interface */
export interface SessionOptions {
    user?: string;
    password?: string;
    encoding?: string;
}

/** Resource options interface */
export interface ResourceOptions {
    mime_type?: string;
    encoding?: string;
    length?: number;
}

/** Transcode options interface */
export interface TranscodeOptions {
    mimeType?: string;
    encoding?: string;
    length?: number;
}

/** Writable stream for main document content */
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

/** Writable stream for resource content */
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

/** Resource request handler */
export class Resource {
    private session: Session;
    public uri: string;
    public isMissing: boolean = true;
    private out: ResourceOut | null = null;

    constructor(session: Session, uri: string) {
        this.session = session;
        this.uri = uri;
    }

    /** Mark resource as found and get output stream */
    found(opts: ResourceOptions = {}): Writable {
        const mimeType = opts.mime_type || 'text/css';
        const encoding = opts.encoding || '';
        const length = (opts.length !== undefined) ? opts.length : -1;

        this.session.send(req_start_resource(this.uri, mimeType, encoding, length));
        this.isMissing = false;
        this.out = new ResourceOut(this.session);
        return this.out;
    }

    /** Finish resource transmission */
    finish(): void {
        if (this.out) {
            this.out.end();
        }
    }
}

/** Session for communicating with Copper PDF server */
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

    /**
     * Creates a new Session
     * @param socket - Connected socket
     * @param options - Session options
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
                if (this.builder && res.bytes) {
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
                if (this.builder) {
                    await this.builder.finish();
                    await this.builder.dispose();
                    this.builder = null;
                }
                this._doResolveCompletion();
                this.mainLength = null;
                this.mainRead = 0;
                this.state = 1;
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

    /** Send data to the server */
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

    /** Set result handler */
    setResults(results: Results): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.results = results;
    }

    /** Set output to a file */
    setOutputAsFile(file: string): void {
        this.setResults(new SingleResult(new FileBuilder(file)));
    }

    /** Set output to a directory with numbered files */
    setOutputAsDirectory(dir: string, prefix: string = '', suffix: string = ''): void {
        this.setResults(new DirectoryResults(dir, prefix, suffix));
    }

    /** Set output to a stream */
    setOutputAsStream(stream: Writable): void {
        this.setResults(new SingleResult(new StreamBuilder(stream)));
    }

    /** Set message callback */
    setMessageFunc(func: MessageCallback | null): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.messageFunc = func;
    }

    /** Set progress callback */
    setProgressFunc(func: ProgressCallback | null): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.progressFunc = func;
    }

    /** Set resource resolver callback */
    setResolverFunc(func: ResolverCallback | null): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.resolverFunc = func;
        this.send(req_client_resource(!!func));
    }

    /** Set continuous mode */
    setContinuous(continuous: boolean): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.send(req_continuous(continuous));
    }

    /** Set a property */
    setProperty(name: string, value: string): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.send(req_property(name, value));
    }

    /** Send a resource */
    resource(uri: string, opts: ResourceOptions = {}): Writable {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        const mimeType = opts.mime_type || 'text/css';
        const encoding = opts.encoding || '';
        const length = (opts.length !== undefined) ? opts.length : -1;

        this.send(req_start_resource(uri, mimeType, encoding, length));
        return new ResourceOut(this);
    }

    /**
     * Start transcoding
     * @param uri - Document URI
     * @param opts - Transcode options
     * @returns Writable stream for document content
     */
    transcode(uri: string = '.', opts: TranscodeOptions = {}): Writable {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        const mimeType = opts.mimeType || 'text/html';
        const encoding = opts.encoding || 'UTF-8';
        const length = (opts.length === undefined) ? -1 : opts.length;

        this.mainLength = null;
        this.mainRead = 0;
        this.builder = null;

        this.completionPromise = new Promise<void>((resolve, reject) => {
            this._resolveCompletion = resolve;
            this._rejectCompletion = reject;
        });

        this.send(req_start_main(uri, mimeType, encoding, length));

        return new MainOut(this);
    }

    /** Transcode content from a server URL */
    transcodeServer(uri: string): void {
        if (this.state >= 2) throw new IllegalStateError("Main content already sent");
        this.send(req_server_main(uri));
        this.state = 2;
        this.completionPromise = new Promise<void>((resolve, reject) => {
            this._resolveCompletion = resolve;
            this._rejectCompletion = reject;
        });
    }

    /** Wait for transcoding to complete */
    async waitForCompletion(): Promise<void> {
        if (this.completionPromise) {
            await this.completionPromise;
        }
    }

    /** Abort current transcoding */
    abort(mode: number): void {
        if (this.state >= 2) {
            this.send(req_abort(mode));
        }
    }

    /** Reset session state */
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

    /** Join multiple documents */
    join(): void {
        if (this.state >= 3) throw new IllegalStateError("Session is closed");
        this.send(req_join());
        this.state = 2;
        this.completionPromise = new Promise<void>((resolve, reject) => {
            this._resolveCompletion = resolve;
            this._rejectCompletion = reject;
        });
    }

    /** Close the session */
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
