#!/usr/bin/env node
// Stands in for `claude -p` in tests: reads the prompt, answers like the CLI does.
let prompt = "";
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  if (prompt.startsWith("Command: ")) {
    // Slide text rewrite: answer with the text in capitals, so tests can see it went through.
    const text = prompt.split("TEXT:\n")[1] ?? "";
    process.stdout.write(JSON.stringify({ type: "result", is_error: false, duration_ms: 300, result: "", structured_output: { text: text.toUpperCase() } }));
    return;
  }
  const passage = prompt.split("PASSAGE TO REVIEW:\n")[1]?.split("\n\nCONTEXT AFTER")[0] ?? "";
  const good = /hexagonal lattice/.test(passage);
  const structured_output = good ? { verdict: "good", summary: "Clear and correct.", comments: [] } : {
    verdict: "needs-work",
    summary: "One grammar slip and a factual error.",
    comments: [
      { quote: "cells fires", kind: "error", comment: "Plural subject: fire.", replacement: "cells fire" },
      { quote: "frontal  lobe", kind: "correction", comment: "The MEC is in the temporal lobe.", replacement: "temporal lobe" },
      { quote: "not in the passage", kind: "style", comment: "dropped" },
      { quote: "therefore", kind: "sense", comment: "This does not follow." },
    ],
  };
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, duration_ms: 1200, total_cost_usd: 0.01, result: "", structured_output, args: process.argv.slice(2) }));
});
