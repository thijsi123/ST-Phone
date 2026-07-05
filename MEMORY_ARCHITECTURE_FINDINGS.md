# ST-Phone Memory Architecture Findings

Date: 2026-07-05

## Current Prototype Snapshot

We currently have a working frontend-only prototype in:

- `public/scripts/extensions/third-party/ST-Phone/manifest.json`
- `public/scripts/extensions/third-party/ST-Phone/index.js`
- `public/scripts/extensions/third-party/ST-Phone/style.css`

This lives under `public/scripts/extensions/third-party`, which keeps it outside normal upstream SillyTavern code paths. That is important because the main SillyTavern repo should stay easy to update with regular `git pull`.

The current extension is named `ST-Phone`, but the real direction is broader: this is becoming an `ST-Memory` system where the phone is the first strong UI/workflow. The phone is not just decoration. It is the first test case for per-character memory, private communication, visibility rules, and external retrieval.

Implemented so far:

- Physical draggable phone widget with launcher, lock screen, home screen, Messages, Contacts, Settings.
- Direct message threads and basic phone group threads.
- Phone contacts generated from current chat/group characters.
- Per-message metadata for visibility, output mode, memory mode, selected viewers, and pinned memory.
- Per-message triple-dot menu with options for output mode, visibility, pinning, copying, and deleting.
- Phone-only mode, phone-plus-chat mode, and narrated mode.
- Hidden JSON parsing from AI replies using `{"phoneMessages":[...]}`.
- Optional stripping of phone JSON from visible chat output.
- Reasoning-block stripping before JSON parsing.
- Optional vector-memory indexing and retrieval for phone messages.

Default behavior is intentionally privacy-first:

- `defaultOutputMode: phone_only`
- `defaultVisibility: participants`
- `defaultMemoryMode: participants`
- `hidePhoneJson: true`
- `stripReasoning: true`

That means phone messages are meant to belong to the phone participants by default, not the whole normal chat cast.

## How We Developed The Current Phone Behavior

The first working path was simple: user sends a phone message, it is stored in the phone UI, then the target character gets a compact phone-only generation prompt. The model is asked to return only:

```json
{"phoneMessages":[{"from":"Responder Name","to":"Recipient Name or Group Title","message":"Text message body"}]}
```

That worked, but testing with a reasoning model showed an important parser problem. The model returned a reasoning prelude like:

```text
<|channel>thought
...
<channel|>{"phoneMessages":[...]}
```

So the extension now strips common reasoning wrappers before looking for JSON. Built-ins currently include:

- `<|channel>thought ... <channel|>`
- `<think>...</think>`

There is also a user-facing custom field where extra start/stop pairs can be added, one per line, for models with different reasoning tags. This exists because parsing phone JSON from reasoning text is risky: a model might brainstorm several possible valid JSON objects before the final answer. We only want the final answer region.

We also changed the phone-only response limit from a tiny value to a larger value during testing. The original 160-token cap was too brittle for reasoning models. The better solution is prompting for short messages while allowing enough output budget, currently around 1000 tokens, so the model has room to finish cleanly.

The first live test with:

```text
Thijs: hi
```

returned:

```json
{"phoneMessages":[{"from":"Dept. of Public Corrections","to":"Thijs","message":"Identify yourself and state the purpose of this communication immediately."}]}
```

That successfully appeared in the phone UI as a phone-only message and did not need to become normal chat narration.

## Implemented Fixes From Testing

### Reasoning-safe parsing

Phone JSON is parsed after stripping known reasoning blocks. This is necessary for models that expose reasoning text before their final answer. Without this, the extension could parse a draft object or fail to parse the final object.

### Contact title ambiguity

We hit a contact-list bug with names like:

- `Dept. of Public Corrections`
- `Dept. of Public Corrections - Erika`
- `Dept. of Public Corrections - Miya`

The phone chat title collapsed to the shared prefix, which made the contacts confusing. The matching logic was tightened so multi-word character names use exact normalized matching instead of first-token matching.

### Phone JSON hiding

When the normal chat contains a visible phone JSON block, the extension can strip it from the rendered message after parsing. This prevents other characters and the user-facing story text from seeing raw transport JSON.

### Per-message controls

The phone now supports message-level controls instead of only global behavior. This matters because a phone message can be private, public, shared with selected characters, pinned as memory, or deleted from the phone UI independently.

## Recent Settled Conclusions

The extension should not replace SillyTavern's native chat system. Native JSONL must remain the canonical normal chat format so users can disable or remove the extension without losing ordinary SillyTavern compatibility. If the extension is gone, the normal chat should still open and work; the extra phone/memory sidecar folders are simply ignored by SillyTavern.

The extension should add a sidecar memory layer beside the native chat, not inside it. The native chat can still contain normal visible messages, while the extension stores phone events, visibility metadata, retrieval records, graph edges, and summaries in its own extension-owned storage.

The best long-term shape is:

- Frontend extension for UI and prompt integration.
- Server plugin for durable sidecar storage, indexing, graph memory, and export/import.
- Native JSONL left untouched except for normal visible chat messages the user intentionally sends.

This is bigger than a phone extension. The phone is the first interface for a broader memory system with:

- event log memory,
- vector retrieval,
- context graph retrieval,
- per-character visibility,
- per-message memory permissions,
- phone-only and phone-plus-world output modes.

## Known Gaps After Reread

The current prototype is useful, but still not the final architecture.

Major gaps:

- No server plugin sidecar exists yet.
- Phone data currently lives in `chat_metadata`, which is convenient but not enough for a large memory system.
- Prompt injection is not truly speaker-filtered yet. A shared injected phone context can still leak too much unless we carefully filter by current speaker/participants before every generation.
- Vector memory is opt-in and prototype-level.
- Phone group chats exist at the data/UI level, but the creation and management workflow is still rough.
- Visibility and memory are not the same thing yet in implementation. A message can be visible to one set of characters but remembered by another set, and the final system must represent that explicitly.
- Built-in SillyTavern Vector Storage can retrieve relevant old chat chunks, but retrieved chunks still count against context. It does not create extra context space.
- The context graph idea is not implemented yet.
- There is no durable event folder per chat yet.

The most important unresolved design rule is:

> Every memory item needs an audience.

A phone message should not become global knowledge just because it exists. It should be retrievable only for the sender, recipients, selected visible characters, and any characters the user explicitly shares it with.

## Conversation Summary

The project started as a request to mimic the phone UI from `H:\AI\RPGraph` inside SillyTavern, while keeping `H:\AI\SillyTavern` easy to update with normal `git pull` operations. Because of that, the first constraint was: avoid editing SillyTavern core unless absolutely necessary. Use third-party extensions under:

```text
public/scripts/extensions/third-party/
```

The first implementation direction was a physical phone widget inspired by:

```text
GetfroggyHoe/universal-immersion-engine
```

We cloned and inspected that project under:

```text
C:\AI\universal-immersion-engine
```

Useful UI ideas came from its phone shell, draggable window, apps, and text-message flow. We decided not to copy its broader architecture because it is large, global, and brittle for our goal.

The first ST-Phone prototype focused on:

- a physical draggable phone widget,
- Messages, Contacts, Settings,
- direct and group phone threads,
- phone-only output,
- phone + normal chat output,
- narrated normal-chat output,
- per-message triple-dot options,
- message visibility settings,
- reasoning-block stripping for model outputs,
- and parsing `{"phoneMessages":[...]}` JSON from model replies.

During testing, a phone-only prompt against a reasoning model produced output like:

```text
<|channel>thought
...
<channel|>{"phoneMessages":[...]}
```

This showed that parsing raw JSON anywhere in the output could accidentally parse JSON inside reasoning. We added reasoning stripping for:

```text
<|channel>thought ... <channel|>
<think> ... </think>
```

and added custom start/end reasoning pairs in settings.

A separate issue appeared with contacts that share a prefix:

```text
Dept. of Public Corrections
Dept. of Public Corrections - Erika
Dept. of Public Corrections - Miya
```

The phone contact list originally collapsed these into the base name because matching was too loose. We tightened name matching so multi-word names only match exact normalized names, preventing these contacts from all opening the same thread title.

The discussion then shifted from UI to memory. The user wanted phone-only messages to be invisible from the public transcript but still remembered by the right characters. That required separating:

```text
visible in normal chat
```

from:

```text
known/remembered by a character
```

This led to the core principle:

> Phone messages do not need to be normal chat messages to become memory.

We discussed mixed timelines like:

```text
chat message
user chat message
chat message
user phone message
AI phone message
user chat message
user phone message
```

The answer was that the normal chat transcript and phone timeline should be separate but bridged by controlled prompt injection and RAG:

- normal chat remains the visible RP log,
- phone messages remain side-channel events,
- output mode decides whether a phone message is published into visible chat,
- memory mode decides who can remember it.

The user then asked what happens when the chat reaches 30k tokens but the model only supports 20k. The answer was that the full phone log cannot simply be stuffed into context. The phone system needs external memory:

- exact phone log outside the prompt,
- recent thread context,
- pinned memories,
- vector-recalled memories,
- speaker-filtered injection,
- strict prompt budget.

This led to the RAG direction. We inspected SillyTavern's Vector Storage system and confirmed it exposes endpoints:

```text
/api/vector/list
/api/vector/insert
/api/vector/delete
/api/vector/query
/api/vector/query-multi
```

The extension now has an opt-in vector phone memory mode that uses KoboldCpp embeddings through SillyTavern's existing vector API. The intended purpose is not to replace the phone log, but to recall relevant old events when a character is texted again much later in the RP.

The user compared this to systems like Neuro-sama, asking how they can remember old things without loading millions of tokens. We concluded that such systems generally use external memory, retrieval, summaries, databases, and agent-side state rather than feeding all history into the model context.

The scope then broadened again:

```text
ST-Phone
```

is no longer just a phone extension. It is becoming:

```text
ST-Memory first, ST-Phone second.
```

The phone remains the strongest first UI/use case because it naturally needs:

- private messages,
- participants,
- group threads,
- hidden events,
- message-specific visibility,
- long-term recall,
- and speaker-specific knowledge.

But the underlying system should support general memory, not only phone memory.

We inspected SillyTavern's chat storage. The user's guess was mostly right:

```text
data/default-user/chats/<character>/<chat>.jsonl
```

for character chats, and:

```text
data/default-user/group chats/<group chat>.jsonl
```

for group chats.

We confirmed that group definitions are separate:

```text
data/default-user/groups/<group id>.json
```

We also confirmed that SillyTavern saves chats as JSONL where the first line is a metadata header and subsequent lines are messages. This means `chat_metadata.st_phone` works for prototyping but is not a good long-term home for large memory logs, because the whole phone/memory state would live in the first JSONL line and be rewritten with the chat.

The user asked why not use a folder per chat. We agreed this is architecturally cleaner:

```text
chat folder/
  transcript.jsonl
  metadata.json
  phone/events.jsonl
  memory/facts.jsonl
  memory/summaries.jsonl
  indexes/
```

But changing SillyTavern's native chat format would affect core save/load/delete/rename/branch/import/export/backup logic. That is risky and unnecessary for users who do not want this extension.

So the better decision is:

> Keep SillyTavern native JSONL untouched. Build our folder-per-chat memory system beside it as an extension/plugin overlay.

The user then suggested a plugin + extension pair. We inspected SillyTavern's server plugin loader and confirmed this is possible. Server plugins live in:

```text
plugins/
```

and can register backend routes mounted under:

```text
/api/plugins/<plugin-id>
```

This solves the browser-extension limitation: a frontend-only extension cannot safely write arbitrary sidecar files under `data/default-user`, but a server plugin can expose scoped storage APIs.

The architecture is now:

```text
Frontend extension:
  public/scripts/extensions/third-party/ST-Phone/
  UI, prompt hooks, SillyTavern events, phone widget.

Server plugin:
  plugins/st-memory/
  durable sidecar files, event logs, facts, summaries, visibility graph,
  plugin-owned APIs.
```

The plugin should store files under something like:

```text
data/default-user/extensions/ST-Memory/chats/<chat-key>/
```

while SillyTavern continues to store normal chats exactly as before.

Finally, we discussed RAG storage. The conclusion was:

- `events.jsonl` and `phone-messages.jsonl` are the exact source of truth.
- `facts.jsonl` and `summaries.jsonl` are human/model-readable distilled memory.
- `rag/chunks.jsonl` stores searchable chunk text plus metadata.
- the actual vector index can initially reuse SillyTavern's Vector Storage under `data/default-user/vectors/<source>/<collection-id>/`.
- the RAG index should be disposable and rebuildable from the event/chunk logs.

The current next step is to scaffold a minimal `plugins/st-memory` server plugin with:

```text
GET  /api/plugins/st-memory/health
POST /api/plugins/st-memory/chat/open
POST /api/plugins/st-memory/events/append
POST /api/plugins/st-memory/events/query
```

Then the frontend extension can detect whether the plugin exists. If it exists, use plugin-backed sidecar memory. If not, fall back to the current `chat_metadata` prototype behavior.

## Goal

ST-Phone started as a physical phone UI for SillyTavern, but the real problem is broader: phone messages need to become character-scoped memory without always becoming visible public chat.

The desired behavior is:

- A phone-only message is not shown in normal chat unless the user asks for that output mode.
- The sender, recipient, and explicitly selected characters can still remember it.
- Group phone chats can have their own participant set.
- Old phone events can be recalled later through RAG even when the active chat is far beyond the model context window.
- Normal chat generations should be influenced only by phone memories the current speaker is allowed to know.

## Current SillyTavern Chat Storage

SillyTavern stores normal character chats as JSONL files under a per-character directory:

```text
data/default-user/chats/<character name>/<chat name>.jsonl
```

Example observed locally:

```text
data/default-user/chats/Adela/
  Adela - 2026-06-22@18h33m33s866ms.jsonl
  Adela - 2026-06-22@18h33m33s866ms - Branch #1.jsonl
```

Group chats are different. They are stored as flat JSONL files:

```text
data/default-user/group chats/<group chat id or timestamp>.jsonl
```

Group definitions are stored separately:

```text
data/default-user/groups/<group id>.json
```

Vector Storage uses separate per-source folders:

```text
data/default-user/vectors/<source>/<collection id>/
```

For KoboldCpp:

```text
data/default-user/vectors/koboldcpp/<chat collection id>/
```

## JSONL Format

SillyTavern saves chats by serializing an array to newline-delimited JSON.

The first JSONL line is a chat header:

```json
{"chat_metadata":{...},"user_name":"unused","character_name":"unused"}
```

Every later line is one chat message object.

Relevant code:

- `src/endpoints/chats.js`: `trySaveChat()` maps each chat object to `JSON.stringify(m)` and joins with `\n`.
- `public/script.js`: `saveChat()` sends `[chatHeader, ...trimmedChat]`.
- `public/script.js`: chat loading shifts the first item off as `chatHeader`, assigns `chat_metadata`, then treats the rest as messages.

## Current ST-Phone Storage

The current prototype stores phone state under:

```text
chat_metadata.st_phone
```

This includes:

- settings
- UI state
- contacts
- thread metadata
- phone message arrays
- vector-memory record metadata

This is acceptable for a prototype, but it is not ideal long-term. If the phone log grows, every normal chat save carries the whole phone state in the first JSONL line.

## Current ST-Phone RAG Behavior

ST-Phone now has an opt-in vector memory mode.

When enabled, it:

- indexes phone messages into a phone-owned vector collection
- stores nearby visible RP context around the phone message
- queries phone vector memory during phone-only replies
- optionally queries the current chat vector collection
- filters phone vector records by message visibility before injecting them

This is still early. It helps phone-only replies, but normal chat injection still needs better speaker filtering.

## Why JSONL Alone Is Not Enough

JSONL is good for:

- human-readable transcript storage
- compatibility with SillyTavern
- backups and exports
- simple append-like log semantics

JSONL is bad for:

- fast per-character memory lookup
- visibility-filtered retrieval
- side-channel memories such as phone messages
- per-message sidecar data
- long-running chats with large private memory logs
- updating a single auxiliary memory without rewriting the chat file

SillyTavern also currently saves by rewriting the whole JSONL file, not by appending one message to an indexed database.

## Folder Per Chat

A folder per chat would be a cleaner long-term structure:

```text
chats/<character>/<chat id>/
  transcript.jsonl
  metadata.json
  phone/events.jsonl
  phone/threads.json
  memory/facts.jsonl
  memory/summaries.jsonl
  attachments/
  indexes/
```

For group chats:

```text
group chats/<group chat id>/
  transcript.jsonl
  metadata.json
  phone/events.jsonl
  memory/facts.jsonl
  indexes/
```

Benefits:

- Each chat can own many related files.
- Extensions can add files without inflating the JSONL header.
- Phone logs, summaries, and indexes can be updated independently.
- Backups can copy one folder.
- Migration to richer memory is easier.

Costs:

- It is a SillyTavern core storage migration.
- Existing import/export, rename, delete, branch, backup, and group chat code expects `.jsonl` files.
- Third-party extensions should avoid requiring this change if the goal is to keep upstream pulls easy.

## Safer Extension-Level Alternative

Do not replace SillyTavern's JSONL storage yet.

Instead, use a sidecar namespace that is keyed by current chat id:

```text
data/default-user/extensions/ST-Phone/chats/<safe chat key>/
  phone-events.jsonl
  phone-threads.json
  memory-facts.jsonl
  memory-summaries.jsonl
```

Keep only lightweight pointers in `chat_metadata.st_phone`, such as:

```json
{
  "storageVersion": 1,
  "sidecarKey": "st-phone-chat-key",
  "settings": {},
  "ui": {}
}
```

This would give most of the folder-per-chat benefits without changing SillyTavern core.

The blocker is that a browser-only third-party extension cannot freely write arbitrary server-side files. It can use existing API endpoints and Vector Storage endpoints, but a robust sidecar file store probably needs either:

- a small backend endpoint in SillyTavern core,
- an extension API that permits scoped data files,
- or a plugin/server component.

Targeted search did not find an existing general-purpose per-chat extension data endpoint. Current extension endpoints mostly manage extension install/delete/update/list behavior. Existing data endpoints are specialized for chats, assets, files, presets, settings, secrets, vectors, world info, and similar first-party domains.

This means the short-term implementation should continue using:

- `chat_metadata.st_phone` for exact prototype state,
- `/api/vector/*` for searchable memory indexes,
- and a future explicit storage endpoint or plugin component for durable sidecar phone logs.

## Plugin + Extension Architecture

SillyTavern has a server plugin loader in `src/plugin-loader.js`.

Server plugins live under:

```text
plugins/<plugin name>/
```

A plugin can be:

- an npm package with `package.json` and a `main` entry,
- or a module file such as `index.js`, `index.cjs`, or `index.mjs`.

The plugin module must expose:

- `info.id`
- `info.name`
- `info.description`
- `init(router)`

The loader gives the plugin an Express router and mounts it at:

```text
/api/plugins/<plugin id>
```

Plugin ids must match:

```text
^[a-z0-9_-]+$
```

This is the clean path for ST-Phone/ST-Memory:

```text
Frontend extension:
  public/scripts/extensions/third-party/ST-Phone/
  UI, prompt hooks, SillyTavern event integration.

Server plugin:
  plugins/st-memory/
  Durable sidecar files, memory event log, summaries, visibility index,
  plugin-owned API routes.
```

This keeps SillyTavern's native JSONL chat system untouched while allowing the extension to maintain a richer per-chat folder structure.

Important deployment note:

```text
enableServerPlugins: false
```

is the upstream default in `default/config.yaml`. The local `config.yaml` currently has:

```text
enableServerPlugins: true
```

So plugin development is available locally, but distribution needs clear setup instructions.

Proposed plugin storage layout:

```text
data/default-user/extensions/ST-Memory/chats/<chat-key>/
  manifest.json
  events.jsonl
  phone-messages.jsonl
  facts.jsonl
  summaries.jsonl
  visibility.json
  indexes.json
```

Expanded RAG-oriented layout:

```text
data/default-user/extensions/ST-Memory/chats/<chat-key>/
  manifest.json
  events.jsonl
  phone-messages.jsonl
  facts.jsonl
  summaries.jsonl
  visibility.json

  rag/
    chunks.jsonl
    retrieval-log.jsonl
    indexes.json
```

The plugin sidecar should keep the human-readable/source metadata. The actual vector index can initially stay in SillyTavern's built-in vector storage:

```text
data/default-user/vectors/<source>/<collection-id>/
```

This avoids building and maintaining a separate vector database before we need one.

Proposed plugin API:

```text
GET  /api/plugins/st-memory/health
POST /api/plugins/st-memory/chat/open
POST /api/plugins/st-memory/events/append
POST /api/plugins/st-memory/events/query
POST /api/plugins/st-memory/facts/upsert
POST /api/plugins/st-memory/facts/query
POST /api/plugins/st-memory/visibility/update
POST /api/plugins/st-memory/export
```

The frontend extension should call these routes and fall back to `chat_metadata` if the plugin is not installed or server plugins are disabled.

## RAG Pipeline

RAG should not replace the exact event log. It is a retrieval layer built from the event log.

Pipeline:

```text
1. Capture event
   Example: Thijs texted Erika: "hi".

2. Attach metadata
   source=phone
   thread id
   sender
   recipients
   visibility
   timestamp
   chat message index
   nearby RP message indexes

3. Create searchable chunk
   Example:
   "Phone message in Dept. thread: Thijs -> Erika: hi.
    Nearby RP: officers stopped Thijs during curfew."

4. Store chunk metadata
   Append to rag/chunks.jsonl with chunk id, event id, visibility, text,
   source pointers, and vector collection id.

5. Embed chunk
   Send chunk text to the selected embedding provider, likely KoboldCpp first.
   Store the vector in SillyTavern Vector Storage under a plugin-owned collection id.

6. Query later
   Build a search query from current speaker, current draft/reply context,
   current phone thread, and recent visible RP context.

7. Retrieve candidates
   Query vector storage for similar chunks.

8. Filter
   Remove memories the current speaker is not allowed to know.

9. Rank and budget
   Prefer recent, pinned, high-score, and speaker-relevant memories.
   Cap total injected memory by a small character/token budget.

10. Inject
   Add a compact memory block to the prompt.
```

The source of truth remains:

```text
events.jsonl
phone-messages.jsonl
facts.jsonl
summaries.jsonl
```

The RAG index is disposable and rebuildable from those files.

## Built-In Vector Storage Behavior

Plain English summary:

SillyTavern's built-in Vector Storage does not magically expand the model's context window.

It works more like this:

```text
1. Remember old chat messages in a searchable outside index.
2. Before a new reply, search that outside index for a few relevant old messages.
3. Copy those relevant old messages back into the prompt.
4. If the prompt is too big, SillyTavern drops other older prompt content until it fits.
```

So yes, Vector Storage can fetch messages from outside the normal recent chat slice. But once it fetches them, they still become normal prompt text. They still cost tokens.

If the model has a 20k context limit and the chat has 30k tokens:

```text
SillyTavern cannot send all 30k.
```

Vector Storage helps by saying:

```text
Do not send all old history.
Send recent chat plus a few relevant old memories.
```

But the final prompt still has to fit inside 20k.

What gets squeezed out?

SillyTavern builds the prompt with character/scenario data, extension prompts, examples, world info, recent chat, etc. If the final prompt is too large, it removes lower-priority/older material, especially older chat messages and examples, until the prompt fits.

Important detail:

Vector Storage may remove a retrieved old message from the generation-time chat array and reinsert it as a vector memory block. This prevents duplicate text in the same prompt. It does not delete the saved chat.

Relevant local code:

- `public/scripts/extensions/vectors/index.js`: `synchronizeChat()` indexes chat messages.
- `public/scripts/extensions/vectors/index.js`: `rearrangeChat()` queries relevant old messages and injects them with `setExtensionPrompt()`.
- `public/scripts/extensions/vectors/index.js`: `getQueryText()` builds the search query from the latest messages.
- `public/script.js`: prompt assembly trims examples and old chat messages when the prompt exceeds context.

Implication for ST-Memory:

Built-in vectors are useful, but they are not enough by themselves. ST-Memory needs a stricter prompt budget and better filtering:

```text
current speaker
  -> allowed memories only
  -> graph facts for visibility/who-knows-what
  -> vector recall for relevant old scenes/messages
  -> compact summaries/facts
  -> final memory block small enough to fit
```

The goal is not to retrieve lots of text. The goal is to retrieve the smallest useful memory.

## SillyTavern Message Pipeline With Vector Storage

This section describes the normal generation path in simple terms.

### 1. User presses Send

The frontend enters `Generate('normal')`.

Before doing the model request, SillyTavern:

- checks slash commands,
- emits generation events,
- clears the textarea,
- saves the user message into the in-memory `chat` array with `sendMessageAsUser()`,
- loads character card fields,
- prepares depth prompts / author-note style injections,
- creates `coreChat`, a generation-time copy/filter of the visible chat.

Important:

```text
The saved chat file is not rebuilt yet at this stage.
The browser has an in-memory chat array that prompt assembly will use.
```

### 2. Extensions get a chance to intercept generation

SillyTavern calls:

```text
runGenerationInterceptors(coreChat, this_max_context, type)
```

Extensions can register a generation interceptor in their manifest.

Vector Storage does this:

```json
"generate_interceptor": "vectors_rearrangeChat"
```

So Vector Storage runs before the final prompt is assembled.

### 3. Vector Storage builds a search query

Vector Storage looks at the latest chat messages and uses them as the search query.

Relevant setting:

```text
Query messages
```

If this is `10`, it takes the last 10 usable messages, reverses them newest-first, joins their text, and uses that as the retrieval query.

Plain English:

```text
"Given what is happening right now, what older messages look relevant?"
```

### 4. Vector Storage queries the outside index

Vector Storage has already been gradually indexing chat messages in the background.

It stores old messages in:

```text
data/default-user/vectors/<source>/<chat collection id>/
```

At generation time, it queries that index and asks for:

```text
Insert#
```

messages. If `Insert#` is `2`, it tries to retrieve 2 relevant old messages.

### 5. Vector Storage protects recent messages

Relevant setting:

```text
Retain#
```

In code this is called `protect`.

If `Retain#` is `8`, the last 8 messages are protected from rearrangement. Vector Storage will not pull those out and reinsert them as vector memories.

Plain English:

```text
Keep the immediate conversation intact.
Only retrieve/rearrange older messages.
```

### 6. Vector Storage removes duplicates from the generation-time chat copy

If an old message was selected by vector search, Vector Storage removes that message from the generation-time `chat` array and puts it into a formatted memory block instead.

This prevents the same text from appearing twice:

```text
once as normal chat history
once as [Past events: ...]
```

Important:

```text
It does not delete the real saved chat.
It only changes the temporary prompt-building copy.
```

### 7. Vector Storage injects a memory block

The retrieved messages are formatted with the configured template:

```text
[Past events: {{text}}]
```

Then it calls:

```text
setExtensionPrompt(...)
```

Depending on settings, this memory block can be inserted:

- before main prompt / story string,
- after main prompt / story string,
- or in-chat at a chosen depth.

### 8. SillyTavern assembles the prompt

After all interceptors are done, SillyTavern builds the actual prompt.

It combines things like:

- system prompt,
- character description,
- scenario,
- persona,
- examples,
- world info,
- author notes,
- extension prompts,
- recent chat messages,
- vector memory block,
- final assistant prefix / instruct formatting.

Everything in that final prompt costs tokens.

### 9. SillyTavern checks the context limit

SillyTavern calculates token count against:

```text
this_max_context
```

This is based on the configured/max backend context minus generation budget and API-specific limits.

If the prompt is too large, SillyTavern trims.

Observed behavior in the local code:

```text
1. Try removing unpinned example messages.
2. If still too large, remove the oldest chat message from the prompt.
3. Repeat until it fits.
```

So Vector Storage does not need to perfectly know ahead of time how much room is available. It injects its block, then SillyTavern's prompt-size check decides what else must be dropped.

### 10. Final request is sent to the model

The model receives only the final assembled prompt that fits the context window.

If the original chat has 30k tokens and the model supports 20k:

```text
Only a selected subset is sent.
```

That subset may include:

- recent chat,
- selected extension prompts,
- retrieved vector memories,
- selected world info,
- examples if they fit,
- character/scenario/system text.

It will not include all 30k.

### Important Mental Model

Vector Storage does not increase context.

It performs a trade:

```text
less random old chat
more relevant old memory
```

If vector memory takes 500 tokens, those 500 tokens come out of the same total budget as everything else.

The final prompt builder handles overflow by dropping older/less-prioritized material until the final request fits.

### What This Means for ST-Memory

ST-Memory should not blindly inject large retrieved chunks.

It should:

- know the current speaker,
- filter by visibility before injection,
- retrieve a small number of high-value memories,
- prefer compact graph facts and summaries over raw transcript text,
- keep an explicit memory budget,
- and let vectors provide candidates, not final authority.

## RAG Storage Principle

Do not put RAG files inside SillyTavern's native chat folders unless core is changed to support that.

Use plugin-owned sidecar folders:

```text
data/default-user/extensions/ST-Memory/chats/<chat-key>/
```

This keeps SillyTavern's existing chat files portable and safe:

```text
data/default-user/chats/<character>/<chat>.jsonl
data/default-user/group chats/<group-chat>.jsonl
```

If the extension is disabled, the original SillyTavern chat remains valid. If the RAG index is deleted, the plugin can rebuild it from event/chunk logs.

## Context Graph Notes

The user shared an article arguing that vector RAG is not enough for multi-agent memory because vector search retrieves similar chunks but does not natively represent relationships between facts.

Core claim from the article:

```text
Raw transcript:
  sends every turn back to the model; token cost grows with chat length.

Vector RAG:
  retrieves similar text chunks; good for single-fact lookup.

Context graph:
  stores entities and typed relationships; better for questions that require joining facts.
```

Example graph shape:

```text
Agent_Implementer --ASSIGNED_TO--> AuthModule
AuthModule        --DEPENDS_ON--> RateLimiter
```

A vector query can retrieve the `AuthModule` chunk or the `RateLimiter` chunk, but it does not inherently know that a two-hop path connects:

```text
Agent_Implementer -> AuthModule -> RateLimiter
```

That distinction matters for ST-Memory because roleplay memory often asks relational questions:

- Who knows this phone message?
- Which character told Erika something that Miya never saw?
- Which group thread discussed a plan connected to a later scene?
- What location was a character at when a private text happened?
- Which private promise was superseded by a later public decision?

These are not always single-chunk similarity lookups. They often need structured relationships.

The article's benchmark numbers should be treated as directional rather than proof for our use case, because its setup was deterministic and simplified. Still, the reported pattern is useful:

```text
Raw history dump:
  higher token cost, decent for direct facts, weak for joins.

Vector-only RAG:
  low token cost, useful for direct semantic lookup, weak for multi-hop joins.

Context graph:
  low token cost, stronger for relationship/join queries.
```

Important production caveats from the article:

- Entity matching is hard.
  - `AuthModule` and "the authentication module" must resolve to the same entity.
  - In production this likely needs an LLM or strong alias/entity-linking layer.

- Stale facts are dangerous.
  - If `Ticket_4471 --HAS_PRIORITY--> high` is later replaced by `critical`, the graph must mark or remove the stale edge.
  - A graph without time/supersession logic can return old facts with false confidence.

- Graph memory is not free.
  - It needs extraction.
  - It needs entity resolution.
  - It needs updates, pruning, and conflict handling.
  - It is an extra moving part.

## Why Context Graphs Matter for ST-Memory

ST-Memory should not be vector-only.

Vector search is useful for:

- finding old scenes semantically similar to the current scene,
- recalling relevant phone messages,
- retrieving nearby RP context,
- searching summaries and facts by natural language.

But graph memory is better for:

- character visibility,
- phone participants,
- who knows what,
- private vs shared knowledge,
- group membership,
- current location,
- promises, decisions, obligations,
- superseded facts,
- multi-hop questions.

The right design is hybrid:

```text
Event log:
  exact chronological source of truth.

Vector index:
  semantic similarity search over event/chunk text.

Context graph:
  structured entities and relationships extracted from events.

Fact/summarization store:
  compact model-readable memory.

Prompt assembler:
  speaker -> graph visibility filter -> vector recall -> graph joins -> budgeted injection.
```

For phone memory, graph triples could look like:

```text
msg_123      --SENT_BY--> Thijs
msg_123      --SENT_TO--> Erika
msg_123      --IN_THREAD--> thread_dept_erika
msg_123      --VISIBLE_TO--> Thijs
msg_123      --VISIBLE_TO--> Erika
msg_123      --OCCURRED_DURING--> scene_curfew_stop

Erika       --MEMBER_OF--> Dept_Public_Corrections
Miya        --MEMBER_OF--> Dept_Public_Corrections
thread_abc  --HAS_PARTICIPANT--> Erika
thread_abc  --HAS_PARTICIPANT--> Miya
```

Then the system can answer:

```text
Can Miya know msg_123?
```

by graph traversal rather than by hoping a vector-retrieved chunk says the right thing.

## Proposed Graph Files

Add graph-oriented sidecar files to the plugin layout:

```text
data/default-user/extensions/ST-Memory/chats/<chat-key>/
  graph/
    entities.jsonl
    edges.jsonl
    aliases.json
    supersessions.jsonl
```

Possible `entities.jsonl` entry:

```json
{"id":"char_erika","type":"character","name":"Dept. of Public Corrections - Erika","aliases":["Erika"]}
```

Possible `edges.jsonl` entry:

```json
{"id":"edge_001","subject":"msg_123","predicate":"VISIBLE_TO","object":"char_erika","sourceEventId":"event_123","createdAt":1783300000000,"active":true}
```

Possible supersession entry:

```json
{"oldEdgeId":"edge_001","newEdgeId":"edge_009","reason":"same subject/predicate updated later","createdAt":1783300100000}
```

The graph should be rebuildable from the event log, just like vector indexes should be rebuildable from chunks.

## Context Graph Implementation Strategy

Do not build the full graph engine first.

Start with a narrow graph that solves real ST-Phone/ST-Memory problems:

1. Characters and aliases.
2. Phone messages.
3. Phone threads.
4. Visibility edges.
5. Group participants.
6. Scene/event links.
7. Supersession for facts that can change.

Then add semantic extraction later:

```text
Phase 1:
  deterministic graph writes from UI actions and known metadata.

Phase 2:
  rule-based extraction from phone events and explicit JSON.

Phase 3:
  optional LLM extractor for natural-language events.
```

This avoids overbuilding and avoids trusting a model to extract every relationship correctly from day one.

## Memory Model We Want

The future memory system should treat visible chat and remembered events as separate layers:

```text
Visible transcript
  Normal SillyTavern chat messages.

Phone event log
  Exact private or semi-private phone messages.

Episodic memory
  Phone message plus nearby RP context, timestamp, chat index, participants.

Semantic memory
  Durable facts extracted from events.

Vector index
  Searchable embeddings of episodic and semantic memory.

Prompt assembler
  Current speaker -> allowed memories -> ranked retrieval -> budgeted injection.
```

## Important Principle

Visibility and memory are not the same thing.

A phone-only message can be invisible to normal chat while still remembered by:

- the sender
- the recipient
- all phone group participants
- selected extra characters
- everyone, if explicitly marked visible to all

Normal chat generation must not receive phone memories globally. It must receive phone memories filtered for the current speaker.

## Next Technical Steps

1. Implement speaker-aware phone memory injection for normal chat.
2. Add a strict phone memory budget for prompt injection.
3. Keep recent exact phone thread context separate from vector-recalled old events.
4. Design a sidecar storage API or use an existing scoped extension storage endpoint if one exists.
5. Move bulky phone logs out of `chat_metadata.st_phone` once a safe sidecar write path is available.
6. Keep JSONL as the canonical transcript and backup/export format.

---

# Findings Update: Chat Completion, KoboldCpp, and Pushing Retrieval (2026-07-05)

This section answers three questions:

1. What should Prompt Post-Processing be set to for KoboldCpp via Chat Completion + Custom (OpenAI-compatible)?
2. Should function calling be enabled, and what does it actually do for ST-Phone?
3. How far can a plugin + extension pair push memory fetching with KoboldCpp backends?

All file references verified against the local SillyTavern source.

## Prompt Post-Processing Explained

Prompt Post-Processing (PPP) is a server-side transform applied to the chat completion message array before it is sent to the backend. It exists because some APIs reject message sequences SillyTavern naturally produces (multiple system messages, consecutive same-role messages, assistant-first conversations).

Source: `src/prompt-converters.js` (`PROMPT_PROCESSING_TYPE`, `postProcessPrompt()`, `mergeMessages()`).

The modes:

```text
None            No transformation. Messages sent as-is.
Merge           Merge consecutive messages of the same role into one.
Merge (tools)   Same, but preserves tool calls in the prompt.
Semi-strict     Merge + only one system message allowed (at the start).
Semi (tools)    Same, preserving tool calls.
Strict          Semi-strict + conversation must start with a user message;
                inserts placeholder user messages if needed.
Strict (tools)  Same, preserving tool calls.
Single user     Squash the entire prompt into ONE user message.
```

Critical detail found in `mergeMessages()`: the non-tools variants (`Merge`, `Semi-strict`, `Strict`) strip tool calls out of the prompt entirely. This is why SillyTavern hard-disables function calling unless PPP is `None` or one of the `(tools)` variants (`public/scripts/tool-calling.js`, `isToolCallingSupported()`, lines ~616-621).

### Recommendation for KoboldCpp

KoboldCpp's `/v1/chat/completions` applies the model's own chat template server-side (or its jinja template with `--jinja`). It does not require strict role alternation the way Claude/Mistral cloud APIs do.

```text
Recommended: None
Fallback:    Merge (tools) — only if a specific model's chat template
             misbehaves with consecutive same-role or mid-chat system
             messages (some Mistral/Gemma templates).
```

Never use `Strict` or `Semi-strict` (non-tools) if function calling matters — they silently disable it. `Single user message` destroys multi-turn structure and should only be used for badly behaved templates.

Related detail: when SillyTavern talks to KoboldCpp through the Custom source, the model id is reported as `koboldcpp/<model name>`. SillyTavern special-cases this pattern (e.g. it forwards `reasoning_effort` for `koboldcpp/*` models — `src/endpoints/backends/chat-completions.js` around line 2511).

## Function Calling: What It Actually Does Here

SillyTavern has a real tool-calling framework: `ToolManager` in `public/scripts/tool-calling.js`. Extensions register tools with `ToolManager.registerFunctionTool({name, description, parameters, action, ...})` (also exposed via `SillyTavern.getContext().registerFunctionTool`). Registered tools are sent as OpenAI `tools` to the backend; when the model emits `tool_calls`, SillyTavern runs the registered `action`, appends the tool result, and re-generates until the model produces a final message.

Requirements (all verified in `isToolCallingSupported()` / `canPerformToolCalls()`):

- Chat Completion API only (`main_api === 'openai'`).
- "Enable function calling" checked in the preset.
- Source must support tools; `CUSTOM` (OpenAI-compatible) is on the supported list.
- PPP must be `None`, `Merge (tools)`, `Semi (tools)`, or `Strict (tools)`.
- KoboldCpp side: recent KoboldCpp versions support the `tools` parameter on `/v1/chat/completions`, with a universal grammar-constrained tool-call mode; `--jinja` (and `--jinjatools`) lets the model's own template drive tool-call formatting.

### The catch that matters for ST-Phone

```text
canPerformToolCalls() excludes generation types: 'quiet', 'impersonate', 'continue'.
```

ST-Phone's phone-only replies use `generateQuietPrompt()` — a quiet generation. Tools NEVER fire during quiet generations. So enabling function calling changes nothing about the current phone-only reply path.

What function calling IS good for:

```text
Normal chat generations.
```

This enables a much cleaner design than JSON-in-narrative parsing:

- Register a `send_phone_message` tool. During a normal RP reply, if a character decides to text someone, the model calls the tool. The extension stores the phone message in the phone timeline (with participants/visibility), the tool result confirms it, and the model continues narrating. No fragile JSON extraction from prose, no reasoning-block stripping — the transport is the tool-call channel itself.
- Register a `remember_fact` / `update_memory` tool for explicit durable memory writes from the model.
- Tool invocations are recorded on the message (`extra.tool_invocations`), so there is an audit trail.

Verdict: enable function calling (with PPP = None), but treat it as the phone/memory write channel for NORMAL chat generations — not for phone-only generations.

## Structured Output: The Real Fix for Phone-Only JSON

The current phone-only flow asks the model for raw JSON and then strips reasoning wrappers by hand. SillyTavern + KoboldCpp can do this properly with grammar-enforced structured output:

- `public/scripts/custom-request.js` `ChatCompletionService` accepts a `json_schema` field in its payload and parses the result (`extractJsonFromData`).
- For the CUSTOM source, the server forwards it as `response_format: { type: 'json_schema', json_schema: { name, strict, schema } }` (`src/endpoints/backends/chat-completions.js` ~line 2325).
- KoboldCpp supports OpenAI Structured Outputs on its chat completions API (grammar-enforced, same machinery as GBNF grammar).
- Text Completion equivalents exist too: `textgen-settings.js` sends GBNF `grammar` to KoboldCpp and `json_schema` to TabbyAPI/llama.cpp server.

Implications for ST-Phone:

```text
Replace: "please return only JSON" + reasoning-stripping + brace-scanning
With:    a real JSON schema for {"phoneMessages":[...]} enforced by grammar.
```

Two caveats:

- Grammar constrains generation from token zero, so reasoning models cannot emit a `<think>` block unless the schema allows it. That eliminates the parsing problem entirely, but may reduce quality for models that lean on reasoning. Optionally keep reasoning by adding a `"thoughts"` string field to the schema before `"phoneMessages"` — still deterministic to parse.
- `generateQuietPrompt()` does not take a `json_schema`. To use structured output, phone-only generation should move off `generateQuietPrompt` onto `ChatCompletionService`/`ConnectionManagerRequestService` (next section). This is a win anyway: quiet prompts run the full prompt pipeline (character card, world info, main chat history), which both wastes tokens and leaks main-chat context into phone replies. A custom request gives a clean, fully controlled message array.

## Extensions Can Use Multiple Backends: ConnectionManagerRequestService

`public/scripts/extensions/shared.js` exports `ConnectionManagerRequestService`:

```js
ConnectionManagerRequestService.sendRequest(
    profileId,      // a Connection Manager profile id
    prompt,         // string or message array
    maxTokens,
    { stream, signal, extractData, includePreset, includeInstruct },
    overridePayload // merged into the request body, e.g. { json_schema: {...} }
);
```

This routes a generation through ANY configured connection profile — not just the one the user is currently chatting with. It supports both chat completion and text completion profiles, and `overridePayload` can carry `json_schema`, sampler overrides, etc. (`ChatCompletionService.createRequestData` passes arbitrary props through).

This is the key to a multi-backend setup without touching the server:

```text
Profile "RP main":        KoboldCpp #1, big RP model, user chats normally.
Profile "Memory utility": KoboldCpp #2, small fast model (3-8B class), used by
                          the extension for summarization, fact extraction,
                          rerank scoring, query rewriting, phone replies.
```

The extension can fire utility requests at backend #2 while backend #1 stays dedicated to actual RP generation.

## KoboldCpp Capabilities Relevant to ST-Memory

Verified against KoboldCpp docs/wiki (July 2026):

- **Embeddings alongside the main model**: `--embeddingsmodel <gguf>` loads an embedding model IN THE SAME instance as the text model. Endpoints: `/api/extra/embeddings` (what SillyTavern's `/api/backends/kobold/embed` proxy calls) and OpenAI-style `/v1/embeddings`. `--embeddingsgpu` offloads it to GPU; `--embeddingsmaxctx` caps its context. One instance can serve RP generation AND embeddings.
- **Multiuser queueing**: enabled by default; multiple clients (extension + plugin + UI) can hit one instance and requests queue safely.
- **Admin mode**: `--admin --admindir <dir of .kcpps configs> [--adminpassword ...]` allows switching the loaded model at runtime via API. With enough VRAM, two instances are simpler than hot-swapping.
- **Speculative decoding**: `--draftmodel` speeds up the main model with a small draft model — free latency win if VRAM allows.
- **Tool calling**: supported on `/v1/chat/completions`; grammar-constrained universal mode by default, `--jinja`/`--jinjatools` for native-template tool calls.
- **Structured output / grammar**: GBNF `grammar` parameter and OpenAI Structured Outputs (`json_schema`) on chat completions.

Note on SillyTavern's `koboldcpp` vector source: embeddings are computed CLIENT-SIDE. The vectors extension calls `/api/backends/kobold/embed`, then ships the resulting vectors to `/api/vector/insert` inside `sourceSettings.embeddings` (`src/endpoints/vectors.js`: the `'koboldcpp'` cases just read `sourceSettings.embeddings[text]`). Consequence: a server plugin cannot reuse the `koboldcpp` vector source without providing vectors itself — but a plugin can simply call KoboldCpp's `/api/extra/embeddings` directly server-side, which is cleaner anyway.

## How Far Can Plugin + Extension Push Memory Fetching?

Very far. The plugin runs inside the SillyTavern Node process with no sandbox: arbitrary file I/O, arbitrary HTTP, npm dependencies, background timers. The extension owns the prompt via generation interceptors and extension prompts. Together that is a full RAG server + orchestrator.

### What the server plugin unlocks

1. **Direct KoboldCpp access, server-side.** The plugin calls `/api/extra/embeddings` and `/v1/chat/completions` on any local instance itself. No frontend round-trips, no UI blocking.
2. **Background memory work.** After each message event (extension POSTs the event to the plugin), the plugin queues async jobs: rolling thread/scene summaries, fact extraction into `facts.jsonl`, graph edge extraction (entities, VISIBLE_TO, MEMBER_OF, supersessions), chunking + embedding into its own index. None of this blocks the user's next message. This is the "sleep-time compute" pattern: memory consolidation happens between user turns, on the utility model.
3. **A plugin-owned vector index with metadata filtering.** SillyTavern's own index uses `vectra` (local file-based index under `data/<user>/vectors/`). The plugin can use vectra (or sqlite-vec/LanceDB) directly with rich per-item metadata: `{speaker, participants[], visibility, threadId, timestamp, kind}`. Visibility filtering then happens IN the query instead of post-filtering a top-K that may have been mostly disallowed items. Strictly better than the current `/api/vector/query` + client-side filter approach.
4. **Hybrid retrieval.** Vector search + keyword/BM25 (trivial over `chunks.jsonl`) + graph traversal, merged and deduplicated server-side, returned as one budgeted memory block:
   ```text
   POST /api/plugins/st-memory/recall
   { speaker, query, threadId?, budgetTokens }
   -> { block: "...", sources: [...] }
   ```
   The extension's generation interceptor calls this once per generation and injects the result with `setExtensionPrompt()`.
5. **Reranking.** First-stage retrieval over-fetches (top 30-50), then a cheap rerank: embedding cosine against a rewritten query (free), or the utility LLM scoring candidates in one batched structured-output call (better, still fast on a 3-8B model). KoboldCpp has no cross-encoder rerank endpoint, so LLM-as-reranker on the utility instance is the practical option.
6. **Query rewriting / HyDE.** Before retrieval, the utility model turns "last few messages + current speaker" into an explicit search query ("What does Erika know about Thijs's curfew stop?"). Raw dialogue is a bad query; this improves RP retrieval a lot.
7. **Time-aware ranking.** Score = similarity x recency-decay x pin-boost x participant-match. Supersession edges from the graph mark stale facts so old truths do not outrank new ones.

### Recommended backend topology (single machine, decent VRAM)

```text
KoboldCpp #1 (main):    RP model, most of the VRAM.
                        Also --embeddingsmodel (embedding GGUFs are tiny,
                        ~0.3-1GB) so vectors work with one instance.
                        Optionally --draftmodel for speed.

KoboldCpp #2 (utility): small instruct model (Qwen3 4B/8B class), used via a
                        Connection Manager profile (extension) and directly
                        by the plugin for extraction/summaries/rerank.
                        Runs in parallel with #1 — memory work no longer
                        competes with RP generation latency.
```

Minimal viable version: one instance with `--embeddingsmodel`, utility calls queued to the main model between user turns. Full version: two instances, fully parallel memory pipeline.

### Recommended SillyTavern settings (current setup)

```text
API:                     Chat Completion, Custom (OpenAI-compatible)
                         URL: http://127.0.0.1:5001/v1
Prompt Post-Processing:  None
Enable function calling: ON (for send_phone_message / remember_fact tools
                         during normal chat; ignored for quiet generations)
KoboldCpp launch:        --jinja recommended for tool calling; add
                         --embeddingsmodel <gguf> for vectors.
Phone-only replies:      migrate from generateQuietPrompt to
                         ChatCompletionService/ConnectionManagerRequestService
                         with json_schema structured output.
```

### The full pipeline this enables

```text
User sends message
  -> extension interceptor calls plugin /recall (speaker-filtered, budgeted)
  -> memory block injected, main model generates
  -> model may call send_phone_message / remember_fact tools (normal gen only)
  -> extension posts new events to plugin
  -> plugin (async, utility model): summarize, extract facts/edges,
     chunk, embed, index
  -> next turn retrieves from an index that is already up to date
```

That is the same architecture pattern as agent memory systems (Letta/MemGPT-style): the context window is a cache, the plugin is the memory hierarchy, and retrieval is speaker-scoped and budgeted. Nothing in SillyTavern blocks this; the extension API (interceptors, `setExtensionPrompt`, tool registration, connection profiles) plus an unsandboxed server plugin covers every layer.

## Milestone 1: Implemented and Verified (2026-07-05)

`plugins/st-memory/` now exists (plain CommonJS, `index.js` + `package.json`, no build step) exposing:

```text
GET  /api/plugins/st-memory/health
POST /api/plugins/st-memory/chat/open      { chatKey }
POST /api/plugins/st-memory/events/append  { chatKey, event }
POST /api/plugins/st-memory/events/query   { chatKey, limit? }
```

Storage lives at `data/default-user/extensions/ST-Memory/chats/<chatKey>/{manifest.json,events.jsonl}`. `chatKey` is computed client-side by the extension as `st_memory_<hash of getCurrentChatId()>` (mirrors the existing `phoneVectorCollectionId()` pattern) — the plugin never needs to know about SillyTavern's chat/character model, it just sanitizes and uses whatever key it's given as a folder name. Appends are serialized per chat key via an in-memory promise chain to avoid interleaved writes; `manifest.json` is written with `write-file-atomic`.

The client side is split into two extensions (memory system first, phone as a consumer):

```text
public/scripts/extensions/third-party/ST-Memory/
  The memory system's frontend. Owns plugin detection (health check on
  APP_READY and CHAT_CHANGED), the per-chat sidecar key, chat/open, and the
  transport for appendEvent/queryEvents. Publishes a stable client API at
  globalThis.STMemory = { isAvailable, getChatKey, appendEvent, queryEvents,
  refresh, STATUS_EVENT } and emits 'st_memory_status' through eventSource
  whenever availability is re-checked. All future memory features (RAG,
  recall, facts, graph) belong here, not in ST-Phone.

public/scripts/extensions/third-party/ST-Phone/
  Pure consumer. Reads globalThis.STMemory lazily at call time (so extension
  load order never matters) and hands phone events over via
  mirrorEventToPlugin() — fire-and-forget, .catch()-guarded, never blocking
  the existing chat_metadata.st_phone path. If the ST-Memory extension or
  the server plugin is missing, everything silently no-ops.
```

ST-Phone dual-writes every phone event (outgoing send, generated reply, parsed-from-chat message). A read-only status line in the phone's Settings shows "ST-Memory: plugin detected / plugin not detected / extension not installed".

Verified end-to-end via the running dev instance:
- Plugin loads and mounts (`[st-memory] Plugin loaded, mounted at /api/plugins/st-memory`).
- Sending a phone message wrote identical data to both `chat_metadata.st_phone` (unchanged behavior) and `events.jsonl` (new).
- With the plugin removed from `plugins/` entirely, the extension logged a graceful 404 on the health check, `memoryPluginAvailable` stayed `false`, no append calls were attempted, and the phone-send flow worked exactly as before — confirming the "remove the extension/plugin, nothing breaks" requirement.
- Repeated `chat/open` calls are idempotent (`createdAt` and event count unchanged on re-open).

Not yet done (still applies from the sections above): vector indexing moved server-side, `/recall` endpoint, structured-output phone replies, function-calling tools, background summarization/graph extraction, second KoboldCpp instance for utility work.

## Milestone 2: Implemented and Verified (2026-07-05)

Server-side RAG with speaker-filtered recall is live.

**Plugin additions** (`plugins/st-memory/index.js`):

```text
POST /api/plugins/st-memory/index/upsert
     { chatKey, server, items: [{ id, text, metadata }] }
     Embeds via the KoboldCpp instance at `server` (/api/extra/embeddings),
     stores in a per-chat vectra index at chats/<chatKey>/rag/index/.
     Dedupes by item id (refId), so re-sends are cheap no-ops.

POST /api/plugins/st-memory/recall
     { chatKey, server, query, speaker?, participants?, excludeIds?,
       topK?, threshold?, budgetChars? }
     Embeds the query, over-fetches topK*4 candidates, then filters by
     visibility BEFORE ranking: an item is allowed if visibility === 'all',
     or the speaker/participants appear in memoryVisibleTo (falling back to
     visibleTo). Ranking = cosine score + recency boost (up to 0.05) +
     pinned boost (0.05). Returns a budgeted, ready-to-inject text block
     plus raw results.
```

**ST-Memory extension** now exposes `indexItems(items)`, `recall(options)`, and `hasEmbeddingServer()` on `globalThis.STMemory`, resolving the KoboldCpp URL from textgen settings / vectors alt endpoint automatically.

**ST-Phone integration:**

- `indexPhoneMessageVector()` prefers the plugin index (with full metadata: kind, threadId, ts, pinned, visibility, visibleTo, memoryVisibleTo); the old client-side embedding path remains as automatic fallback when the plugin is absent.
- `buildVectorRecallBlock()` (phone-only replies) prefers plugin `/recall` filtered by thread participants.
- NEW: normal-chat generation interceptor (`generate_interceptor: stPhoneMemoryInterceptor` in manifest.json). When "Memory recall in normal chat" is enabled, every normal generation gets a compact `[Private memories known to <speaker> ...]` block injected via `setExtensionPrompt`, retrieved with `speaker = current character` so characters only ever see memories they are allowed to know. Quiet generations are skipped (the phone-only path does its own recall).

**Settings:** new "Memory recall in normal chat" checkbox (default off). Default `vectorScoreThreshold` lowered 0.55 -> 0.4 because Qwen3-Embedding-0.6B similarity scores run low (a directly-relevant match scored ~0.55; unrelated content scores well below 0.4).

**Verified live** (Qwen3-Embedding-0.6B via the main KoboldCpp instance, 1024-dim vectors):

- Phone message "the secret meeting is behind the old water tower at midnight" indexed server-side with visibility metadata.
- `/recall` with `speaker: Miya` returned it; `speaker: Erika` (not a participant) got zero results — visibility enforcement confirmed at the query layer.
- Interceptor test: with a fake chat asking about the meeting, the speaker-filtered memory block appeared in `extensionPrompts.st_phone_recall` for a normal generation and was cleared for a quiet generation.
- Junk-folder guard: sidecar `chat/open` is skipped when no chat is active (previously created an `unknown-chat` folder at the welcome screen).

**Remaining follow-ons:** structured-output phone replies (json_schema), `send_phone_message`/`remember_fact` function tools, background summarization + fact/graph extraction, hybrid keyword+vector retrieval, LLM reranking, second KoboldCpp utility instance.

## Updated Next Technical Steps

1. ~~Scaffold `plugins/st-memory` (health, chat/open, events/append, events/query)~~ — done, see Milestone 1 above.
2. Move phone-only generation to `ConnectionManagerRequestService`/`ChatCompletionService` with `json_schema` structured output; keep the reasoning-stripping parser only as a fallback for backends without grammar support.
3. Enable function calling (PPP = None) and register `send_phone_message` + `remember_fact` tools for normal chat generations.
4. Add a second KoboldCpp instance + Connection Manager profile for utility work; wire extraction/summarization jobs into the plugin.
5. Give the plugin its own vectra (or sqlite-vec) index with metadata filters for speaker/visibility-scoped queries; keep ST's built-in vectors only for plain chat history.
6. Implement `/recall` with hybrid retrieval + rerank + token budget, called from the generation interceptor.
