/**
 * Chrome Native Messaging binary protocol implementation.
 *
 * Messages are framed with a 4-byte UInt32LE length prefix followed by UTF-8 JSON.
 * @module protocol
 */

'use strict';

/**
 * Reads a single native messaging message from a readable stream.
 * @param {NodeJS.ReadableStream} stream - The input stream (typically process.stdin)
 * @returns {Promise<object>} The parsed JSON message
 */
function readMessage(stream) {
  return new Promise((resolve, reject) => {
    let lengthBuffer = Buffer.alloc(0);

    const onReadable = () => {
      // First, read the 4-byte length prefix
      if (lengthBuffer.length < 4) {
        const chunk = stream.read(4 - lengthBuffer.length);
        if (chunk === null) return;
        lengthBuffer = Buffer.concat([lengthBuffer, chunk]);
      }

      if (lengthBuffer.length < 4) return;

      const messageLength = lengthBuffer.readUInt32LE(0);

      if (messageLength === 0) {
        cleanup();
        resolve({});
        return;
      }

      if (messageLength > 1024 * 1024 * 4) {
        cleanup();
        reject(new Error(`Message too large: ${messageLength} bytes`));
        return;
      }

      const messageData = stream.read(messageLength);
      if (messageData === null) return;

      cleanup();

      try {
        const message = JSON.parse(messageData.toString('utf8'));
        resolve(message);
      } catch (err) {
        reject(new Error(`Invalid JSON in message: ${err.message}`));
      }
    };

    const onEnd = () => {
      cleanup();
      reject(new Error('Stream ended before message was complete'));
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      stream.removeListener('readable', onReadable);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };

    stream.on('readable', onReadable);
    stream.on('end', onEnd);
    stream.on('error', onError);

    // Try reading immediately in case data is already buffered
    onReadable();
  });
}

/**
 * Writes a native messaging message to a writable stream.
 * @param {NodeJS.WritableStream} stream - The output stream (typically process.stdout)
 * @param {object} message - The message object to send
 */
function writeMessage(stream, message) {
  const json = JSON.stringify(message);
  const messageBuffer = Buffer.from(json, 'utf8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(messageBuffer.length, 0);
  stream.write(lengthBuffer);
  stream.write(messageBuffer);
}

/**
 * Encodes a message into a Buffer with the native messaging protocol format.
 * @param {object} message - The message object to encode
 * @returns {Buffer} The encoded buffer with 4-byte length prefix + JSON
 */
function encodeMessage(message) {
  const json = JSON.stringify(message);
  const messageBuffer = Buffer.from(json, 'utf8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(messageBuffer.length, 0);
  return Buffer.concat([lengthBuffer, messageBuffer]);
}

/**
 * Decodes a native messaging protocol buffer into a message object.
 * @param {Buffer} buffer - The buffer to decode (must include the 4-byte length prefix)
 * @returns {object} The parsed message object
 */
function decodeMessage(buffer) {
  if (buffer.length < 4) {
    throw new Error('Buffer too small to contain a message');
  }
  const messageLength = buffer.readUInt32LE(0);
  if (buffer.length < 4 + messageLength) {
    throw new Error(`Buffer too small: expected ${4 + messageLength} bytes, got ${buffer.length}`);
  }
  const json = buffer.slice(4, 4 + messageLength).toString('utf8');
  return JSON.parse(json);
}

module.exports = { readMessage, writeMessage, encodeMessage, decodeMessage };
