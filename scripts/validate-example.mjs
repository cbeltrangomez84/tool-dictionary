/**
 * Proves the JSON Schema and the worked example in spec/ agree.
 *
 * This only checks structure. The cross-reference rules in spec section 17.1
 * (paths resolve, relation targets exist, placeholders name real inputs) are the
 * validator's job in the reference service, not JSON Schema's.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const schema = JSON.parse(readFileSync(new URL('../spec/schema/dictionary.schema.json', import.meta.url), 'utf8'));

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

// Every dictionary this repository ships as an artifact, not just the showcase:
// the conformance fixture is the input of the vectors in conformance/text.
const documents = ['../spec/examples/crypto-data.dictionary.json', '../spec/examples/city-weather.dictionary.json', '../spec/examples/pool-scout/pool-scout.dictionary.json', '../conformance/fixtures/vectors.dictionary.json'];

let failed = false;
for (const relative of documents) {
  const doc = JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
  if (validate(doc)) {
    console.log(`ok: ${doc.id} v${doc.version} — ${doc.entries.length} entries valid against Tool Dictionary ${doc.toolDictionary}`);
  } else {
    console.error(`${relative}:`);
    console.error(JSON.stringify(validate.errors, null, 2));
    failed = true;
  }
}
if (failed) process.exit(1);
