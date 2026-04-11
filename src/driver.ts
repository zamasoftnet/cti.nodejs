/**
 * Driver モジュール
 * 
 * このモジュールは、Copper PDFサーバーへのセッションを作成するためのDriverクラスを提供します。
 */

import * as net from 'net';
import * as tls from 'tls';
import { Session, SessionOptions } from './session';

/**
 * 接続先サーバーの TLS 設定を含む拡張セッションオプション。
 * `SessionOptions` の全フィールドを継承し、`ctips://` URI 使用時に追加で設定できる。
 */
export interface DriverOptions extends SessionOptions {
    /** 不明なSSL証明書を拒否するかどうか (デフォルト: true) */
    rejectUnauthorized?: boolean;
}

/**
 * Copper PDF サーバーへの接続を展開して `Session` を作成するドライバークラス。
 *
 * CTIP (`ctip://`) および CTIPS (`ctips://`) の両方の URI スキームに対応する。
 * URI にはホスト名・ポート番号は省略可能で、それぞれデフォルト `localhost` / `8099` を使用する。
 *
 * @example
 * ```ts
 * const session = new Driver().getSession('ctip://localhost:8099/');
 * ```
 */
export class Driver {
    /**
     * Copper PDFサーバーへのセッションを作成
     * @param uri - サーバーURI (ctip://host:port/ または ctips://host:port/)
     * @param options - 接続オプション
     * @returns 新しいSessionインスタンス
     */
    getSession(uri: string, options: DriverOptions = {}): Session {
        let host = 'localhost';
        let port = 8099;
        let useSSL = false;

        // 簡易URI解析
        // ctip://host:port/
        // ctips://host:port/

        let match = uri.match(/^ctips:\/\/([^:/]+):([0-9]+)\/?$/);
        if (match) {
            useSSL = true;
            host = match[1];
            port = parseInt(match[2], 10);
        } else {
            match = uri.match(/^ctips:\/\/([^:/]+)\/?$/);
            if (match) {
                useSSL = true;
                host = match[1];
            } else {
                match = uri.match(/^ctip:\/\/([^:/]+):([0-9]+)\/?$/);
                if (match) {
                    host = match[1];
                    port = parseInt(match[2], 10);
                } else {
                    match = uri.match(/^ctip:\/\/([^:/]+)\/?$/);
                    if (match) {
                        host = match[1];
                    }
                }
            }
        }

        let socket: net.Socket | tls.TLSSocket;
        if (useSSL) {
            const tlsOptions: tls.ConnectionOptions = {
                rejectUnauthorized: options.rejectUnauthorized !== undefined ? options.rejectUnauthorized : true
            };
            socket = tls.connect(port, host, tlsOptions);
        } else {
            socket = net.connect(port, host);
        }

        return new Session(socket, options);
    }
}
