
import { StreamBuilder } from '../src/builder';
import { Writable } from 'stream';

class MemoryWritable extends Writable {
    public buffer: Buffer = Buffer.alloc(0);

    _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        callback();
    }
}

describe('StreamBuilder', () => {
    let outputStream: MemoryWritable;
    let builder: StreamBuilder;

    beforeEach(() => {
        outputStream = new MemoryWritable();
        builder = new StreamBuilder(outputStream);
    });

    afterEach(async () => {
        await builder.dispose();
    });


    test('少量のデータがメモリに書き込まれ、ストリームにフラッシュされること', async () => {
        builder.addBlock();
        const data = Buffer.from('hello world');
        await builder.write(0, data);
        await builder.finish();

        expect(outputStream.buffer.toString()).toBe('hello world');
    });

    test('順序通りに複数のブロックを処理できること', async () => {
        builder.addBlock(); // ブロック 0
        builder.addBlock(); // ブロック 1

        await builder.write(0, Buffer.from('Hello '));
        await builder.write(1, Buffer.from('World!'));

        await builder.finish();

        expect(outputStream.buffer.toString()).toBe('Hello World!');
    });

    test('先頭ブロックの前に挿入すると例外になること', () => {
        builder.addBlock(); // ブロック 0

        expect(() => {
            builder.insertBlockBefore(0);
        }).toThrow();
    });

    test('中間ブロックの前にブロックを挿入できること', async () => {
        builder.addBlock(); // 0
        builder.addBlock(); // 1
        await builder.write(0, Buffer.from('A'));
        await builder.write(1, Buffer.from('C'));

        builder.insertBlockBefore(1);
        await builder.write(2, Buffer.from('B'));

        await builder.finish();

        expect(outputStream.buffer.toString()).toBe('ABC');
    });

    test('ディスクにあふれる大きなデータを処理できること', async () => {
        // ソースコードによると FRG_MEM_SIZE = 256
        // フラグメントに対してディスク使用を強制するために256バイト以上書き込む

        builder.addBlock();
        const largeData = Buffer.alloc(300, 'a');
        await builder.write(0, largeData);

        await builder.finish();

        expect(outputStream.buffer.length).toBe(300);
        expect(outputStream.buffer.toString()).toBe(largeData.toString());
    });
});
