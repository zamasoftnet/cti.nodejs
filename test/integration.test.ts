
import { Driver } from '../src/driver';
import { Session, IllegalStateError } from '../src/session';
import { SingleResult } from '../src/results';
import { NullBuilder } from '../src/builder';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { Writable } from 'stream';

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

const DATA_DIR = path.join(__dirname, 'data');
const OUT_DIR = path.join(__dirname, 'out');

class MemoryWritable extends Writable {
    public buffer: Buffer = Buffer.alloc(0);
    _write(chunk: any, _enc: BufferEncoding, callback: (error?: Error | null) => void): void {
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
            const timeout = setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
            socket.once('connect', () => { clearTimeout(timeout); socket.destroy(); resolve(true); });
            socket.once('error', () => { clearTimeout(timeout); resolve(false); });
            socket.connect({ host, port });
        });
    } catch (_e) {
        return Promise.resolve(false);
    }
}

function createSession(): Session {
    const driver = new Driver();
    return driver.getSession(config!.serverUri, {
        user: config!.user,
        password: config!.password
    });
}

function transcodeHtml(session: Session, outputFile: string): Promise<void> {
    session.setOutputAsFile(outputFile);

    const cssStream = session.resource('test.css');
    fs.createReadStream(path.join(DATA_DIR, 'test.css')).pipe(cssStream);

    return new Promise((resolve, reject) => {
        cssStream.once('finish', () => {
            const out = session.transcode('test.html', { mimeType: 'text/html' });
            fs.createReadStream(path.join(DATA_DIR, 'test.html')).pipe(out);
            out.once('finish', () => {
                session.waitForCompletion().then(resolve).catch(reject);
            });
            out.once('error', reject);
        });
        cssStream.once('error', reject);
    });
}

function assertPdf(filePath: string): void {
    const buf = fs.readFileSync(filePath);
    expect(buf.subarray(0, 4).toString('binary')).toBe('%PDF');
}

describe('Integration Test', () => {
    let serverAvailable = false;

    beforeAll(async () => {
        if (config) {
            serverAvailable = await canConnect(config.serverUri);
        }
        if (!serverAvailable) {
            console.warn('Skipping CTI integration test: server unavailable.');
        }
        fs.mkdirSync(OUT_DIR, { recursive: true });
    });

    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    const skipIf = (condition: boolean) => condition ? test.skip : test;

    skipIf(!config || !serverAvailable)('サーバー接続とセッション作成', async () => {
        const session = createSession();
        expect(session).toBeDefined();
        session.close();
    }, 10000);

    skipIf(!config || !serverAvailable)('サーバー情報を取得できる', async () => {
        const session = createSession();
        try {
            const info = await session.getServerInfo('http://www.cssj.jp/ns/ctip/version');
            expect(info).toBeTruthy();
            expect(info.length).toBeGreaterThan(0);
        } finally {
            session.close();
        }
    }, 10000);

    skipIf(!config || !serverAvailable)('HTMLをPDFファイルに変換できる', async () => {
        const outFile = path.join(OUT_DIR, 'nodejs-output-file.pdf');
        if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

        const session = createSession();
        try {
            await transcodeHtml(session, outFile);
        } finally {
            session.close();
        }

        assertPdf(outFile);
    }, 30000);

    skipIf(!config || !serverAvailable)('出力ディレクトリに画像ファイルを生成できる', async () => {
        const outputDir = path.join(OUT_DIR, 'output-dir');
        fs.mkdirSync(outputDir, { recursive: true });
        for (const f of fs.readdirSync(outputDir)) {
            fs.unlinkSync(path.join(outputDir, f));
        }

        const session = createSession();
        try {
            session.setProperty('output.type', 'image/jpeg');
            session.setOutputAsDirectory(outputDir, '', '.jpg');
            const out = session.transcode('test.html', { mimeType: 'text/html' });
            fs.createReadStream(path.join(DATA_DIR, 'test.html')).pipe(out);
            out.once('error', (e) => { throw e; });
            await session.waitForCompletion();
        } finally {
            session.close();
        }

        const jpgs = fs.readdirSync(outputDir).filter(f => f.toLowerCase().endsWith('.jpg'));
        expect(jpgs.length).toBeGreaterThan(0);
    }, 30000);

    skipIf(!config || !serverAvailable)('プロパティを設定してPDF変換できる', async () => {
        const output = new MemoryWritable();
        const session = createSession();
        try {
            session.setProperty('output.pdf.version', '1.5');
            session.setOutputAsStream(output);
            const out = session.transcode('test.html', { mimeType: 'text/html' });
            fs.createReadStream(path.join(DATA_DIR, 'test.html')).pipe(out);
            await session.waitForCompletion();
        } finally {
            session.close();
        }

        expect(output.buffer.subarray(0, 4).toString('binary')).toBe('%PDF');
    }, 30000);

    skipIf(!config || !serverAvailable)('リゾルバコールバックが呼ばれてリソースを解決できる', async () => {
        const outFile = path.join(OUT_DIR, 'nodejs-resolver.pdf');
        if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

        let resolved = false;
        const session = createSession();
        try {
            session.setResolverFunc(async (uri, resource) => {
                if (uri === 'test.css') {
                    resolved = true;
                    const out = resource.found();
                    await new Promise<void>((resolve, reject) => {
                        fs.createReadStream(path.join(DATA_DIR, 'test.css')).pipe(out);
                        out.once('finish', resolve);
                        out.once('error', reject);
                    });
                }
            });
            session.setOutputAsFile(outFile);
            const out = session.transcode('test.html', { mimeType: 'text/html' });
            fs.createReadStream(path.join(DATA_DIR, 'test.html')).pipe(out);
            await session.waitForCompletion();
        } finally {
            session.close();
        }

        expect(resolved).toBe(true);
        assertPdf(outFile);
    }, 30000);

    skipIf(!config || !serverAvailable)('進行状況コールバックが呼ばれる', async () => {
        const progress: Array<[number | null, number]> = [];
        const session = createSession();
        try {
            session.setResults(new SingleResult(new NullBuilder()));
            session.setProgressFunc((total, read) => { progress.push([total, read]); });
            session.setProperty('input.include', 'https://www.w3.org/**');
            session.transcodeServer('https://www.w3.org/TR/xslt-10/');
            await session.waitForCompletion();
        } finally {
            session.close();
        }

        expect(progress.length).toBeGreaterThan(0);
    }, 60000);

    skipIf(!config || !serverAvailable)('リセット後に再変換できる', async () => {
        const out1 = path.join(OUT_DIR, 'nodejs-reset-1.pdf');
        const out2 = path.join(OUT_DIR, 'nodejs-reset-2.pdf');
        for (const f of [out1, out2]) {
            if (fs.existsSync(f)) fs.unlinkSync(f);
        }

        const session = createSession();
        try {
            await transcodeHtml(session, out1);
            session.reset();
            await transcodeHtml(session, out2);
        } finally {
            session.close();
        }

        assertPdf(out1);
        assertPdf(out2);
    }, 60000);

    skipIf(!config)('認証失敗時に例外がスローされる', async () => {
        const driver = new Driver();
        const session = driver.getSession(config!.serverUri, {
            user: 'invalid-user',
            password: 'invalid-password'
        });

        const out = session.transcode('test.html');
        out.write(Buffer.from('<html><body><p>test</p></body></html>'));
        out.end();

        await expect(session.waitForCompletion()).rejects.toThrow();
        session.close();
    }, 10000);
});
