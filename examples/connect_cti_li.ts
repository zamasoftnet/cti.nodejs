
import { Driver } from '../src/driver';
import { Session } from '../src/session';
import * as fs from 'fs';

async function main() {
    const driver = new Driver();
    const uri = 'ctip://cti.li/';

    console.log(`Connecting to ${uri}...`);

    // Attempt connection with user credentials
    const session = driver.getSession(uri, {
        user: 'user',
        password: 'kappa'
    });

    session.setMessageFunc((code, msg, args) => {
        console.log(`[Server Message] Code: ${code}, Msg: ${msg}`, args);
    });

    try {
        console.log('Connection established (TCP). Waiting for handshake...');

        // Wait a bit to ensure handshake works
        await new Promise(resolve => setTimeout(resolve, 1000));

        console.log('Attempting to start transcode for "http://example.com"...');
        try {
            // "example.com" のPDF変換を要求
            const stream = session.transcode('http://example.com');
            const outFile = 'output.pdf';
            const fileStream = fs.createWriteStream(outFile);

            let totalBytes = 0;
            stream.on('data', (chunk) => {
                totalBytes += chunk.length;
                console.log(`Received ${chunk.length} bytes. Total: ${totalBytes}`);
                fileStream.write(chunk);
            });

            stream.on('end', () => {
                console.log(`Transcoding finished. Total size: ${totalBytes} bytes.`);
                fileStream.end();
                session.close();
            });

            stream.on('error', (err) => {
                console.error('Transcoding stream error:', err);
                fileStream.end();
                session.close();
            });

            await session.waitForCompletion();
            console.log(`Saved output to ${outFile}`);

        } catch (e: any) {
            console.error('Failed to start transcoding:', e.message);
        }

    } catch (err) {
        console.error('An error occurred:', err);
    } finally {
        // session.close() is called in end/error handlers usually, 
        // but ensuring here in case of early exit.
        // If already closed, it's fine.
    }
}

main().catch(console.error);
