const MAX_CONTEXT_CHARS = 320;

export function buildContinuityInstruction({ lastCoach = "", lastUser = "", state = "", reason = "" } = {}) {
  const coach = compact(lastCoach);
  const user = compact(lastUser);
  return `\n\nCONVERSATIONAL CONTINUITY (higher priority than generic transition phrasing):
- Treat this as the next turn of one continuous human conversation, not the opening of a new state.
- Continue from the meaning and wording of the immediately preceding turns below.
- Do not repeat a greeting, acknowledgement, transition phrase, exercise name, target, safety statement, or question already delivered by the coach.
- If the previous coach turn already bridges into the current task, omit another bridge and provide only the missing cue or question.
- Never say that you are recording, updating, checking, moving on, or entering a state.
- Use at most one short connective phrase, and vary it naturally.
Current controller state: ${state || "unknown"}; transition reason: ${reason || "unknown"}.
Previous coach utterance: ${coach ? JSON.stringify(coach) : "none"}.
Latest participant utterance: ${user ? JSON.stringify(user) : "none"}.`;
}

function compact(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_CONTEXT_CHARS - 1)}…`;
}
