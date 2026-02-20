/**
 * Results モジュール
 * 
 * このモジュールは、さまざまな出力シナリオに対する結果ハンドラを提供します。
 */

import * as path from 'path';
import { Builder, FileBuilder, NullBuilder, FinishCallback } from './builder';
import { Packet } from './ctip2';

/** 完了コールバックに渡されるオプション */
export interface ResultOptions {
    uri?: string;
    mime_type?: string;
    encoding?: string;
    length?: number;
}

/** 結果完了コールバックの型 */
export type ResultFinishCallback = (opts: ResultOptions) => void;

/** 結果ハンドラのインターフェース */
export interface Results {
    nextBuilder(opts: Partial<Packet>): Builder;
}

/** 単一結果ハンドラ - 1つのビルダーを返し、その後はNullBuilderを返します */
export class SingleResult implements Results {
    private builder: Builder | null;
    private finishFunc: ResultFinishCallback | null;

    constructor(builder: Builder, finishFunc: ResultFinishCallback | null = null) {
        this.builder = builder;
        this.finishFunc = finishFunc;
    }

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

    constructor(dir: string, prefix: string = '', suffix: string = '') {
        this.dir = dir;
        this.prefix = prefix;
        this.suffix = suffix;
    }

    nextBuilder(_opts: Partial<Packet> = {}): Builder {
        this.counter++;
        const filename = `${this.prefix}${this.counter}${this.suffix}`;
        const filepath = path.join(this.dir, filename);
        return new FileBuilder(filepath);
    }
}
