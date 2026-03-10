'use strict';

const path = require('path');
const fs = require('fs');

let get_session;
try {
    ({ get_session } = require('../dist'));
} catch (e) {
    process.stderr.write('CTIドライバを読み込めません（npm run build が必要かもしれません）: ' + e.message + '\n');
    process.exit(0);
}

const SERVER_URI = 'ctip://cti.li/';
const USER = 'user';
const PASSWORD = 'kappa';
const SOURCE_URI = 'http://cti.li/';
const OUTPUT_DIR = path.resolve(__dirname, '../../test-output');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function withSession(filename, setup) {
    const session = get_session(SERVER_URI, { user: USER, password: PASSWORD });
    session.setOutputAsFile(path.join(OUTPUT_DIR, filename));
    try {
        await setup(session);
        await session.waitForCompletion();
        process.stderr.write('生成: ' + filename + '\n');
    } catch (e) {
        process.stderr.write('エラー (' + filename + '): ' + e.message + '\n');
        process.exit(0);
    } finally {
        try { session.close(); } catch (_) {}
    }
}

async function main() {
    // TC-01: 基本URL変換
    await withSession('ctip-nodejs-url.pdf', session => {
        session.transcodeServer(SOURCE_URI);
    });

    // TC-02: ハイパーリンク有効
    await withSession('ctip-nodejs-hyperlinks.pdf', session => {
        session.setProperty('output.pdf.hyperlinks', 'true');
        session.transcodeServer(SOURCE_URI);
    });

    // TC-03: ブックマーク有効
    await withSession('ctip-nodejs-bookmarks.pdf', session => {
        session.setProperty('output.pdf.bookmarks', 'true');
        session.transcodeServer(SOURCE_URI);
    });

    // TC-04: ハイパーリンクとブックマーク有効
    await withSession('ctip-nodejs-hyperlinks-bookmarks.pdf', session => {
        session.setProperty('output.pdf.hyperlinks', 'true');
        session.setProperty('output.pdf.bookmarks', 'true');
        session.transcodeServer(SOURCE_URI);
    });

    // TC-05: クライアント側HTML変換
    await withSession('ctip-nodejs-client-html.pdf', session => {
        const html = '<html><body><h1>Hello</h1><p>Client-side HTML transcoding test.</p></body></html>';
        const w = session.transcode('dummy:///test.html');
        w.write(Buffer.from(html, 'utf8'));
        w.end();
    });

    // TC-06: 日本語HTMLコンテンツ
    await withSession('ctip-nodejs-client-japanese.pdf', session => {
        const html = '<html><head><meta charset="UTF-8"/></head><body>'
            + '<h1>日本語テスト</h1><p>こんにちは世界。クライアント側から日本語コンテンツを送信します。</p>'
            + '</body></html>';
        const w = session.transcode('dummy:///japanese.html');
        w.write(Buffer.from(html, 'utf8'));
        w.end();
    });

    // TC-07: 最小HTML（境界条件）
    await withSession('ctip-nodejs-client-minimal.pdf', session => {
        const html = '<html><body><p>.</p></body></html>';
        const w = session.transcode('dummy:///minimal.html');
        w.write(Buffer.from(html, 'utf8'));
        w.end();
    });

    // TC-08: 連続モード（2文書を結合）
    // 注: 連続モードでは RES_START_DATA は最初の文書でのみ送信される。
    // 2文書目以降は既存のビルダーへの差分ブロックデータとして届き、
    // join()後の RES_EOF でビルダーがfinish()される。
    await withSession('ctip-nodejs-continuous.pdf', async session => {
        const html1 = '<html><body><h1>Page 1</h1><p>First document in continuous mode.</p></body></html>';
        const html2 = '<html><body><h1>Page 2</h1><p>Second document in continuous mode.</p></body></html>';
        session.setContinuous(true);
        const w1 = session.transcode('dummy:///page1.html');
        w1.write(Buffer.from(html1, 'utf8'));
        w1.end();
        await session.waitForCompletion();
        const w2 = session.transcode('dummy:///page2.html');
        w2.write(Buffer.from(html2, 'utf8'));
        w2.end();
        await session.waitForCompletion();
        session.join();
    });

    // TC-09: 大規模テーブル（メモリ→ファイル切り替えを誘発）
    await withSession('ctip-nodejs-large-table.pdf', session => {
        const w = session.transcode('dummy:///large-table.html');
        w.write(Buffer.from('<html><head><meta charset="UTF-8"/></head><body>', 'utf8'));
        w.write(Buffer.from('<h1>大規模テーブルテスト</h1>', 'utf8'));
        w.write(Buffer.from('<table border="1"><tr><th>番号</th><th>名前</th><th>説明</th><th>備考</th></tr>', 'utf8'));
        for (let i = 1; i <= 15000; i++) {
            w.write(Buffer.from(
                `<tr><td>${i}</td><td>項目${i}</td><td>これはテスト項目 ${i} の詳細説明テキストです。</td><td>備考テキスト ${i}</td></tr>`,
                'utf8'));
        }
        w.write(Buffer.from('</table></body></html>', 'utf8'));
        w.end();
    });

    // TC-10: 長文テキスト文書
    await withSession('ctip-nodejs-large-text.pdf', session => {
        const sentences = 'Copper PDFはHTMLやXMLをPDFに変換するサーバーサイドのソフトウェアです。'
            + 'CTIプロトコルを通じてクライアントからドキュメントを送信し、変換結果をPDFとして受け取ります。'
            + 'このテストは大量のテキストコンテンツを含む文書を生成します。'
            + 'ドライバはPDF出力が2MBを超えた際にメモリからファイル書き出しへ切り替わります。'
            + 'このテストはその動作を確認するために設計されています。';
        const w = session.transcode('dummy:///large-text.html');
        w.write(Buffer.from('<html><head><meta charset="UTF-8"/></head><body>', 'utf8'));
        for (let s = 1; s <= 500; s++) {
            w.write(Buffer.from(`<h2>セクション ${s}</h2>`, 'utf8'));
            for (let p = 0; p < 20; p++) {
                w.write(Buffer.from(`<p>${sentences}（セクション${s}、段落${p + 1}）</p>`, 'utf8'));
            }
        }
        w.write(Buffer.from('</body></html>', 'utf8'));
        w.end();
    });
}

main().catch(err => {
    process.stderr.write('致命的エラー: ' + err.message + '\n');
    process.exit(0);
});
