import assert from "node:assert/strict";
import test from "node:test";
import { branchesOf } from "../thunderbird-addon/loom/branches.js";

const commit = (sha, parents, refs = [], subject = sha) => ({ sha, parents, refs, subject });
const branch = (name) => ({ kind: "branch", name });

test("each commit is named for the branch whose first-parent line it is on", () => {
  // Newest first:   F2 (feature) ─ F1 ─┐
  //                 M3 (main) ─ merge of 'old' ─ M2 ─ M1
  //                                    └ O1 (merged branch, its ref deleted) ─┘
  const commits = [
    commit("F2", ["F1"], [branch("fix/login")]),
    commit("M3", ["MM"], [branch("main"), { kind: "remote", name: "origin/main" }]),
    commit("F1", ["M2"]),
    commit("MM", ["M2", "O1"], [], "Merge branch 'old-idea' into main"),
    commit("O1", ["M1"]),
    commit("M2", ["M1"], [branch("stale")]),
    commit("M1", []),
  ];
  const names = branchesOf(commits, "main");
  assert.deepEqual(Object.fromEntries(names), {
    F2: "fix/login", F1: "fix/login",
    M3: "main", MM: "main", M2: "main", M1: "main", // main outranks the feature that branched off it and a stale ref on its history
    O1: "old-idea", // named by the merge's message
  });
  assert.equal(branchesOf(commits, "fix/login").get("M2"), "main", "main's own line stays main whoever is checked out");
  assert.equal(branchesOf([commit("A", [], [{ kind: "remote", name: "origin/topic" }])], null).get("A"), "origin/topic");
});
