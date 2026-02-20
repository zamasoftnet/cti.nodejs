
import { Driver } from '../src/driver';
import { Session, IllegalStateError } from '../src/session';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';

// 設定ファイルのインターフェース
interface TestConfig {
    serverUri: string;
    user?: string;
    password?: string;
}

// 設定を読み込む
let config: TestConfig | null = null;
const configPath = path.join(__dirname, 'test-config.json');

try {
    if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        config = JSON.parse(raw);
    }
} catch (e) {
    console.warn('Failed to load test-config.json, skipping integration test.');
}

import { Writable } from 'stream';

class MemoryWritable extends Writable {
    public buffer: Buffer = Buffer.alloc(0);
    _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        callback();
    }
}

function canConnect(serverUri: string): Promise<boolean> {
    try {
        const target = new URL(serverUri);
        const host = target.hostname;
        const port = Number(target.port) || 8099;
        return new Promise((resolve) => {
            const socket = new net.Socket();
            const timeout = setTimeout(() => {
                socket.destroy();
                resolve(false);
            }, 2000);
            socket.once('connect', () => {
                clearTimeout(timeout);
                socket.destroy();
                resolve(true);
            });
            socket.once('error', () => {
                clearTimeout(timeout);
                resolve(false);
            });
            socket.connect({ host, port });
        });
    } catch (_e) {
        return Promise.resolve(false);
    }
}

// 接続テスト (実際のネットワークアクセスを伴う)
describe('Integration Test', () => {
    let session: Session;
    let serverAvailable = false;

    beforeAll(async () => {
        if (config) {
            serverAvailable = await canConnect(config.serverUri);
        }
        if (!serverAvailable) {
            console.warn('Skipping CTI integration test: server unavailable.');
        }
    });

    beforeEach(() => {
        // コンソールエラーを抑制 (認証エラーなどは想定内)
        jest.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        if (session) {
            session.close();
        }
    });

    const runTest = config ? test : test.skip;

    runTest('サーバーに接続し、PDF生成(トランスコード)を行う', async () => {
        if (!serverAvailable) {
            return;
        }

        const driver = new Driver();
        const uri = config!.serverUri;

        console.log(`Testing with config: ${JSON.stringify(config)}`);

        session = driver.getSession(uri, {
            user: config!.user,
            password: config!.password
        });

        // PDFの出力先をメモリバッファにする
        const output = new MemoryWritable();
        session.setOutputAsStream(output);

        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Test PDF</title>
            <style>
                body { font-family: sans-serif; }
                h1 { color: blue; }
            </style>
        </head>
        <body>
            <h1>Hello, Copper PDF!</h1>
            <p>This is a test document generated via cti.nodejs integration test.</p>
        </body>
        </html>
        `;

        try {
            // test.html としてトランスコードを開始
            // 注意: transcode() が返すのはサーバーへ送るデータの入力ストリーム (MainOut)
            const inputStream = session.transcode('test.html');

            // HTMLコンテンツをサーバーへ送信
            inputStream.write(Buffer.from(htmlContent));
            inputStream.end();

            console.log('Transcoding started, waiting for completion...');

            // トランスコード完了(レスポンス受信完了)を待機
            await session.waitForCompletion();

            console.log(`Transcoding finished. Received PDF size: ${output.buffer.length} bytes`);

            // データが受信できているか確認
            if (output.buffer.length === 0) {
                throw new Error('データを受信できませんでした (0 bytes)');
            }

            // PDFヘッダーのチェック (%PDF-...)
            const header = output.buffer.subarray(0, 5).toString();
            if (header !== '%PDF-') {
                throw new Error(`Invalid PDF header: ${header}`);
            }

        } catch (e) {
            throw e;
        }
    }, 30000); // 30秒タイムアウト
});
