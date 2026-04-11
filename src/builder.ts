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

/**
 * PDF 出力チャンクを保持する内部データ構造。
 *
 * 小さなチャンクはメモリ上の `buffer` に保持し、
 * `FRG_MEM_SIZE` 超過または全体のメモリ使用量が `ON_MEMORY` を超えた場合は
 * `StreamBuilder` の一時ファイルにセグメント単位で書き出す。
 * 双方向リンクリストでフラグメント同士を連結する。
 */
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
    /**
     * 出力チェーンの末尾に新しいブロックを追加する。
     * ブロックはサーバーから受信したチャンクデータを保持するコンテナであり、
     * `write()` で書き込み、`finish()` 時にストリームへ順番に出力される。
     */
    addBlock(): void;

    /**
     * 指定したブロックの直前に新しいブロックを挿入する。
     * サーバーが RES_INSERT_BLOCK を送信した場合に呼び出される。
     * @param anchorId - 挿入基準となる既存ブロックの ID
     */
    insertBlockBefore(anchorId: number): void;

    /**
     * 指定ブロックにデータを書き込む。
     * メモリもしくは一時ファイルへの書き込みを透過的に処理する。
     * @param id - 書き込み先ブロックの ID
     * @param data - 書き込むバイナリデータ
     */
    write(id: number, data: Buffer): Promise<void>;

    /**
     * 指定ブロックを閉じる。
     * 実装によっては何も行わない場合がある。
     * @param id - 閉じるブロックの ID
     */
    closeBlock(id: number): void;

    /**
     * データをフラグメント管理を介さず出力ストリームに直接シリアルに書き込む。
     * RES_DATA パケット (フラグメント外データ) の処理に使用される。
     * @param data - 書き込むバイナリデータ
     */
    serialWrite(data: Buffer): Promise<void>;

    /**
     * すべてのフラグメントを出力ストリームへ順番にフラッシュし、
     * トランスコードの完了を確定させる。
     * 呼び出し後はリソースを解放するため `dispose()` も呼ぶこと。
     */
    finish(): Promise<void>;

    /**
     * バッファや一時ファイルを含む全リソースを解放する。
     * `finish()` 後、またはエラー発生時に必ず呼び出すこと。
     */
    dispose(): Promise<void>;
}

/**
 * トランスコード完了時に PDF 全体長を受け取るコールバック関数の型。
 * `StreamBuilder` のコンストラクタで渡すことができ、
 * `finish()` 実行前に結果のバイト長を参照するような用途 (例: HTTP `Content-Length` ヘッダの設定) に使用する。
 * @param totalLength - フラッシュ完了時の結果全体バイト長
 */
export type FinishCallback = (totalLength: number) => Promise<void> | void;

/**
 * フラグメントベースのストリーム書き込みビルダー。
 *
 * サーバーからの `RES_ADD_BLOCK` / `RES_INSERT_BLOCK` / `RES_BLOCK_DATA` に応じて
 * `Fragment` リストを構築し、`finish()` 時に順序どおりに出力ストリームへフラッシュする。
 *
 * 小さなデータはメモリ上で保持し、閉じきい場合は OS の一時ファイルへスピルアウトする。
 * HTTP レスポンスストリームなどが完了前に `Content-Length` を記載したい場合は
 * `FinishCallback` を渡してそのタイミングでヘッダ添付できる。
 */
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

    /**
     * 一時ファイルの指定位置にバッファを書き込む。
     * ファイルが存在しない場合は自動的に作成される。
     * Fragment クラスがディスクへのスピルアウト時に内部から呼び出す。
     * @param buffer - 書き込むデータ
     * @param position - ファイル内の書き込み開始バイト位置
     */
    async writeToTempFile(buffer: Buffer, position: number): Promise<void> {
        await this._ensureTempFile();
        await this.fd!.write(buffer, 0, buffer.length, position);
    }

    /**
     * 一時ファイルの指定位置からデータを読み込む。
     * 一時ファイルが未作成の場合は 0 を返す。
     * @param buffer - 読み込んだデータを格納するバッファ
     * @param position - ファイル内の読み込み開始バイト位置
     * @returns 実際に読み込んだバイト数
     */
    async readFromTempFile(buffer: Buffer, position: number): Promise<number> {
        if (!this.fd) return 0;
        const { bytesRead } = await this.fd.read(buffer, 0, buffer.length, position);
        return bytesRead;
    }

    /**
     * 出力チェーンの末尾に新しいフラグメント (ブロック) を追加する。
     * 追加されたブロックの ID は `frgs` 配列のインデックスで管理される。
     */
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

  /**
   * 指定した既存ブロックの直前に新しいフラグメントを挿入する。
   * 双方向リンクリストのポインタを更新してフラグメント順序を調整する。
   * @param anchorId - 挿入基準となる既存ブロックの ID
   */
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

    /**
     * 指定 ID のフラグメントにデータを書き込む。
     * フラグメントのメモリ使用量に応じて、自動的にディスクへスピルアウトする。
     * @param id - 書き込み先フラグメントの ID
     * @param data - 書き込むバイナリデータ
     */
    async write(id: number, data: Buffer): Promise<void> {
        const frg = this.frgs[id];
        const delta = await frg.write(this, data, this.onMemory);
        this.onMemory += delta;
        this.totalLength += data.length;
    }

    /**
     * データをフラグメント管理を介さず出力ストリームへ直接書き込む。
     * ストリームのバックプレッシャーを考慮して `drain` イベントを待機する。
     * @param data - 書き込むバイナリデータ
     */
    async serialWrite(data: Buffer): Promise<void> {
        if (!this.out.write(data)) {
            await new Promise<void>(resolve => this.out.once('drain', resolve));
        }
    }

    /**
     * 指定ブロックを閉じる。
     * `StreamBuilder` では使用しないため何も行わない。
     * @param _id - 閉じるブロックの ID (未使用)
     */
    closeBlock(_id: number): void {
        // 何もしない
    }

    /**
     * すべてのフラグメントを順番に出力ストリームへフラッシュする。
     * `finishFunc` が設定されている場合は先に呼び出す。
     * 処理後は一時ファイルを削除してリソースを解放する。
     */
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

    /**
     * フラグメント配列と一時ファイルを解放する。
     * エラー発生時にもリソースリークが発生しないよう必ず呼び出すこと。
     */
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

/**
 * 指定ファイルパスへ PDF 出力を書き込むビルダー。
 *
 * `StreamBuilder` を継承して内部で `fs.WriteStream` を作成する。
 * `finish()` 完了後にストリームを自動的に閉じるため、呼び出し元でのファイルクローズは不要。
 */
export class FileBuilder extends StreamBuilder {
    /**
     * 指定ファイルパスへ書き込む `FileBuilder` を作成する。
     * @param filePath - 出力先ファイルの絶対パスまたは相対パス
     */
    constructor(filePath: string) {
        const stream = fs.createWriteStream(filePath);
        super(stream, null);
    }

    /**
     * 全フラグメントをファイルへフラッシュしてストリームを閉じる。
     * ファイルへの書き込みが完全に完了したことを `finish` イベントで確認する。
     */
    async finish(): Promise<void> {
        await super.finish();
        this.out.end();
        await new Promise<void>(resolve => this.out.once('finish', resolve));
    }
}

/**
 * すべての出力を默默で破棄するビルダー。
 *
 * テスト・ドライランや、第 2 回以降の `SingleResult.nextBuilder()` 呼び出し時のフォールバックとして利用される。
 * リソースを一切割り当てないため、特定の出力先が不要な場面で安全に使用できる。
 */
export class NullBuilder implements Builder {
    /** ブロックを追加する (何も行わない)。 */
    addBlock(): void { }
    /**
     * ブロックを挿入する (何も行わない)。
     * @param _id - アンカーブロック ID (未使用)
     */
    insertBlockBefore(_id: number): void { }
    /**
     * データを書き込む (破棄する)。
     * @param _id - ブロック ID (未使用)
     * @param _data - データ (未使用)
     */
    async write(_id: number, _data: Buffer): Promise<void> { }
    /**
     * ブロックを閉じる (何も行わない)。
     * @param _id - ブロック ID (未使用)
     */
    closeBlock(_id: number): void { }
    /**
     * データをシリアル書き込みする (破棄する)。
     * @param _data - データ (未使用)
     */
    async serialWrite(_data: Buffer): Promise<void> { }
    /** 完了処理を実行する (何も行わない)。 */
    async finish(): Promise<void> { }
    /** リソースを解放する (何も行わない)。 */
    async dispose(): Promise<void> { }
}
