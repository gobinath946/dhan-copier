const crypto = require('crypto');
const env = require('../config/env');

// AES-256-GCM encryption for Dhan access tokens at rest in MongoDB.
// Format stored: <iv-hex>:<authTag-hex>:<ciphertext-hex>
const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recommended

function getKey() {
  return Buffer.from(env.encryptionKey, 'hex'); // 32 bytes
}

function encrypt(plainText) {
  if (typeof plainText !== 'string' || plainText.length === 0) {
    throw new Error('encrypt() requires a non-empty string');
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(payload) {
  if (typeof payload !== 'string') throw new Error('decrypt() requires a string');
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Malformed encrypted payload');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

function last4(str) {
  if (!str || str.length < 4) return '****';
  return str.slice(-4);
}

module.exports = { encrypt, decrypt, last4 };
