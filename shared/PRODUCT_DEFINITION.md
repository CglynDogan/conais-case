# Real-Time Intake Whisper Assistant — Product Definition

## Project Identity

This project is a **Real-Time Intake Whisper Assistant**.

Important terminology:
In this project, **“whisper” does NOT refer to the Whisper STT model**.  
It refers to a **live whisper assistant / whisper coach** — a background assistant that listens to a live conversation and guides the intake agent in real time.

## Core Product Goal

The system should listen to a **live customer conversation** and provide **real-time whisper guidance** to the intake agent.

This is **not** primarily a transcription product.  
This is **not** an offline recording-analysis tool.  
This is **not** a hardcoded mock/demo experience.

The core value is:

- understanding the customer
- validating intake completeness
- detecting missing questions
- suggesting the next best questions
- generating live whisper guidance

## What the Product Should Do

During a live conversation, the system should continuously help answer:

- What does the customer want?
- What important information has already been collected?
- What is still missing?
- What is still unclear?
- What should the intake agent ask next?
- Are there any risk, budget, urgency, or eligibility signals?

## Primary Outputs

The system should focus on producing these outputs:

### 1. Customer Signals

Examples:

- price_sensitive
- urgent
- hesitant
- comparing_options
- unclear_eligibility
- decision_maker_unknown
- first_time_researcher

### 2. Covered Intake Fields

The fields that are already sufficiently answered.

### 3. Missing / Unclear Fields

The fields that have not been asked, or have only partial / unclear answers.

### 4. Next Best Questions

1–3 concrete follow-up questions the intake agent should ask next.

### 5. Whisper Note

A short, actionable guidance note for the intake agent.

## What the Product Should NOT Be

The system should **not** be framed as:

- a simple speech-to-text app
- a generic transcript viewer
- an offline voice recorder with post-call analysis
- a fake demo driven mainly by hardcoded mock conversation content

A transcript panel may exist, but transcript is **supporting context**, not the main value.

## Input Direction

The preferred direction is the **most phone-like / call-like live flow possible**.

Accepted directions for the prototype:

- live conversation audio
- system audio / browser tab audio / meeting audio
- live, near-real-time speech input

A future phone / VoIP integration should remain possible, but it is **not the product core**.  
The core is the **intake intelligence layer**.

## Analysis Behaviors

The core intelligence layer should perform:

- customer signal extraction
- intake field extraction
- intake checklist validation
- missing question detection
- next-best-question generation
- whisper guidance generation

## Product Example

If the customer says things like:

- “The price feels a bit high for us.”
- “We’re still comparing a few options.”
- “I’m not sure how quickly we can move.”
- “I need to discuss this with my partner.”

The system might output:

- customer_signals:
  - price_sensitive
  - comparing_options
  - decision_maker_unknown
- missing_fields:
  - timeline
  - budget
- next_questions:
  - “What budget range are you comfortable with for this process?”
  - “When would you ideally like to move forward?”
  - “Will you be making this decision on your own?”
- whisper_note:
  - “Budget and decision-making ownership are still unclear.”

## Product Priorities

When making implementation choices, prioritize:

1. live usefulness
2. intake intelligence quality
3. demo reliability
4. clarity of outputs
5. low-risk implementation

Do **not** prioritize:

- fancy architecture over working behavior
- transcription polish over intake intelligence
- hardcoded scripted demos over real input handling
- product breadth over the core whisper use case
