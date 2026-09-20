/* Relay keygen — generate an Ed25519 keypair for signing/verifying cross-gap packages.
 * The private key signs on the SOURCE console; the public key verifies on the DESTINATION console.
 * In a true two-console deploy: put RELAY_SIGNING_KEY on the exporting side, RELAY_VERIFY_KEY on the
 * importing side (they can also both hold both for bidirectional relay). Keys are base64 DER.
 * Run: node scripts/relay-keygen.cjs */
const { generateKeyPairSync } = require('crypto');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
console.log('# Ed25519 relay keypair — add to the environment (never commit).');
console.log('RELAY_SIGNING_KEY=' + priv);
console.log('RELAY_VERIFY_KEY=' + pub);
