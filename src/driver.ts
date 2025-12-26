/**
 * Driver Module
 * 
 * This module provides the Driver class for creating sessions to Copper PDF servers.
 */

import * as net from 'net';
import * as tls from 'tls';
import { Session, SessionOptions } from './session';

/** Extended session options including TLS settings */
export interface DriverOptions extends SessionOptions {
    /** Whether to reject unauthorized SSL certificates (default: true) */
    rejectUnauthorized?: boolean;
}

/** Driver for connecting to Copper PDF servers */
export class Driver {
    /**
     * Create a session to a Copper PDF server
     * @param uri - Server URI (ctip://host:port/ or ctips://host:port/)
     * @param options - Connection options
     * @returns A new Session instance
     */
    getSession(uri: string, options: DriverOptions = {}): Session {
        let host = 'localhost';
        let port = 8099;
        let useSSL = false;

        // Simple URI parsing
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
