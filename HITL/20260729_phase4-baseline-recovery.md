# Phase 4 baseline recovery before Phase 5

Read the content of ./HITL (all the files mentioned are there)

The Phase 5 run stopped correctly after finding that the current remote baseline
passes 294 tests rather than the accepted 328-test Phase 4 suite.

Do not begin Phase 5 in this run. Do not change PID Provider behavior. Do not
lower the expected baseline count to 294.

The accepted Phase 4 deliverables are supplied alongside this prompt:

- `eudi-trusted-list-publisher-phase4-final.zip`
- `20260729T092225Z_phase4-codex-final-acceptance.md`

The accepted repository ZIP has SHA-256:

```text
c0d6e220fb198307738870a5bbbbea630eccda8f1625c81e8dc47ad559eef597
```

The accepted local Phase 4 commit was:

```text
34e56c53347f3a4ebe70115182439cee5aa7cd84
```

Its parent was `4a6ffbdd20b25d1eaf02e78a9b536290c95e4705`.
The current remote checkpoint may instead be the divergent partial commit
`49c06bb54277b9f85196051bbf5932efba2068bc`, which passes only 294 tests.

## Objective

Promote the exact accepted Phase 4 tree from the supplied ZIP onto the current
`origin/main` history as one normal recovery commit. Preserve remote history;
do not force-push, reset the remote, rewrite commits or reimplement the Phase 4
changes from memory.

## Procedure

1. Read `AGENTS.md` and the applicable repository directives completely.
2. Fetch `origin/main`, record its hash and verify the working tree is clean.
3. Verify the supplied repository ZIP SHA-256 exactly matches the value above.
4. Extract it into a temporary directory under the current workspace.
5. Compare the extracted repository tree with the current checkout.
6. Replace the tracked working-tree contents with the exact extracted tree
   while preserving the checkout's `.git` directory and remote configuration.
   Do not copy `node_modules`, caches, logs, runtime data, secrets or signing
   keys. Do not modify canonical `HITL/` assets unless the accepted ZIP itself
   differs byte-for-byte from the current checkout.
7. Prove that the resulting tracked tree is byte-for-byte equivalent to the
   supplied accepted tree. Report every intentional exclusion.
8. Confirm that `test/phase4-final-acceptance.test.ts` exists.
9. Run sequentially:

   ```bash
   npm ci
   npm run format:check
   npm run build
   npm run lint
   npm test
   git diff --check
   ```

10. The complete suite must pass exactly 328 tests. If it does not, stop and
    report the exact discrepancy without changing production code or tests.
11. Run `./run.sh`, verify `/healthz` returns HTTP 200, and stop it cleanly.
12. Inspect the complete diff. It should represent only the difference between
    the current partial checkpoint and the accepted Phase 4 tree.
13. Create one Conventional Commit on top of the fetched `origin/main`, for
    example:

    ```text
    test(phase4): restore accepted cumulative baseline
    ```

14. Push normally to `origin/main`; never force-push.
15. Fetch again and prove local `HEAD` equals `origin/main`.
16. Finish with:

    ```bash
    git status --short
    git log -3 --oneline
    git rev-parse HEAD
    git rev-parse origin/main
    ```

## Handoff

Write a new ignored BARIO handoff recording:

- the initial remote hash and 294-test mismatch;
- the supplied ZIP hash;
- the accepted Phase 4 commit identity;
- the exact tree differences promoted;
- all validation results and the 328-test count;
- the recovery commit and push evidence;
- any discrepancy or omission.

Prove the handoff is ignored with `git check-ignore -v`.

Do not mark this recovery complete unless the working tree is clean, the full
suite passes 328/328, `/healthz` returns 200, the push is a normal push, and
local `HEAD` equals `origin/main`.

After this recovery is complete, stop. Phase 5 must be started as a separate
run using `20260729_phase5_pid-provider-vertical-slice.md`.
