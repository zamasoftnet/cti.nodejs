/**
 * Copper PDF CTI Driver for Node.js
 * 
 * This module provides the main entry point for the copper-cti package.
 */

export { Driver, DriverOptions } from './driver';
export { Session, SessionOptions, Resource, IllegalStateError, MessageCallback, ProgressCallback, ResolverCallback, ResourceOptions, TranscodeOptions } from './session';
export { StreamBuilder, FileBuilder, NullBuilder, Builder, FinishCallback } from './builder';
export { SingleResult, DirectoryResults, Results, ResultOptions, ResultFinishCallback } from './results';
export { MSG, PacketParser, Packet } from './ctip2';

import { Driver, DriverOptions } from './driver';
import { Session } from './session';

/** Get a new Driver instance */
export function get_driver(): Driver {
    return new Driver();
}

/** Create a session to a Copper PDF server */
export function get_session(uri: string, options: DriverOptions = {}): Session {
    return new Driver().getSession(uri, options);
}
