const { get_session } = require('../dist');
const fs = require('fs');
const path = require('path');

/**
 * リソースリゾルバを使用するサンプル
 * HTML内の画像などをローカルから送信します
 * 使用法: node resolver.js <URI> <HTMLファイル> <出力PDFファイル>
 */
async function main() {
    console.log('Starting resolver.js...');
    // サンプル用に値をハードコード
    const htmlFile = path.join(__dirname, 'test_resolver.html');
    const outFile = path.join(__dirname, '../output/resolver.pdf');
    const uri = 'ctip://cti.li/';
    const baseDir = path.dirname(htmlFile);

    console.log(`HTML File: ${htmlFile}`);
    console.log(`Output File: ${outFile}`);
    console.log(`URI: ${uri}`);

    // Ensure output directory exists
    const outDir = path.dirname(outFile);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    const session = get_session(uri, { user: 'user', password: 'kappa' });

    try {
        session.setOutputAsFile(outFile);

        // リゾルバ関数を設定
        session.setResolverFunc((uri, resource) => {
            console.log(`Server requested resource: ${uri}`);
            
            // 相対パス解決の簡易実装
            let localPath = uri;
            if (!path.isAbsolute(uri)) {
                localPath = path.join(baseDir, uri);
            }

            if (fs.existsSync(localPath)) {
                console.log(`Sending local file: ${localPath}`);
                
                // Content-Typeの簡易判定（実際にはもっと厳密に行うべき）
                let mime = 'application/octet-stream';
                if (localPath.endsWith('.css')) mime = 'text/css';
                else if (localPath.endsWith('.png')) mime = 'image/png';
                else if (localPath.endsWith('.jpg')) mime = 'image/jpeg';

                const output = resource.found({ mime_type: mime });
                fs.createReadStream(localPath).pipe(output);
                
                // ストリーム完了を待つ必要があればPromiseを返すべきだが、
                // pipeは非同期に進む。ドライバ側はResource#foundが同期的に呼ばれることを期待しているが、
                // 実際のデータ送信は非同期でOK。
            } else {
                console.warn(`Resource not found: ${localPath}`);
                // 何もしないと missing 扱いになる
            }
        });

        console.log('Sending HTML content...');
        const input = session.transcode();
        fs.createReadStream(htmlFile).pipe(input);
        console.log('HTML content piped, waiting for completion...');

        await session.waitForCompletion();
        console.log(`Created ${outFile}`);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        session.close();
    }
}

main();
