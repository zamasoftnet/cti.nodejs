/**
 * Builder モジュール
 * 
 * このモジュールは、フラグメントからPDF出力を構築するためのビルダークラスを提供します。
 * メモリ使用効率を高めるために、メモリとディスクベースの両方のフラグメントストレージを処理します。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Writable } from 'stream';

/** ディスクに書き出す前のフラグメントの最大メモリサイズ */
const FRG_MEM_SIZE = 256;

/** ディスク書き込みを強制する前の最大合計メモリ使用量 */
const ON_MEMORY = 1024 * 1024;

/** 一時ファイルストレージのセグメントサイズ */
const SEGMENT_SIZE = 8192;

/** 出力チャンクを管理するためのフラグメントデータ構造 */
class Fragment {
    id: number;
    prev: Fragment | null = null;
    next: Fragment | null = null;
    length: number = 0;
    buffer: Buffer = Buffer.alloc(0);
    segments: number[] | null = null;
    segLen: number = 0;

    constructor(id: number) {
        this.id = id;
    }

    /**
     * このフラグメントにデータを書き込む
     * @param builder - 親ビルダー (一時ファイルを管理)
     * @param data - 書き込むデータ
     * @param currentTotalOnMemory - 現在の合計メモリ使用量
     * @returns メモリ差分 (正数 = 増加, 負数 = 減少)
     */
    async write(builder: StreamBuilder, data: Buffer, currentTotalOnMemory: number): Promise<number> {
        const len = data.length;
        let memoryDelta = 0;

        // メモリに保存可能かチェック
        if (this.segments === null &&
            this.length + len <= FRG_MEM_SIZE &&
            currentTotalOnMemory + len <= ON_MEMORY) {

            this.buffer = Buffer.concat([this.buffer, data]);
            memoryDelta = len;
            this.length += len;
            return memoryDelta;
        }

        // ディスクに書き込む必要がある
        // 既存のバッファがあれば先にフラッシュする
        if (this.buffer.length > 0) {
            const flushedLen = this.buffer.length;
            await this._flushBufferToDisk(builder);
            memoryDelta -= flushedLen;
        }

        // 新しいデータをディスクに書き込む
        await this._writeToDisk(builder, data);
        this.length += len;

        return memoryDelta;
    }

    private async _flushBufferToDisk(builder: StreamBuilder): Promise<void> {
        if (this.buffer.length === 0) return;
        await this._writeToDisk(builder, this.buffer);
        this.buffer = Buffer.alloc(0);
    }

    private async _writeToDisk(builder: StreamBuilder, data: Buffer): Promise<void> {
        if (this.segments === null) {
            this.segments = [];
            const initialSeg = builder.nextSegmentIndex++;
            this.segments.push(initialSeg);
            this.segLen = 0;
        }

        let offset = 0;
        while (offset < data.length) {
            if (this.segLen === SEGMENT_SIZE) {
                const nextSeg = builder.nextSegmentIndex++;
                this.segments.push(nextSeg);
                this.segLen = 0;
            }

            const currentSegIndex = this.segments[this.segments.length - 1];
            const remainingInSeg = SEGMENT_SIZE - this.segLen;
            const writeSize = Math.min(data.length - offset, remainingInSeg);

            const chunk = data.subarray(offset, offset + writeSize);
            const filePos = (currentSegIndex * SEGMENT_SIZE) + this.segLen;

            await builder.writeToTempFile(chunk, filePos);

            this.segLen += writeSize;
            offset += writeSize;
        }
    }

    /** フラグメントの内容を出力ストリームにフラッシュする */
    async flushToStream(builder: StreamBuilder, outStream: Writable): Promise<void> {
        // メモリベースのフラグメント
        if (this.segments === null) {
            if (this.buffer.length > 0) {
                if (!outStream.write(this.buffer)) {
                    await new Promise<void>(resolve => outStream.once('drain', resolve));
                }
            }
            return;
        }

        // ディスクベースのフラグメント
        for (let i = 0; i < this.segments.length; i++) {
            const segIndex = this.segments[i];
            const readSize = (i === this.segments.length - 1) ? this.segLen : SEGMENT_SIZE;

            if (readSize > 0) {
                const filePos = segIndex * SEGMENT_SIZE;
                const buf = Buffer.alloc(readSize);
                const bytesRead = await builder.readFromTempFile(buf, filePos);

                const dataToWrite = (bytesRead === readSize) ? buf : buf.subarray(0, bytesRead);

                if (dataToWrite.length > 0) {
                    if (!outStream.write(dataToWrite)) {
                        await new Promise<void>(resolve => outStream.once('drain', resolve));
                    }
                }
            }
        }
    }

    dispose(): void {
        this.buffer = Buffer.alloc(0);
        this.segments = null;
    }
}

/** 出力構築用のビルダーインターフェース */
export interface Builder {
    addBlock(): void;
    insertBlockBefore(anchorId: number): void;
    write(id: number, data: Buffer): Promise<void>;
    closeBlock(id: number): void;
    serialWrite(data: Buffer): Promise<void>;
    finish(): Promise<void>;
    dispose(): Promise<void>;
}

/** 完了コールバック関数の型 */
export type FinishCallback = (totalLength: number) => Promise<void> | void;

/** ストリームに出力を書き込むビルダー */
export class StreamBuilder implements Builder {
    protected out: Writable;
    protected finishFunc: FinishCallback | null;
    protected frgs: Fragment[] = [];
    protected first: Fragment | null = null;
    protected last: Fragment | null = null;
    protected onMemory: number = 0;
    protected totalLength: number = 0;

    // 一時ファイル管理
    protected tempPath: string | null = null;
    protected fd: fs.promises.FileHandle | null = null;
    public nextSegmentIndex: number = 0;

    constructor(outStream: Writable, finishFunc: FinishCallback | null = null) {
        this.out = outStream;
        this.finishFunc = finishFunc;
    }

    private async _ensureTempFile(): Promise<void> {
        if (!this.fd) {
            this.tempPath = path.join(os.tmpdir(), `cti-node-${Date.now()}-${Math.random()}.tmp`);
            this.fd = await fs.promises.open(this.tempPath, 'w+');
        }
    }

    async writeToTempFile(buffer: Buffer, position: number): Promise<void> {
        await this._ensureTempFile();
        await this.fd!.write(buffer, 0, buffer.length, position);
    }

    async readFromTempFile(buffer: Buffer, position: number): Promise<number> {
        if (!this.fd) return 0;
        const { bytesRead } = await this.fd.read(buffer, 0, buffer.length, position);
        return bytesRead;
    }

    addBlock(): void {
        const id = this.frgs.length;
        const frg = new Fragment(id);
        this.frgs.push(frg);

        if (this.first === null) {
            this.first = frg;
        } else {
            this.last!.next = frg;
            frg.prev = this.last;
        }
        this.last = frg;
    }

  insertBlockBefore(anchorId: number): void {
    const id = this.frgs.length;
    const frg = new Fragment(id);
    this.frgs.push(frg);

    const anchor = this.frgs[anchorId];

    frg.prev = anchor.prev;
    frg.next = anchor;
    anchor.prev!.next = frg;
    anchor.prev = frg;

    if (this.first === anchor) {
      this.first = frg;
    }
  }

    async write(id: number, data: Buffer): Promise<void> {
        const frg = this.frgs[id];
        const delta = await frg.write(this, data, this.onMemory);
        this.onMemory += delta;
        this.totalLength += data.length;
    }

    async serialWrite(data: Buffer): Promise<void> {
        if (!this.out.write(data)) {
            await new Promise<void>(resolve => this.out.once('drain', resolve));
        }
    }

    closeBlock(_id: number): void {
        // 何もしない
    }

    async finish(): Promise<void> {
        try {
            if (this.finishFunc) {
                await this.finishFunc(this.totalLength);
            }

            let frg = this.first;
            while (frg) {
                await frg.flushToStream(this, this.out);
                frg = frg.next;
            }
        } finally {
            await this.disposeTemp();
        }
    }

    async dispose(): Promise<void> {
        await this.disposeTemp();
        this.frgs = [];
    }

    protected async disposeTemp(): Promise<void> {
        if (this.fd) {
            await this.fd.close().catch(() => { });
            this.fd = null;
        }
        if (this.tempPath) {
            await fs.promises.unlink(this.tempPath).catch(() => { });
            this.tempPath = null;
        }
    }
}

/** ファイルに出力を書き込むビルダー */
export class FileBuilder extends StreamBuilder {
    constructor(filePath: string) {
        const stream = fs.createWriteStream(filePath);
        super(stream, null);
    }

    async finish(): Promise<void> {
        await super.finish();
        this.out.end();
        await new Promise<void>(resolve => this.out.once('finish', resolve));
    }
}

/** すべての出力を破棄するビルダー (テストまたはドライラン用) */
export class NullBuilder implements Builder {
    addBlock(): void { }
    insertBlockBefore(_id: number): void { }
    async write(_id: number, _data: Buffer): Promise<void> { }
    closeBlock(_id: number): void { }
    async serialWrite(_data: Buffer): Promise<void> { }
    async finish(): Promise<void> { }
    async dispose(): Promise<void> { }
}
