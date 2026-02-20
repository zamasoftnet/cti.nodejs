
import { Session } from '../src/session';
import { EventEmitter } from 'events';
import { Socket } from 'net';

class MockSocket extends EventEmitter {
    public written: Buffer[] = [];
    public ended: boolean = false;
    public destroyed: boolean = false;

    write(data: Buffer | string): boolean {
        if (typeof data === 'string') {
            this.written.push(Buffer.from(data));
        } else {
            this.written.push(data);
        }
        return true;
    }

    end(): void {
        this.ended = true;
        this.emit('close');
    }

    destroy(): void {
        this.destroyed = true;
        this.emit('close');
    }

    // Helper to simulate incoming data
    emitData(data: Buffer | string): void {
        if (typeof data === 'string') {
            this.emit('data', Buffer.from(data));
        } else {
            this.emit('data', data);
        }
    }
}

describe('Session Boundary Tests', () => {
    let socket: MockSocket;
    let session: Session;

    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => { });
        socket = new MockSocket();
        session = new Session(socket as unknown as Socket, { user: 'u', password: 'p' });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });


    test('ハンドシェイクが複数のチャンクに分割されても処理できること', (done) => {
        // セッションコンストラクタによってハンドシェイクリクエストが送信される
        expect(socket.written.length).toBeGreaterThan(0);

        // 分割された "OK \n" をシミュレート
        socket.emitData(Buffer.from('O'));
        socket.emitData(Buffer.from('K'));
        socket.emitData(Buffer.from(' '));
        socket.emitData(Buffer.from('\n'));

        // ここまでエラーなく到達し、データを送信できればハンドシェイクは成功している
        // パケットの送信を試みることで検証 (ハンドシェイク完了後のみ送信される)
        const sent = session.send(Buffer.from([0xC0, 0x01]));
        expect(sent).toBe(true);
        expect(socket.written.length).toBeGreaterThan(1); // 初期ハンドシェイク + 新しいパケット
        done();
    });

    test('NGハンドシェイクで失敗すること', (done) => {
        session.close = jest.fn(); // closeが呼ばれたかチェックするためのモック

        socket.emitData('NG Some Error\n');

        // 接続が切断されるべき
        expect(socket.ended).toBe(true);
        done();
    });

    test('不正なハンドシェイクデータで失敗すること', (done) => {
        socket.emitData('GARBAGE'.repeat(20) + '\n');

        // バッファオーバーフローチェックにより接続が切断されるべき
        expect(socket.ended).toBe(true);
        done();
    });

    test('ハンドシェイク完了前に送信されたパケットはバッファリングされること', () => {
        // 初期ハンドシェイクの書き込みが存在する
        const initialWrites = socket.written.length;
        expect(initialWrites).toBeGreaterThan(0);

        // サーバー応答のシミュレーション前にデータを送信
        session.send(Buffer.from('test'));

        // まだソケットには書き込まれていないはず (内部でバッファリング)
        expect(socket.written.length).toBe(initialWrites);

        // ハンドシェイク完了
        socket.emitData('OK \n');

        // これで書き込まれるはず
        expect(socket.written.length).toBe(initialWrites + 1);
        expect(socket.written[socket.written.length - 1].toString()).toBe('test');
    });

    // 有効な s14 メッセージパケットを作成するヘルパー
    function createMessagePacket(msg: string): Buffer {
        const msgBuf = Buffer.from(msg);
        const codeSize = 2;
        const msgLenSize = 2;
        const msgSize = msgBuf.length;
        const typeSize = 1;

        const payloadSize = typeSize + codeSize + msgLenSize + msgSize;
        const buf = Buffer.alloc(4 + payloadSize);

        // 長さを書き込み
        buf.writeUInt32BE(payloadSize, 0);

        let offset = 4;
        // タイプを書き込み (s14 は MESSAGE 0x14)
        // src/ctip2.ts: RES_MESSAGE: 0x14
        buf.writeUInt8(0x14, offset++);

        // コード (0)
        buf.writeUInt16BE(0, offset); offset += 2;

        // メッセージ長
        buf.writeUInt16BE(msgSize, offset); offset += 2;

        // メッセージ本体
        msgBuf.copy(buf, offset); offset += msgSize;

        return buf;
    }

    test('1つのチャンクに含まれる複数のパケットを処理できること', async () => {
        socket.emitData('OK \n');

        let receivedMessages: string[] = [];
        session.setMessageFunc((code, msg, args) => {
            receivedMessages.push(msg);
        });

        const pkt1 = createMessagePacket('Hello');
        const pkt2 = createMessagePacket('World');

        // 両方を一度に送信
        socket.emitData(Buffer.concat([pkt1, pkt2]));

        // セッションは通常非同期でパケットを処理するため、少し待つ
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(receivedMessages).toEqual(['Hello', 'World']);
    });

    test('チャンクに分割されたパケットを処理できること', async () => {
        socket.emitData('OK \n');

        let receivedMessages: string[] = [];
        session.setMessageFunc((code, msg, args) => {
            receivedMessages.push(msg);
        });

        const pkt = createMessagePacket('Split');

        // 1バイトずつ送信
        for (const byte of pkt) {
            socket.emitData(Buffer.from([byte]));
        }

        await new Promise(resolve => setTimeout(resolve, 50));

        expect(receivedMessages).toEqual(['Split']);
    });

    test('不正なパケットヘッダーを適切に無視するかエラーにすること', async () => {
        socket.emitData('OK \n');

        // 切り詰められたパケット (完了しない)
        const partialPkt = createMessagePacket('Partial').subarray(0, 8); // 途中でカット

        socket.emitData(partialPkt);

        await new Promise(resolve => setTimeout(resolve, 10));
        // まだ処理されておらず、クラッシュしていないはず

        // 残りを送信
        const rest = createMessagePacket('Partial').subarray(8);
        socket.emitData(rest);

        // 処理を待つ
        await new Promise(resolve => setTimeout(resolve, 50));
    });
});
