# JEV Fast Agent benchmark

This is an executable **offline control-flow and accounting benchmark**. It
cannot establish model quality, real browser reliability, inference latency,
token cost, or speedup over an outer agent. No API, bridge server, browser,
credentials, or additional dependency is needed.

The fixture is `test/fixtures/fast-agent.html`. It contains the task descriptions
and a small manual demonstration. The harness reads those descriptions and
simulates a structured bridge. It does not render the HTML, execute its script,
or exercise the extension DOM implementation. The DOM and extension tests cover
that boundary separately; a real signed-in Chrome run remains a separate check.

## Run

```sh
node scripts/benchmark-fast-agent.mjs --iterations 5
node scripts/benchmark-fast-agent.mjs --iterations 3 --task stale-once
node scripts/benchmark-fast-agent.mjs --iterations 5 > /tmp/beat-browser-benchmark.json
node --test test/fast-benchmark.test.js
```

Output goes to stdout by default. The harness never creates a result file in the
repository. Iterations are bounded to 1 through 100. Each mode receives fresh
fixture state for every task and iteration. The clock starts immediately before
task execution and stops after the terminal result and local verification.
Mock setup and result aggregation are outside that timing boundary.

## Compared modes

| Mode | Execution | What the comparison measures |
| --- | --- | --- |
| A | A scripted outer decision loop with ordinary snapshot/action/verification-shaped mock MCP calls | A documented baseline schedule and its accounting; no actual outer LLM is used |
| B | The actual `runTask` runner with an injected mock adapter and typed mock Decisions client | Fast runner behavior under deterministic observations, decisions, and failures |
| C | The same fast runner, followed by a scripted outer escalation for a low-confidence safe task | Delegation and continuation overhead; sensitive tasks remain blocked |

The mock Decisions client returns valid choice heads for the current legal
choice IDs. The low-confidence task deliberately returns a valid but uncertain
decision. It never substitutes arbitrary action code or sends a network request.
Mode A is deliberately a declared scripted schedule, not a measured commercial
model or proof that all ordinary MCP agents make that number of calls.

Every offline record has `evidenceMode: "offline-mock"`. Its latency is local
JavaScript/control-flow overhead, not representative model latency. Its model
calls count calls to a mock decision function. Input tokens are `null`; no
fabricated tokenizer estimate, unit price, or dollar saving is reported.

## Tasks and interpretation

The suite covers opening details, exact supplied input, a native select, one
stale decision before dispatch, sensitive-send escalation, simulated domain
drift, no effect after a click, low confidence, and DONE without assertions.
The mock bridge injects domain drift by changing an in-memory URL; it never
contacts the example hostnames.

`taskSuccess` records whether the fixture objective was reached, independently
of the runner's completion claim. `verified` records a successful deterministic
caller assertion. A safe block can match the expected outcome while still
counting as an unsuccessful task. `unverified` means a completion candidate
without verified assertions. Therefore expected-outcome match rate is **not**
the task completion rate, and `taskSuccess` can be true while `verified` is false.

Summaries are separated by evidence mode and execution mode. They include:

- Task, verified, blocked, unverified, and expected-outcome match rates.
- Median and p95 end-to-end latency. Median averages the middle pair for an even
  sample count; p95 uses the nearest-rank `ceil(0.95 * n)` observation.
- Model calls, protocol calls, dispatched browser actions, stale decisions,
  retries, and safety escalations.
- Input token coverage, known token total, and aggregate token total. The last
  remains `null` whenever any record has unknown usage.

Protocol calls count mocked adapter calls representing open, observe, execute,
status, and verify. Retries count a fresh decision after an explicitly stale
pre-dispatch failure; no action is replayed. Safety escalations count a blocked
executor stage, including low confidence, no effect, domains and sensitive
operations; they do not all imply a dangerous action was proposed. A later
successful hybrid continuation retains the initial escalation count. They do
not mean a human approved an action. The baseline and hybrid follow these same
safety constraints.

## Import externally collected runs

```sh
node scripts/benchmark-fast-agent.mjs --input-records /absolute/path/real-runs.json
```

The importer performs local JSON/schema validation and aggregation only. It
does not contact a provider or independently verify the collector's claims.
Imported records must explicitly declare `live-external` provenance. A file can
contain multiple tasks and modes. Evidence modes are never pooled together.
The file has this shape. The numbers below illustrate the schema only; they are
not measured results. Replace them with collected values before importing:

```json
{
  "schemaVersion": 1,
  "records": [{
    "schemaVersion": 1,
    "evidenceMode": "live-external",
    "mode": "A",
    "taskId": "search-task",
    "iteration": 1,
    "outcome": "completed",
    "taskSuccess": true,
    "verified": true,
    "blocked": false,
    "unverified": false,
    "escalated": false,
    "expectedOutcomeMatched": null,
    "blockedReason": null,
    "latencyMs": 12000,
    "modelCalls": 3,
    "inputTokens": null,
    "retries": 0,
    "staleDecisions": 0,
    "safetyEscalations": 0,
    "protocolCalls": 8,
    "browserActions": 2,
    "measurement": {
      "latency": "external-wall-clock",
      "model": "external-model-logs",
      "browser": "external-protocol-logs",
      "tokens": "unavailable",
      "modelLatencyRepresentative": true
    }
  }]
}
```

With provider-reported usage, set `inputTokens` to its nonnegative integer count
and `measurement.tokens` to `provider-reported`. Otherwise both stay as shown.
Allowed outcomes are `completed`, `blocked`, `completion_candidate`, `error`,
`timeout`, and `aborted`. Completed records must have verified assertions;
unverified model completion uses `completion_candidate`. Use distinct iteration
numbers for repeats of the same evidence mode, execution mode, and task ID.
The importer rejects duplicate trial identities, contradictory outcome flags,
missing usage/provenance fields, negative counters, and non-finite timings.

For a real comparison, separately authorize provider usage and browser access,
pin the browser/extension revision and task set, reset equivalent page state,
use the same goals, inputs, assertions and allowed domains, randomize A/B/C run
order, and collect enough matched repetitions. Start before initial navigation
and finish after deterministic verification for all modes. Include every
attempt, timeout, block, escalation and unverified result; retain externally
auditable logs without secrets or page bodies. Record provider-reported tokens
where available and leave unknown usage as `null`.

Hybrid totals must include both fast and outer calls and the full wall clock.
Report task-level distributions alongside aggregate rates so a different task
mix cannot create a misleading speedup. Do not derive a production claim from
this offline harness or from another project's single demonstration.
