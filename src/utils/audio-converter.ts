import ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { PassThrough } from 'stream';
import { Readable } from 'stream';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export async function transcodeToOggOpus(inputBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const inputStream = new Readable();
    inputStream.push(inputBuffer);
    inputStream.push(null);

    const outputStream = new PassThrough();
    const chunks: Buffer[] = [];

    outputStream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    outputStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    outputStream.on('error', (err: Error) => {
      reject(err);
    });

    ffmpeg(inputStream)
      .inputFormat('webm') // Chrome uses webm for MediaRecorder
      .audioCodec('libopus')
      .format('ogg')
      .on('error', (err: Error) => {
        reject(err);
      })
      .pipe(outputStream, { end: true });
  });
}
