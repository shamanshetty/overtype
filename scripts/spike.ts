import { runSpike } from "../src/spike";
runSpike(console.log).catch(error => { console.error(error.message); process.exitCode = 1; });
