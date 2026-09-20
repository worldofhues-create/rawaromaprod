/* Formula KEK keygen — mint a 32-byte AES-256 KEK (base64) for the OFFLINE console's
 * FORMULA_KEK_FILE. Store the file on removable / encrypted media, mounted only during unseal.
 *
 *   node scripts/formula-kek-keygen.cjs [outfile]   (prints to stdout if no outfile)
 *
 * IMPORTANT: to keep formulas that were sealed on the ONLINE console readable on the offline
 * console, do NOT generate a new key — copy the online console's existing FORMULA_KEK value into
 * the file instead: `printf '%s' "$FORMULA_KEK" > /media/keys/formula.kek`. Generate a fresh key
 * only for a console that will be the sole sealer/unsealer of its own vault. Never commit the key. */
const { randomBytes } = require('crypto');
const fs = require('fs');
const key = randomBytes(32).toString('base64'); // 32 bytes → AES-256
const out = process.argv[2];
if (out) {
  fs.writeFileSync(out, key, { mode: 0o400 });
  console.log(`wrote 32-byte KEK → ${out} (perms 0400). Put this on removable/encrypted media; set FORMULA_KEK_FILE to its path.`);
} else {
  console.log('# 32-byte AES-256 KEK (base64) for FORMULA_KEK_FILE — store on removable/encrypted media, never commit:');
  console.log(key);
}
