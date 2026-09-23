#!/usr/bin/env node
/* Make two pg_dump outputs of the same database comparable.
 *
 *   pg_dump --schema-only ... | node scripts/migrate/pgdump-normalise.mjs > schema.src
 *
 * A modern pg_dump wraps a plain-text dump in psql meta-commands:
 *
 *   \restrict   XOhJc7aw0DOu6UCfaAWW8oE9OJd9i3qDl8P6pyjqaTKtIV67i0Dv5tQhCY7g1L0
 *   \unrestrict XOhJc7aw0DOu6UCfaAWW8oE9OJd9i3qDl8P6pyjqaTKtIV67i0Dv5tQhCY7g1L0
 *
 * so that nothing inside the dump can be read back as a meta-command. The
 * token is RANDOM PER INVOCATION, which is the point of it -- a predictable
 * token could be closed by the dump's own contents. Two dumps of one database
 * therefore differ on those lines every time, and the restore drill's textual
 * schema comparison reported a mismatch that was not one.
 *
 * It failed only on CI. pg_dump 14 emits no wrapper at all, so the drill
 * passed on a laptop and failed on a runner from the same commit -- the same
 * shape as the G11 capture defect: an instrument whose answer depended on
 * where it ran.
 *
 * WHAT THIS IS NOT ALLOWED TO DO is hide a real difference, and the line is
 * KEPT and its token REPLACED for exactly that reason. Delete the lines and a
 * dump carrying the wrapper compares equal to one without it -- two different
 * pg_dump versions across the two sides of the drill, which is a thing the
 * drill should surface rather than swallow. Anchored at the start of the line
 * and requiring the whole rest of the line to be one base64-ish token, so a
 * column named `restrict_days` and a comment mentioning the word are
 * untouched; a dump is the one place a filter that guesses is unrecoverable.
 *
 * The count goes to stderr so the drill can say the comparison was over
 * normalised text. A silent normalisation is a comparison whose subject
 * nobody can see. Proved by backend/api/src/__tests__/pgdump-nonce.test.ts.
 */
const NONCE = /^(\\(?:un)?restrict) [A-Za-z0-9+/=_-]+$/;
const PLACEHOLDER = "<nonce normalised by scripts/migrate/pgdump-normalise.mjs>";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  let n = 0;
  /* Split on \n and rejoin, so a dump with no trailing newline keeps not
     having one: this filter sits between pg_dump and a byte comparison, and
     adding a byte of its own would be the filter failing its own purpose. */
  const out = input.split("\n").map((line) => {
    const m = NONCE.exec(line);
    if (!m) return line;
    n += 1;
    return `${m[1]} ${PLACEHOLDER}`;
  }).join("\n");
  process.stderr.write(`${n}\n`);
  process.stdout.write(out);
});
