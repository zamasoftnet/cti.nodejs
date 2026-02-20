/**
 * Node.js用 Copper PDF CTI ドライバ
 * 
 * このモジュールは、copper-ctiパッケージのメインエントリポイントを提供します。
 */

export { Driver, DriverOptions } from './driver';
export { Session, SessionOptions, Resource, IllegalStateError, MessageCallback, ProgressCallback, ResolverCallback, ResourceOptions, TranscodeOptions } from './session';
export { StreamBuilder, FileBuilder, NullBuilder, Builder, FinishCallback } from './builder';
export { SingleResult, DirectoryResults, Results, ResultOptions, ResultFinishCallback } from './results';
export { MSG, PacketParser, Packet } from './ctip2';

import { Driver, DriverOptions } from './driver';
import { Session } from './session';

/** 新しいDriverインスタンスを取得 */
export function get_driver(): Driver {
    return new Driver();
}

/** Copper PDFサーバーへのセッションを作成 */
export function get_session(uri: string, options: DriverOptions = {}): Session {
    return new Driver().getSession(uri, options);
}
