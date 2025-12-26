/**
 * Builder Module
 * 
 * This module provides builder classes for constructing PDF output from fragments.
 * It handles both memory and disk-based fragment storage for efficient memory usage.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Writable } from 'stream';

/** Maximum size of a fragment in memory before spilling to disk */
const FRG_MEM_SIZE = 256;

/** Maximum total memory usage before forcing disk writes */
const ON_MEMORY = 1024 * 1024;

/** Segment size for temporary file storage */
const SEGMENT_SIZE = 8192;

/** Fragment data structure for managing output chunks */
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
     * Write data to this fragment
     * @param builder - The parent builder (manages temp file)
     * @param data - Data to write
     * @param currentTotalOnMemory - Current total memory usage
     * @returns Memory delta (positive = increased, negative = decreased)
     */
    async write(builder: StreamBuilder, data: Buffer, currentTotalOnMemory: number): Promise<number> {
        const len = data.length;
        let memoryDelta = 0;

        // Check if we can store in memory
        if (this.segments === null &&
            this.length + len <= FRG_MEM_SIZE &&
            currentTotalOnMemory + len <= ON_MEMORY) {

            this.buffer = Buffer.concat([this.buffer, data]);
            memoryDelta = len;
            this.length += len;
            return memoryDelta;
        }

        // Need to write to disk
        // First flush existing buffer if any
        if (this.buffer.length > 0) {
            const flushedLen = this.buffer.length;
            await this._flushBufferToDisk(builder);
            memoryDelta -= flushedLen;
        }

        // Write new data to disk
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

    /** Flush fragment contents to output stream */
    async flushToStream(builder: StreamBuilder, outStream: Writable): Promise<void> {
        // Memory-based fragment
        if (this.segments === null) {
            if (this.buffer.length > 0) {
                if (!outStream.write(this.buffer)) {
                    await new Promise<void>(resolve => outStream.once('drain', resolve));
                }
            }
            return;
        }

        // Disk-based fragment
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

/** Builder interface for output construction */
export interface Builder {
    addBlock(): void;
    insertBlockBefore(anchorId: number): void;
    write(id: number, data: Buffer): Promise<void>;
    closeBlock(id: number): void;
    serialWrite(data: Buffer): Promise<void>;
    finish(): Promise<void>;
    dispose(): Promise<void>;
}

/** Type for finish callback function */
export type FinishCallback = (totalLength: number) => Promise<void> | void;

/** Builder that writes output to a stream */
export class StreamBuilder implements Builder {
    protected out: Writable;
    protected finishFunc: FinishCallback | null;
    protected frgs: Fragment[] = [];
    protected first: Fragment | null = null;
    protected last: Fragment | null = null;
    protected onMemory: number = 0;
    protected totalLength: number = 0;

    // Temp file management
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

        if (anchor.prev) {
            anchor.prev.next = frg;
        }
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
        // No-op
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

/** Builder that writes output to a file */
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

/** Builder that discards all output (for testing or dry runs) */
export class NullBuilder implements Builder {
    addBlock(): void { }
    insertBlockBefore(_id: number): void { }
    async write(_id: number, _data: Buffer): Promise<void> { }
    closeBlock(_id: number): void { }
    async serialWrite(_data: Buffer): Promise<void> { }
    async finish(): Promise<void> { }
    async dispose(): Promise<void> { }
}
