const ignored = new Set(
  "the a an it to as of by or in and be for that this with".split(" "),
);
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !ignored.has(w));
export function ledger(
  paths: string[],
  query: string,
  open: string[],
  budget = 4000,
) {
  const terms = new Set(words(query)),
    docs = paths.map((path) => ({ path, tokens: words(path) }));
  const freq = new Map<string, number>();
  for (const d of docs)
    for (const t of new Set(d.tokens)) freq.set(t, (freq.get(t) ?? 0) + 1);
  const avg =
    docs.reduce((a, d) => a + d.tokens.length, 0) / (docs.length || 1);
  const ranked = docs
    .map(({ path, tokens }) => {
      const reasons: string[] = [];
      let score = 0;
      for (const t of terms) {
        const count = tokens.filter(
          (w) => w === t || (w.endsWith("s") && w.slice(0, -1) === t),
        ).length;
        if (!count) continue;
        reasons.push(t);
        score +=
          (Math.log(
            1 +
              (paths.length - (freq.get(t) || 1) + 0.5) /
                ((freq.get(t) || 1) + 0.5),
          ) *
            count *
            2.2) /
          (count + 1.2 * (0.25 + (0.75 * tokens.length) / (avg || 1)));
      }
      if (open.includes(path)) {
        score += 4;
        reasons.push("open file");
      }
      if (query.includes("@" + path)) {
        score += 20;
        reasons.push("mentioned");
      }
      return {
        path,
        score,
        reasons,
        cost: Math.ceil(Buffer.byteLength(path + "\n") / 4),
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  let used = 0,
    count = 0;
  return ranked.map((row) => {
    const included = count < 24 && used + row.cost <= budget;
    if (included) {
      used += row.cost;
      count++;
    }
    return { ...row, included };
  });
}
