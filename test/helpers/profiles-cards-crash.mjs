// Disposable process owner: leave a real running journal at the metadata boundary.
import { openProfilesStore } from '../../src/profiles/store.mjs';
import { cardsFile, request, add } from './profiles-cards-fixture.mjs';

const options = JSON.parse(process.argv[2]);
const store = openProfilesStore({
  ...options,
  hooks: { beforeWrite(id) { if (id === cardsFile) process.exit(73); } },
});
const result = store.apply(request(store, [add()]));
console.error(JSON.stringify(result));
process.exit(74);
