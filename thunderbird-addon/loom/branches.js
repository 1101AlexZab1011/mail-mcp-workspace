// Which branch each commit of Loom's graph is on (pure, so it can be tested without the add-on).

const MAINLINE = new Set(["main", "master", "trunk", "develop"]);
const mergedName = (subject) => /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject)?.[1] ?? /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(subject)?.[1] ?? null;

/**
 * The branch each commit is on, as sha → name. A branch's name runs down its first-parent chain from
 * its head; where chains meet, the stronger claim wins: main/master (history a feature shares with
 * it is main's), then the checked-out branch, then other local branches, then remote ones. A merged branch whose ref is gone takes its name from
 * the merge's message ("Merge branch 'x'"). Commits come newest first, so every child has spoken
 * before its parent is decided.
 */
export function branchesOf(commits, head) {
  const best = new Map(); // sha → { name, rank }
  const claim = (sha, name, rank) => {
    if (!sha || !name) return;
    const known = best.get(sha);
    if (!known || rank < known.rank) best.set(sha, { name, rank });
  };
  for (const commit of commits) {
    for (const ref of commit.refs) {
      if (ref.kind === "branch") claim(commit.sha, ref.name, MAINLINE.has(ref.name) ? 0 : ref.name === head ? 1 : 2);
      if (ref.kind === "remote") claim(commit.sha, ref.name, MAINLINE.has(ref.name.split("/").slice(1).join("/")) ? 0.5 : 3);
    }
    const own = best.get(commit.sha);
    if (own) claim(commit.parents[0], own.name, own.rank);
    const merged = commit.parents.length > 1 ? mergedName(commit.subject) : null;
    for (const parent of commit.parents.slice(1)) claim(parent, merged, 4);
  }
  return new Map([...best].map(([sha, { name }]) => [sha, name]));
}
