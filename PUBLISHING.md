# リリース手順

## リリース方法

`package.json` の `version` を更新し、バージョンタグを push します。

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions が以下を自動実行します：

1. ビルド（`npm run build`）
2. TypeDoc によるAPIドキュメント生成（`npm run doc`）
3. GitHub Releases にアーカイブを公開（`cti-nodejs-{VERSION}.zip` / `.tar.gz`）
4. GitHub Pages にドキュメントをデプロイ

## ドキュメント

- **GitHub Pages**: https://zamasoftnet.github.io/cti.nodejs/
- リリース時に自動更新
