# v4 Simplified Controller Design

## Goal

Test a middle architecture between an LLM-only Otago prompt and the v3 function-per-state machine. GPT Realtime 2.1 owns conversational interpretation and delivery. Local code owns only facts that must be exact, persistent, inspectable, or safety-enforced.

## Responsibility split

```text
GPT Realtime 2.1
  - understands speech and user intent
  - combines speech, motion labels, and still-image evidence
  - chooses how to explain, clarify, correct, encourage, or pause
  - submits one semantic session event

Compact local controller
  - stores phase/mode and three queue indices
  - validates event legality
  - preserves PT dose, support, side, and set order
  - locks the run after safety stop
  - computes weekly count effects and persists logs
```

## Cursor

```json
{
  "phase": "exercise",
  "mode": "active_set",
  "warm_up_index": 6,
  "exercise_index": 0,
  "set_index": 0,
  "observed_count": 4,
  "stop_reason": null
}
```

The UI still receives familiar state names (`exercise_intro`, `set_readiness`, `active_set`, and `rest`), derived from this cursor. They are not separate function implementations. `set_readiness` is a static pre-exercise gate; routine movement correction stays inside `active_set`.

## Four function families

1. `submit_session_event`: all ordinary progress, including readiness, warm-up result, prepare/skip, set-readiness result, motion observation, set completion, rest choice, early end, and explicit new-run request.
2. `capture_vision_snapshot`: evidence only; never changes the cursor.
3. `report_safety_stop`: cross-cutting, immediately locks the run in `stop_session`.
4. `finalize_session`: available only in review/stopped mode; records disposition and completes the run.

The controller rejects an event that is incompatible with the current task card. For example, `set_completed` is invalid during greeting, and ordinary exercise events are invalid after a safety stop.

## Prompt/context strategy

Each session update contains:

```text
compact invariant global rules
+ one generic controller contract
+ week-specific brevity line
+ current task card JSON
+ current action's common/specific Otago rules (only during action phases)
```

It never injects the complete action pool. Conversation history uses Realtime retention-ratio truncation, while the cursor remains outside the model context.

## Why this is a useful research baseline

Compared with v3, v4 tests whether stronger Realtime instruction following can absorb conversational routing without surrendering program integrity. Compare the two architectures on cursor accuracy, illegal transitions, prescription deviations, interruption recovery, safety compliance, wake-up utterances, tokens per response, latency, and perceived naturalness.
