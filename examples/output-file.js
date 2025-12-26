const { Driver, get_session } = require('../dist');
const fs = require('fs');
const path = require('path');

/**
 * ファイルにPDFを出力するサンプル
 * 使用法: node output-file.js <URI> <HTMLファイル> <出力PDFファイル>
 */
async function main() {
    // サンプル用に値をハードコード
    const htmlFile = path.join(__dirname, 'test.html');
    const outFile = path.join(__dirname, '../output/file.pdf');
    const uri = 'ctip://cti.li/';
    
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
        // 結果の出力先をファイルに設定
        session.setOutputAsFile(outFile);

        // メッセージハンドラの設定
        session.setMessageFunc((code, msg, args) => {
            console.error(`Message [${code}]: ${msg}`, args);
        });

        const writer = session.transcode();
        fs.createReadStream(htmlFile).pipe(writer);

        await session.waitForCompletion();
        console.log(`Successfully created ${outFile}`);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        session.close();
    }
}

main();
