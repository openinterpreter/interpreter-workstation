import convert from 'heic-convert';
import { readFile } from 'fs/promises';

export async function convertHeicToJpeg(filePath: string): Promise<Buffer> {
  const inputBuffer = await readFile(filePath);
  const outputBuffer = await convert({
    buffer: inputBuffer as unknown as ArrayBufferLike,
    format: 'JPEG',
    quality: 0.9,
  });
  return Buffer.from(outputBuffer);
}

export async function convertHeicToPng(filePath: string): Promise<Buffer> {
  const inputBuffer = await readFile(filePath);
  const outputBuffer = await convert({
    buffer: inputBuffer as unknown as ArrayBufferLike,
    format: 'PNG',
  });
  return Buffer.from(outputBuffer);
}
