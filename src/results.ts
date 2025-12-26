/**
 * Results Module
 * 
 * This module provides result handlers for different output scenarios.
 */

import * as path from 'path';
import { Builder, FileBuilder, NullBuilder, FinishCallback } from './builder';
import { Packet } from './ctip2';

/** Options passed to finish callback */
export interface ResultOptions {
    uri?: string;
    mime_type?: string;
    encoding?: string;
    length?: number;
}

/** Type for result finish callback */
export type ResultFinishCallback = (opts: ResultOptions) => void;

/** Interface for result handlers */
export interface Results {
    nextBuilder(opts: Partial<Packet>): Builder;
}

/** Single result handler - returns one builder and then NullBuilder */
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
        this.builder = null; // Single use
        return b;
    }
}

/** Directory results handler - creates numbered files in a directory */
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
