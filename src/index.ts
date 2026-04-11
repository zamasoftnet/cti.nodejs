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

/**
 * 新しい `Driver` インスタンスを返す。
 * @returns 新たに作成した `Driver` インスタンス
 */
export function get_driver(): Driver {
    return new Driver();
}

/**
 * Copper PDFサーバーへのセッションを直接作成するショートカット関数。
 * 内部で `new Driver().getSession(...)` を呼び出す。
 * @param uri - サーバー URI (`ctip://host:port/` または `ctips://host:port/`)
 * @param options - 認証情報や TLS 設定を含む接続オプション
 * @returns 接続新の `Session` インスタンス
 */
export function get_session(uri: string, options: DriverOptions = {}): Session {
    return new Driver().getSession(uri, options);
}
