/**
 * Results モジュール
 * 
 * このモジュールは、さまざまな出力シナリオに対する結果ハンドラを提供します。
 */

import * as path from 'path';
import { Builder, FileBuilder, NullBuilder, FinishCallback } from './builder';
import { Packet } from './ctip2';

/** `nextBuilder()` 呼び出し時に `ResultFinishCallback` へ渡されるトランスコード开始情報 */
export interface ResultOptions {
    /** トランスコード対象ドキュメントの URI */
    uri?: string;
    /** ドキュメントの MIME タイプ */
    mime_type?: string;
    /** ドキュメントのエンコーディング */
    encoding?: string;
    /** ドキュメントの全バイト長。不明の場合は省略 */
    length?: number;
}

/**
 * トランスコード開始時に `Builder` を取得する直前に呼ばれるコールバック関数の型。
 * 例えば、ファイル名を動的に決定したい場合に使用する。
 * @param opts - トランスコード対象の URI や MIME タイプなどの情報
 */
export type ResultFinishCallback = (opts: ResultOptions) => void;

/**
 * トランスコード結果の書き込み先を表すインターフェース。
 *
 * トランスコードの度に `nextBuilder()` が呼ばれ、
 * 1 回のトランスコードに対応する `Builder` を返す、0
 */
export interface Results {
    nextBuilder(opts: Partial<Packet>): Builder;
}

/** 単一結果ハンドラ - 1つのビルダーを返し、その後はNullBuilderを返します */
export class SingleResult implements Results {
    private builder: Builder | null;
    private finishFunc: ResultFinishCallback | null;

    /**
     * 単一ビルダーを持つ `SingleResult` を作成する。
     * @param builder - 実際に出力に使用する `Builder` インスタンス
     * @param finishFunc - 最初のビルダー取得時に呼び出される完了コールバック、または `null`
     */
    constructor(builder: Builder, finishFunc: ResultFinishCallback | null = null) {
        this.builder = builder;
        this.finishFunc = finishFunc;
    }

    /**
     * 次のトランスコード向けの `Builder` を返す。
     * 初回呼び出しはコンストラクタで渡したビルダーを返す。
     * 2回目以降は `NullBuilder` を返す (単一トランスコード専用)。
     * @param opts - トランスコードパケットのメタ情報 (URI、MIMEタイプなど)
     * @returns 出力用 `Builder` インスタンス
     */
    nextBuilder(opts: Partial<Packet> = {}): Builder {
        if (!this.builder) {
            return new NullBuilder();
        }

        if (this.finishFunc) {
            this.finishFunc(opts);
        }

        const b = this.builder;
        this.builder = null; // 一回使い切り
        return b;
    }
}

/** ディレクトリ結果ハンドラ - ディレクトリ内に番号付きファイルを作成します */
export class DirectoryResults implements Results {
    private dir: string;
    private prefix: string;
    private suffix: string;
    private counter: number = 0;

    /**
     * 定町ディレクトリへ連番ファイルを生成する `DirectoryResults` を作成する。
     * @param dir - 出力先ディレクトリのパス
     * @param prefix - 生成ファイル名のプレフィックス (デフォルト: 空文字列)
     * @param suffix - 生成ファイル名のサフィックス (デフォルト: 空文字列)。拡張子は含めない場合もある
     */
    constructor(dir: string, prefix: string = '', suffix: string = '') {
        this.dir = dir;
        this.prefix = prefix;
        this.suffix = suffix;
    }

    /**
     * 次の連番ファイルへ書き込む `FileBuilder` を返す。
     * 呼び出すたびにカウンターがインクリメントされ、`{dir}/{prefix}{n}{suffix}` 形式のファイルが生成される。
     * @param _opts - トランスコードパケットのメタ情報 (現在未使用)
     * @returns 次の出力ファイル向け `FileBuilder` インスタンス
     */
    nextBuilder(_opts: Partial<Packet> = {}): Builder {
        this.counter++;
        const filename = `${this.prefix}${this.counter}${this.suffix}`;
        const filepath = path.join(this.dir, filename);
        return new FileBuilder(filepath);
    }
}
