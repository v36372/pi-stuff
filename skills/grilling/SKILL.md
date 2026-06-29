---
name: grilling
description: Interview the user relentlessly about a plan or design. Use when the user wants to stress-test a plan before building, or uses any 'grill' trigger phrases.
disable-model-invocation: true
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a question can be answered by exploring the codebase, explore the codebase instead.

At the end of every turn where you pose a new grilling question, you MUST call the `ask_user` tool with the question already structured for the answer UI. Do not use `/answer` or `execute_command` for grilling questions.

Call `ask_user` with exactly this shape:

```json
{
  "questions": [
    {
      "question": "The single grilling question the user should answer.",
      "context": "Optional short context containing your recommendation, relevant tradeoffs, and any constraints needed to answer without rereading the transcript."
    }
  ]
}
```

The `context` field is optional, but include it when your recommendation or the decision context affects the answer. This hands the turn back to the user so they can respond to the question. Do not end the turn any other way when a new question is on the table.
