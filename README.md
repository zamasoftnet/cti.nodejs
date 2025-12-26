# Copper PDF CTI Driver for Node.js

Node.jsを使ってCopper PDF 2.1以降にアクセスするための公式ドライバです。
CTIP (Copper Transaction Interlace Protocol) 2.0 に対応しています。

**TypeScriptで実装されており、完全な型定義を提供します。**

## 動作環境

* Node.js 14以降

## インストール

### npmからインストール（公開後）

```bash
npm install copper-cti
```

### Gitリポジトリからインストール

```bash
git clone https://github.com/mimidesunya/copper_drivers.git
cd copper_drivers/cti.nodejs
npm install
npm run build
cd ../..
npm install ./copper_drivers/cti.nodejs
```

## 使い方

詳細は `examples/` ディレクトリ内のサンプルコードを参照してください。

### 基本的な変換 (ファイル出力)

```typescript
import { get_session } from 'copper-cti';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
    // Copper PDFサーバーに接続 (例: ctip://cti.li/)
    const session = get_session('ctip://cti.li/', {
        user: 'user',
        password: 'kappa'
    });

    try {
        const outFile = 'output/result.pdf';
        
        // 出力先ディレクトリがない場合は作成
        const outDir = path.dirname(outFile);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        // 結果の出力先をファイルに指定
        session.setOutputAsFile(outFile);

        // 変換中のメッセージを表示するハンドラ
        session.setMessageFunc((code, msg, args) => {
            console.log(`Message [${code}]: ${msg}`);
        });

        // 変換開始 (ストリームへの書き込み)
        const writer = session.transcode('.');
        
        // HTMLを流し込む
        writer.write('<html><body><h1>Hello, Copper PDF!</h1></body></html>');
        writer.end();

        // 変換完了を待機
        await session.waitForCompletion();
        console.log(`PDF generated successfully: ${outFile}`);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        session.close();
    }
}

main();
```

### JavaScript (CommonJS) での使用

```javascript
const { get_session } = require('copper-cti');
const fs = require('fs');

async function main() {
    const session = get_session('ctip://cti.li/', {
        user: 'user',
        password: 'kappa'
    });

    try {
        session.setOutputAsFile('output/result.pdf');
        
        const writer = session.transcode('.');
        fs.createReadStream('index.html').pipe(writer);

        await session.waitForCompletion();
        console.log('PDF generated successfully');
    } catch (err) {
        console.error('Error:', err);
    } finally {
        session.close();
    }
}

main();
```

### ストリームの使用 (標準出力など)

```typescript
import { get_session } from 'copper-cti';
import * as fs from 'fs';

async function main() {
    const session = get_session('ctip://cti.li/', {
        user: 'user',
        password: 'kappa'
    });

    try {
        // 結果を標準出力に流す
        session.setOutputAsStream(process.stdout);

        const writer = session.transcode('.');
        fs.createReadStream('index.html').pipe(writer);

        await session.waitForCompletion();
    } catch (err) {
        console.error(err);
    } finally {
        session.close();
    }
}

main();
```

### プロパティの設定

```typescript
session.setProperty('output.pdf.version', '1.5');
```

### リソース解決（CSS、画像など）

```typescript
import { get_session, Resource } from 'copper-cti';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
    const session = get_session('ctip://cti.li/', {
        user: 'user',
        password: 'kappa'
    });

    try {
        session.setOutputAsFile('output/result.pdf');

        // リソース解決コールバックを設定
        session.setResolverFunc((uri: string, resource: Resource) => {
            const localPath = path.join(__dirname, uri);
            if (fs.existsSync(localPath)) {
                const out = resource.found({ mime_type: 'text/css' });
                fs.createReadStream(localPath).pipe(out);
            }
            // リソースが見つからない場合は resource.found() を呼ばない
        });

        const writer = session.transcode('.');
        fs.createReadStream('index.html').pipe(writer);

        await session.waitForCompletion();
    } finally {
        session.close();
    }
}

main();
```

## API

### 主要な型

```typescript
// セッションオプション
interface SessionOptions {
    user?: string;
    password?: string;
    encoding?: string;
}

// トランスコードオプション
interface TranscodeOptions {
    mimeType?: string;    // デフォルト: 'text/html'
    encoding?: string;    // デフォルト: 'UTF-8'
    length?: number;      // デフォルト: -1 (不明)
}

// メッセージコールバック
type MessageCallback = (code: number, message: string, args: string[]) => void;

// 進捗コールバック
type ProgressCallback = (total: number | null, read: number) => void;

// リソース解決コールバック
type ResolverCallback = (uri: string, resource: Resource) => void | Promise<void>;
```

### Session クラスの主要メソッド

| メソッド | 説明 |
| :--- | :--- |
| `setOutputAsFile(path)` | PDFをファイルに出力 |
| `setOutputAsStream(stream)` | PDFをストリームに出力 |
| `setOutputAsDirectory(dir, prefix, suffix)` | PDFをディレクトリに連番で出力 |
| `setMessageFunc(callback)` | メッセージコールバックを設定 |
| `setProgressFunc(callback)` | 進捗コールバックを設定 |
| `setResolverFunc(callback)` | リソース解決コールバックを設定 |
| `setProperty(name, value)` | プロパティを設定 |
| `transcode(uri?, opts?)` | 変換を開始（Writableを返す） |
| `waitForCompletion()` | 変換完了を待機 |
| `close()` | セッションを閉じる |

## ディレクトリ構成

```
cti.nodejs/
├── src/           # TypeScriptソースコード
├── dist/          # コンパイル済みJavaScript + 型定義
├── examples/      # 使用例
└── package.json
```

## 開発

```bash
# 依存関係のインストール
npm install

# TypeScriptをコンパイル
npm run build

# サンプルを実行
node examples/output-file.js
```

## ライセンス

Apache License 2.0
