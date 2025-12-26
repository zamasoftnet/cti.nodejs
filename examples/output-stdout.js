const { get_session } = require('../dist');
const fs = require('fs');

/**
 * 標準出力にPDFを出力するサンプル
 * 使用法: node output-stdout.js <URI> <HTMLファイル> > output.pdf
 */
async function main() {
    // 使用法: node output-stdout.js [HTMLファイル] [URI]
    // デフォルトURI: ctip://cti.li/
    
    // サンプル用に値をハードコード
    const path = require('path'); // Ensure path is available if not already
    const htmlFile = path.join(__dirname, 'test.html');
    const uri = 'ctip://cti.li/';
    
    console.error(`HTML File: ${htmlFile}`); // Log to stderr to not interfere with stdout PDF output
    console.error(`URI: ${uri}`);

    // セッションの作成
    const session = get_session(uri, { user: 'user', password: 'kappa' });

    try {
        // 結果の出力先を標準出力に設定
        session.setOutputAsStream(process.stdout);

        // プログレス表示（標準エラー出力へ）
        session.setProgressFunc((total, read) => {
            console.error(`Progress: ${read}/${total !== -1 ? total : '???'}`);
        });

        // 変換開始
        console.error('Starting transcoding...');
        const input = session.transcode();
        
        // ファイルを読み込んでCopperサーバーへ送信
        fs.createReadStream(htmlFile).pipe(input);

        // 完了待機
        await session.waitForCompletion();
        console.error('Done.');

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        session.close();
    }
}

main();
