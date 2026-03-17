# Real-Time Intake Whisper Assistant — Architecture Plan

## Architecture Principle

The heart of this product is **not STT**.  
The heart of this product is the **intake intelligence layer**.

Audio input and transcription are only the **input layer**.

## End-to-End Flow

### A. Audio Input Layer

The system should ingest a **live conversation flow** in the most phone-like way possible.

Preferred prototype directions:

- live conversation audio
- browser/system audio
- meeting audio
- real-time or near-real-time speech input

A future phone / VoIP integration should remain possible, but does not need to be built first.

## B. Live Transcription Layer

The audio stream should be turned into text with low enough latency for live guidance.

This layer is responsible for:

- live transcript generation
- utterance segmentation
- optionally speaker-related metadata if available

This layer is **not** the main product value.

## C. Conversation State Layer

Every new utterance should update a structured conversation state.

The system should maintain state for:

- recent transcript context
- customer signals
- intake field coverage
- missing fields
- unclear fields
- next analysis context
- whisper guidance context

This layer is essential because the system should reason about the **state of the conversation**, not just the latest sentence.

## D. Intake Intelligence Layer

This is the core of the product.

For each new turn, the system should perform:

### 1. Customer Signal Extraction

Examples:

- budget sensitivity
- urgency
- hesitation
- comparing providers/options
- unclear eligibility
- decision-maker uncertainty

### 2. Intake Field Extraction

Map the conversation to a defined checklist of required intake fields.

### 3. Intake Checklist Validation

Determine which fields are:

- answered
- partial
- missing
- unknown

### 4. Missing Question Detection

Detect which important questions have not yet been asked or answered clearly.

### 5. Next-Best-Question Generation

Suggest the most useful 1–3 follow-up questions.

### 6. Whisper Guidance Generation

Produce a short note to guide the intake agent live.

## E. UI / Whisper Layer

The UI should present **guidance**, not just transcript.

Primary UI panels should focus on:

- Customer Signals
- Covered Fields
- Missing / Unclear Fields
- Next Best Questions
- Whisper Note

Transcript can be included as a supporting panel, but it should not dominate the product.

---

## Intake Schema

The system should be designed around an intake schema.  
Example fields:

- customer_goal
- urgency
- budget
- current_status
- prior_attempts
- main_constraint
- decision_maker
- timeline
- eligibility_risk
- next_step_readiness

Each field should have a status such as:

- answered
- partial
- missing
- unknown

## Example Structured Output

A representative output shape could look like this:

```json
{
  "customer_signals": ["price_sensitive", "first_time_researcher"],
  "covered_fields": ["customer_goal", "prior_attempts"],
  "missing_fields": ["budget", "timeline", "decision_maker"],
  "next_questions": [
    "What budget range are you comfortable with for this process?",
    "When would you ideally like to start?",
    "Will you be making this decision on your own?"
  ],
  "whisper_note": "Budget and decision-maker information are still missing."
}
```
