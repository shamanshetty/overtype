import assert from "node:assert/strict";
import { reviewHunks, previewAccepted } from "../src/review";
const a = "a\r\nx\r\nb\r\ny\r\nc";
const b = "1\nkeep\n2\n";
const first = reviewHunks(a, "A\nx\nB\ny\nC");
const second = reviewHunks(b, "one\nkeep\ntwo\n");
assert.equal(first.length + second.length, 5);
assert.equal(previewAccepted(a, [first[0], first[2]]), "A\r\nx\r\nb\r\ny\r\nC");
assert.equal(previewAccepted(b, [second[1]]), "1\nkeep\ntwo\n");
for (const [before, after] of [["", "new\n"], ["old\n", ""], ["same", "same"]]) {
  assert.equal(previewAccepted(before, reviewHunks(before, after)), after);
}
console.log("Partial acceptance, CRLF, file boundaries and empty content passed.");

import {ledger} from "../src/context";
const paths=["src/app/cli.py","tests/test_cli.py","docs/cli.rst",...Array.from({length:1800},(_,i)=>"misc/chapter-"+i+".md")];
const rows=ledger(paths,"document a CLI command and test it",[],4000);
assert.deepEqual(new Set(rows.filter(r=>r.included).map(r=>r.path)),new Set(paths.slice(0,3)));
for(const budget of [1,8,20,100]){
 const small=ledger(paths,"CLI chapter",[],budget);
 assert.ok(small.filter(r=>r.included).reduce((sum,r)=>sum+r.cost,0)<=budget);
}
console.log("Context ranking and path-budget tests passed.");
